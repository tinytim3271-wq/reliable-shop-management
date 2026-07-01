import { Router, type IRouter, type Request } from "express";
import { rateLimit, MemoryStore } from "express-rate-limit";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import {
  db,
  aiConversationsTable,
  aiMemoriesTable,
} from "@workspace/db";
import {
  AiAgentMessageBody,
  AiAgentConfirmBody,
  ListAiConversationsResponse,
  GetAiConversationParams,
  GetAiConversationResponse,
  ListAiMemoriesResponse,
  DeleteAiMemoryParams,
} from "@workspace/api-zod";
import {
  runAgentTurn,
  resolvePendingAction,
  AgentError,
  getFilteredConversationTranscript,
  getFilteredMemoriesForUser,
} from "../lib/aiAgent";
import type { PermissionKey } from "../lib/auth";

const router: IRouter = Router();

// Agent turns call the model (slow, costs provider credits) and run a tool loop,
// so bound them per IP even behind the authenticated boundary.
//
// The store is held in its own reference (rather than relying on the implicit
// default MemoryStore) only so tests can clear all counters between blocks via
// `resetAgentLimiter()` below. Behavior in production is identical to the
// default in-memory store.
const agentLimiterStore = new MemoryStore();
const agentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: agentLimiterStore,
  message: {
    error: "Too many assistant requests. Please wait a moment and try again.",
  },
});

// Test-only hook: clear every per-IP counter so a test block can start from a
// fresh limiter budget without faking the system clock. Production code never
// calls this; resetting an empty in-memory store is otherwise a no-op.
export function resetAgentLimiter(): Promise<void> | void {
  return agentLimiterStore.resetAll();
}

interface ActorContext {
  userId: number;
  isAdmin: boolean;
  permissions: PermissionKey[];
}

function actor(req: Request): ActorContext | null {
  const user = req.currentUser;
  if (!user) return null;
  return {
    userId: user.id,
    isAdmin: user.role === "admin",
    permissions: user.permissions as PermissionKey[],
  };
}

// POST /ai/agent/message — send a user message; runs the tool-calling loop and
// returns either a final reply or a pending write action awaiting confirmation.
router.post("/ai/agent/message", agentLimiter, async (req, res) => {
  const me = actor(req);
  if (!me) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const parsed = AiAgentMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const input = parsed.data;
  try {
    const result = await runAgentTurn({
      conversationId: input.conversationId ?? null,
      userId: me.userId,
      isAdmin: me.isAdmin,
      permissions: me.permissions,
      message: input.message,
      vehicleId: input.vehicleId ?? null,
      attachments: input.attachments ?? null,
      documentAttachments: input.documentAttachments ?? null,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof AgentError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "AI agent message failed");
    res.status(500).json({ error: "The assistant failed to respond." });
  }
});

// POST /ai/agent/confirm — approve or reject a pending write action, then
// continue the loop so the assistant can report the outcome.
router.post("/ai/agent/confirm", agentLimiter, async (req, res) => {
  const me = actor(req);
  if (!me) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const parsed = AiAgentConfirmBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const input = parsed.data;
  try {
    const result = await resolvePendingAction({
      conversationId: input.conversationId,
      userId: me.userId,
      isAdmin: me.isAdmin,
      permissions: me.permissions,
      pendingActionId: input.pendingActionId,
      decision: input.decision,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof AgentError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "AI agent confirm failed");
    res.status(500).json({ error: "The assistant failed to respond." });
  }
});

// GET /ai/conversations — the current user's recent conversations.
router.get("/ai/conversations", async (req, res) => {
  const me = actor(req);
  if (!me) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const rows = await db
    .select({
      id: aiConversationsTable.id,
      title: aiConversationsTable.title,
      createdAt: aiConversationsTable.createdAt,
      updatedAt: aiConversationsTable.updatedAt,
    })
    .from(aiConversationsTable)
    .where(eq(aiConversationsTable.userId, me.userId))
    .orderBy(desc(aiConversationsTable.updatedAt))
    .limit(50);
  res.json(ListAiConversationsResponse.parse(rows));
});

// GET /ai/conversations/:id — a conversation and its readable transcript. Tool
// plumbing (tool results and tool-call-only assistant messages) is omitted.
// Security: assistant replies that follow a restricted tool result are redacted
// using the caller's CURRENT permissions so that post-revocation access to
// sensitive data from prior turns is blocked.
router.get("/ai/conversations/:id", async (req, res) => {
  const me = actor(req);
  if (!me) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const params = GetAiConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const id = params.data.id;
  const [conv] = await db
    .select()
    .from(aiConversationsTable)
    .where(eq(aiConversationsTable.id, id));
  if (!conv || conv.userId !== me.userId) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const ctx = { userId: me.userId, isAdmin: me.isAdmin, permissions: me.permissions };
  const transcript = await getFilteredConversationTranscript(id, ctx);
  res.json(
    GetAiConversationResponse.parse({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      messages: transcript,
    }),
  );
});

// GET /ai/memories — durable things the assistant has been asked to remember for
// the current user, plus any shop-wide notes. Newest first.
// Security: filtered by current permissions so post-revocation data is blocked.
router.get("/ai/memories", async (req, res) => {
  const me = actor(req);
  if (!me) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const ctx = { userId: me.userId, isAdmin: me.isAdmin, permissions: me.permissions };
  const rows = await getFilteredMemoriesForUser(ctx);
  res.json(ListAiMemoriesResponse.parse(rows));
});

// DELETE /ai/memories/:id — forget a remembered item. Users may delete their own
// memories; only admins may delete shop-wide ones. Anything else returns 404 so
// the route does not reveal another user's memory ids.
router.delete("/ai/memories/:id", async (req, res) => {
  const me = actor(req);
  if (!me) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const params = DeleteAiMemoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const id = params.data.id;
  const [mem] = await db
    .select()
    .from(aiMemoriesTable)
    .where(eq(aiMemoriesTable.id, id));
  const ownedByMe = mem && mem.userId === me.userId;
  const shopWideAdmin = mem && mem.userId === null && me.isAdmin;
  if (!mem || (!ownedByMe && !shopWideAdmin)) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  await db.delete(aiMemoriesTable).where(eq(aiMemoriesTable.id, id));
  res.status(204).end();
});

export default router;
