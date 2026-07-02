import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The whole conversational AI surface (agent message/confirm, conversations,
// memories, voice) is intentionally reachable by ANY authenticated staff user,
// regardless of their module permissions. The auth gate is fail-safe
// default-deny, so any AI sub-route that is not explicitly allowlisted silently
// falls through to admin-only. This suite is a regression guard: it seeds a
// permission-scoped non-admin staff user and proves each staff-reachable AI
// route is NOT 403, while the two intentionally module-gated AI routes
// (/ai/labor-estimate, /ai/diagnose) stay gated.

// Mock the OpenAI integration so agent turns never make a real network call and
// the tool/loop output is fully controlled. Mocking the module also sidesteps
// the import-time env checks in the real client.
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
  },
}));

// Mock the ElevenLabs voice helpers so the voice routes never proxy to the
// provider. The route imports these from "../lib/elevenlabs"; vitest matches
// the mock by resolved module path.
vi.mock("../src/lib/elevenlabs", () => ({
  transcribeAudio: vi.fn(),
  synthesizeSpeech: vi.fn(),
  // The /ai/voice/speak route resolves the configured voice id before
  // synthesizing; the mock must export it too or the route throws at call time.
  resolveVoiceId: vi.fn(() => "test-voice-id"),
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
  aiMemoriesTable,
  aiConversationsTable,
  aiPendingActionsTable,
  aiMessagesTable,
  customersTable,
  vehiclesTable,
  workOrdersTable,
  workOrderLineItemsTable,
  appointmentsTable,
  estimatesTable,
  estimateLineItemsTable,
  inspectionsTable,
  inspectionItemsTable,
  inspectionTemplatesTable,
  inspectionTemplateItemsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { transcribeAudio, synthesizeSpeech } from "../src/lib/elevenlabs";
import { TOOLS } from "../src/lib/aiTools";
import {
  agent,
  seedAdmin,
  seedStaffUser,
  seedPart,
  seedCustomerVehicle,
  resetLimiterPerTest,
  type SeededAdmin,
} from "./helpers";

const mockedCreate = vi.mocked(openai.chat.completions.create);
const mockedTranscribe = vi.mocked(transcribeAudio);
const mockedSynthesize = vi.mocked(synthesizeSpeech);

// A chat completion whose assistant message is plain text (no tool calls); the
// agent loop treats this as a final reply.
function finalCompletion(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] } as never;
}

// A chat completion whose assistant message requests a single function tool
// call; the agent loop stages it as a pending action awaiting confirmation.
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
  return agent().post(path).set("Cookie", cookie).set("X-Forwarded-Proto", "https");
}

// A technician scoped to a single, AI-unrelated module. None of the user-scoped
// AI routes (agent message, conversations, memories, voice) require a specific
// module — they must stay reachable for this user.
let staff: SeededAdmin;
// A technician scoped to workOrders, used to drive the create_work_order write
// tool through the agent message -> confirm flow end to end.
let woStaff: SeededAdmin;
// A technician scoped to inspections + customers, used to drive the inspection
// write tools end to end (create_inspection links a vehicle, so it needs
// customers too).
let inspStaff: SeededAdmin;
// A technician scoped to inspections ONLY (no customers), used to prove the
// cross-module customers gate inside create_inspection still fails closed even
// though the caller can reach the tool.
let inspOnlyStaff: SeededAdmin;
// A technician scoped to inspections + customers + settings, used to drive the
// template-seeded inspection flow (seeding a template needs the settings module
// because templates are settings-gated).
let inspTplStaff: SeededAdmin;
// A technician scoped to workOrders + customers, used to drive duplicate_work_order
// end to end (duplicating links a customer record, so it needs customers too).
let woFullStaff: SeededAdmin;
// A technician scoped to estimates + customers, used to drive duplicate_estimate
// end to end (duplicating links a customer record, so it needs customers too).
let estStaff: SeededAdmin;
// A technician scoped to estimates ONLY (no customers): clears the estimates
// requiredPermission gate but must still fail closed on the cross-module
// customers gate inside duplicate_estimate's execute.
let estOnlyStaff: SeededAdmin;

beforeAll(async () => {
  staff = await seedStaffUser(["appointments"]);
  woStaff = await seedStaffUser(["workOrders"], "wo");
  inspStaff = await seedStaffUser(["inspections", "customers"], "insp");
  inspOnlyStaff = await seedStaffUser(["inspections"], "insponly");
  inspTplStaff = await seedStaffUser(
    ["inspections", "customers", "settings"],
    "insptpl",
  );
  woFullStaff = await seedStaffUser(["workOrders", "customers"], "wofull");
  estStaff = await seedStaffUser(["estimates", "customers"], "est");
  estOnlyStaff = await seedStaffUser(["estimates"], "estonly");
});

beforeEach(() => {
  mockedCreate.mockReset();
  mockedTranscribe.mockReset();
  mockedSynthesize.mockReset();
});

describe("AI surface stays reachable by non-admin staff", () => {
  it("POST /ai/agent/message answers a permission-scoped staff user", async () => {
    mockedCreate.mockResolvedValueOnce(finalCompletion("Check the brake pads."));

    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "Where do I start on a grinding brake?",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.reply).toBe("Check the brake pads.");
    expect(typeof res.body.conversationId).toBe("number");
  });

  it("GET /ai/conversations lists the staff user's conversations", async () => {
    const res = await agent()
      .get("/api/ai/conversations")
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /ai/conversations/:id returns the staff user's own transcript", async () => {
    mockedCreate.mockResolvedValueOnce(finalCompletion("Inspect the rotors next."));
    const created = await post("/api/ai/agent/message", staff.cookie).send({
      message: "What about the rotors?",
    });
    expect(created.status).toBe(200);
    const conversationId = created.body.conversationId as number;

    const res = await agent()
      .get(`/api/ai/conversations/${conversationId}`)
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(conversationId);
    expect(Array.isArray(res.body.messages)).toBe(true);
  });

  it("GET /ai/memories lists durable memories for the staff user", async () => {
    const res = await agent()
      .get("/api/ai/memories")
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("DELETE /ai/memories/:id lets the staff user forget their own memory", async () => {
    const [mem] = await db
      .insert(aiMemoriesTable)
      .values({ userId: staff.id, kind: "fact", content: "Prefers OEM pads." })
      .returning();

    const res = await agent()
      .delete(`/api/ai/memories/${mem.id}`)
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(204);
  });

  it("POST /ai/voice/transcribe accepts audio from a staff user", async () => {
    mockedTranscribe.mockResolvedValueOnce("spongy brake pedal");

    const res = await post("/api/ai/voice/transcribe", staff.cookie)
      .set("Content-Type", "audio/webm")
      .send(Buffer.from([1, 2, 3, 4]));

    expect(res.status).toBe(200);
    expect(res.body.text).toBe("spongy brake pedal");
  });

  it("POST /ai/voice/speak synthesizes audio for a staff user", async () => {
    mockedSynthesize.mockResolvedValueOnce(Buffer.from("fake-mp3-bytes"));

    const res = await post("/api/ai/voice/speak", staff.cookie).send({
      text: "Bleed the brakes and recheck pedal feel.",
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");
  });

  it("POST /ai/agent/confirm resolves a pending action for a staff user", async () => {
    // First turn: the model requests a write tool the woStaff user is allowed to
    // use, which the agent stages as a pending action awaiting confirmation.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("create_work_order", {
        customerId: 1,
        vehicleId: 1,
        title: "Brake inspection",
      }),
    );
    const turn = await post("/api/ai/agent/message", woStaff.cookie).send({
      message: "Open a work order for a brake inspection.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    expect(typeof turn.body.pendingAction?.id).toBe("number");

    // Confirm turn: reject the action (so no real write happens), then the loop
    // runs once more and returns a final reply.
    mockedCreate.mockResolvedValueOnce(finalCompletion("No problem, cancelled."));
    const res = await post("/api/ai/agent/confirm", woStaff.cookie).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "reject",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
  });
});

describe("Module-gated AI routes stay gated for staff lacking the module", () => {
  it("POST /ai/labor-estimate is 403 without the estimates module", async () => {
    const res = await post("/api/ai/labor-estimate", staff.cookie).send({
      jobDescription: "Replace front brake pads",
      vehicleYear: 2018,
      vehicleMake: "Toyota",
      vehicleModel: "Corolla",
    });

    expect(res.status).toBe(403);
    // Blocked at the gate — the provider must never be called.
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("POST /ai/diagnose is 403 without the workOrders module", async () => {
    const res = await post("/api/ai/diagnose", staff.cookie).send({
      symptoms: "Grinding noise when braking",
    });

    expect(res.status).toBe(403);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

// The per-tool permission boundary lives inside the agent itself: `canUseTool`
// fails closed, and both the message path (handleToolCall) and the confirm path
// (resolvePendingAction) enforce it. The AI routes are reachable by any staff
// user, so this is the only thing stopping an appointments-only technician from
// using the assistant to create/update/delete records in a module they lack.
describe("AI agent refuses write tools outside the caller's module access", () => {
  it("does not stage a pending action when the caller lacks the tool's module", async () => {
    // The `staff` user holds only `appointments`; create_work_order requires the
    // `workOrders` module. The model "asks" for it on the first turn.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("create_work_order", {
        customerId: 1,
        vehicleId: 1,
        title: "Brake inspection",
      }),
    );
    // After the agent feeds back the permission-denied tool result, the loop
    // calls the model again; it gives up with a plain final reply.
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Sorry, you don't have access to work orders."),
    );

    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "Open a work order for a brake inspection.",
    });

    expect(res.status).toBe(200);
    // The action must NOT be staged for confirmation — it is refused outright.
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // No pending action row was created for this conversation.
    const conversationId = res.body.conversationId as number;
    const pending = await db
      .select()
      .from(aiPendingActionsTable)
      .where(eq(aiPendingActionsTable.conversationId, conversationId));
    expect(pending).toHaveLength(0);

    // The agent fed a "Permission denied" tool result back to the model rather
    // than executing the tool, so the second model call sees it in its messages.
    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("workOrders");
  });

  it("refuses to execute on confirm/approve when the caller lacks the module", async () => {
    // Simulate a pending action that somehow exists for an appointments-only
    // user against a workOrders write tool (e.g. permission revoked after it was
    // staged). Approving it must still fail closed.
    const [conv] = await db
      .insert(aiConversationsTable)
      .values({ userId: staff.id, title: "Stale pending action" })
      .returning();
    const [pending] = await db
      .insert(aiPendingActionsTable)
      .values({
        conversationId: conv.id,
        toolName: "create_work_order",
        argsJson: { customerId: 1, vehicleId: 1, title: "Brake inspection" },
        summary: "create a work order titled Brake inspection",
        toolCallId: "call_stale_1",
        status: "pending",
      })
      .returning();

    // After the confirm path records the refusal, the loop runs once more and
    // returns a final reply.
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("That action could not be completed."),
    );

    const res = await post("/api/ai/agent/confirm", staff.cookie).send({
      conversationId: conv.id,
      pendingActionId: pending.id,
      decision: "approve",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    // The action was refused, not executed: status is "failed" and no result.
    const [after] = await db
      .select()
      .from(aiPendingActionsTable)
      .where(eq(aiPendingActionsTable.id, pending.id));
    expect(after.status).toBe("failed");
    expect(after.resultJson).toBeNull();

    // The refusal was persisted as a permission-denied tool result tied to the
    // staged tool call.
    const [toolMsg] = await db
      .select()
      .from(aiMessagesTable)
      .where(
        and(
          eq(aiMessagesTable.conversationId, conv.id),
          eq(aiMessagesTable.toolCallId, "call_stale_1"),
        ),
      );
    expect(toolMsg?.content).toContain("Permission denied");
    expect(toolMsg?.content).toContain("workOrders");
  });
});

// Read tools run immediately (no confirmation step), so the same fail-closed
// `canUseTool` check in handleToolCall is the only thing standing between a
// hallucinated tool name and a PII/inventory leak. getToolSpecs normally hides
// tools the user can't use, but if the model invents one the caller lacks, the
// agent must deny it instead of executing the read and feeding the rows back.
describe("AI agent refuses read tools outside the caller's module access", () => {
  it("denies get_customer and never leaks the row to the model", async () => {
    // Seed a customer with distinctive PII so we can prove none of it ever
    // reaches the model in the tool result.
    const [customer] = await db
      .insert(customersTable)
      .values({
        name: "Zaphod Beeblebrox",
        phone: "555-0142-secret",
        email: "zaphod@heart-of-gold.test",
      })
      .returning();

    // First turn: the `staff` user holds only `appointments`; get_customer
    // requires the `customers` module. The model "hallucinates" the tool.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("get_customer", { id: customer.id }),
    );
    // After the permission-denied tool result is fed back, the loop calls the
    // model again; it gives up with a plain final reply.
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Sorry, you don't have access to customer records."),
    );

    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "Pull up the details for customer 1.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The agent fed a "Permission denied" tool result back to the model rather
    // than executing the read, so the second model call sees it in its messages.
    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("customers");

    // Crucially, no customer row data leaked into ANY message sent to the model.
    const serialized = JSON.stringify(secondCall.messages);
    expect(serialized).not.toContain("Zaphod Beeblebrox");
    expect(serialized).not.toContain("555-0142-secret");
    expect(serialized).not.toContain("zaphod@heart-of-gold.test");

    // The denial is also persisted as a permission-denied tool message rather
    // than a row of customer data.
    const conversationId = res.body.conversationId as number;
    const toolMsgs = await db
      .select()
      .from(aiMessagesTable)
      .where(
        and(
          eq(aiMessagesTable.conversationId, conversationId),
          eq(aiMessagesTable.role, "tool"),
        ),
      );
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toContain("Permission denied");
    expect(toolMsgs[0].content).not.toContain("Zaphod Beeblebrox");
  });

  it("denies find_customers for a caller lacking the customers module", async () => {
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("find_customers", { search: "Beeblebrox" }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't look up customers for you."),
    );

    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "Find the customer named Beeblebrox.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("customers");
    expect(JSON.stringify(secondCall.messages)).not.toContain("Zaphod Beeblebrox");
  });
});

// Inventory reads (`find_parts`, `get_part`) sit behind the same fail-closed
// `canUseTool` check as the customer reads, gated on the `inventory` module. The
// `staff` user holds only `appointments`, so a model that invents one of these
// tool names must be denied before any part row (stock levels, cost, pricing) is
// read or fed back to the model.
describe("AI agent refuses inventory read tools outside the caller's module access", () => {
  it("denies get_part and never leaks the part row to the model", async () => {
    // Seed a part with distinctive identifiers so we can prove none of it ever
    // reaches the model in the tool result.
    const part = await seedPart({
      name: "Unobtainium-Brake-Rotor-XYZ",
      quantityOnHand: 42,
      reorderLevel: 5,
      unitPrice: 1337,
    });

    // First turn: get_part requires the `inventory` module the caller lacks; the
    // model "hallucinates" the tool against the seeded part id.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("get_part", { id: part.id }),
    );
    // After the permission-denied tool result is fed back, the loop calls the
    // model again; it gives up with a plain final reply.
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Sorry, you don't have access to inventory."),
    );

    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "Look up part details and stock.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The agent fed a "Permission denied" tool result back to the model rather
    // than executing the read, so the second model call sees it in its messages.
    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("inventory");

    // Crucially, no part row data leaked into ANY message sent to the model.
    const serialized = JSON.stringify(secondCall.messages);
    expect(serialized).not.toContain("Unobtainium-Brake-Rotor-XYZ");
    expect(serialized).not.toContain("1337");

    // The denial is also persisted as a permission-denied tool message rather
    // than a row of part data.
    const conversationId = res.body.conversationId as number;
    const toolMsgs = await db
      .select()
      .from(aiMessagesTable)
      .where(
        and(
          eq(aiMessagesTable.conversationId, conversationId),
          eq(aiMessagesTable.role, "tool"),
        ),
      );
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toContain("Permission denied");
    expect(toolMsgs[0].content).not.toContain("Unobtainium-Brake-Rotor-XYZ");
  });

  it("denies find_parts for a caller lacking the inventory module", async () => {
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("find_parts", { search: "Unobtainium" }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't look up parts for you."),
    );

    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "Find parts matching Unobtainium.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("inventory");
    expect(JSON.stringify(secondCall.messages)).not.toContain(
      "Unobtainium-Brake-Rotor-XYZ",
    );
  });
});

// Estimate reads (`find_estimates`, `get_estimate`) sit behind the same
// fail-closed `canUseTool` check, gated on the `estimates` module. The `staff`
// user holds only `appointments`, so a model that invents one of these tool
// names must be denied before any estimate row (status, totals, notes) is read
// or fed back to the model.
describe("AI agent refuses estimate read tools outside the caller's module access", () => {
  it("denies get_estimate and never leaks the estimate row to the model", async () => {
    // Seed a customer/vehicle and an estimate with distinctive notes so we can
    // prove none of it ever reaches the model in the tool result.
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const [estimate] = await db
      .insert(estimatesTable)
      .values({
        customerId,
        vehicleId,
        status: "draft",
        notes: "Flux-Capacitor-Estimate-SECRET",
      })
      .returning();

    // First turn: get_estimate requires the `estimates` module the caller lacks;
    // the model "hallucinates" the tool against the seeded estimate id.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("get_estimate", { id: estimate.id }),
    );
    // After the permission-denied tool result is fed back, the loop calls the
    // model again; it gives up with a plain final reply.
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Sorry, you don't have access to estimates."),
    );

    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "Pull up the estimate details.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The agent fed a "Permission denied" tool result back to the model rather
    // than executing the read, so the second model call sees it in its messages.
    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("estimates");

    // Crucially, no estimate row data leaked into ANY message sent to the model.
    expect(JSON.stringify(secondCall.messages)).not.toContain(
      "Flux-Capacitor-Estimate-SECRET",
    );

    // The denial is also persisted as a permission-denied tool message rather
    // than a row of estimate data.
    const conversationId = res.body.conversationId as number;
    const toolMsgs = await db
      .select()
      .from(aiMessagesTable)
      .where(
        and(
          eq(aiMessagesTable.conversationId, conversationId),
          eq(aiMessagesTable.role, "tool"),
        ),
      );
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toContain("Permission denied");
    expect(toolMsgs[0].content).not.toContain("Flux-Capacitor-Estimate-SECRET");
  });

  it("denies find_estimates for a caller lacking the estimates module", async () => {
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("find_estimates", { status: "draft" }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't look up estimates for you."),
    );

    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "List the draft estimates.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("estimates");
    expect(JSON.stringify(secondCall.messages)).not.toContain(
      "Flux-Capacitor-Estimate-SECRET",
    );
  });
});

// Work order reads (`find_work_orders`, `get_work_order`) sit behind the same
// fail-closed `canUseTool` check, gated on the `workOrders` module. The `staff`
// user holds only `appointments`, so a model that invents one of these tool
// names must be denied before any work order row (title, complaint, notes) is
// read or fed back to the model.
describe("AI agent refuses work order read tools outside the caller's module access", () => {
  it("denies get_work_order and never leaks the work order row to the model", async () => {
    // Seed a customer/vehicle and a work order with a distinctive title so we
    // can prove none of it ever reaches the model in the tool result.
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const [workOrder] = await db
      .insert(workOrdersTable)
      .values({
        customerId,
        vehicleId,
        title: "Teleporter-Realignment-SECRET",
        status: "open",
      })
      .returning();

    // First turn: get_work_order requires the `workOrders` module the caller
    // lacks; the model "hallucinates" the tool against the seeded id.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("get_work_order", { id: workOrder.id }),
    );
    // After the permission-denied tool result is fed back, the loop calls the
    // model again; it gives up with a plain final reply.
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Sorry, you don't have access to work orders."),
    );

    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "Pull up the work order details.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The agent fed a "Permission denied" tool result back to the model rather
    // than executing the read, so the second model call sees it in its messages.
    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("workOrders");

    // Crucially, no work order row data leaked into ANY message sent to the model.
    expect(JSON.stringify(secondCall.messages)).not.toContain(
      "Teleporter-Realignment-SECRET",
    );

    // The denial is also persisted as a permission-denied tool message rather
    // than a row of work order data.
    const conversationId = res.body.conversationId as number;
    const toolMsgs = await db
      .select()
      .from(aiMessagesTable)
      .where(
        and(
          eq(aiMessagesTable.conversationId, conversationId),
          eq(aiMessagesTable.role, "tool"),
        ),
      );
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toContain("Permission denied");
    expect(toolMsgs[0].content).not.toContain("Teleporter-Realignment-SECRET");
  });

  it("denies find_work_orders for a caller lacking the workOrders module", async () => {
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("find_work_orders", { status: "open" }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't look up work orders for you."),
    );

    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "List the open work orders.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("workOrders");
    expect(JSON.stringify(secondCall.messages)).not.toContain(
      "Teleporter-Realignment-SECRET",
    );
  });
});

// Appointment reads (`find_appointments`, `get_appointment`) sit behind the
// same fail-closed `canUseTool` check, gated on the `appointments` module. The
// `staff` user HOLDS `appointments`, so these tests drive the `woStaff` user
// (workOrders only) which LACKS `appointments`; a model that invents one of
// these tool names must be denied before any appointment row (customer name,
// phone, schedule) is read or fed back to the model.
describe("AI agent refuses appointment read tools outside the caller's module access", () => {
  it("denies get_appointment and never leaks the appointment row to the model", async () => {
    // Seed an appointment with a distinctive customer name/phone so we can prove
    // none of it ever reaches the model in the tool result.
    const [appointment] = await db
      .insert(appointmentsTable)
      .values({
        customerName: "Ford-Prefect-SECRET",
        phone: "555-0199-secret",
        serviceType: "Improbability tune-up",
        scheduledAt: "2099-09-01T09:00:00.000Z",
      })
      .returning();

    // First turn: get_appointment requires the `appointments` module the caller
    // lacks; the model "hallucinates" the tool against the seeded id.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("get_appointment", { id: appointment.id }),
    );
    // After the permission-denied tool result is fed back, the loop calls the
    // model again; it gives up with a plain final reply.
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Sorry, you don't have access to appointments."),
    );

    const res = await post("/api/ai/agent/message", woStaff.cookie).send({
      message: "Pull up the appointment details.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The agent fed a "Permission denied" tool result back to the model rather
    // than executing the read, so the second model call sees it in its messages.
    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("appointments");

    // Crucially, no appointment row data leaked into ANY message sent to the model.
    const serialized = JSON.stringify(secondCall.messages);
    expect(serialized).not.toContain("Ford-Prefect-SECRET");
    expect(serialized).not.toContain("555-0199-secret");

    // The denial is also persisted as a permission-denied tool message rather
    // than a row of appointment data.
    const conversationId = res.body.conversationId as number;
    const toolMsgs = await db
      .select()
      .from(aiMessagesTable)
      .where(
        and(
          eq(aiMessagesTable.conversationId, conversationId),
          eq(aiMessagesTable.role, "tool"),
        ),
      );
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toContain("Permission denied");
    expect(toolMsgs[0].content).not.toContain("Ford-Prefect-SECRET");
  });

  it("denies find_appointments for a caller lacking the appointments module", async () => {
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("find_appointments", { status: "scheduled" }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't look up appointments for you."),
    );

    const res = await post("/api/ai/agent/message", woStaff.cookie).send({
      message: "List the scheduled appointments.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("appointments");
    expect(JSON.stringify(secondCall.messages)).not.toContain(
      "Ford-Prefect-SECRET",
    );
  });
});

// Timothy can run the full digital-inspection workflow (create an inspection,
// then add checklist items) end to end through the agent message -> confirm
// flow, but only within the same permission boundary as the REST inspection
// routes: the `inspections` module to reach the tools at all, plus `customers`
// because an inspection links a vehicle record.
describe("AI agent drives the inspection write tools for a permitted staff user", () => {
  it("creates an inspection and an item through message -> confirm", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();

    // Turn 1: the model asks to create an inspection; it is staged for
    // confirmation rather than executed immediately.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("create_inspection", {
        vehicleId,
        customerId,
        title: "Pre-purchase inspection",
      }),
    );
    const turn = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Start a pre-purchase inspection on this car.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const pendingId = turn.body.pendingAction?.id as number;
    expect(typeof pendingId).toBe("number");

    // Approve: the tool runs and the loop calls the model once more.
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Inspection started; what should I check first?"),
    );
    const confirmed = await post("/api/ai/agent/confirm", inspStaff.cookie).send(
      {
        conversationId: turn.body.conversationId,
        pendingActionId: pendingId,
        decision: "approve",
      },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    // The inspection row really exists, linked to the seeded vehicle.
    const inspections = await db
      .select()
      .from(inspectionsTable)
      .where(eq(inspectionsTable.vehicleId, vehicleId));
    expect(inspections).toHaveLength(1);
    expect(inspections[0].title).toBe("Pre-purchase inspection");
    expect(inspections[0].status).toBe("in_progress");
    const inspectionId = inspections[0].id;

    // Turn 2: add a checklist item to the new inspection, then approve it.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("add_inspection_item", {
        inspectionId,
        name: "Front brake pads",
        condition: "attention",
        notes: "About 3mm left",
      }),
    );
    const itemTurn = await post(
      "/api/ai/agent/message",
      inspStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      message: "Note the front brake pads need attention, about 3mm left.",
    });
    expect(itemTurn.body.status).toBe("awaiting_confirmation");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Logged that item."));
    const itemConfirmed = await post(
      "/api/ai/agent/confirm",
      inspStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: itemTurn.body.pendingAction.id,
      decision: "approve",
    });
    expect(itemConfirmed.body.status).toBe("final");

    const items = await db
      .select()
      .from(inspectionItemsTable)
      .where(eq(inspectionItemsTable.inspectionId, inspectionId));
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Front brake pads");
    expect(items[0].condition).toBe("attention");
  });

  it("refuses create_inspection for a caller lacking the inspections module", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();

    // The `staff` user holds only `appointments`; create_inspection requires the
    // `inspections` module. canUseTool fails closed before anything is staged.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("create_inspection", {
        vehicleId,
        customerId,
        title: "Sneaky inspection",
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Sorry, you don't have access to inspections."),
    );

    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "Start an inspection on this car.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // No inspection was created and the denial mentions the missing module.
    const inspections = await db
      .select()
      .from(inspectionsTable)
      .where(eq(inspectionsTable.vehicleId, vehicleId));
    expect(inspections).toHaveLength(0);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("inspections");
  });

  it("fails closed on approve when an inspections-only caller lacks customers", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();

    // inspOnlyStaff can REACH create_inspection (has `inspections`), so the
    // action is staged. But the tool links a vehicle record, which requires the
    // `customers` module it lacks, so execution must fail closed on approve.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("create_inspection", {
        vehicleId,
        customerId,
        title: "Blocked inspection",
      }),
    );
    const turn = await post(
      "/api/ai/agent/message",
      inspOnlyStaff.cookie,
    ).send({ message: "Start an inspection on this car." });
    expect(turn.body.status).toBe("awaiting_confirmation");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("That couldn't be completed."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspOnlyStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.body.status).toBe("final");

    // No inspection row was written for this blocked vehicle.
    const inspections = await db
      .select()
      .from(inspectionsTable)
      .where(eq(inspectionsTable.vehicleId, vehicleId));
    expect(inspections).toHaveLength(0);

    // The tool result fed back records the cross-module refusal.
    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("vehicle record");
  });
});

// Timothy can pre-fill a new inspection's checklist from a saved template:
// create_inspection accepts an optional templateId and seeds the inspection's
// items from that template, exactly like POST /inspections. Because templates
// are settings-gated, seeding additionally requires the settings module, so the
// flow fails closed for an inspections+customers caller lacking settings.
describe("AI agent seeds an inspection from a saved checklist template", () => {
  async function seedTemplate(itemNames: string[]) {
    const [template] = await db
      .insert(inspectionTemplatesTable)
      .values({ name: "Pre-delivery checklist", description: "Standard" })
      .returning();
    await db.insert(inspectionTemplateItemsTable).values(
      itemNames.map((name, idx) => ({
        templateId: template.id,
        category: "General",
        name,
        sortOrder: idx,
      })),
    );
    return template.id;
  }

  it("pre-fills the checklist items when a templateId is supplied", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const templateId = await seedTemplate([
      "Check tire tread",
      "Check brake fluid",
      "Check wiper blades",
    ]);

    // Turn 1: the model asks to create an inspection seeded from the template.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("create_inspection", {
        vehicleId,
        customerId,
        templateId,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Start a standard pre-delivery inspection on this car.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    // The confirmation summary discloses the template it will seed from.
    expect(String(turn.body.pendingAction?.summary)).toContain(
      "Pre-delivery checklist",
    );
    const pendingId = turn.body.pendingAction?.id as number;

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Inspection started with the standard checklist."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: pendingId,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    // The inspection exists, links the template, and defaulted its title to the
    // template name (no explicit title was supplied).
    const inspections = await db
      .select()
      .from(inspectionsTable)
      .where(eq(inspectionsTable.vehicleId, vehicleId));
    expect(inspections).toHaveLength(1);
    expect(inspections[0].templateId).toBe(templateId);
    expect(inspections[0].title).toBe("Pre-delivery checklist");

    // Its checklist items were seeded from the template, in order.
    const items = await db
      .select()
      .from(inspectionItemsTable)
      .where(eq(inspectionItemsTable.inspectionId, inspections[0].id))
      .orderBy(inspectionItemsTable.sortOrder, inspectionItemsTable.id);
    expect(items.map((i) => i.name)).toEqual([
      "Check tire tread",
      "Check brake fluid",
      "Check wiper blades",
    ]);
    expect(items.every((i) => i.condition === "pass")).toBe(true);
  });

  it("fails closed on approve when the caller lacks the settings module", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const templateId = await seedTemplate(["Check tire tread"]);

    // inspStaff holds inspections + customers but NOT settings, so it can reach
    // and stage create_inspection, but seeding a template must fail closed on
    // approve and write neither the inspection nor any items.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("create_inspection", {
        vehicleId,
        customerId,
        templateId,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Start a pre-delivery inspection from the template.",
    });
    expect(turn.body.status).toBe("awaiting_confirmation");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("That couldn't be completed."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.body.status).toBe("final");

    // No inspection row was written for this blocked vehicle.
    const inspections = await db
      .select()
      .from(inspectionsTable)
      .where(eq(inspectionsTable.vehicleId, vehicleId));
    expect(inspections).toHaveLength(0);

    // The tool result fed back records the template permission refusal.
    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("inspection templates");
  });

  it("find_inspection_templates is denied for a caller lacking the settings module", async () => {
    // inspStaff lacks settings; find_inspection_templates is settings-gated, so
    // canUseTool must fail closed before any template row is read.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("find_inspection_templates", { search: "delivery" }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't look up inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "What inspection templates do we have?",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });
});

// Timothy can build the template library by voice: create_inspection_template
// persists a template + its checklist items, either from an explicit list or
// captured from a finished inspection (the reverse of seeding). Because
// templates are settings-gated, the tool fails closed for a caller lacking the
// settings module, exactly like the seeding path.
describe("AI agent saves inspection checklist templates", () => {
  // This file shares one in-memory agent rate-limiter budget (message + confirm
  // count against the same 30-per-window cap) across every test. Reset the
  // limiter before each test so it starts with a fresh budget and can't inherit
  // another block's accumulated hits. (See helpers.ts.)
  resetLimiterPerTest();

  it("creates a template and its items from an explicit list", async () => {
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("create_inspection_template", {
        name: "Standard 21-point",
        description: "Our baseline checklist",
        items: [
          { name: "Check tire tread", category: "Tires" },
          { name: "Check brake fluid", category: "Brakes" },
          { name: "Check wiper blades", category: "Exterior" },
        ],
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Save a standard 21-point inspection template.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    // The confirmation summary discloses the template name and item count.
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Standard 21-point");
    expect(summary).toContain("3 items");
    const pendingId = turn.body.pendingAction?.id as number;

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Saved the Standard 21-point template."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: pendingId,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    // The template row and its items were written, in order.
    const templates = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.name, "Standard 21-point"));
    expect(templates).toHaveLength(1);
    expect(templates[0].description).toBe("Our baseline checklist");

    const items = await db
      .select()
      .from(inspectionTemplateItemsTable)
      .where(eq(inspectionTemplateItemsTable.templateId, templates[0].id))
      .orderBy(
        inspectionTemplateItemsTable.sortOrder,
        inspectionTemplateItemsTable.id,
      );
    expect(items.map((i) => i.name)).toEqual([
      "Check tire tread",
      "Check brake fluid",
      "Check wiper blades",
    ]);
    expect(items.map((i) => i.category)).toEqual([
      "Tires",
      "Brakes",
      "Exterior",
    ]);
  });

  it("captures items from a finished inspection (reverse seeding)", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const [inspection] = await db
      .insert(inspectionsTable)
      .values({
        vehicleId,
        customerId,
        title: "Completed multi-point",
        status: "completed",
      })
      .returning();
    await db.insert(inspectionItemsTable).values([
      {
        inspectionId: inspection.id,
        category: "Brakes",
        name: "Front brake pads",
        condition: "attention",
        sortOrder: 0,
      },
      {
        inspectionId: inspection.id,
        category: "Fluids",
        name: "Coolant level",
        condition: "pass",
        sortOrder: 1,
      },
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("create_inspection_template", {
        name: "From last job",
        fromInspectionId: inspection.id,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Save this inspection's checklist as a template.",
    });
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("From last job");
    expect(summary).toContain("Completed multi-point");
    expect(summary).toContain("2 items");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Saved that checklist as a template."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.body.status).toBe("final");

    const templates = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.name, "From last job"));
    expect(templates).toHaveLength(1);
    const items = await db
      .select()
      .from(inspectionTemplateItemsTable)
      .where(eq(inspectionTemplateItemsTable.templateId, templates[0].id))
      .orderBy(
        inspectionTemplateItemsTable.sortOrder,
        inspectionTemplateItemsTable.id,
      );
    // The condition is intentionally dropped — a template captures the item
    // list (name + category), not the inspection's per-item findings.
    expect(items.map((i) => i.name)).toEqual([
      "Front brake pads",
      "Coolant level",
    ]);
    expect(items.map((i) => i.category)).toEqual(["Brakes", "Fluids"]);
  });

  it("is denied for a caller lacking the settings module", async () => {
    // inspStaff holds inspections + customers but NOT settings; the tool is
    // settings-gated, so canUseTool must fail closed before any row is written.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("create_inspection_template", {
        name: "Sneaky template",
        items: [{ name: "Check tire tread" }],
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't save inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Save a new inspection template.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // No template row was written.
    const templates = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.name, "Sneaky template"));
    expect(templates).toHaveLength(0);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });
});

// Timothy can curate the template library by voice too: update_inspection_template
// renames / re-describes / replaces the checklist, and delete_inspection_template
// removes a template (its items cascade away). Both are settings-gated, so they
// fail closed for a caller lacking the settings module, exactly like creation.
describe("AI agent edits and deletes inspection checklist templates", () => {
  // Reset the shared agent rate-limiter before each test so every test starts
  // with a fresh budget. (See helpers.ts.)
  resetLimiterPerTest();

  // Seed a template with a couple of items and return its id.
  async function seedTemplateRow(name: string, itemNames: string[]) {
    const [tpl] = await db
      .insert(inspectionTemplatesTable)
      .values({ name, description: "Original description" })
      .returning();
    if (itemNames.length) {
      await db.insert(inspectionTemplateItemsTable).values(
        itemNames.map((n, idx) => ({
          templateId: tpl.id,
          name: n,
          category: "General",
          sortOrder: idx,
        })),
      );
    }
    return tpl.id;
  }

  it("renames a template and replaces its checklist items", async () => {
    const templateId = await seedTemplateRow("Old name", [
      "Old item A",
      "Old item B",
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("update_inspection_template", {
        id: templateId,
        name: "New name",
        description: "Updated description",
        items: [
          { name: "Check tire tread", category: "Tires" },
          { name: "Check brake fluid", category: "Brakes" },
          { name: "Check wiper blades", category: "Exterior" },
        ],
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Rename that template and refresh its checklist.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    // The summary discloses the rename, description change, and item count.
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Old name");
    expect(summary).toContain('rename to "New name"');
    expect(summary).toContain("Updated description");
    expect(summary).toContain("replace the checklist with 3 items");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Updated the template."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const [tpl] = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.id, templateId));
    expect(tpl.name).toBe("New name");
    expect(tpl.description).toBe("Updated description");

    const items = await db
      .select()
      .from(inspectionTemplateItemsTable)
      .where(eq(inspectionTemplateItemsTable.templateId, templateId))
      .orderBy(
        inspectionTemplateItemsTable.sortOrder,
        inspectionTemplateItemsTable.id,
      );
    // The old items are gone; the new checklist replaced them in order.
    expect(items.map((i) => i.name)).toEqual([
      "Check tire tread",
      "Check brake fluid",
      "Check wiper blades",
    ]);
  });

  it("update is denied for a caller lacking the settings module", async () => {
    const templateId = await seedTemplateRow("Untouchable", ["Item A"]);
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("update_inspection_template", {
        id: templateId,
        name: "Hacked name",
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't edit inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Rename that template.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The template was not modified.
    const [tpl] = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.id, templateId));
    expect(tpl.name).toBe("Untouchable");

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });

  it("renames a template without touching its checklist via rename_inspection_template", async () => {
    const templateId = await seedTemplateRow("Stale name", [
      "Keep item A",
      "Keep item B",
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("rename_inspection_template", {
        id: templateId,
        name: "Fresh name",
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Just rename that template.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    // The summary names both the old and the new template name.
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Stale name");
    expect(summary).toContain("Fresh name");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Renamed the template."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const [tpl] = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.id, templateId));
    expect(tpl.name).toBe("Fresh name");
    // The description and checklist items are left untouched.
    expect(tpl.description).toBe("Original description");
    const items = await db
      .select()
      .from(inspectionTemplateItemsTable)
      .where(eq(inspectionTemplateItemsTable.templateId, templateId))
      .orderBy(
        inspectionTemplateItemsTable.sortOrder,
        inspectionTemplateItemsTable.id,
      );
    expect(items.map((i) => i.name)).toEqual(["Keep item A", "Keep item B"]);
  });

  it("rename_inspection_template is denied for a caller lacking the settings module", async () => {
    const templateId = await seedTemplateRow("Locked name", ["Item A"]);
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("rename_inspection_template", {
        id: templateId,
        name: "Hacked name",
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't rename inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Rename that template.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The template name was not modified.
    const [tpl] = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.id, templateId));
    expect(tpl.name).toBe("Locked name");

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });

  it("sets a template's description without touching its name or checklist via set_inspection_template_description", async () => {
    const templateId = await seedTemplateRow("Keep name", [
      "Keep item A",
      "Keep item B",
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("set_inspection_template_description", {
        id: templateId,
        description: "Fresh description",
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Just change that template's description.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    // The summary names the template and the new description.
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Keep name");
    expect(summary).toContain("Fresh description");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Updated the description."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const [tpl] = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.id, templateId));
    expect(tpl.description).toBe("Fresh description");
    // The name and checklist items are left untouched.
    expect(tpl.name).toBe("Keep name");
    const items = await db
      .select()
      .from(inspectionTemplateItemsTable)
      .where(eq(inspectionTemplateItemsTable.templateId, templateId))
      .orderBy(
        inspectionTemplateItemsTable.sortOrder,
        inspectionTemplateItemsTable.id,
      );
    expect(items.map((i) => i.name)).toEqual(["Keep item A", "Keep item B"]);
  });

  it("clears a template's description when passed null via set_inspection_template_description", async () => {
    const templateId = await seedTemplateRow("Clearable", ["Item A"]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("set_inspection_template_description", {
        id: templateId,
        description: null,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Clear that template's description.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Clearable");
    expect(summary.toLowerCase()).toContain("clear");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Cleared the description."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const [tpl] = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.id, templateId));
    expect(tpl.description).toBeNull();
  });

  it("set_inspection_template_description is denied for a caller lacking the settings module", async () => {
    const templateId = await seedTemplateRow("Locked desc", ["Item A"]);
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("set_inspection_template_description", {
        id: templateId,
        description: "Hacked description",
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't edit inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Change that template's description.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The template description was not modified.
    const [tpl] = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.id, templateId));
    expect(tpl.description).toBe("Original description");

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });

  it("deletes a template and cascades its items", async () => {
    const templateId = await seedTemplateRow("Disposable", [
      "Item A",
      "Item B",
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("delete_inspection_template", { id: templateId }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Delete that template.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Disposable");
    expect(summary).toContain("2 items");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Deleted the template."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const templates = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.id, templateId));
    expect(templates).toHaveLength(0);
    const items = await db
      .select()
      .from(inspectionTemplateItemsTable)
      .where(eq(inspectionTemplateItemsTable.templateId, templateId));
    expect(items).toHaveLength(0);
  });

  it("delete summary warns when inspections reference the template", async () => {
    const templateId = await seedTemplateRow("Referenced", ["Item A"]);
    const { customerId, vehicleId } = await seedCustomerVehicle();
    await db.insert(inspectionsTable).values({
      vehicleId,
      customerId,
      title: "Seeded from template",
      status: "in_progress",
      templateId,
    });

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("delete_inspection_template", { id: templateId }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Delete the referenced template.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Referenced");
    expect(summary).toContain("lose the template link");
  });

  it("delete is denied for a caller lacking the settings module", async () => {
    const templateId = await seedTemplateRow("Protected", ["Item A"]);
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("delete_inspection_template", { id: templateId }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't delete inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Delete that template.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The template still exists.
    const templates = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.id, templateId));
    expect(templates).toHaveLength(1);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });
});

// Timothy can curate a single checklist line by voice: add_inspection_template_item
// appends one item (at the end or a given position) and delete_inspection_template_item
// removes one by id. Both are settings-gated, so they fail closed for a caller
// lacking the settings module, exactly like the whole-template tools.
describe("AI agent adds and removes single inspection template items", () => {
  // Reset the shared agent rate-limiter before each test so every test starts
  // with a fresh budget. (See helpers.ts.)
  resetLimiterPerTest();

  async function seedTemplateRow(name: string, itemNames: string[]) {
    const [tpl] = await db
      .insert(inspectionTemplatesTable)
      .values({ name, description: "Original description" })
      .returning();
    if (itemNames.length) {
      await db.insert(inspectionTemplateItemsTable).values(
        itemNames.map((n, idx) => ({
          templateId: tpl.id,
          name: n,
          category: "General",
          sortOrder: idx,
        })),
      );
    }
    return tpl.id;
  }

  async function loadItems(templateId: number) {
    return db
      .select()
      .from(inspectionTemplateItemsTable)
      .where(eq(inspectionTemplateItemsTable.templateId, templateId))
      .orderBy(
        inspectionTemplateItemsTable.sortOrder,
        inspectionTemplateItemsTable.id,
      );
  }

  it("appends a single checklist item at the end", async () => {
    const templateId = await seedTemplateRow("Quick check", [
      "Check tire tread",
      "Check brake fluid",
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("add_inspection_template_item", {
        templateId,
        name: "Check wiper blades",
        category: "Exterior",
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Add a wiper blade check to that template.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Check wiper blades");
    expect(summary).toContain("Quick check");
    expect(summary).toContain("at the end");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Added the item."));
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const items = await loadItems(templateId);
    expect(items.map((i) => i.name)).toEqual([
      "Check tire tread",
      "Check brake fluid",
      "Check wiper blades",
    ]);
    // Sort orders stay contiguous after the append.
    expect(items.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
    expect(items[2].category).toBe("Exterior");
  });

  it("inserts a single checklist item at a given position", async () => {
    const templateId = await seedTemplateRow("Ordered check", [
      "First",
      "Third",
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("add_inspection_template_item", {
        templateId,
        name: "Second",
        position: 2,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Slot a step in between.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    expect(String(turn.body.pendingAction?.summary)).toContain("at position 2");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Inserted the item."));
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const items = await loadItems(templateId);
    expect(items.map((i) => i.name)).toEqual(["First", "Second", "Third"]);
    expect(items.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
  });

  it("removes a single checklist item by id", async () => {
    const templateId = await seedTemplateRow("Trim check", [
      "Keep A",
      "Drop B",
      "Keep C",
    ]);
    const seeded = await loadItems(templateId);
    const dropId = seeded.find((i) => i.name === "Drop B")!.id;

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("delete_inspection_template_item", { id: dropId }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Drop that one line.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Drop B");
    expect(summary).toContain("Trim check");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Removed the item."));
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const items = await loadItems(templateId);
    expect(items.map((i) => i.name)).toEqual(["Keep A", "Keep C"]);
  });

  it("moves a single checklist item to a new position", async () => {
    const templateId = await seedTemplateRow("Reorder check", [
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    const seeded = await loadItems(templateId);
    const moveId = seeded.find((i) => i.name === "Charlie")!.id;

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("move_inspection_template_item", {
        id: moveId,
        position: 1,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Move that last step to the top.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Charlie");
    expect(summary).toContain("Reorder check");
    expect(summary).toContain("position 1");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Moved the item."));
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const items = await loadItems(templateId);
    expect(items.map((i) => i.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
    // Sort orders stay contiguous after the move.
    expect(items.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
  });

  it("move is denied for a caller lacking the settings module", async () => {
    const templateId = await seedTemplateRow("Pinned", ["Item A", "Item B"]);
    const seeded = await loadItems(templateId);
    const moveId = seeded.find((i) => i.name === "Item B")!.id;
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("move_inspection_template_item", {
        id: moveId,
        position: 1,
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't edit inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Move that item to the top.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The order is unchanged.
    const items = await loadItems(templateId);
    expect(items.map((i) => i.name)).toEqual(["Item A", "Item B"]);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });

  it("moves a single checklist item to a different template", async () => {
    const sourceId = await seedTemplateRow("Source check", [
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    const destId = await seedTemplateRow("Destination check", [
      "Delta",
      "Echo",
    ]);
    const seeded = await loadItems(sourceId);
    const moveId = seeded.find((i) => i.name === "Bravo")!.id;

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("move_inspection_template_item_to_template", {
        id: moveId,
        templateId: destId,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Move that step over to the destination template.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Bravo");
    expect(summary).toContain("Source check");
    expect(summary).toContain("Destination check");
    expect(summary).toContain("at the end");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Moved the item."));
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    // The item left the source, which stays contiguous.
    const sourceItems = await loadItems(sourceId);
    expect(sourceItems.map((i) => i.name)).toEqual(["Alpha", "Charlie"]);
    expect(sourceItems.map((i) => i.sortOrder)).toEqual([0, 1]);

    // The item lands at the end of the destination, which stays contiguous.
    const destItems = await loadItems(destId);
    expect(destItems.map((i) => i.name)).toEqual(["Delta", "Echo", "Bravo"]);
    expect(destItems.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
  });

  it("moves an item to a 1-based position in the destination template", async () => {
    const sourceId = await seedTemplateRow("From here", ["One", "Two"]);
    const destId = await seedTemplateRow("To here", ["First", "Second"]);
    const seeded = await loadItems(sourceId);
    const moveId = seeded.find((i) => i.name === "Two")!.id;

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("move_inspection_template_item_to_template", {
        id: moveId,
        templateId: destId,
        position: 1,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Move that item to the top of the other template.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("position 1");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Moved the item."));
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const destItems = await loadItems(destId);
    expect(destItems.map((i) => i.name)).toEqual(["Two", "First", "Second"]);
    expect(destItems.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
  });

  it("cross-template move is denied for a caller lacking the settings module", async () => {
    const sourceId = await seedTemplateRow("Guarded source", [
      "Item A",
      "Item B",
    ]);
    const destId = await seedTemplateRow("Guarded dest", ["Item C"]);
    const seeded = await loadItems(sourceId);
    const moveId = seeded.find((i) => i.name === "Item B")!.id;
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("move_inspection_template_item_to_template", {
        id: moveId,
        templateId: destId,
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't edit inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Move that item to the other template.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // Neither template changed.
    const sourceItems = await loadItems(sourceId);
    expect(sourceItems.map((i) => i.name)).toEqual(["Item A", "Item B"]);
    const destItems = await loadItems(destId);
    expect(destItems.map((i) => i.name)).toEqual(["Item C"]);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });

  it("copies a single checklist item into a different template, leaving the source intact", async () => {
    const sourceId = await seedTemplateRow("Brake check", [
      "Check brake pads",
      "Check brake fluid",
      "Check rotors",
    ]);
    const destId = await seedTemplateRow("Safety check", ["Check lights"]);
    const seeded = await loadItems(sourceId);
    const copyItem = seeded.find((i) => i.name === "Check brake fluid")!;

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("copy_inspection_template_item_to_template", {
        id: copyItem.id,
        templateId: destId,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Also put that brake fluid check on the safety template.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Check brake fluid");
    expect(summary).toContain("Brake check");
    expect(summary).toContain("Safety check");
    expect(summary).toContain("at the end");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Copied the item."));
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    // The source template is untouched.
    const sourceItems = await loadItems(sourceId);
    expect(sourceItems.map((i) => i.name)).toEqual([
      "Check brake pads",
      "Check brake fluid",
      "Check rotors",
    ]);
    expect(sourceItems.map((i) => i.sortOrder)).toEqual([0, 1, 2]);

    // The destination grows by the copied item at the end and stays contiguous.
    const destItems = await loadItems(destId);
    expect(destItems.map((i) => i.name)).toEqual([
      "Check lights",
      "Check brake fluid",
    ]);
    expect(destItems.map((i) => i.sortOrder)).toEqual([0, 1]);
    // The copy carries the source category and is a distinct row.
    const copied = destItems.find((i) => i.name === "Check brake fluid")!;
    expect(copied.id).not.toBe(copyItem.id);
    expect(copied.category).toBe("General");
  });

  it("copies an item to a 1-based position in the destination template", async () => {
    const sourceId = await seedTemplateRow("Origin", ["Keep me"]);
    const destId = await seedTemplateRow("Target", ["First", "Second"]);
    const seeded = await loadItems(sourceId);
    const copyId = seeded.find((i) => i.name === "Keep me")!.id;

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("copy_inspection_template_item_to_template", {
        id: copyId,
        templateId: destId,
        position: 1,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Copy that to the top of the target template.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    expect(String(turn.body.pendingAction?.summary)).toContain("position 1");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Copied the item."));
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    // The source still has its single item.
    const sourceItems = await loadItems(sourceId);
    expect(sourceItems.map((i) => i.name)).toEqual(["Keep me"]);

    const destItems = await loadItems(destId);
    expect(destItems.map((i) => i.name)).toEqual(["Keep me", "First", "Second"]);
    expect(destItems.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
  });

  it("cross-template copy is denied for a caller lacking the settings module", async () => {
    const sourceId = await seedTemplateRow("Locked source", [
      "Item A",
      "Item B",
    ]);
    const destId = await seedTemplateRow("Locked dest", ["Item C"]);
    const seeded = await loadItems(sourceId);
    const copyId = seeded.find((i) => i.name === "Item B")!.id;
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("copy_inspection_template_item_to_template", {
        id: copyId,
        templateId: destId,
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't edit inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Copy that item to the other template.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // Neither template changed.
    const sourceItems = await loadItems(sourceId);
    expect(sourceItems.map((i) => i.name)).toEqual(["Item A", "Item B"]);
    const destItems = await loadItems(destId);
    expect(destItems.map((i) => i.name)).toEqual(["Item C"]);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });

  it("duplicates an entire template with all items, leaving the source intact", async () => {
    const sourceId = await seedTemplateRow("Standard Inspection", [
      "Check tire tread",
      "Check brake fluid",
      "Check wiper blades",
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("duplicate_inspection_template", {
        id: sourceId,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Make a copy of the standard inspection template.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Standard Inspection");
    expect(summary).toContain("Standard Inspection (copy)");
    expect(summary).toContain("3 checklist items");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Duplicated the template."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    // The source template and its items are untouched.
    const sourceItems = await loadItems(sourceId);
    expect(sourceItems.map((i) => i.name)).toEqual([
      "Check tire tread",
      "Check brake fluid",
      "Check wiper blades",
    ]);
    expect(sourceItems.map((i) => i.sortOrder)).toEqual([0, 1, 2]);

    // A new template was created, distinct from the source, copying its
    // description and all items with contiguous sort orders.
    const templates = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.name, "Standard Inspection (copy)"));
    expect(templates).toHaveLength(1);
    const copy = templates[0];
    expect(copy.id).not.toBe(sourceId);
    expect(copy.description).toBe("Original description");
    const copyItems = await loadItems(copy.id);
    expect(copyItems.map((i) => i.name)).toEqual([
      "Check tire tread",
      "Check brake fluid",
      "Check wiper blades",
    ]);
    expect(copyItems.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
    expect(copyItems.map((i) => i.category)).toEqual([
      "General",
      "General",
      "General",
    ]);
    // The copied items are distinct rows from the source items.
    const sourceIds = new Set(sourceItems.map((i) => i.id));
    expect(copyItems.every((i) => !sourceIds.has(i.id))).toBe(true);
  });

  it("duplicates a template under a custom name", async () => {
    const sourceId = await seedTemplateRow("Pre-purchase", [
      "Check VIN",
      "Check title",
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("duplicate_inspection_template", {
        id: sourceId,
        newName: "Pre-purchase (Fleet)",
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Duplicate that template as the fleet version.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    expect(String(turn.body.pendingAction?.summary)).toContain(
      "Pre-purchase (Fleet)",
    );

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Duplicated the template."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const templates = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.name, "Pre-purchase (Fleet)"));
    expect(templates).toHaveLength(1);
    const copyItems = await loadItems(templates[0].id);
    expect(copyItems.map((i) => i.name)).toEqual(["Check VIN", "Check title"]);
  });

  it("duplicate is denied for a caller lacking the settings module", async () => {
    const sourceId = await seedTemplateRow("Locked template", [
      "Item A",
      "Item B",
    ]);
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("duplicate_inspection_template", {
        id: sourceId,
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't edit inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Duplicate that template.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // No new template was created.
    const templates = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.name, "Locked template (copy)"));
    expect(templates).toHaveLength(0);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });

  it("add is denied for a caller lacking the settings module", async () => {
    const templateId = await seedTemplateRow("Locked", ["Item A"]);
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("add_inspection_template_item", {
        templateId,
        name: "Sneaky item",
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't edit inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Add an item to that template.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // No item was appended.
    const items = await loadItems(templateId);
    expect(items.map((i) => i.name)).toEqual(["Item A"]);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });

  it("delete is denied for a caller lacking the settings module", async () => {
    const templateId = await seedTemplateRow("Guarded", ["Item A"]);
    const [item] = await loadItems(templateId);
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("delete_inspection_template_item", { id: item.id }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't edit inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Remove that item.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The item still exists.
    const items = await loadItems(templateId);
    expect(items.map((i) => i.name)).toEqual(["Item A"]);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });
});

// Timothy can fix a typo or relabel one checklist line by voice:
// update_inspection_template_item changes name and/or category on one item by id,
// completing the single-item editing set. It is settings-gated, so it fails closed
// for a caller lacking the settings module, exactly like the sibling tools.
describe("AI agent renames a single inspection template item", () => {
  // Reset the shared agent rate-limiter before each test so every test starts
  // with a fresh budget. (See helpers.ts.)
  resetLimiterPerTest();

  async function seedTemplateRow(name: string, itemNames: string[]) {
    const [tpl] = await db
      .insert(inspectionTemplatesTable)
      .values({ name, description: "Original description" })
      .returning();
    if (itemNames.length) {
      await db.insert(inspectionTemplateItemsTable).values(
        itemNames.map((n, idx) => ({
          templateId: tpl.id,
          name: n,
          category: "General",
          sortOrder: idx,
        })),
      );
    }
    return tpl.id;
  }

  async function loadItems(templateId: number) {
    return db
      .select()
      .from(inspectionTemplateItemsTable)
      .where(eq(inspectionTemplateItemsTable.templateId, templateId))
      .orderBy(
        inspectionTemplateItemsTable.sortOrder,
        inspectionTemplateItemsTable.id,
      );
  }

  it("renames a single checklist item by id", async () => {
    const templateId = await seedTemplateRow("Relabel check", [
      "Chekc tire tread",
      "Check brake fluid",
    ]);
    const seeded = await loadItems(templateId);
    const target = seeded.find((i) => i.name === "Chekc tire tread")!;

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("update_inspection_template_item", {
        id: target.id,
        name: "Check tire tread",
        category: "Tires",
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Fix that typo and file it under tires.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Chekc tire tread");
    expect(summary).toContain("Relabel check");
    expect(summary).toContain('rename to "Check tire tread"');
    expect(summary).toContain('set category to "Tires"');

    mockedCreate.mockResolvedValueOnce(finalCompletion("Renamed the item."));
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const items = await loadItems(templateId);
    expect(items.map((i) => i.name)).toEqual([
      "Check tire tread",
      "Check brake fluid",
    ]);
    const renamed = items.find((i) => i.id === target.id)!;
    expect(renamed.category).toBe("Tires");
    // Sort order is untouched by a rename.
    expect(renamed.sortOrder).toBe(target.sortOrder);
  });

  it("rename is denied for a caller lacking the settings module", async () => {
    const templateId = await seedTemplateRow("Guarded rename", ["Item A"]);
    const [item] = await loadItems(templateId);
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("update_inspection_template_item", {
        id: item.id,
        name: "Sneaky rename",
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't edit inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Rename that item.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The item name is unchanged.
    const items = await loadItems(templateId);
    expect(items.map((i) => i.name)).toEqual(["Item A"]);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });

  it("sets a single checklist item's category by id without touching its name via set_inspection_template_item_category", async () => {
    const templateId = await seedTemplateRow("Recategorize check", [
      "Check tire tread",
      "Check brake fluid",
    ]);
    const seeded = await loadItems(templateId);
    const target = seeded.find((i) => i.name === "Check tire tread")!;

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("set_inspection_template_item_category", {
        id: target.id,
        category: "Tires",
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "File the tire tread check under tires.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Check tire tread");
    expect(summary).toContain("Recategorize check");
    expect(summary).toContain('set category');
    expect(summary).toContain('"Tires"');

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Recategorized the item."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const items = await loadItems(templateId);
    const recategorized = items.find((i) => i.id === target.id)!;
    expect(recategorized.category).toBe("Tires");
    // The name is untouched by a category change.
    expect(recategorized.name).toBe("Check tire tread");
    // Sibling item is unaffected.
    const sibling = items.find((i) => i.name === "Check brake fluid")!;
    expect(sibling.category).toBe("General");
  });

  it("clears a single checklist item's category when passed null via set_inspection_template_item_category", async () => {
    const templateId = await seedTemplateRow("Clear category check", [
      "Check tire tread",
    ]);
    const [target] = await loadItems(templateId);
    expect(target.category).toBe("General");

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("set_inspection_template_item_category", {
        id: target.id,
        category: null,
      }),
    );
    const turn = await post("/api/ai/agent/message", inspTplStaff.cookie).send({
      message: "Remove the grouping on that item.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("clear the category");
    expect(summary).toContain("Check tire tread");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Cleared the category."));
    const confirmed = await post(
      "/api/ai/agent/confirm",
      inspTplStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    const [updated] = await loadItems(templateId);
    expect(updated.category).toBeNull();
    expect(updated.name).toBe("Check tire tread");
  });

  it("set_inspection_template_item_category is denied for a caller lacking the settings module", async () => {
    const templateId = await seedTemplateRow("Guarded recategorize", [
      "Item A",
    ]);
    const [item] = await loadItems(templateId);
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("set_inspection_template_item_category", {
        id: item.id,
        category: "Sneaky category",
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't edit inspection templates for you."),
    );

    const res = await post("/api/ai/agent/message", inspStaff.cookie).send({
      message: "Recategorize that item.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // The item category is unchanged.
    const items = await loadItems(templateId);
    expect(items.map((i) => i.category)).toEqual(["General"]);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("settings");
  });
});

// Timothy can clone a whole estimate or work order by voice: duplicate_estimate
// and duplicate_work_order create a brand-new record copying every line item
// (type, qty, unit price) with server-computed totals, optionally re-targeting
// the customer/vehicle, leaving the source untouched. Both are module-gated
// (estimates / workOrders) plus a cross-module customers gate (they link a
// customer record), so a caller lacking the module fails closed.
describe("AI agent duplicates a whole estimate by voice", () => {
  resetLimiterPerTest();

  async function seedEstimateRow(
    shop: { customerId: number; vehicleId: number },
    lines: { type: string; description: string; quantity: number; unitPrice: number }[],
  ): Promise<number> {
    const [est] = await db
      .insert(estimatesTable)
      .values({
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        status: "sent",
        notes: "Original quote notes",
        taxRate: 8.25,
      })
      .returning();
    if (lines.length) {
      await db
        .insert(estimateLineItemsTable)
        .values(lines.map((l) => ({ ...l, estimateId: est.id })));
    }
    return est.id;
  }

  function loadLines(estimateId: number) {
    return db
      .select()
      .from(estimateLineItemsTable)
      .where(eq(estimateLineItemsTable.estimateId, estimateId))
      .orderBy(estimateLineItemsTable.id);
  }

  it("copies every line item into a new draft estimate, leaving the source intact", async () => {
    const shop = await seedCustomerVehicle();
    const sourceId = await seedEstimateRow(shop, [
      { type: "labor", description: "Brake job", quantity: 2, unitPrice: 95 },
      { type: "part", description: "Brake pads", quantity: 1, unitPrice: 60 },
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("duplicate_estimate", { id: sourceId }),
    );
    const turn = await post("/api/ai/agent/message", estStaff.cookie).send({
      message: "Make the same quote as last time.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("EST-");
    expect(summary).toContain("2 line items");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Duplicated the estimate."));
    const confirmed = await post("/api/ai/agent/confirm", estStaff.cookie).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    // The duplicate's total is computed server-side from the copied lines and
    // copied tax rate (250 subtotal + 8.25% tax = 270.63) and surfaced in the
    // tool result fed back to the model.
    const estConfirmCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const estToolResult = estConfirmCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(JSON.parse(String(estToolResult?.content)).total).toBe(270.63);

    // The source is untouched: same status and same line items.
    const [source] = await db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.id, sourceId));
    expect(source.status).toBe("sent");
    const sourceLines = await loadLines(sourceId);
    expect(sourceLines.map((l) => l.description)).toEqual([
      "Brake job",
      "Brake pads",
    ]);

    // A new draft estimate exists with the copied lines and copied tax rate.
    const copies = await db
      .select()
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.customerId, shop.customerId),
          eq(estimatesTable.status, "draft"),
        ),
      );
    expect(copies).toHaveLength(1);
    const copy = copies[0];
    expect(copy.id).not.toBe(sourceId);
    expect(copy.taxRate).toBe(8.25);
    expect(copy.notes).toBe("Original quote notes");
    const copyLines = await loadLines(copy.id);
    expect(
      copyLines.map((l) => ({
        type: l.type,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
      })),
    ).toEqual([
      { type: "labor", description: "Brake job", quantity: 2, unitPrice: 95 },
      { type: "part", description: "Brake pads", quantity: 1, unitPrice: 60 },
    ]);
    // The copied lines are distinct rows from the source lines.
    const sourceIds = new Set(sourceLines.map((l) => l.id));
    expect(copyLines.every((l) => !sourceIds.has(l.id))).toBe(true);
  });

  it("re-targets the copy to a different customer and vehicle", async () => {
    const shop = await seedCustomerVehicle();
    const other = await seedCustomerVehicle();
    const sourceId = await seedEstimateRow(shop, [
      { type: "labor", description: "Oil change", quantity: 1, unitPrice: 40 },
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("duplicate_estimate", {
        id: sourceId,
        customerId: other.customerId,
        vehicleId: other.vehicleId,
      }),
    );
    const turn = await post("/api/ai/agent/message", estStaff.cookie).send({
      message: "Same quote, but for the other customer.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Duplicated the estimate."));
    const confirmed = await post("/api/ai/agent/confirm", estStaff.cookie).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);

    const copies = await db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.customerId, other.customerId));
    expect(copies).toHaveLength(1);
    expect(copies[0].vehicleId).toBe(other.vehicleId);
  });

  it("is denied for a caller lacking the estimates module", async () => {
    const shop = await seedCustomerVehicle();
    const sourceId = await seedEstimateRow(shop, [
      { type: "labor", description: "Locked", quantity: 1, unitPrice: 10 },
    ]);
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("duplicate_estimate", { id: sourceId }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't duplicate estimates for you."),
    );

    // `staff` holds only `appointments`, so it lacks the estimates module.
    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "Duplicate that estimate.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // No copy was created: the source customer still has exactly one estimate.
    const estimates = await db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.customerId, shop.customerId));
    expect(estimates).toHaveLength(1);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("estimates");
  });

  it("fails closed on the cross-module customers gate (estimates but no customers)", async () => {
    const shop = await seedCustomerVehicle();
    const sourceId = await seedEstimateRow(shop, [
      { type: "labor", description: "Cross-module", quantity: 1, unitPrice: 10 },
    ]);

    // `estOnlyStaff` clears the estimates requiredPermission gate, so the tool
    // reaches confirmation, but duplicating links a customer record and the
    // caller lacks the customers module — execute must refuse and create nothing.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("duplicate_estimate", { id: sourceId }),
    );
    const turn = await post("/api/ai/agent/message", estOnlyStaff.cookie).send({
      message: "Duplicate that estimate.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't link a customer for you."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      estOnlyStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);

    // No copy was created: the source customer still has exactly one estimate.
    const estimates = await db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.customerId, shop.customerId));
    expect(estimates).toHaveLength(1);

    const confirmCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = confirmCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("customer record");
  });
});

describe("AI agent duplicates a whole work order by voice", () => {
  resetLimiterPerTest();

  async function seedWorkOrderRow(
    shop: { customerId: number; vehicleId: number },
    lines: { type: string; description: string; quantity: number; unitPrice: number }[],
  ): Promise<number> {
    const [wo] = await db
      .insert(workOrdersTable)
      .values({
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        title: "Recurring service",
        description: "Original description",
        status: "completed",
        complaint: "Noise on braking",
        notes: "Internal notes",
      })
      .returning();
    if (lines.length) {
      await db
        .insert(workOrderLineItemsTable)
        .values(lines.map((l) => ({ ...l, workOrderId: wo.id })));
    }
    return wo.id;
  }

  function loadLines(workOrderId: number) {
    return db
      .select()
      .from(workOrderLineItemsTable)
      .where(eq(workOrderLineItemsTable.workOrderId, workOrderId))
      .orderBy(workOrderLineItemsTable.id);
  }

  it("copies every line item into a new open work order, leaving the source intact", async () => {
    const shop = await seedCustomerVehicle();
    const sourceId = await seedWorkOrderRow(shop, [
      { type: "labor", description: "Diagnostics", quantity: 1, unitPrice: 120 },
      { type: "part", description: "Rotor", quantity: 2, unitPrice: 85 },
    ]);

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("duplicate_work_order", { id: sourceId }),
    );
    const turn = await post("/api/ai/agent/message", woFullStaff.cookie).send({
      message: "Same work order as last time.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    const summary = String(turn.body.pendingAction?.summary);
    expect(summary).toContain("Recurring service");
    expect(summary).toContain("2 line items");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Duplicated the work order."),
    );
    const confirmed = await post(
      "/api/ai/agent/confirm",
      woFullStaff.cookie,
    ).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("final");

    // The duplicate's total is computed server-side from the copied lines
    // (1x120 + 2x85 = 290; work orders carry no tax) and surfaced in the tool
    // result fed back to the model.
    const woConfirmCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const woToolResult = woConfirmCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(JSON.parse(String(woToolResult?.content)).total).toBe(290);

    // The source is untouched: same status and same line items.
    const [source] = await db
      .select()
      .from(workOrdersTable)
      .where(eq(workOrdersTable.id, sourceId));
    expect(source.status).toBe("completed");
    const sourceLines = await loadLines(sourceId);
    expect(sourceLines.map((l) => l.description)).toEqual([
      "Diagnostics",
      "Rotor",
    ]);

    // A new open work order exists with the copied lines and copied fields.
    const copies = await db
      .select()
      .from(workOrdersTable)
      .where(
        and(
          eq(workOrdersTable.customerId, shop.customerId),
          eq(workOrdersTable.status, "open"),
        ),
      );
    expect(copies).toHaveLength(1);
    const copy = copies[0];
    expect(copy.id).not.toBe(sourceId);
    expect(copy.title).toBe("Recurring service");
    expect(copy.complaint).toBe("Noise on braking");
    const copyLines = await loadLines(copy.id);
    expect(
      copyLines.map((l) => ({
        type: l.type,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
      })),
    ).toEqual([
      { type: "labor", description: "Diagnostics", quantity: 1, unitPrice: 120 },
      { type: "part", description: "Rotor", quantity: 2, unitPrice: 85 },
    ]);
    const sourceIds = new Set(sourceLines.map((l) => l.id));
    expect(copyLines.every((l) => !sourceIds.has(l.id))).toBe(true);
  });

  it("is denied for a caller lacking the workOrders module", async () => {
    const shop = await seedCustomerVehicle();
    const sourceId = await seedWorkOrderRow(shop, [
      { type: "labor", description: "Locked", quantity: 1, unitPrice: 10 },
    ]);
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("duplicate_work_order", { id: sourceId }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't duplicate work orders for you."),
    );

    // `staff` holds only `appointments`, so it lacks the workOrders module.
    const res = await post("/api/ai/agent/message", staff.cookie).send({
      message: "Duplicate that work order.",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");
    expect(res.body.pendingAction).toBeUndefined();

    // No copy was created: the source customer still has exactly one work order.
    const workOrders = await db
      .select()
      .from(workOrdersTable)
      .where(eq(workOrdersTable.customerId, shop.customerId));
    expect(workOrders).toHaveLength(1);

    const secondCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = secondCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("Permission denied");
    expect(String(toolResult?.content)).toContain("workOrders");
  });

  it("fails closed on the cross-module customers gate (workOrders but no customers)", async () => {
    const shop = await seedCustomerVehicle();
    const sourceId = await seedWorkOrderRow(shop, [
      { type: "labor", description: "Cross-module", quantity: 1, unitPrice: 10 },
    ]);

    // `woStaff` clears the workOrders requiredPermission gate, so the tool
    // reaches confirmation, but duplicating links a customer record and the
    // caller lacks the customers module — execute must refuse and create nothing.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("duplicate_work_order", { id: sourceId }),
    );
    const turn = await post("/api/ai/agent/message", woStaff.cookie).send({
      message: "Duplicate that work order.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");

    mockedCreate.mockResolvedValueOnce(
      finalCompletion("I can't link a customer for you."),
    );
    const confirmed = await post("/api/ai/agent/confirm", woStaff.cookie).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirmed.status).toBe(200);

    // No copy was created: the source customer still has exactly one work order.
    const workOrders = await db
      .select()
      .from(workOrdersTable)
      .where(eq(workOrdersTable.customerId, shop.customerId));
    expect(workOrders).toHaveLength(1);

    const confirmCall = mockedCreate.mock.calls[1]?.[0] as {
      messages: { role: string; content?: unknown }[];
    };
    const toolResult = confirmCall.messages.find(
      (m) => m.role === "tool" && typeof m.content === "string",
    );
    expect(String(toolResult?.content)).toContain("customer record");
  });
});

// ---------------------------------------------------------------------------
// Full write-tool permission matrix.
//
// The bespoke describe blocks above prove the fail-closed `canUseTool` boundary
// for create_work_order (both paths) and a handful of inspection/template tools
// (message path). This matrix closes the remaining gaps so EVERY module-scoped
// write tool the assistant exposes is exercised against a caller who lacks its
// module — both when the model first requests it (message path -> no pending
// action staged) and if a stale pending action is somehow approved later
// (confirm path -> action left "failed", never executed).
//
// The permission check fires BEFORE argument parsing on both paths
// (handleToolCall and resolvePendingAction), so the placeholder args below only
// need a shape the model could plausibly send; they are never executed.
interface WriteToolCase {
  tool: string;
  module: string;
  args: Record<string, unknown>;
}

// Every module-scoped write tool the assistant exposes, minus create_work_order
// (already covered explicitly on both paths above). `module` is the tool's
// requiredPermission; the caller is always chosen to LACK it.
const REMAINING_WRITE_TOOLS: WriteToolCase[] = [
  { tool: "create_customer", module: "customers", args: { name: "Matrix Customer" } },
  { tool: "update_customer", module: "customers", args: { id: 1, name: "Renamed" } },
  { tool: "delete_customer", module: "customers", args: { id: 1 } },
  { tool: "create_vehicle", module: "customers", args: { customerId: 1, make: "Toyota" } },
  { tool: "update_vehicle", module: "customers", args: { id: 1, make: "Honda" } },
  { tool: "delete_vehicle", module: "customers", args: { id: 1 } },
  { tool: "create_part", module: "inventory", args: { name: "Matrix Pad" } },
  { tool: "update_part", module: "inventory", args: { id: 1, quantityOnHand: 5 } },
  { tool: "delete_part", module: "inventory", args: { id: 1 } },
  { tool: "update_work_order", module: "workOrders", args: { id: 1, title: "Renamed" } },
  { tool: "delete_work_order", module: "workOrders", args: { id: 1 } },
  { tool: "duplicate_work_order", module: "workOrders", args: { id: 1 } },
  { tool: "create_inspection", module: "inspections", args: { vehicleId: 1, title: "Matrix Inspection" } },
  { tool: "update_inspection", module: "inspections", args: { id: 1, title: "Renamed" } },
  { tool: "add_inspection_item", module: "inspections", args: { inspectionId: 1, name: "Brakes" } },
  { tool: "update_inspection_item", module: "inspections", args: { id: 1, status: "fail" } },
  { tool: "create_inspection_template", module: "settings", args: { name: "Matrix Template" } },
  { tool: "update_inspection_template", module: "settings", args: { id: 1, name: "Renamed" } },
  { tool: "rename_inspection_template", module: "settings", args: { id: 1, name: "Renamed" } },
  { tool: "set_inspection_template_description", module: "settings", args: { id: 1, description: "Renamed" } },
  { tool: "delete_inspection_template", module: "settings", args: { id: 1 } },
  { tool: "add_inspection_template_item", module: "settings", args: { templateId: 1, name: "Tires" } },
  { tool: "delete_inspection_template_item", module: "settings", args: { id: 1 } },
  { tool: "update_inspection_template_item", module: "settings", args: { id: 1, name: "Renamed" } },
  { tool: "set_inspection_template_item_category", module: "settings", args: { id: 1, category: "Tires" } },
  { tool: "move_inspection_template_item", module: "settings", args: { id: 1, direction: "up" } },
  { tool: "create_appointment", module: "appointments", args: { title: "Matrix Appt" } },
  { tool: "update_appointment", module: "appointments", args: { id: 1, title: "Renamed" } },
  { tool: "delete_appointment", module: "appointments", args: { id: 1 } },
  { tool: "create_estimate", module: "estimates", args: { customerId: 1, vehicleId: 1 } },
  { tool: "duplicate_estimate", module: "estimates", args: { id: 1 } },
  { tool: "add_estimate_line_item", module: "estimates", args: { estimateId: 1, description: "Labor" } },
  { tool: "update_estimate_line_item", module: "estimates", args: { id: 1, description: "Renamed" } },
  { tool: "remove_estimate_line_item", module: "estimates", args: { id: 1 } },
  { tool: "update_estimate_status", module: "estimates", args: { id: 1, status: "sent" } },
  { tool: "suggest_estimate_line_items", module: "estimates", args: { estimateId: 1 } },
  { tool: "convert_estimate_to_invoice", module: "estimates", args: { id: 1 } },
  { tool: "convert_estimate_to_work_order", module: "estimates", args: { id: 1 } },
  { tool: "draft_message", module: "communications", args: { customerId: 1, channel: "email", body: "Hi" } },
];

// Tools whose message-path denial is already proven by a bespoke test above, so
// the message-path matrix below skips them to avoid pure duplication. (The
// confirm path is NOT covered for these by name, so the confirm matrix still
// includes them.)
const MESSAGE_PATH_ALREADY_COVERED = new Set([
  "create_inspection",
  "create_inspection_template",
  "update_inspection_template",
  "rename_inspection_template",
  "set_inspection_template_description",
  "delete_inspection_template",
  "add_inspection_template_item",
  "delete_inspection_template_item",
  "update_inspection_template_item",
  "set_inspection_template_item_category",
  "move_inspection_template_item",
]);

// `staff` holds only `appointments`, so it lacks every other module. For the
// appointment write tools we need a caller who lacks `appointments`; `woStaff`
// (workOrders only) fits and lacks appointments.
function callerLacking(module: string): SeededAdmin {
  return module === "appointments" ? woStaff : staff;
}

// The whole file shares ONE in-memory agent rate-limiter budget (message +
// confirm both count against the same 30-requests-per-5-minute cap). This matrix
// fires far more than 30 requests, so reset the limiter before each case to give
// it a fresh budget. The reset only clears the limiter store — never any row we
// assert on. (See helpers.ts.)
describe("AI agent write-tool permission matrix (fail-closed for every module)", () => {
  resetLimiterPerTest();

  describe("refuses every remaining write tool on the message path", () => {
  const cases = REMAINING_WRITE_TOOLS.filter(
    (c) => !MESSAGE_PATH_ALREADY_COVERED.has(c.tool),
  );

  it.each(cases)(
    "denies $tool and stages no pending action ($module module)",
    async ({ tool, module, args }) => {
      const caller = callerLacking(module);

      // First turn: the model requests a write tool the caller's module gate
      // forbids. Second turn: after the permission-denied tool result is fed
      // back, the model gives up with a plain final reply.
      mockedCreate.mockResolvedValueOnce(toolCallCompletion(tool, args));
      mockedCreate.mockResolvedValueOnce(
        finalCompletion("Sorry, you don't have access to that."),
      );

      const res = await post("/api/ai/agent/message", caller.cookie).send({
        message: `Please run ${tool}.`,
      });

      expect(res.status).toBe(200);
      // The action must NOT be staged for confirmation — it is refused outright.
      expect(res.body.status).toBe("final");
      expect(res.body.pendingAction).toBeUndefined();

      // No pending action row was created for this conversation.
      const conversationId = res.body.conversationId as number;
      const pending = await db
        .select()
        .from(aiPendingActionsTable)
        .where(eq(aiPendingActionsTable.conversationId, conversationId));
      expect(pending).toHaveLength(0);

      // The agent fed a "Permission denied" tool result naming the module back
      // to the model rather than staging or executing the write.
      const secondCall = mockedCreate.mock.calls[1]?.[0] as {
        messages: { role: string; content?: unknown }[];
      };
      const toolResult = secondCall.messages.find(
        (m) => m.role === "tool" && typeof m.content === "string",
      );
      expect(String(toolResult?.content)).toContain("Permission denied");
      expect(String(toolResult?.content)).toContain(module);
    },
  );
  });

  describe("refuses every remaining write tool on the confirm path", () => {
  it.each(REMAINING_WRITE_TOOLS)(
    "leaves $tool failed with no execution on approve ($module module)",
    async ({ tool, module, args }) => {
      const caller = callerLacking(module);
      const toolCallId = `call_${tool}_confirm`;

      // Simulate a pending action that somehow exists for a caller lacking the
      // tool's module (e.g. permission revoked after it was staged). Approving
      // it must still fail closed.
      const [conv] = await db
        .insert(aiConversationsTable)
        .values({ userId: caller.id, title: `Stale ${tool}` })
        .returning();
      const [pending] = await db
        .insert(aiPendingActionsTable)
        .values({
          conversationId: conv.id,
          toolName: tool,
          argsJson: args,
          summary: `run ${tool}`,
          toolCallId,
          status: "pending",
        })
        .returning();

      // After the confirm path records the refusal, the loop runs once more and
      // returns a final reply.
      mockedCreate.mockResolvedValueOnce(
        finalCompletion("That action could not be completed."),
      );

      const res = await post("/api/ai/agent/confirm", caller.cookie).send({
        conversationId: conv.id,
        pendingActionId: pending.id,
        decision: "approve",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("final");

      // The action was refused, not executed: status is "failed", no result.
      const [after] = await db
        .select()
        .from(aiPendingActionsTable)
        .where(eq(aiPendingActionsTable.id, pending.id));
      expect(after.status).toBe("failed");
      expect(after.resultJson).toBeNull();

      // The refusal was persisted as a permission-denied tool result naming the
      // module, tied to the staged tool call.
      const [toolMsg] = await db
        .select()
        .from(aiMessagesTable)
        .where(
          and(
            eq(aiMessagesTable.conversationId, conv.id),
            eq(aiMessagesTable.toolCallId, toolCallId),
          ),
        );
      expect(toolMsg?.content).toContain("Permission denied");
      expect(toolMsg?.content).toContain(module);
    },
  );
  });
});

// Full read-tool permission matrix.
//
// The bespoke describe blocks above prove the fail-closed `canUseTool` boundary
// for a handful of read tools (customers, inventory, estimates, work orders,
// appointments). But read tools execute IMMEDIATELY -- there is no confirmation
// step -- so the same canUseTool check inside handleToolCall is the only thing
// standing between a hallucinated tool name and a customer-PII / financial-data
// leak. This matrix closes the remaining gaps so EVERY module-scoped read tool
// the assistant exposes is exercised against a caller who LACKS its module: the
// agent must feed back a "Permission denied" tool result naming the module and
// must never read or return the underlying rows.
//
// The permission check fires BEFORE argument parsing and BEFORE execute() runs
// (handleToolCall), so the placeholder args below only need a shape the model
// could plausibly send; tool.execute is never reached.
interface ReadToolCase {
  tool: string;
  module: string;
  args: Record<string, unknown>;
}

// Every module-scoped read tool the assistant exposes. `module` is the tool's
// requiredPermission; the caller is always chosen to LACK it. Module-scoped
// read tools belong here; tools that carry no single module gate (null
// requiredPermission) live in META_READ_TOOLS instead. The exhaustiveness guard
// below proves the two lists together have not drifted from the registry.
const READ_TOOLS: ReadToolCase[] = [
  { tool: "find_customers", module: "customers", args: { search: "Beeblebrox" } },
  { tool: "get_customer", module: "customers", args: { id: 1 } },
  { tool: "find_vehicles", module: "customers", args: { search: "Toyota" } },
  { tool: "get_vehicle", module: "customers", args: { id: 1 } },
  { tool: "find_parts", module: "inventory", args: { search: "Rotor" } },
  { tool: "get_part", module: "inventory", args: { id: 1 } },
  { tool: "find_work_orders", module: "workOrders", args: { status: "open" } },
  { tool: "get_work_order", module: "workOrders", args: { id: 1 } },
  { tool: "find_appointments", module: "appointments", args: { status: "scheduled" } },
  { tool: "get_appointment", module: "appointments", args: { id: 1 } },
  { tool: "find_inspections", module: "inspections", args: { status: "in_progress" } },
  { tool: "get_inspection", module: "inspections", args: { id: 1 } },
  { tool: "find_inspection_templates", module: "settings", args: { search: "Standard" } },
  { tool: "find_estimates", module: "estimates", args: { status: "draft" } },
  { tool: "get_estimate", module: "estimates", args: { id: 1 } },
  { tool: "get_estimate_line_items", module: "estimates", args: { estimateId: 1 } },
  { tool: "list_message_templates", module: "communications", args: {} },
  { tool: "get_payday_report", module: "payroll", args: {} },
  { tool: "get_profit_loss_report", module: "accounting", args: {} },
  { tool: "get_expense_report", module: "accounting", args: {} },
  { tool: "get_tax_report", module: "accounting", args: {} },
  { tool: "get_sales_summary_report", module: "accounting", args: {} },
  { tool: "get_accounts_receivable_report", module: "accounting", args: {} },
  { tool: "get_top_services_report", module: "accounting", args: {} },
  { tool: "get_payments_by_method_report", module: "accounting", args: {} },
  { tool: "get_stock_movements_report", module: "inventory", args: {} },
];

// Meta read tools carry no single module gate (requiredPermission: null): they
// open or print a report and enforce the *target report's* permission inside
// execute (per-report), so they can't be exercised by the module-gate matrix
// above. They are listed here so the exhaustiveness guard stays honest, and a
// dedicated per-report gate test below proves they still fail closed.
const META_READ_TOOLS = [
  // open_import_dialog spans several modules (customers, workOrders, invoices,
  // accounting), so it carries no single requiredPermission and enforces the
  // per-type module check inside execute. Its per-type denial is proven in
  // ai-open-import.test.ts.
  "open_import_dialog",
  "navigate_to_report",
  "print_report",
  "download_report_pdf",
  "email_report_pdf",
];

describe("AI agent read-tool permission matrix (fail-closed for every module)", () => {
  // The whole file shares ONE in-memory agent rate-limiter budget. Resetting it
  // before each case gives every test a fresh budget, so this matrix can't
  // collide with the write-tool matrix that runs before it. The reset only
  // clears the limiter store, not any asserted rows. (See helpers.ts.)
  resetLimiterPerTest();

  // Guard: the matrix must stay exhaustive. If a new module-scoped read tool is
  // added to the registry (or one's requiredPermission changes) without being
  // added here, this fails -- so the leak boundary can never silently regress.
  it("enumerates every module-scoped read tool the registry exposes", () => {
    const registryReadTools = Object.values(TOOLS)
      .filter((t) => t.kind === "read")
      .map((t) => t.name)
      .sort();
    // The module-gate matrix plus the explicitly-listed meta read tools must
    // together account for every read tool in the registry, so a newly added
    // read tool can never silently dodge both this matrix and a null-gate.
    const matrixReadTools = [...READ_TOOLS.map((c) => c.tool), ...META_READ_TOOLS].sort();
    expect(matrixReadTools).toEqual(registryReadTools);

    // Module-scoped read tools must always carry a real module gate (never
    // null), and each case's expected module must match the tool's actual
    // requiredPermission.
    for (const c of READ_TOOLS) {
      const def = TOOLS[c.tool];
      expect(def).toBeDefined();
      expect(def.requiredPermission).not.toBeNull();
      expect(def.requiredPermission).toBe(c.module);
    }

    // Meta read tools carry no single module gate; they gate per-report inside
    // execute instead. Assert the null gate so a future edit that gives one a
    // module gate (or makes a module tool null) is forced through this guard.
    for (const name of META_READ_TOOLS) {
      const def = TOOLS[name];
      expect(def).toBeDefined();
      expect(def.requiredPermission).toBeNull();
    }
  });

  it.each(READ_TOOLS)(
    "denies $tool and never reads or returns the rows ($module module)",
    async ({ tool, module, args }) => {
      const caller = callerLacking(module);

      // First turn: the model "hallucinates" a read tool the caller's module
      // gate forbids. Second turn: after the permission-denied tool result is
      // fed back, the model gives up with a plain final reply.
      mockedCreate.mockResolvedValueOnce(toolCallCompletion(tool, args));
      mockedCreate.mockResolvedValueOnce(
        finalCompletion("Sorry, you don't have access to that."),
      );

      const res = await post("/api/ai/agent/message", caller.cookie).send({
        message: `Please run ${tool}.`,
      });

      expect(res.status).toBe(200);
      // Read tools never stage a pending action; this one was refused outright.
      expect(res.body.status).toBe("final");
      expect(res.body.pendingAction).toBeUndefined();
      const conversationId = res.body.conversationId as number;

      // The agent fed a "Permission denied" tool result naming the module back
      // to the model rather than executing the read.
      const secondCall = mockedCreate.mock.calls[1]?.[0] as {
        messages: { role: string; content?: unknown }[];
      };
      const toolResult = secondCall.messages.find(
        (m) => m.role === "tool" && typeof m.content === "string",
      );
      expect(String(toolResult?.content)).toContain("Permission denied");
      expect(String(toolResult?.content)).toContain(module);

      // The denial is persisted as exactly one tool message, and its content is
      // ONLY the permission-denied error -- proof that execute() never ran and
      // no record fields (the tool would return data keys, not an `error`) were
      // ever read or fed back to the model.
      const toolMsgs = await db
        .select()
        .from(aiMessagesTable)
        .where(
          and(
            eq(aiMessagesTable.conversationId, conversationId),
            eq(aiMessagesTable.role, "tool"),
          ),
        );
      expect(toolMsgs).toHaveLength(1);
      const payload = JSON.parse(toolMsgs[0].content ?? "{}") as Record<
        string,
        unknown
      >;
      expect(Object.keys(payload)).toEqual(["error"]);
      expect(String(payload.error)).toContain("Permission denied");
      expect(String(payload.error)).toContain(module);
    },
  );

  // Meta read tools (navigate_to_report / print_report) carry no single module
  // gate, so handleToolCall lets execute() run; execute must itself refuse a
  // report whose module the caller lacks. `staff` holds only `appointments`, so
  // it lacks `payroll` (the payday report's module). The agent must feed back a
  // "Permission denied" tool result naming the module and emit NO client action.
  it.each([
    { tool: "navigate_to_report", verb: "opening" },
    { tool: "print_report", verb: "printing" },
    { tool: "download_report_pdf", verb: "downloading" },
    { tool: "email_report_pdf", verb: "drafting" },
  ])(
    "denies $tool for a report whose module the caller lacks and emits no action",
    async ({ tool }) => {
      const caller = staff; // holds only `appointments`, lacks `payroll`
      mockedCreate.mockResolvedValueOnce(
        toolCallCompletion(tool, { report: "payday" }),
      );
      mockedCreate.mockResolvedValueOnce(
        finalCompletion("Sorry, you don't have access to that report."),
      );

      const res = await post("/api/ai/agent/message", caller.cookie).send({
        message: `Please run ${tool} for the payday report.`,
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("final");
      expect(res.body.pendingAction).toBeUndefined();
      // No client action may leak past the permission check.
      expect(res.body.action).toBeUndefined();
      const conversationId = res.body.conversationId as number;

      // The denial is fed back to the model as a permission error naming the
      // payroll module rather than a navigate/print action.
      const secondCall = mockedCreate.mock.calls[1]?.[0] as {
        messages: { role: string; content?: unknown }[];
      };
      const toolResult = secondCall.messages.find(
        (m) => m.role === "tool" && typeof m.content === "string",
      );
      expect(String(toolResult?.content)).toContain("Permission denied");
      expect(String(toolResult?.content)).toContain("payroll");

      // Exactly one tool message, and its payload is ONLY the error -- proof the
      // report path / action was never built or returned.
      const toolMsgs = await db
        .select()
        .from(aiMessagesTable)
        .where(
          and(
            eq(aiMessagesTable.conversationId, conversationId),
            eq(aiMessagesTable.role, "tool"),
          ),
        );
      expect(toolMsgs).toHaveLength(1);
      const payload = JSON.parse(toolMsgs[0].content ?? "{}") as Record<
        string,
        unknown
      >;
      expect(Object.keys(payload)).toEqual(["error"]);
      expect(String(payload.error)).toContain("Permission denied");
      expect(String(payload.error)).toContain("payroll");
    },
  );

  // Positive path: a caller WITH access to the target report gets the client
  // action threaded all the way out to res.body.action. Admins clear every
  // report's per-report gate, so navigate/print mint and return the action that
  // the frontend uses to setLocation()/print(). This proves the runLoop carries
  // a read tool's action onto the final reply (regression guard for the
  // action-never-returned bug).
  it.each([
    { tool: "navigate_to_report", type: "navigate", path: "/payday" },
    { tool: "print_report", type: "print", path: "/payday?print=1" },
    { tool: "download_report_pdf", type: "pdf", path: "/payday?pdf=1" },
    { tool: "email_report_pdf", type: "email_report", path: "/payday?emailPdf=1" },
  ])(
    "$tool returns a $type client action for an authorized caller",
    async ({ tool, type, path }) => {
      const admin = await seedAdmin();
      mockedCreate.mockResolvedValueOnce(
        toolCallCompletion(tool, { report: "payday" }),
      );
      mockedCreate.mockResolvedValueOnce(
        finalCompletion("Here is the payday report."),
      );

      const res = await post("/api/ai/agent/message", admin.cookie).send({
        message: `Please run ${tool} for the payday report.`,
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("final");
      // The client action survived the agent loop onto the final reply.
      expect(res.body.action).toEqual({ type, path });
    },
  );

  // End-to-end for the Payments by Method report as an accounting (non-admin)
  // user: the AI navigate action must be returned AND the backend report route
  // the frontend lands on must be reachable for that same permission. This guards
  // the regression where /reports/payments-by-method was missing from
  // ROUTE_PERMISSIONS, so navigation succeeded but the report fetch 403'd.
  it("navigate to payments-by-method works for an accounting user, action + report fetch", async () => {
    const acct = await seedStaffUser(["accounting"], "acct");

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("navigate_to_report", {
        report: "payments-by-method",
      }),
    );
    mockedCreate.mockResolvedValueOnce(
      finalCompletion("Opening the payments by method report."),
    );

    const ai = await post("/api/ai/agent/message", acct.cookie).send({
      message: "Open the payments by method report.",
    });
    expect(ai.status).toBe(200);
    expect(ai.body.status).toBe("final");
    expect(ai.body.action).toEqual({
      type: "navigate",
      path: "/reports?tab=payments",
    });

    // The page the frontend routes to fetches this report; the accounting user
    // must clear ROUTE_PERMISSIONS for it instead of hitting the default-deny.
    const report = await agent()
      .get("/api/reports/payments-by-method")
      .set("Cookie", acct.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(report.status).toBe(200);
  });
});
