import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";

// The agent loop and the labor estimator both call the OpenAI integration. Mock
// the whole module so the suite makes no real network calls and we fully script
// the model's behaviour: which tools it picks, and the structured labor estimate
// the suggest_estimate_line_items tool relies on. Mocking the module also
// sidesteps the import-time env checks in the real client.
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import { db, estimatesTable, estimateLineItemsTable } from "@workspace/db";
import { ESTIMATE_DISCLAIMER } from "../src/lib/aiEstimating";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  seedPart,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

const mockedCreate = vi.mocked(openai.chat.completions.create);

const JOB_DESCRIPTION = "replace front brake pads and rotors";
// Catalog lookups (matchCatalogPart) fuzzy-match by name across the shared run
// database, so use unique part descriptions: this keeps the suggested prices
// deterministic regardless of which other test files seed generic "Brake Pad"
// parts before this one runs. The matching catalog rows are seeded in beforeAll
// at the same prices the scripted estimator returns.
const PART_PADS = uniqueName("Front brake pads");
const PART_ROTORS = uniqueName("Front rotors (pair)");
const PART_PADS_PRICE = 60;
const PART_ROTORS_PRICE = 75;
const CAUTION_ROTOR = "Verify rotor thickness before reuse";
const CAUTION_CALIPER = "Check caliper condition";

let admin: SeededAdmin;
let shop: SeededShop;

// ---- scripted OpenAI completions -------------------------------------------

function toolCallCompletion(id: string, name: string, args: unknown) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  } as never;
}

function finalReplyCompletion(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] } as never;
}

// Controls what the inner labor-estimate (json_schema) call does for the current
// test: return a normal estimate, throw like a failing provider, or return a
// usable response that contains no labor and no parts.
let estimatorBehavior: "ok" | "throw" | "empty" = "ok";

// A structurally valid estimate with zero labor hours and no parts, so the
// suggest tool's rows.length === 0 branch fires and nothing is written.
function emptyLaborEstimateCompletion() {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            summary: "No additional work identified.",
            laborHours: 0,
            parts: [],
            cautions: [],
            confidence: "low",
          }),
        },
      },
    ],
  } as never;
}

// The structured estimate the json_schema labor-estimate call returns.
function laborEstimateCompletion() {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            summary: "Replace front brake pads and rotors.",
            laborHours: 2,
            parts: [
              { description: PART_PADS, quantity: 1, unitPrice: PART_PADS_PRICE },
              { description: PART_ROTORS, quantity: 2, unitPrice: PART_ROTORS_PRICE },
            ],
            cautions: [CAUTION_ROTOR, CAUTION_CALIPER],
            confidence: "medium",
          }),
        },
      },
    ],
  } as never;
}

interface ChatMsg {
  role: string;
  content: string | null;
}

// Pull the estimate id out of a create_estimate tool result already in history.
function findCreatedEstimateId(messages: ChatMsg[]): number | null {
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    try {
      const parsed = JSON.parse(m.content);
      if (parsed?.created?.id && parsed?.created?.number) return parsed.created.id;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

// Find a suggest_estimate_line_items tool result (added[] + disclaimer) so the
// final scripted reply can surface the disclaimer/cautions the way a real model
// would after reading the tool output.
function findSuggestResult(
  messages: ChatMsg[],
): { added: unknown[]; cautions?: string[]; disclaimer: string } | null {
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    try {
      const parsed = JSON.parse(m.content);
      if (Array.isArray(parsed?.added) && typeof parsed?.disclaimer === "string") {
        return parsed;
      }
    } catch {
      /* not JSON */
    }
  }
  return null;
}

// Find an error result returned by the suggest_estimate_line_items tool (e.g.
// the estimator threw) so the scripted model can report the failure plainly
// instead of re-proposing the suggestion forever.
function findSuggestToolError(messages: ChatMsg[]): string | null {
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    try {
      const parsed = JSON.parse(m.content);
      if (typeof parsed?.error === "string") return parsed.error;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

// Detect a declined pending action so the scripted model can wrap up instead of
// re-proposing the same write forever.
function hasRejection(messages: ChatMsg[]): boolean {
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    try {
      const parsed = JSON.parse(m.content);
      if (parsed?.rejected === true) return true;
    } catch {
      /* not JSON */
    }
  }
  return false;
}

function sendMessage(cookie: string, body: Record<string, unknown>) {
  return agent()
    .post("/api/ai/agent/message")
    .set("Cookie", cookie)
    .set("X-Forwarded-Proto", "https")
    .send(body);
}

function confirmAction(cookie: string, body: Record<string, unknown>) {
  return agent()
    .post("/api/ai/agent/confirm")
    .set("Cookie", cookie)
    .set("X-Forwarded-Proto", "https")
    .send(body);
}

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
  // Seed catalog rows that exactly match the scripted estimator's part
  // descriptions, priced identically. An exact-name match is "high" confidence,
  // so it deterministically wins over any fuzzy "Brake Pad" parts seeded by
  // other files and the suggested unit prices stay stable across run orders.
  await seedPart({
    name: PART_PADS,
    quantityOnHand: 100,
    reorderLevel: 1,
    unitPrice: PART_PADS_PRICE,
  });
  await seedPart({
    name: PART_ROTORS,
    quantityOnHand: 100,
    reorderLevel: 1,
    unitPrice: PART_ROTORS_PRICE,
  });
});

beforeEach(() => {
  mockedCreate.mockReset();
  estimatorBehavior = "ok";
  // Drive the whole conversation deterministically off the request shape and
  // the conversation state encoded in the messages, so the same mock serves
  // every model + estimator call in the loop.
  mockedCreate.mockImplementation((params: unknown) => {
    const p = params as {
      response_format?: { type?: string };
      messages?: ChatMsg[];
    };
    // Inner labor-estimate call: no tools, json_schema response format.
    if (p.response_format?.type === "json_schema") {
      if (estimatorBehavior === "throw") {
        throw new Error("Simulated AI estimator provider failure");
      }
      if (estimatorBehavior === "empty") {
        return emptyLaborEstimateCompletion();
      }
      return laborEstimateCompletion();
    }
    const messages = p.messages ?? [];
    // The estimator failed and the tool returned an error -> tell the user we
    // couldn't generate suggestions instead of silently looping.
    const suggestError = findSuggestToolError(messages);
    if (suggestError) {
      return finalReplyCompletion(
        `Sorry, I couldn't generate suggestions for the brake job. ${suggestError}`,
      );
    }
    // Once the suggestions have been added, wrap up with a final spoken reply
    // that surfaces the AI disclaimer + cautions from the tool result.
    const suggest = findSuggestResult(messages);
    if (suggest) {
      if (suggest.added.length === 0) {
        // The estimator returned nothing usable: say so plainly.
        return finalReplyCompletion(
          `I didn't add any line items because the estimator didn't return any parts or labor for the brake job. ${suggest.disclaimer}`,
        );
      }
      const cautions = (suggest.cautions ?? []).join(" ");
      return finalReplyCompletion(
        `I added ${suggest.added.length} suggested line items for the brake job. ${cautions} ${suggest.disclaimer}`,
      );
    }
    // A pending action was declined -> acknowledge instead of re-proposing it.
    if (hasRejection(messages)) {
      return finalReplyCompletion(
        "No problem, I won't add those line items. Let me know if you'd like anything else.",
      );
    }
    // No estimate yet -> draft one for the seeded customer/vehicle.
    const estimateId = findCreatedEstimateId(messages);
    if (estimateId === null) {
      return toolCallCompletion("call_create_est", "create_estimate", {
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        status: "draft",
      });
    }
    // Estimate exists -> ask the estimator to suggest line items for the job.
    return toolCallCompletion("call_suggest", "suggest_estimate_line_items", {
      estimateId,
      jobDescription: JOB_DESCRIPTION,
    });
  });
});

describe("AI estimate suggestions end-to-end", () => {
  it("drafts an estimate, suggests line items on approval, and surfaces the disclaimer", async () => {
    // 1) User asks the assistant to draft an estimate and suggest line items.
    const turn1 = await sendMessage(admin.cookie, {
      message:
        "Draft a brake job estimate for that customer and suggest the line items for it.",
    });
    expect(turn1.status).toBe(200);
    expect(turn1.body.status).toBe("awaiting_confirmation");
    expect(turn1.body.pendingAction?.toolName).toBe("create_estimate");
    expect(turn1.body.reply).toContain("create a draft estimate");
    const conversationId: number = turn1.body.conversationId;
    const createActionId: number = turn1.body.pendingAction.id;

    // 2) Approve drafting the estimate -> the loop continues and proposes the
    //    AI suggestion as the next pending action.
    const confirm1 = await confirmAction(admin.cookie, {
      conversationId,
      pendingActionId: createActionId,
      decision: "approve",
    });
    expect(confirm1.status).toBe(200);
    expect(confirm1.body.status).toBe("awaiting_confirmation");
    expect(confirm1.body.pendingAction?.toolName).toBe(
      "suggest_estimate_line_items",
    );
    expect(confirm1.body.reply).toContain("generate AI-suggested");
    const suggestActionId: number = confirm1.body.pendingAction.id;

    // The estimate row exists after the first approval, with no line items yet.
    // Use ORDER BY id DESC to pick the most recently created one (just seeded
    // by this test's create_estimate approval) rather than an arbitrary row
    // from earlier parallel test runs sharing the same DB.
    const [estimate] = await db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.customerId, shop.customerId))
      .orderBy(desc(estimatesTable.id))
      .limit(1);
    expect(estimate).toBeDefined();
    const before = await db
      .select()
      .from(estimateLineItemsTable)
      .where(eq(estimateLineItemsTable.estimateId, estimate.id));
    expect(before.length).toBe(0);

    // 3) Approve the AI suggestion -> it calls the estimator and writes the
    //    labor + parts line items, then the assistant reports back.
    const confirm2 = await confirmAction(admin.cookie, {
      conversationId,
      pendingActionId: suggestActionId,
      decision: "approve",
    });
    expect(confirm2.status).toBe(200);
    expect(confirm2.body.status).toBe("final");

    // The disclaimer and a caution from the estimator surface to the user.
    expect(confirm2.body.reply).toContain(ESTIMATE_DISCLAIMER);
    expect(confirm2.body.reply).toContain(CAUTION_ROTOR);

    // The estimate now has the labor line and both suggested parts.
    const items = await db
      .select()
      .from(estimateLineItemsTable)
      .where(eq(estimateLineItemsTable.estimateId, estimate.id));
    expect(items.length).toBe(3);

    const labor = items.find((i) => i.type === "labor");
    expect(labor).toBeDefined();
    expect(labor?.description).toContain(JOB_DESCRIPTION);
    expect(labor?.quantity).toBe(2);

    const pads = items.find((i) => i.description === PART_PADS);
    expect(pads).toBeDefined();
    expect(pads?.type).toBe("part");
    expect(pads?.quantity).toBe(1);
    expect(pads?.unitPrice).toBe(PART_PADS_PRICE);

    const rotors = items.find((i) => i.description === PART_ROTORS);
    expect(rotors).toBeDefined();
    expect(rotors?.type).toBe("part");
    expect(rotors?.quantity).toBe(2);
    expect(rotors?.unitPrice).toBe(PART_ROTORS_PRICE);
  });

  it("does not write any line items when the suggestion is rejected", async () => {
    const turn1 = await sendMessage(admin.cookie, {
      message: "Start a new brake estimate and suggest the parts.",
    });
    expect(turn1.body.pendingAction?.toolName).toBe("create_estimate");
    const conversationId: number = turn1.body.conversationId;

    const confirm1 = await confirmAction(admin.cookie, {
      conversationId,
      pendingActionId: turn1.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirm1.body.pendingAction?.toolName).toBe(
      "suggest_estimate_line_items",
    );

    // Reject the AI suggestion: the estimate stays but gets no line items, and
    // the estimator is never invoked.
    const reject = await confirmAction(admin.cookie, {
      conversationId,
      pendingActionId: confirm1.body.pendingAction.id,
      decision: "reject",
    });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe("final");

    // Two estimates now exist for the customer (from both tests); the one from
    // this conversation has no line items. Assert none of the estimator's parts
    // were written in this run.
    const estimates = await db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.customerId, shop.customerId));
    expect(estimates.length).toBeGreaterThanOrEqual(2);

    // The labor-estimate (json_schema) call must never have fired on a reject.
    const calls = mockedCreate.mock.calls as Array<[{ response_format?: { type?: string } }]>;
    const estimatorCalled = calls.some(
      ([p]) => p?.response_format?.type === "json_schema",
    );
    expect(estimatorCalled).toBe(false);
  });

  it("tells the user it couldn't generate suggestions when the estimator fails", async () => {
    estimatorBehavior = "throw";

    const turn1 = await sendMessage(admin.cookie, {
      message: "Draft a brake estimate and suggest the line items for it.",
    });
    expect(turn1.body.pendingAction?.toolName).toBe("create_estimate");
    const conversationId: number = turn1.body.conversationId;

    const confirm1 = await confirmAction(admin.cookie, {
      conversationId,
      pendingActionId: turn1.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirm1.body.pendingAction?.toolName).toBe(
      "suggest_estimate_line_items",
    );

    // Approve the suggestion: the estimator throws, the tool returns a graceful
    // error, and the assistant reports the failure to the user.
    const confirm2 = await confirmAction(admin.cookie, {
      conversationId,
      pendingActionId: confirm1.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirm2.status).toBe(200);
    expect(confirm2.body.status).toBe("final");
    expect(confirm2.body.reply).toContain("couldn't generate suggestions");

    // The estimator (json_schema) call must have fired and thrown on this run.
    const calls = mockedCreate.mock.calls as Array<[{ response_format?: { type?: string } }]>;
    const estimatorCalled = calls.some(
      ([p]) => p?.response_format?.type === "json_schema",
    );
    expect(estimatorCalled).toBe(true);

    // The estimate created in this conversation is the most recent one; it must
    // have no line items because the failed suggestion wrote nothing.
    const [latest] = await db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.customerId, shop.customerId))
      .orderBy(desc(estimatesTable.id))
      .limit(1);
    expect(latest).toBeDefined();
    const items = await db
      .select()
      .from(estimateLineItemsTable)
      .where(eq(estimateLineItemsTable.estimateId, latest.id));
    expect(items.length).toBe(0);
  });

  it("tells the user nothing was added when the estimator returns no parts or labor", async () => {
    estimatorBehavior = "empty";

    const turn1 = await sendMessage(admin.cookie, {
      message: "Draft a brake estimate and suggest the line items for it.",
    });
    expect(turn1.body.pendingAction?.toolName).toBe("create_estimate");
    const conversationId: number = turn1.body.conversationId;

    const confirm1 = await confirmAction(admin.cookie, {
      conversationId,
      pendingActionId: turn1.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirm1.body.pendingAction?.toolName).toBe(
      "suggest_estimate_line_items",
    );

    // Approve the suggestion: the estimator returns an empty result, so nothing
    // is written and the assistant says so plainly.
    const confirm2 = await confirmAction(admin.cookie, {
      conversationId,
      pendingActionId: confirm1.body.pendingAction.id,
      decision: "approve",
    });
    expect(confirm2.status).toBe(200);
    expect(confirm2.body.status).toBe("final");
    expect(confirm2.body.reply).toContain("didn't add any line items");

    // The estimator was invoked but the estimate is left unchanged (no items).
    const calls = mockedCreate.mock.calls as Array<[{ response_format?: { type?: string } }]>;
    const estimatorCalled = calls.some(
      ([p]) => p?.response_format?.type === "json_schema",
    );
    expect(estimatorCalled).toBe(true);

    const [latest] = await db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.customerId, shop.customerId))
      .orderBy(desc(estimatesTable.id))
      .limit(1);
    expect(latest).toBeDefined();
    const items = await db
      .select()
      .from(estimateLineItemsTable)
      .where(eq(estimateLineItemsTable.estimateId, latest.id));
    expect(items.length).toBe(0);
  });
});
