import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import {
  db,
  aiConversationsTable,
  aiMessagesTable,
  aiPendingActionsTable,
  aiMemoriesTable,
  shopSettingsTable,
  type AiToolCall,
  type AiMessage,
} from "@workspace/db";
import type OpenAI from "openai";
import type { PermissionKey } from "./auth";
import { logger } from "./logger";
import { TOOLS, getToolSpecs, canUseTool, type AiToolContext } from "./aiTools";
import {
  ObjectStorageService,
  verifyObjectUploadOwnership,
  getConfirmedUploadMetadata,
  MAX_OBJECT_UPLOAD_SIZE_BYTES,
} from "./objectStorage";
import {
  extractDocumentText,
  isExtractableDocumentType,
  DocumentExtractError,
} from "./documentExtract";

const MODEL = "gpt-5.4";
const REQUEST_OPTIONS = { timeout: 60_000, maxRetries: 2 } as const;
// How many stored messages to replay into the model each turn.
const HISTORY_LIMIT = 40;
// Hard stop on tool-call/model iterations so a confused model cannot loop forever.
const LOOP_CAP = 8;
// Cap the size of any single tool result fed back to the model.
const TOOL_RESULT_MAX = 6000;
// Cap the rendered memory block injected into the system prompt.
const MEMORY_CHARS_MAX = 2000;

async function getOpenAiClient() {
  const mod = await import("@workspace/integrations-openai-ai-server");
  return mod.openai;
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// Errors the route layer maps directly onto HTTP status codes.
export class AgentError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export interface AgentTurnInput {
  conversationId: number | null;
  userId: number;
  isAdmin: boolean;
  permissions: readonly PermissionKey[];
  message: string;
  vehicleId?: number | null;
  // Photos the caller has already uploaded and may attach to an inspection
  // item. Verified server-side; the model only ever sees them as 1-based
  // numbers (never the raw object path).
  attachments?: ReadonlyArray<{ objectPath: string }> | null;
  // Documents the caller uploaded for the assistant to review. Verified
  // server-side; text is extracted and injected into this turn only (never
  // persisted). Limited to 3 per message.
  documentAttachments?: ReadonlyArray<{
    objectPath: string;
    fileName?: string;
    mimeType?: string;
  }> | null;
}

export interface PendingActionView {
  id: number;
  toolName: string;
  summary: string;
  // Other top candidate records the model considered when it resolved this
  // action from an ambiguous lookup. Read back to the user if they reject the
  // best guess so they can pick a different one by name or position. Absent when
  // the match was unambiguous.
  alternatives?: string[];
}

// Largest number of alternative candidates surfaced on a pending action, and the
// per-label cap. The model is told to send at most 3; we re-enforce both bounds
// server-side so a chatty or adversarial model cannot bloat the confirmation.
const MAX_ALTERNATIVES = 3;
const ALTERNATIVE_LABEL_MAX = 80;

// Pull the optional model-supplied `alternatives` off the raw tool-call args and
// sanitize them: keep only non-empty strings, trim, truncate, dedupe (case-
// insensitive), and cap the count. Returns [] when none are usable. This field
// is advertised on write tools but is never part of their argsSchema, so it
// never reaches execute(); it exists purely to drive the clarify read-back.
function extractAlternatives(rawArgs: unknown): string[] {
  if (typeof rawArgs !== "object" || rawArgs === null) return [];
  const raw = (rawArgs as { alternatives?: unknown }).alternatives;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const label = truncate(entry.trim(), ALTERNATIVE_LABEL_MAX);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MAX_ALTERNATIVES) break;
  }
  return out;
}

// A client-side action a tool asks the frontend to perform after the reply is
// shown — navigating to or printing a report. It carries no business data; the
// per-report permission is enforced server-side before the action is minted.
export interface AgentAction {
  type: "navigate" | "print" | "open_import" | "pdf" | "email_report";
  path: string;
}

export interface AgentTurnResult {
  conversationId: number;
  status: "final" | "awaiting_confirmation";
  reply: string | null;
  pendingAction?: PendingActionView;
  action?: AgentAction;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated]`;
}

function serializeToolPayload(payload: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch {
    text = String(payload);
  }
  return truncate(text, TOOL_RESULT_MAX);
}

// Default voice-assistant name, used when the shop has not customized it (or the
// settings row cannot be read). Kept in sync with the DB column default.
const DEFAULT_ASSISTANT_NAME = "Timothy";

// Read the shop's chosen voice-assistant name. Falls back to the default if the
// settings row is missing/blank or the lookup fails, so a turn never breaks just
// because the name could not be resolved.
async function loadAssistantName(): Promise<string> {
  try {
    const [row] = await db
      .select({ assistantName: shopSettingsTable.assistantName })
      .from(shopSettingsTable)
      .where(eq(shopSettingsTable.id, 1));
    const name = row?.assistantName?.trim();
    return name || DEFAULT_ASSISTANT_NAME;
  } catch (err) {
    // Surface the read failure so a settings/DB outage that silently downgrades
    // the assistant's name is diagnosable rather than masked.
    logger.warn(
      { err },
      "loadAssistantName: settings read failed, using default assistant name",
    );
    return DEFAULT_ASSISTANT_NAME;
  }
}

function buildSystemPrompt(
  vehicleContext: string | null,
  memoryBlock: string | null,
  attachmentNote: string | null = null,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
  documentNote: string | null = null,
): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `You are ${assistantName}, the hands-free voice assistant for Reliable Shop Systems, an auto-repair shop management app. If someone asks your name, you are ${assistantName}.`,
    "You help shop staff manage customers, vehicles, parts and inventory, work orders, appointments, estimates, and digital vehicle inspections by calling tools.",
    "For estimates you can look them up, create them, add/update/remove line items, change their status, generate AI-suggested labor and parts line items for a job, convert an approved estimate into a draft invoice (copying its line items and tax), and convert an estimate into a new work order (copying its linked customer and vehicle). AI-suggested figures are estimates the staff must verify before quoting the customer.",
    "When you add AI-suggested line items, if the tool result includes a pricingNote or per-part pricing info, tell the user which parts were priced from the real parts catalog versus left as unverified AI estimates, and call out any low-stock parts. If that info is absent, just note the part prices are AI estimates to verify.",
    "For inspections you can look them up, start a new inspection for a vehicle, add and update checklist items each with a pass, attention, fail, or na condition, and mark an inspection completed or back to in progress.",
    "When the user asks to import data, bring in records from another program (Mitchell1, Tekmetric, Shopmonkey, AutoFluent), bring in their books or expenses from QuickBooks, or upload/open a CSV, call open_import_dialog to open the importer for them; pass the closest type (customers, work-orders, invoices, or expenses) so the right importer opens, or omit type to open the import hub. It opens a dialog where they pick and confirm the file, so do not ask them to paste the data.",
    "Always look things up with the read tools before acting; resolve people and vehicles by searching to get their id, and never invent ids.",
    "When a search returns several similarly-named records and you must pick one to act on, choose your best guess and call the write tool with it, but also pass the human-readable labels of the other top 2-3 candidates in that tool's alternatives argument. The app reads those back to the user so they can correct you if your guess is wrong. Only include alternatives when the match was genuinely ambiguous.",
    "To create, update, or delete data, call the matching write tool directly with the details you have gathered. Do NOT ask the user to confirm in your reply first — when you call a write tool the app automatically shows the user a confirmation prompt and nothing is saved until they approve. Only ask the user beforehand when you are missing a required detail or need to disambiguate which record they mean.",
    "Never claim a change was made until a tool result confirms it succeeded.",
    "When the user states a lasting preference, corrects you, or shares an important fact worth keeping, call the remember tool to save it for next time. Do not remember one-off details of the current task.",
    "Keep replies short and natural for being read aloud: one to three sentences, plain text, no markdown and no bullet symbols.",
    "Ask a brief clarifying question when a request is ambiguous or missing required details.",
    `Today is ${today}. Interpret relative dates accordingly and pass ISO 8601 timestamps to tools.`,
    "If you cannot do something, say so plainly.",
    memoryBlock
      ? `Things you have been asked to remember (apply them, but do not recite them unprompted):\n${memoryBlock}`
      : null,
    attachmentNote,
    documentNote,
    vehicleContext ? `Context: ${vehicleContext}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

// Shared object-storage handle for verifying caller-supplied attachments.
const attachmentStorage = new ObjectStorageService();

// Verify each caller-supplied attachment and return an ordered list of the
// object paths that passed. Index N in the returned array is exposed to the
// model as photo number N+1; the model never sees these paths. Anything that is
// not a first-party upload owned by the caller (admins bypass ownership) or that
// exceeds the upload size cap is dropped so it can never be referenced.
async function buildAttachmentManifest(
  attachments: ReadonlyArray<{ objectPath: string }> | null | undefined,
  ctx: AiToolContext,
): Promise<string[]> {
  if (!attachments || attachments.length === 0) return [];
  const manifest: string[] = [];
  for (const a of attachments) {
    const path = a?.objectPath;
    // Only first-party uploaded objects may ever be attached — never an
    // arbitrary or external path.
    if (typeof path !== "string" || !path.startsWith("/objects/")) continue;
    if (manifest.includes(path)) continue;
    if (!ctx.isAdmin) {
      const owned = await verifyObjectUploadOwnership(
        path,
        ctx.userId,
        attachmentStorage,
      );
      if (!owned) continue;
    }
    const size = await attachmentStorage.getObjectEntitySizeBytes(path);
    if (size !== null && size > MAX_OBJECT_UPLOAD_SIZE_BYTES) continue;
    manifest.push(path);
  }
  return manifest;
}

function attachmentNoteFor(count: number): string | null {
  if (count <= 0) return null;
  const plural = count === 1 ? "" : "s";
  return (
    `The user attached ${count} photo${plural} to this message, numbered 1 to ${count}. ` +
    "To attach one or more of them to an inspection checklist item, pass their numbers in the " +
    "photoRefs argument of add_inspection_item or update_inspection_item. " +
    `Only use numbers 1 to ${count}; never invent photo numbers, and never put a file path in photoUrls yourself.`
  );
}

// Hard cap on documents read per turn (matches the API schema maxItems). Belt-
// and-suspenders against a hand-crafted request carrying more.
const MAX_DOCUMENTS_PER_TURN = 3;

// Read a verified, owned upload handle fully into a Buffer for text extraction.
async function readUploadToBuffer(objectPath: string): Promise<Buffer> {
  const handle = await attachmentStorage.getObjectEntityFile(objectPath);
  const stream = handle.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface DocumentContext {
  // Block appended (in-memory, for this turn only) to the user message so the
  // model can read the extracted content. Null when nothing was extracted.
  userBlock: string | null;
  // System-prompt note describing the attachments and how to use them.
  systemNote: string | null;
}

// Verify, extract, and assemble the per-turn document context from caller-
// supplied document attachments. Ownership is verified exactly like photos
// (admins bypass). The content type used to pick a parser comes from the stored
// object metadata (server-trusted), never the client. Per-file failures become
// inline notices the model is told to relay; they never abort the turn. The
// extracted text is used only for this turn and is never persisted.
async function buildDocumentContext(
  attachments:
    | ReadonlyArray<{ objectPath: string; fileName?: string; mimeType?: string }>
    | null
    | undefined,
  ctx: AiToolContext,
): Promise<DocumentContext> {
  if (!attachments || attachments.length === 0) {
    return { userBlock: null, systemNote: null };
  }

  const seen = new Set<string>();
  const sections: string[] = [];
  const errors: string[] = [];
  let extracted = 0;

  for (const a of attachments.slice(0, MAX_DOCUMENTS_PER_TURN)) {
    const path = a?.objectPath;
    if (typeof path !== "string" || !path.startsWith("/objects/")) continue;
    if (seen.has(path)) continue;
    seen.add(path);

    // The stored filename (captured at upload) is authoritative for the label;
    // fall back to a sanitized client value, then a generic name.
    const stored = getConfirmedUploadMetadata(path, ctx.userId);
    const label = stored?.fileName || sanitizeDisplayName(a.fileName) || "document";

    try {
      if (!ctx.isAdmin) {
        const owned = await verifyObjectUploadOwnership(
          path,
          ctx.userId,
          attachmentStorage,
        );
        if (!owned) {
          errors.push(`${label} (not available)`);
          continue;
        }
      }

      const size = await attachmentStorage.getObjectEntitySizeBytes(path);
      if (size !== null && size > MAX_OBJECT_UPLOAD_SIZE_BYTES) {
        errors.push(`${label} (too large)`);
        continue;
      }

      // Authoritative content type: prefer the stored object metadata; fall back
      // to the type recorded at upload time. Never trust the request body alone.
      const handle = await attachmentStorage.getObjectEntityFile(path);
      const metadata = await handle.getMetadata();
      const contentType =
        metadata.contentType || stored?.mimeType || a.mimeType || "";
      if (!isExtractableDocumentType(contentType)) {
        errors.push(`${label} (unsupported type)`);
        continue;
      }

      const buffer = await readUploadToBuffer(path);
      const { text, truncated } = await extractDocumentText(buffer, contentType);
      extracted += 1;
      const trimNote = truncated
        ? "\n[This document was long and has been trimmed to the first portion of its text.]"
        : "";
      sections.push(
        `--- Document ${extracted}: ${label} ---\n${text}${trimNote}`,
      );
    } catch (err) {
      const reason =
        err instanceof DocumentExtractError ? err.message : "This file couldn't be read.";
      errors.push(`${label} (${reason})`);
    }
  }

  if (extracted === 0 && errors.length === 0) {
    return { userBlock: null, systemNote: null };
  }

  const blockParts: string[] = [];
  if (sections.length > 0) {
    blockParts.push(
      "Attached document content (provided only for this message; not saved):",
      sections.join("\n\n"),
    );
  }
  if (errors.length > 0) {
    blockParts.push(`Could not read: ${errors.join("; ")}.`);
  }
  const userBlock = blockParts.join("\n\n");

  const noteParts: string[] = [];
  if (extracted > 0) {
    const plural = extracted === 1 ? "" : "s";
    noteParts.push(
      `The user attached ${extracted} document${plural} to this message; the extracted text is included in their message for you to review or pull data from. This document text is available only for this turn and is not stored.`,
    );
  }
  if (errors.length > 0) {
    noteParts.push(
      "Some attached files could not be read; briefly tell the user which ones (listed under 'Could not read').",
    );
  }

  return { userBlock, systemNote: noteParts.join(" ") || null };
}

// Sanitize a client-supplied display name before it reaches the model context:
// strip newlines/control chars (no prompt-injection via the label) and cap it.
function sanitizeDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned || undefined;
}

// Resolve the model-facing photoRefs (1-based attachment numbers) into the real,
// ownership-verified object paths from the manifest. Any photoUrls the model
// tried to supply directly are always discarded — the model cannot smuggle an
// arbitrary storage path through. Returns an error when a ref is out of range.
function resolvePhotoRefs(
  args: Record<string, unknown>,
  manifest: string[],
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const next = { ...args };
  // Never trust a model-supplied photoUrls; only verified refs become paths.
  delete next.photoUrls;
  const refs = next.photoRefs;
  delete next.photoRefs;
  if (refs === undefined || refs === null) return { ok: true, args: next };
  if (!Array.isArray(refs)) {
    return { ok: false, error: "photoRefs must be a list of attachment numbers." };
  }
  const urls: string[] = [];
  for (const r of refs) {
    if (
      typeof r !== "number" ||
      !Number.isInteger(r) ||
      r < 1 ||
      r > manifest.length
    ) {
      return {
        ok: false,
        error: `Photo ${String(r)} is not one of the ${manifest.length} photo(s) attached to this message.`,
      };
    }
    urls.push(manifest[r - 1]);
  }
  if (urls.length > 0) {
    // Dedupe while preserving order.
    next.photoUrls = [...new Set(urls)];
  }
  return { ok: true, args: next };
}

// Return true when a memory row is readable by the given user.
//
// sourcePermissions encoding (must match aiTools.ts remember tool):
//   null       — unknown provenance (pre-migration rows).  Fail closed for
//                non-admins; admins always see all rows.
//   []         — ungated ONLY for shop-wide rows (isShopWide = true, i.e.
//                userId IS NULL, backfilled by migration).  User-scoped []
//                rows were written by admins under the old code path and are
//                treated identically to ["admin"] (admin-only).
//   ["admin"]  — admin-authored user-scoped row.  Only readable by current
//                admins; becomes invisible after role downgrade.
//   ["__any"]  — non-admin with no module permissions at write time.  Any
//                authenticated staff member may read (preferences/facts only).
//   [...perms] — non-admin with module permissions at write time.  Reader must
//                currently hold ALL listed permissions.
//
// isShopWide must be true iff the row's userId IS NULL in the DB.  Both call
// sites pass this from the query result; it cannot be spoofed by the client.
function canReadMemory(
  sourcePermissions: string[] | null | undefined,
  ctx: AiToolContext,
  isShopWide: boolean,
): boolean {
  if (ctx.isAdmin) return true;
  // null = unknown provenance → fail closed for non-admins.
  if (sourcePermissions == null) return false;
  if (sourcePermissions.length === 0) {
    // [] = ungated only for shop-wide rows; user-scoped [] is legacy
    // admin-authored → admin-only (same as ["admin"]).
    return isShopWide;
  }
  if (sourcePermissions.length === 1) {
    const sentinel = sourcePermissions[0];
    // ["admin"] = admin-authored → only current admins (denied here; admin
    // fast-path above already returned true).
    if (sentinel === "admin") return false;
    // ["__any"] = non-admin with no module perms → any authenticated staff.
    if (sentinel === "__any") return true;
  }
  // [...perms] = reader must currently hold ALL listed permissions.
  return sourcePermissions.every((p) =>
    ctx.permissions.includes(p as PermissionKey),
  );
}

// Load durable memories for the user (and any shop-wide ones), newest first, and
// render them into a compact block capped at MEMORY_CHARS_MAX characters so they
// never dominate the prompt.
//
// Security: memories are filtered by the user's CURRENT permissions so that
// revoked module access is honoured even for memories written under broader rights.
async function loadMemoryBlock(
  userId: number,
  ctx: AiToolContext,
): Promise<string | null> {
  const rows = await db
    .select({
      userId: aiMemoriesTable.userId,
      kind: aiMemoriesTable.kind,
      content: aiMemoriesTable.content,
      sourcePermissions: aiMemoriesTable.sourcePermissions,
    })
    .from(aiMemoriesTable)
    .where(
      or(eq(aiMemoriesTable.userId, userId), isNull(aiMemoriesTable.userId)),
    )
    .orderBy(desc(aiMemoriesTable.updatedAt))
    .limit(50);
  if (rows.length === 0) return null;
  const lines: string[] = [];
  let total = 0;
  for (const r of rows) {
    if (!canReadMemory(r.sourcePermissions, ctx, r.userId === null)) continue;
    const line = `- (${r.kind}) ${r.content}`;
    if (total + line.length + 1 > MEMORY_CHARS_MAX) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

// Return the conversation transcript for a given conversation, redacting
// assistant replies that immediately follow a tool result for a tool the
// current user can no longer call.  This closes the post-revocation side
// channel where a user with reduced permissions could recover previously
// disclosed module data from the stored conversation history.
//
// All messages (including role:"tool") are loaded so the function can detect
// which assistant replies are tainted by restricted tool results; only
// user/assistant messages with visible content are returned.
export async function getFilteredConversationTranscript(
  conversationId: number,
  ctx: AiToolContext,
): Promise<
  Array<{
    id: number;
    role: string;
    content: string | null;
    name: string | null;
    createdAt: string;
  }>
> {
  const allMessages = await db
    .select({
      id: aiMessagesTable.id,
      role: aiMessagesTable.role,
      content: aiMessagesTable.content,
      name: aiMessagesTable.name,
      toolCalls: aiMessagesTable.toolCalls,
      createdAt: aiMessagesTable.createdAt,
    })
    .from(aiMessagesTable)
    .where(eq(aiMessagesTable.conversationId, conversationId))
    .orderBy(asc(aiMessagesTable.id));

  const transcript: Array<{
    id: number;
    role: string;
    content: string | null;
    name: string | null;
    createdAt: string;
  }> = [];
  // Mirrors the turn-taint logic in rebuildModelMessages: set when any
  // restricted (or unknown) tool result appears in the current turn, cleared
  // on a new user message or after the assistant's text reply is emitted.
  let turnTainted = false;

  for (const m of allMessages) {
    if (m.role === "user") {
      turnTainted = false;
      if (m.content !== null && m.content.trim() !== "") {
        transcript.push({
          id: m.id,
          role: m.role,
          content: m.content,
          name: m.name,
          createdAt: m.createdAt,
        });
      }
    } else if (m.role === "tool") {
      // Fail closed: unknown/removed tools are treated as restricted.
      if (isToolResultRestricted(m.name, m.content, ctx)) {
        turnTainted = true;
      }
    } else if (m.role === "assistant") {
      const isFinalReply = !m.toolCalls || m.toolCalls.length === 0;
      if (isFinalReply) {
        // Final text reply for this turn (no pending tool calls). Redact if the
        // turn was tainted by a restricted tool result, then reset the taint.
        if (m.content !== null && m.content.trim() !== "") {
          transcript.push({
            id: m.id,
            role: m.role,
            content: turnTainted
              ? "[This reply has been redacted because it may contain information from a module your account can no longer access.]"
              : m.content,
            name: m.name,
            createdAt: m.createdAt,
          });
        }
        turnTainted = false; // reset after consuming the final reply
      } else {
        // Intermediate assistant message that requests tool calls — may have a
        // non-null preamble. Include in the transcript if it has visible text.
        // Redact the preamble if the turn is already tainted by a prior
        // restricted tool result (e.g. model called find_parts, got restricted
        // data, then emitted a second message summarising it before calling a
        // write tool). Do NOT reset taint here: tool results that follow may
        // add further taint, and the final reply also needs to be redacted.
        if (m.content !== null && m.content.trim() !== "") {
          transcript.push({
            id: m.id,
            role: m.role,
            content: turnTainted
              ? "[This reply has been redacted because it may contain information from a module your account can no longer access.]"
              : m.content,
            name: m.name,
            createdAt: m.createdAt,
          });
        }
      }
    }
  }
  return transcript;
}

// Return memories visible to the given user, applying permission-aware
// filtering so that revoked module access is honoured.
export async function getFilteredMemoriesForUser(ctx: AiToolContext): Promise<
  Array<{
    id: number;
    kind: string;
    content: string;
    createdAt: string;
  }>
> {
  const rows = await db
    .select({
      id: aiMemoriesTable.id,
      userId: aiMemoriesTable.userId,
      kind: aiMemoriesTable.kind,
      content: aiMemoriesTable.content,
      sourcePermissions: aiMemoriesTable.sourcePermissions,
      createdAt: aiMemoriesTable.createdAt,
    })
    .from(aiMemoriesTable)
    .where(
      or(
        eq(aiMemoriesTable.userId, ctx.userId),
        isNull(aiMemoriesTable.userId),
      ),
    )
    .orderBy(desc(aiMemoriesTable.updatedAt))
    .limit(200);
  return rows
    .filter((r) => canReadMemory(r.sourcePermissions, ctx, r.userId === null))
    .map(({ id, kind, content, createdAt }) => ({ id, kind, content, createdAt }));
}

// Collect only the function tool calls from a model message, in order.
function collectFunctionToolCalls(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
): AiToolCall[] {
  const out: AiToolCall[] = [];
  for (const t of message.tool_calls ?? []) {
    if (t.type !== "function") continue;
    out.push({
      id: t.id,
      type: "function",
      function: { name: t.function.name, arguments: t.function.arguments },
    });
  }
  return out;
}

async function insertUserMessage(
  conversationId: number,
  content: string,
): Promise<void> {
  await db
    .insert(aiMessagesTable)
    .values({ conversationId, role: "user", content });
}

async function insertAssistantText(
  conversationId: number,
  content: string,
): Promise<void> {
  await db
    .insert(aiMessagesTable)
    .values({ conversationId, role: "assistant", content });
}

async function insertAssistantToolCalls(
  conversationId: number,
  content: string | null,
  toolCalls: AiToolCall[],
): Promise<void> {
  await db
    .insert(aiMessagesTable)
    .values({ conversationId, role: "assistant", content, toolCalls });
}

async function insertToolResult(
  conversationId: number,
  toolCallId: string,
  name: string,
  payload: unknown,
): Promise<string> {
  const content = serializeToolPayload(payload);
  await db
    .insert(aiMessagesTable)
    .values({ conversationId, role: "tool", toolCallId, name, content });
  return content;
}

async function touchConversation(conversationId: number): Promise<void> {
  await db
    .update(aiConversationsTable)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(aiConversationsTable.id, conversationId));
}

// Load and verify ownership of a conversation, or create a fresh one.
async function loadOrCreateConversation(
  conversationId: number | null,
  userId: number,
  firstMessage: string,
): Promise<number> {
  if (conversationId !== null) {
    const [conv] = await db
      .select()
      .from(aiConversationsTable)
      .where(eq(aiConversationsTable.id, conversationId));
    if (!conv) throw new AgentError(404, "Conversation not found");
    if (conv.userId !== userId) throw new AgentError(404, "Conversation not found");
    return conv.id;
  }
  const title = truncate(firstMessage.trim(), 60);
  const [conv] = await db
    .insert(aiConversationsTable)
    .values({ userId, title })
    .returning();
  return conv.id;
}

// When a new user message arrives, cancel any still-pending action and repair the
// thread by recording a synthetic tool result for its dangling tool call.
async function cancelDanglingPending(conversationId: number): Promise<void> {
  const pendings = await db
    .update(aiPendingActionsTable)
    .set({ status: "rejected", resolvedAt: new Date().toISOString() })
    .where(
      and(
        eq(aiPendingActionsTable.conversationId, conversationId),
        eq(aiPendingActionsTable.status, "pending"),
      ),
    )
    .returning();
  for (const p of pendings) {
    await insertToolResult(conversationId, p.toolCallId, p.toolName, {
      cancelled: true,
      message: "User moved on without confirming; the action was cancelled.",
    });
  }
}

// Return true when a stored tool result should be redacted for the current user.
//
// Fails closed in four cases:
// 1. No tool name or unrecognised/removed tool → treat as restricted.
// 2. Memory-kind tools (e.g. "remember"): their results contain model-chosen
//    summaries of data from prior privileged sessions. The model already
//    receives an up-to-date, permission-filtered memory block via the system
//    prompt, so replaying historical remember results adds no value and creates
//    a persistent side channel even after module access is revoked.
// 3. The tool's requiredPermission is no longer held by the current user.
// 4. The tool defines isStoredResultRestricted and that callback returns true:
//    handles tools that conditionally enrich their results with data derived from
//    additional permissions (e.g. inventory-enriched pricing on an estimates
//    tool). Without this fourth check, a user downgraded from
//    estimates+inventory to estimates-only would still see catalog prices,
//    part ids, stock levels and low-stock flags from historical tool results even
//    though direct inventory access has been revoked.
function isToolResultRestricted(
  toolName: string | null,
  content: string | null,
  ctx: AiToolContext,
): boolean {
  if (!toolName) return true; // no name → unknown, fail closed
  const toolDef = TOOLS[toolName];
  if (!toolDef) return true; // unknown/removed tool, fail closed
  if (toolDef.kind === "memory") return true; // always redact memory-tool history
  if (!canUseTool(toolDef, ctx)) return true;
  // Secondary check: tool may have stored richer data that required additional
  // permissions at execution time. Delegate to the tool-level callback.
  if (toolDef.isStoredResultRestricted) {
    return toolDef.isStoredResultRestricted(content ?? "", ctx);
  }
  return false;
}

// Rebuild the model message list from stored history, windowing to the most
// recent messages and repairing tool-call/result pairs so the request is valid:
// leading orphan tool results are dropped and assistant tool calls with no
// recorded result get a synthetic "interrupted" result.
//
// Security: history replay enforces current permissions at two levels:
//   1. role:"tool" results for restricted or unknown tools are replaced with a
//      redaction notice.
//   2. role:"assistant" text replies that follow a restricted tool result
//      (which may summarise the sensitive data) are ALSO redacted.  A
//      turn-taint flag is set when any restricted tool result appears in a turn
//      and is cleared by the next user message or after the assistant's final
//      text reply is consumed.
// This prevents the model prompt from re-surfacing data the user's account can
// no longer access after a permission downgrade or role change.
function rebuildModelMessages(
  rows: AiMessage[],
  systemPrompt: string,
  ctx: AiToolContext,
): ChatMessage[] {
  let windowed = rows.slice(-HISTORY_LIMIT);
  while (windowed.length > 0 && windowed[0].role === "tool") windowed.shift();

  const out: ChatMessage[] = [{ role: "system", content: systemPrompt }];

  // Set when any restricted tool result is seen in the current assistant turn;
  // causes the following assistant text reply to be redacted as well.
  let turnTainted = false;

  for (let i = 0; i < windowed.length; i++) {
    const m = windowed[i];
    if (m.role === "user") {
      turnTainted = false; // new user turn resets taint
      out.push({ role: "user", content: m.content ?? "" });
    } else if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        // Tool-calling assistant message. Redact the content preamble if the
        // turn is already tainted by a prior restricted tool result so that
        // sensitive data summarised in an intermediate preamble is not fed back
        // into future model turns. Do NOT reset taint here.
        out.push({
          role: "assistant",
          content: turnTainted
            ? "[Reply redacted: this response may reference information from a module your account can no longer access.]"
            : m.content,
          tool_calls: m.toolCalls,
        } as ChatMessage);
        // Find which tool calls already have a contiguous result behind them.
        const provided = new Set<string>();
        for (let j = i + 1; j < windowed.length; j++) {
          const n = windowed[j];
          if (n.role === "tool" && n.toolCallId) provided.add(n.toolCallId);
          else break;
        }
        for (const tc of m.toolCalls) {
          if (!provided.has(tc.id)) {
            out.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "Interrupted: no result was recorded for this tool call.",
            } as ChatMessage);
          }
        }
      } else {
        // Final text reply for this turn. Redact if any tool result in this
        // turn was restricted, then consume the taint flag.
        const content = turnTainted
          ? "[Reply redacted: this response may reference information from a module your account can no longer access.]"
          : (m.content ?? "");
        out.push({ role: "assistant", content });
        turnTainted = false;
      }
    } else if (m.role === "tool") {
      // Fail closed: unknown/removed tool names are treated as restricted.
      const restricted = isToolResultRestricted(m.name, m.content, ctx);
      if (restricted) turnTainted = true;
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: restricted
          ? "[Result redacted: the module permission required for this tool is no longer active for your account.]"
          : (m.content ?? ""),
      } as ChatMessage);
    }
  }
  return out;
}

// Append extra text to the final user message in the model message list, in
// memory only. Used to inject extracted document text into the current turn
// without persisting it. No-op if the last message is not a user message.
function appendToLastUserMessage(messages: ChatMessage[], extra: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      const current = typeof m.content === "string" ? m.content : "";
      m.content = current ? `${current}\n\n${extra}` : extra;
      return;
    }
  }
}

async function loadHistory(conversationId: number): Promise<AiMessage[]> {
  return db
    .select()
    .from(aiMessagesTable)
    .where(eq(aiMessagesTable.conversationId, conversationId))
    .orderBy(asc(aiMessagesTable.id));
}

interface ToolOutcome {
  kind: "continue" | "pending";
  reply?: string;
  pendingAction?: PendingActionView;
  action?: AgentAction;
}

// Read off a client action a tool returned (navigate/print). Validates the
// shape so an arbitrary tool result can never smuggle an unexpected action.
function extractClientAction(data: unknown): AgentAction | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const action = (data as { action?: unknown }).action;
  if (typeof action !== "object" || action === null) return undefined;
  const { type, path } = action as { type?: unknown; path?: unknown };
  if (
    (type !== "navigate" &&
      type !== "print" &&
      type !== "open_import" &&
      type !== "pdf" &&
      type !== "email_report") ||
    typeof path !== "string"
  ) {
    return undefined;
  }
  return { type, path };
}

// Execute (read) or stage (write) a single tool call. Read results are appended
// to both the DB thread and the in-memory model messages. Write tools create a
// pending action and leave the tool call dangling until the user confirms.
async function handleToolCall(
  tc: AiToolCall,
  ctx: AiToolContext,
  conversationId: number,
  modelMessages: ChatMessage[],
  attachmentManifest: string[],
): Promise<ToolOutcome> {
  const append = async (payload: unknown): Promise<void> => {
    const content = await insertToolResult(
      conversationId,
      tc.id,
      tc.function.name,
      payload,
    );
    modelMessages.push({
      role: "tool",
      tool_call_id: tc.id,
      content,
    } as ChatMessage);
  };

  const tool = TOOLS[tc.function.name];
  if (!tool) {
    await append({ error: `Unknown tool: ${tc.function.name}` });
    return { kind: "continue" };
  }
  if (!canUseTool(tool, ctx)) {
    await append({
      error: `Permission denied: you lack the "${tool.requiredPermission}" module.`,
    });
    return { kind: "continue" };
  }

  let rawArgs: unknown;
  try {
    rawArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
  } catch {
    await append({ error: "Arguments were not valid JSON." });
    return { kind: "continue" };
  }
  const parsed = tool.argsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    await append({ error: "Invalid arguments.", details: parsed.error.issues });
    return { kind: "continue" };
  }

  // Read and memory tools run immediately; only write tools stage a pending
  // action for the user to confirm.
  if (tool.kind !== "write") {
    try {
      const data = await tool.execute(parsed.data, ctx);
      await append(data);
      const action = extractClientAction(data);
      return action ? { kind: "continue", action } : { kind: "continue" };
    } catch {
      await append({ error: "The tool failed to run." });
    }
    return { kind: "continue" };
  }

  // Write tool: stage a pending action for confirmation. Do not append a tool
  // result; the call stays dangling until the user approves or rejects.
  //
  // For photo-attaching tools, resolve the model-supplied photoRefs (1-based
  // attachment numbers) into the real, ownership-verified object paths before
  // staging. resolvePhotoRefs also strips any photoUrls the model tried to
  // supply directly, so a model can never smuggle an arbitrary storage path.
  let stagedArgs = parsed.data as Record<string, unknown>;
  if (tool.attachesPhotos) {
    const resolved = resolvePhotoRefs(stagedArgs, attachmentManifest);
    if (!resolved.ok) {
      await append({ error: resolved.error });
      return { kind: "continue" };
    }
    stagedArgs = resolved.args;
  }
  const summary = tool.summarize
    ? await tool.summarize(stagedArgs, ctx)
    : `${tool.name}`;
  // The model lists the other top candidates here when it resolved the action
  // from an ambiguous lookup. They drive the clarify read-back if the user
  // rejects the best guess; they are read off the raw args (not stagedArgs),
  // because they are deliberately absent from each tool's argsSchema so execute()
  // never receives them.
  const alternatives = extractAlternatives(rawArgs);
  const [pending] = await db
    .insert(aiPendingActionsTable)
    .values({
      conversationId,
      toolName: tool.name,
      argsJson: stagedArgs,
      summary,
      toolCallId: tc.id,
      status: "pending",
    })
    .returning();
  return {
    kind: "pending",
    reply: `Just to confirm — you want me to ${summary}?`,
    pendingAction: {
      id: pending.id,
      toolName: tool.name,
      summary,
      ...(alternatives.length > 0 ? { alternatives } : {}),
    },
  };
}

// Drive the model/tool loop from the current model message list until it returns
// a final reply or stages a write action that needs confirmation.
async function runLoop(
  conversationId: number,
  ctx: AiToolContext,
  modelMessages: ChatMessage[],
  attachmentManifest: string[] = [],
): Promise<AgentTurnResult> {
  const tools = getToolSpecs(ctx);
  let openai: Awaited<ReturnType<typeof getOpenAiClient>>;
  try {
    openai = await getOpenAiClient();
  } catch {
    throw new AgentError(502, "The AI provider failed to respond.");
  }

  // The latest client action requested by a read tool this turn (navigate or
  // print). Carried across loop iterations and attached to the final reply so
  // the frontend performs it once Timothy has spoken.
  let clientAction: AgentAction | undefined;

  for (let iteration = 0; iteration < LOOP_CAP; iteration++) {
    let completion;
    try {
      completion = await openai.chat.completions.create(
        {
          model: MODEL,
          max_completion_tokens: 4096,
          messages: modelMessages,
          tools,
          tool_choice: "auto",
          parallel_tool_calls: false,
        },
        REQUEST_OPTIONS,
      );
    } catch {
      throw new AgentError(502, "The AI provider failed to respond.");
    }

    const msg = completion.choices[0]?.message;
    if (!msg) throw new AgentError(502, "The AI provider returned no message.");

    const toolCalls = collectFunctionToolCalls(msg);

    if (toolCalls.length === 0) {
      const reply = msg.content?.trim() || "Okay.";
      await insertAssistantText(conversationId, reply);
      await touchConversation(conversationId);
      return {
        conversationId,
        status: "final",
        reply,
        ...(clientAction ? { action: clientAction } : {}),
      };
    }

    await insertAssistantToolCalls(conversationId, msg.content ?? null, toolCalls);
    modelMessages.push({
      role: "assistant",
      content: msg.content,
      tool_calls: msg.tool_calls,
    } as ChatMessage);

    let pending: ToolOutcome | null = null;
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      if (pending) {
        // Only one action is processed per turn; resolve extras so the thread
        // stays valid.
        const content = await insertToolResult(conversationId, tc.id, tc.function.name, {
          skipped: true,
          message: "Only one action is handled at a time.",
        });
        modelMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content,
        } as ChatMessage);
        continue;
      }
      const outcome = await handleToolCall(
        tc,
        ctx,
        conversationId,
        modelMessages,
        attachmentManifest,
      );
      // A read tool (navigate_to_report / print_report) can return a client
      // action; carry the latest one so it rides out on the final reply.
      if (outcome.action) clientAction = outcome.action;
      if (outcome.kind === "pending") pending = outcome;
    }

    if (pending) {
      await touchConversation(conversationId);
      return {
        conversationId,
        status: "awaiting_confirmation",
        reply: pending.reply ?? null,
        pendingAction: pending.pendingAction,
      };
    }
  }

  const stuck =
    "I wasn't able to finish that in a reasonable number of steps. Could you rephrase it or break it into smaller parts?";
  await insertAssistantText(conversationId, stuck);
  await touchConversation(conversationId);
  return { conversationId, status: "final", reply: stuck };
}

async function vehicleContextLine(
  vehicleId: number | null | undefined,
  ctx: AiToolContext,
): Promise<string | null> {
  if (vehicleId === null || vehicleId === undefined) return null;
  const tool = TOOLS["get_vehicle"];
  // Resolve under the caller's own permissions so a user who cannot see
  // vehicles never leaks a vehicle label into the system prompt.
  if (!tool || !canUseTool(tool, ctx)) return null;
  try {
    const result = (await tool.execute({ id: vehicleId }, ctx)) as
      | { vehicle?: { year?: number | null; make?: string | null; model?: string | null } }
      | undefined;
    const v = result?.vehicle;
    if (!v) return null;
    const label = [v.year, v.make, v.model].filter(Boolean).join(" ");
    return label ? `the user is working on a ${label}` : null;
  } catch {
    // Degrade to no vehicle context rather than failing the whole turn.
    return null;
  }
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const conversationId = await loadOrCreateConversation(
    input.conversationId,
    input.userId,
    input.message,
  );
  await cancelDanglingPending(conversationId);
  await insertUserMessage(conversationId, input.message);

  const ctx: AiToolContext = {
    userId: input.userId,
    isAdmin: input.isAdmin,
    permissions: input.permissions,
  };

  const vehicleContext = await vehicleContextLine(input.vehicleId, ctx);
  const memoryBlock = await loadMemoryBlock(input.userId, ctx);
  const attachmentManifest = await buildAttachmentManifest(
    input.attachments,
    ctx,
  );
  const documentContext = await buildDocumentContext(
    input.documentAttachments,
    ctx,
  );
  const assistantName = await loadAssistantName();
  const systemPrompt = buildSystemPrompt(
    vehicleContext,
    memoryBlock,
    attachmentNoteFor(attachmentManifest.length),
    assistantName,
    documentContext.systemNote,
  );
  const history = await loadHistory(conversationId);
  const modelMessages = rebuildModelMessages(history, systemPrompt, ctx);

  // Inject the extracted document text into this turn only — append it to the
  // last user message in-memory. The persisted transcript (loadHistory above)
  // keeps only the typed text, so the document content is never saved.
  if (documentContext.userBlock) {
    appendToLastUserMessage(modelMessages, documentContext.userBlock);
  }

  return runLoop(conversationId, ctx, modelMessages, attachmentManifest);
}

export interface ConfirmInput {
  conversationId: number;
  userId: number;
  isAdmin: boolean;
  permissions: readonly PermissionKey[];
  pendingActionId: number;
  decision: "approve" | "reject";
}

export async function resolvePendingAction(
  input: ConfirmInput,
): Promise<AgentTurnResult> {
  const [conv] = await db
    .select()
    .from(aiConversationsTable)
    .where(eq(aiConversationsTable.id, input.conversationId));
  if (!conv || conv.userId !== input.userId) {
    throw new AgentError(404, "Conversation not found");
  }

  const nextStatus = input.decision === "approve" ? "approved" : "rejected";
  // Atomically claim the pending action so it can never be executed twice.
  const [claimed] = await db
    .update(aiPendingActionsTable)
    .set({ status: nextStatus, resolvedAt: new Date().toISOString() })
    .where(
      and(
        eq(aiPendingActionsTable.id, input.pendingActionId),
        eq(aiPendingActionsTable.conversationId, input.conversationId),
        eq(aiPendingActionsTable.status, "pending"),
      ),
    )
    .returning();
  if (!claimed) {
    throw new AgentError(409, "That action has already been resolved.");
  }

  const ctx: AiToolContext = {
    userId: input.userId,
    isAdmin: input.isAdmin,
    permissions: input.permissions,
  };

  if (input.decision === "reject") {
    await insertToolResult(input.conversationId, claimed.toolCallId, claimed.toolName, {
      rejected: true,
      message: "The user declined this action; it was not performed.",
    });
  } else {
    const tool = TOOLS[claimed.toolName];
    if (!tool) {
      await markFailed(claimed.id);
      await insertToolResult(input.conversationId, claimed.toolCallId, claimed.toolName, {
        error: "This action is no longer available.",
      });
    } else if (!canUseTool(tool, ctx)) {
      await markFailed(claimed.id);
      await insertToolResult(input.conversationId, claimed.toolCallId, claimed.toolName, {
        error: `Permission denied: you lack the "${tool.requiredPermission}" module.`,
      });
    } else {
      const parsed = tool.argsSchema.safeParse(claimed.argsJson);
      if (!parsed.success) {
        await markFailed(claimed.id);
        await insertToolResult(input.conversationId, claimed.toolCallId, claimed.toolName, {
          error: "The saved action arguments were no longer valid.",
        });
      } else {
        try {
          const result = await tool.execute(parsed.data, ctx);
          await db
            .update(aiPendingActionsTable)
            .set({ status: "executed", resultJson: result })
            .where(eq(aiPendingActionsTable.id, claimed.id));
          await insertToolResult(
            input.conversationId,
            claimed.toolCallId,
            claimed.toolName,
            result,
          );
        } catch {
          await markFailed(claimed.id);
          await insertToolResult(input.conversationId, claimed.toolCallId, claimed.toolName, {
            error: "The action failed while running.",
          });
        }
      }
    }
  }

  const memoryBlock = await loadMemoryBlock(input.userId, ctx);
  const assistantName = await loadAssistantName();
  const systemPrompt = buildSystemPrompt(null, memoryBlock, null, assistantName);
  const history = await loadHistory(input.conversationId);
  const modelMessages = rebuildModelMessages(history, systemPrompt, ctx);
  return runLoop(input.conversationId, ctx, modelMessages);
}

async function markFailed(id: number): Promise<void> {
  await db
    .update(aiPendingActionsTable)
    .set({ status: "failed" })
    .where(eq(aiPendingActionsTable.id, id));
}
