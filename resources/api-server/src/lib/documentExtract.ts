// Server-side text extraction for documents staff attach to an AI chat message.
//
// The extracted text is injected into a single AI turn (see aiAgent.ts) and is
// never persisted: only the user's typed message is stored in the conversation
// transcript, not the document contents. Extraction is best-effort and fails
// loudly — an unreadable or unsupported file surfaces a typed error the route
// turns into an inline notice rather than silently dropping the attachment.
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

// MIME types the document-attachment flow accepts. Kept deliberately separate
// from SAFE_INLINE_CONTENT_TYPES in objectStorage.ts: these are uploadable and
// extractable, but must still be SERVED as application/octet-stream (never
// inline) so a malicious document can never execute on the app origin.
export const DOCUMENT_CONTENT_TYPES = new Set<string>([
  "application/pdf",
  "text/csv",
  "text/tab-separated-values",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
]);

// Upper bound on how much extracted text is injected into the model turn. Larger
// documents are trimmed to this many characters and flagged truncated so the
// route can append a notice to the model context.
export const DOCUMENT_TEXT_CHAR_LIMIT = 40000;

export function isExtractableDocumentType(contentType: string): boolean {
  return DOCUMENT_CONTENT_TYPES.has(contentType.split(";")[0].trim().toLowerCase());
}

// Thrown when a document cannot be read (unsupported type or parse failure).
// The AI route catches this and renders an inline per-file error to the user.
export class DocumentExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentExtractError";
  }
}

export interface ExtractedDocument {
  text: string;
  truncated: boolean;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? "";
}

function extractXlsx(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const parts: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (csv.trim()) {
      parts.push(`# Sheet: ${name}\n${csv}`);
    }
  }
  return parts.join("\n\n");
}

// Extract plain text from a document buffer using the stored content type to
// select the parser. The content type must come from a server-trusted source
// (the stored object metadata), not from client-declared values. Throws
// DocumentExtractError for unsupported types and any parser failure.
export async function extractDocumentText(
  buffer: Buffer,
  contentType: string,
): Promise<ExtractedDocument> {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (!DOCUMENT_CONTENT_TYPES.has(type)) {
    throw new DocumentExtractError("This file type can't be read.");
  }

  let raw: string;
  try {
    if (type === "application/pdf") {
      raw = await extractPdf(buffer);
    } else if (
      type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      raw = await extractDocx(buffer);
    } else if (
      type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      raw = extractXlsx(buffer);
    } else {
      // text/csv, text/tab-separated-values, text/plain
      raw = buffer.toString("utf8");
    }
  } catch {
    throw new DocumentExtractError("This file couldn't be read.");
  }

  const text = raw.replace(/\u0000/g, "").trim();
  if (!text) {
    throw new DocumentExtractError("No readable text was found in this file.");
  }

  if (text.length > DOCUMENT_TEXT_CHAR_LIMIT) {
    return { text: text.slice(0, DOCUMENT_TEXT_CHAR_LIMIT), truncated: true };
  }
  return { text, truncated: false };
}
