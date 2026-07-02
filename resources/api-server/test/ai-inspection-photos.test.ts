import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Timothy (the AI agent) can attach already-uploaded, ownership-verified photos
// to inspection items. The model only ever references them by 1-based number
// (photoRefs); it never supplies a raw object-storage path. This suite proves
// the happy path works AND that a caller cannot smuggle an arbitrary storage
// path through the AI tools — neither by injecting photoUrls directly nor by
// referencing an attachment the caller does not own.

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
  db,
  inspectionsTable,
  inspectionItemsTable,
  aiPendingActionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { registerConfirmedUpload } from "../src/lib/objectStorage";
import {
  agent,
  seedStaffUser,
  seedCustomerVehicle,
  type SeededAdmin,
} from "./helpers";

const mockedCreate = vi.mocked(openai.chat.completions.create);

function finalCompletion(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] } as never;
}

function toolCallCompletion(name: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  } as never;
}

function post(path: string, cookie: string) {
  return agent()
    .post(path)
    .set("Cookie", cookie)
    .set("X-Forwarded-Proto", "https");
}

// inspections + customers staff: create_inspection links a vehicle, and the
// inspection-item tools need the inspections module.
let inspStaff: SeededAdmin;

async function seedInspection(): Promise<number> {
  const { customerId, vehicleId } = await seedCustomerVehicle();
  const [insp] = await db
    .insert(inspectionsTable)
    .values({
      vehicleId,
      customerId,
      title: "Photo test inspection",
      status: "in_progress",
    })
    .returning({ id: inspectionsTable.id });
  return insp.id;
}

beforeAll(async () => {
  inspStaff = await seedStaffUser(["inspections", "customers"], "insp-photo");
});

beforeEach(() => {
  mockedCreate.mockReset();
});

describe("AI inspection photo attachment — safe id-reference mechanism", () => {
  it("attaches an owned, verified upload referenced by photoRefs", async () => {
    const inspectionId = await seedInspection();
    // The caller owns this upload (confirmed token in the in-memory registry —
    // no GCS needed). This is what the frontend would pass in `attachments`.
    const ownPath = `/objects/uploads/own-${inspStaff.id}-${Date.now()}.jpg`;
    registerConfirmedUpload(ownPath, inspStaff.id);

    // The model only ever sees the photo as number 1.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("add_inspection_item", {
        inspectionId,
        name: "Front brake pads",
        condition: "fail",
        photoRefs: [1],
      }),
    );

    const turn = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Add a failed brake pad item with this photo.",
      attachments: [{ objectPath: ownPath }],
    });
    expect(turn.body.status).toBe("awaiting_confirmation");

    // The staged action already carries the resolved, verified path (not a ref).
    const [staged] = await db
      .select()
      .from(aiPendingActionsTable)
      .where(eq(aiPendingActionsTable.id, turn.body.pendingAction.id));
    expect((staged.argsJson as { photoUrls?: string[] }).photoUrls).toEqual([
      ownPath,
    ]);

    mockedCreate.mockResolvedValueOnce(finalCompletion("Added the item."));
    const confirmed = await post("/api/ai/agent/confirm", inspStaff.cookie).send(
      {
        conversationId: turn.body.conversationId,
        pendingActionId: turn.body.pendingAction.id,
        decision: "approve",
      },
    );
    expect(confirmed.body.status).toBe("final");

    const items = await db
      .select()
      .from(inspectionItemsTable)
      .where(eq(inspectionItemsTable.inspectionId, inspectionId));
    expect(items).toHaveLength(1);
    expect(items[0].photoUrls).toEqual([ownPath]);
  });

  it("drops a raw photoUrls the model supplies directly (no smuggling)", async () => {
    const inspectionId = await seedInspection();
    // A path owned by a DIFFERENT user. The model tries to inject it straight
    // into photoUrls, bypassing photoRefs. It must never be persisted.
    const foreignPath = `/objects/uploads/foreign-99999-${Date.now()}.jpg`;
    registerConfirmedUpload(foreignPath, 99_999);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("add_inspection_item", {
        inspectionId,
        name: "Smuggled item",
        photoUrls: [foreignPath],
      }),
    );

    // No attachments supplied — the model has nothing legitimate to reference.
    const turn = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Add an item.",
    });
    expect(turn.body.status).toBe("awaiting_confirmation");

    // The staged action must NOT carry the smuggled path.
    const [staged] = await db
      .select()
      .from(aiPendingActionsTable)
      .where(eq(aiPendingActionsTable.id, turn.body.pendingAction.id));
    const stagedArgs = staged.argsJson as { photoUrls?: string[] };
    expect(stagedArgs.photoUrls ?? []).not.toContain(foreignPath);
    expect(JSON.stringify(staged.argsJson)).not.toContain(foreignPath);

    mockedCreate.mockResolvedValueOnce(finalCompletion("Added the item."));
    const confirmed = await post("/api/ai/agent/confirm", inspStaff.cookie).send(
      {
        conversationId: turn.body.conversationId,
        pendingActionId: turn.body.pendingAction.id,
        decision: "approve",
      },
    );
    expect(confirmed.body.status).toBe("final");

    const items = await db
      .select()
      .from(inspectionItemsTable)
      .where(eq(inspectionItemsTable.inspectionId, inspectionId));
    expect(items).toHaveLength(1);
    expect(items[0].photoUrls ?? []).not.toContain(foreignPath);
    expect(items[0].photoUrls ?? []).toEqual([]);
  });

  it("rejects a photoRef pointing at a non-owned attachment (not in manifest)", async () => {
    const inspectionId = await seedInspection();
    // The attachment the caller passes is owned by ANOTHER user, so ownership
    // verification fails and it never enters the manifest. A photoRef of 1 is
    // therefore out of range.
    const foreignPath = `/objects/uploads/foreign-88888-${Date.now()}.jpg`;
    registerConfirmedUpload(foreignPath, 88_888);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("add_inspection_item", {
        inspectionId,
        name: "Item with bad ref",
        photoRefs: [1],
      }),
    );
    // After the resolution error is fed back as a tool result, the loop calls
    // the model again; it returns a plain reply.
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I couldn't find that photo."),
    );

    const turn = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Add an item with the attached photo.",
      attachments: [{ objectPath: foreignPath }],
    });

    // No action was staged (bad ref => tool error, not a pending action).
    expect(turn.body.status).toBe("final");
    expect(turn.body.pendingAction).toBeUndefined();

    // No inspection item was created.
    const items = await db
      .select()
      .from(inspectionItemsTable)
      .where(eq(inspectionItemsTable.inspectionId, inspectionId));
    expect(items).toHaveLength(0);

    // The model saw a tool error explaining the ref was invalid.
    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("not one of");
  });
});
