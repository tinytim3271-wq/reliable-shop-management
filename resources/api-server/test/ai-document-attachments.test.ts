import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "stream";

// Timothy (the AI agent) can read documents the staff member uploaded and
// attached to a chat message. The text is extracted server-side, injected into
// THIS turn only (appended to the user message the model sees), and never
// persisted. This suite proves, end to end through the HTTP route:
//   - an owned, readable document's text reaches the model;
//   - a non-admin cannot read a document they do not own (admins bypass);
//   - an unreadable / unsupported file becomes a per-file inline notice without
//     aborting the turn (and without leaking sibling document content);
//   - an overlong document is trimmed with a notice;
//   - the per-message document cap (3) is enforced at the route.

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
  },
}));

vi.mock("../src/lib/elevenlabs", () => ({
  transcribeAudio: vi.fn(),
  synthesizeSpeech: vi.fn(),
  VoiceError: class VoiceError extends Error {
    readonly status: number;
    constructor(message: string, status = 502) {
      super(message);
      this.name = "VoiceError";
      this.status = status;
    }
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import {
  ObjectStorageService,
  registerConfirmedUpload,
} from "../src/lib/objectStorage";
import {
  agent,
  seedAdmin,
  seedStaffUser,
  type SeededAdmin,
} from "./helpers";

const mockedCreate = vi.mocked(openai.chat.completions.create);

function finalCompletion(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] } as never;
}

function post(path: string, cookie: string) {
  return agent()
    .post(path)
    .set("Cookie", cookie)
    .set("X-Forwarded-Proto", "https");
}

// In-memory backing store for the storage spy: object path -> bytes + content
// type. The agent's document flow only ever reads through getObjectEntityFile
// (for both the size check and the metadata content type) and the returned
// handle's createReadStream, so faking those is enough — no GCS needed.
const fakeObjects = new Map<string, { buffer: Buffer; contentType: string }>();

class FakeNotFound extends Error {
  constructor() {
    super("object not found");
    this.name = "ObjectNotFoundError";
  }
}

function seedObject(
  path: string,
  ownerId: number,
  text: string | Buffer,
  contentType: string,
  fileName: string,
) {
  const buffer = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
  fakeObjects.set(path, { buffer, contentType });
  registerConfirmedUpload(path, ownerId, { fileName, mimeType: contentType });
}

let docStaff: SeededAdmin;
let adminUser: SeededAdmin;

beforeAll(async () => {
  docStaff = await seedStaffUser(["customers"], "doc-staff");
  adminUser = await seedAdmin();
});

beforeEach(() => {
  mockedCreate.mockReset();
  fakeObjects.clear();
  vi.spyOn(
    ObjectStorageService.prototype,
    "getObjectEntityFile",
  ).mockImplementation(async (objectPath: string) => {
    const obj = fakeObjects.get(objectPath);
    if (!obj) throw new FakeNotFound();
    return {
      getMetadata: async () => ({
        size: obj.buffer.length,
        contentType: obj.contentType,
      }),
      createReadStream: () => Readable.from(obj.buffer),
    } as never;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Pull the text of the last user-role message the model received on the Nth
// (default first) create call. The extracted document block is appended to it.
function lastUserMessage(callIndex = 0): string {
  const call = mockedCreate.mock.calls[callIndex]?.[0] as {
    messages: { role: string; content?: unknown }[];
  };
  const userMsgs = call.messages.filter((m) => m.role === "user");
  const last = userMsgs[userMsgs.length - 1];
  return typeof last?.content === "string" ? last.content : "";
}

function systemMessage(callIndex = 0): string {
  const call = mockedCreate.mock.calls[callIndex]?.[0] as {
    messages: { role: string; content?: unknown }[];
  };
  const sys = call.messages.find((m) => m.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
}

describe("AI document attachments — extraction into the turn", () => {
  it("injects an owned, readable document's text into the model turn", async () => {
    const path = `/objects/uploads/doc-${docStaff.id}-${Date.now()}.csv`;
    seedObject(
      path,
      docStaff.id,
      "part,qty\nbrake pad,4\n",
      "text/csv",
      "inventory.csv",
    );

    mockedCreate.mockResolvedValueOnce(finalCompletion("Read your file."));

    const res = await post("/api/ai/agent/message", docStaff.cookie).send({
      message: "What is in this file?",
      documentAttachments: [{ objectPath: path, fileName: "inventory.csv" }],
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    const userMsg = lastUserMessage();
    expect(userMsg).toContain("What is in this file?");
    expect(userMsg).toContain("Document 1: inventory.csv");
    expect(userMsg).toContain("brake pad,4");
    // The system prompt tells the model a document was attached for this turn.
    expect(systemMessage()).toContain("attached 1 document");
  });

  it("enforces ownership: a non-admin cannot read a document owned by another user", async () => {
    // Registered to a DIFFERENT user and absent from the fake store, so the
    // ownership fallback (getObjectEntityFile) throws -> not available.
    const path = `/objects/uploads/foreign-${Date.now()}.txt`;
    registerConfirmedUpload(path, 99_999, {
      fileName: "secret.txt",
      mimeType: "text/plain",
    });

    mockedCreate.mockResolvedValueOnce(finalCompletion("Couldn't read it."));

    const res = await post("/api/ai/agent/message", docStaff.cookie).send({
      message: "Summarize this.",
      documentAttachments: [{ objectPath: path, fileName: "secret.txt" }],
    });

    expect(res.status).toBe(200);
    const userMsg = lastUserMessage();
    expect(userMsg).toContain("Could not read");
    expect(userMsg).toContain("secret.txt");
    // No document content section was produced.
    expect(userMsg).not.toContain("Document 1:");
    expect(systemMessage()).toContain("could not be read");
  });

  it("lets an admin bypass ownership and read another user's upload", async () => {
    // Owned by a different (non-admin) user but readable, so admin extracts it.
    const path = `/objects/uploads/owned-by-staff-${Date.now()}.txt`;
    seedObject(
      path,
      docStaff.id,
      "Confidential admin-readable note.",
      "text/plain",
      "note.txt",
    );

    mockedCreate.mockResolvedValueOnce(finalCompletion("Got it."));

    const res = await post("/api/ai/agent/message", adminUser.cookie).send({
      message: "Read this note.",
      documentAttachments: [{ objectPath: path, fileName: "note.txt" }],
    });

    expect(res.status).toBe(200);
    const userMsg = lastUserMessage();
    expect(userMsg).toContain("Document 1: note.txt");
    expect(userMsg).toContain("Confidential admin-readable note.");
  });

  it("renders a per-file inline notice for an unreadable file without dropping a good one", async () => {
    const goodPath = `/objects/uploads/good-${Date.now()}.csv`;
    const badPath = `/objects/uploads/bad-${Date.now()}.png`;
    seedObject(goodPath, docStaff.id, "col\nvalue\n", "text/csv", "good.csv");
    // Unsupported content type -> inline "unsupported type" notice.
    seedObject(
      badPath,
      docStaff.id,
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "image/png",
      "photo.png",
    );

    mockedCreate.mockResolvedValueOnce(finalCompletion("One worked."));

    const res = await post("/api/ai/agent/message", docStaff.cookie).send({
      message: "Look at both.",
      documentAttachments: [
        { objectPath: goodPath, fileName: "good.csv" },
        { objectPath: badPath, fileName: "photo.png" },
      ],
    });

    expect(res.status).toBe(200);
    const userMsg = lastUserMessage();
    // The good file was extracted.
    expect(userMsg).toContain("good.csv");
    expect(userMsg).toContain("value");
    // The bad file became an inline notice, not a hard failure.
    expect(userMsg).toContain("Could not read");
    expect(userMsg).toContain("photo.png");
    const sys = systemMessage();
    expect(sys).toContain("attached 1 document");
    expect(sys).toContain("could not be read");
  });

  it("trims an overlong document and notes the truncation", async () => {
    const path = `/objects/uploads/big-${Date.now()}.txt`;
    const head = "BEGINMARK";
    const tail = "ENDMARKERSHOULDBECUT";
    seedObject(
      path,
      docStaff.id,
      head + "A".repeat(40_000) + tail,
      "text/plain",
      "big.txt",
    );

    mockedCreate.mockResolvedValueOnce(finalCompletion("That was long."));

    const res = await post("/api/ai/agent/message", docStaff.cookie).send({
      message: "Read this big file.",
      documentAttachments: [{ objectPath: path, fileName: "big.txt" }],
    });

    expect(res.status).toBe(200);
    const userMsg = lastUserMessage();
    expect(userMsg).toContain("big.txt");
    expect(userMsg).toContain(head);
    expect(userMsg).toContain("trimmed to the first portion");
    // Content past the limit was cut before reaching the model.
    expect(userMsg).not.toContain(tail);
  });

  it("rejects more than 3 document attachments at the route", async () => {
    const docs = Array.from({ length: 4 }, (_, i) => ({
      objectPath: `/objects/uploads/many-${i}-${Date.now()}.txt`,
      fileName: `f${i}.txt`,
    }));

    const res = await post("/api/ai/agent/message", docStaff.cookie).send({
      message: "Read all of these.",
      documentAttachments: docs,
    });

    expect(res.status).toBe(400);
    // The model is never called for a rejected request.
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("processes all three documents when exactly at the limit", async () => {
    const docs = [0, 1, 2].map((i) => {
      const path = `/objects/uploads/trio-${i}-${Date.now()}.txt`;
      seedObject(path, docStaff.id, `Body of file ${i}.`, "text/plain", `f${i}.txt`);
      return { objectPath: path, fileName: `f${i}.txt` };
    });

    mockedCreate.mockResolvedValueOnce(finalCompletion("Read all three."));

    const res = await post("/api/ai/agent/message", docStaff.cookie).send({
      message: "Summarize these three.",
      documentAttachments: docs,
    });

    expect(res.status).toBe(200);
    const userMsg = lastUserMessage();
    expect(userMsg).toContain("Document 1: f0.txt");
    expect(userMsg).toContain("Document 2: f1.txt");
    expect(userMsg).toContain("Document 3: f2.txt");
    expect(userMsg).toContain("Body of file 2.");
    expect(systemMessage()).toContain("attached 3 documents");
  });
});
