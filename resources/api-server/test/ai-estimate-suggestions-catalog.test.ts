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
import {
  agent,
  seedStaffUser,
  seedPart,
  seedCustomerVehicle,
  uniqueName,
  type SeededAdmin,
  type SeededPart,
  type SeededShop,
} from "./helpers";

const mockedCreate = vi.mocked(openai.chat.completions.create);

// Unique names so the part/job the estimator returns can't collide with parts
// seeded by other test files in the shared run database.
const CATALOG_PART_NAME = uniqueName("Suggest Cabin Air Filter");
const UNMATCHED_PART_NAME = uniqueName("Suggest Nonexistent Part");
const JOB_DESCRIPTION = "replace the cabin air filter";
const AI_PART_PRICE = 99; // the AI's guessed price for the catalog part
const CATALOG_PART_PRICE = 24.5; // the real shop price the match should adopt
const AI_UNMATCHED_PRICE = 30;

let inventoryStaff: SeededAdmin; // estimates + inventory
let woStaff: SeededAdmin; // estimates + workOrders (no inventory)
let shop: SeededShop;
let catalogPart: SeededPart;

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

// The structured estimate the json_schema labor-estimate call returns: one part
// that matches the seeded catalog entry (with a deliberately wrong AI price) and
// one that matches nothing.
function laborEstimateCompletion() {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            summary: "Replace cabin air filter.",
            laborHours: 1,
            parts: [
              { description: CATALOG_PART_NAME, quantity: 2, unitPrice: AI_PART_PRICE },
              { description: UNMATCHED_PART_NAME, quantity: 1, unitPrice: AI_UNMATCHED_PRICE },
            ],
            cautions: [],
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

interface SuggestResult {
  added: unknown[];
  disclaimer: string;
  partsPricing?: {
    description: string;
    unitPrice: number;
    fromCatalog: boolean;
    partId: number | null;
    quantityOnHand: number | null;
    matchConfidence: string | null;
    lowStock: boolean | null;
  }[];
  pricingNote?: string;
}

function findSuggestResult(messages: ChatMsg[]): SuggestResult | null {
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    try {
      const parsed = JSON.parse(m.content);
      if (Array.isArray(parsed?.added) && typeof parsed?.disclaimer === "string") {
        return parsed as SuggestResult;
      }
    } catch {
      /* not JSON */
    }
  }
  return null;
}

// Captures the suggest tool result observed by the model on each run so tests
// can assert on the catalog/stock provenance the assistant is handed.
let capturedSuggest: SuggestResult | null = null;

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
  inventoryStaff = await seedStaffUser(
    ["estimates", "customers", "inventory"],
    "sugestinv",
  );
  woStaff = await seedStaffUser(["estimates", "customers"], "sugestwo");
  shop = await seedCustomerVehicle();
  catalogPart = await seedPart({
    name: CATALOG_PART_NAME,
    quantityOnHand: 2,
    reorderLevel: 5,
    unitPrice: CATALOG_PART_PRICE,
  });
});

beforeEach(() => {
  mockedCreate.mockReset();
  capturedSuggest = null;
  // Drive the whole conversation deterministically off the conversation state in
  // the messages, so the same mock serves every model + estimator call.
  mockedCreate.mockImplementation((params: unknown) => {
    const p = params as {
      response_format?: { type?: string };
      messages?: ChatMsg[];
    };
    if (p.response_format?.type === "json_schema") {
      return laborEstimateCompletion();
    }
    const messages = p.messages ?? [];
    const suggest = findSuggestResult(messages);
    if (suggest) {
      capturedSuggest = suggest;
      return finalReplyCompletion(
        `I added ${suggest.added.length} suggested line items. ${suggest.disclaimer}`,
      );
    }
    const estimateId = findCreatedEstimateId(messages);
    if (estimateId === null) {
      return toolCallCompletion("call_create_est", "create_estimate", {
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        status: "draft",
      });
    }
    return toolCallCompletion("call_suggest", "suggest_estimate_line_items", {
      estimateId,
      jobDescription: JOB_DESCRIPTION,
    });
  });
});

// Resolve the estimate created in the most recent conversation for a customer.
async function latestEstimateId(): Promise<number> {
  const [latest] = await db
    .select({ id: estimatesTable.id })
    .from(estimatesTable)
    .where(eq(estimatesTable.customerId, shop.customerId))
    .orderBy(desc(estimatesTable.id))
    .limit(1);
  expect(latest).toBeDefined();
  return latest.id;
}

// Run the draft-estimate -> suggest-line-items flow end to end for a caller,
// approving both pending actions, and return the resulting estimate id.
async function runSuggestionFlow(cookie: string): Promise<number> {
  const turn1 = await sendMessage(cookie, {
    message: "Draft a cabin filter estimate and suggest the line items for it.",
  });
  expect(turn1.body.pendingAction?.toolName).toBe("create_estimate");
  const conversationId: number = turn1.body.conversationId;

  const confirm1 = await confirmAction(cookie, {
    conversationId,
    pendingActionId: turn1.body.pendingAction.id,
    decision: "approve",
  });
  expect(confirm1.body.pendingAction?.toolName).toBe("suggest_estimate_line_items");

  const confirm2 = await confirmAction(cookie, {
    conversationId,
    pendingActionId: confirm1.body.pendingAction.id,
    decision: "approve",
  });
  expect(confirm2.status).toBe(200);
  expect(confirm2.body.status).toBe("final");

  return latestEstimateId();
}

describe("AI estimate suggestions adopt catalog pricing", () => {
  it("uses the catalog price for an inventory caller's matched part", async () => {
    const estimateId = await runSuggestionFlow(inventoryStaff.cookie);
    const items = await db
      .select()
      .from(estimateLineItemsTable)
      .where(eq(estimateLineItemsTable.estimateId, estimateId));

    const matched = items.find((i) => i.description === CATALOG_PART_NAME);
    expect(matched).toBeDefined();
    expect(matched?.type).toBe("part");
    expect(matched?.quantity).toBe(2);
    // The AI's guessed 99 is overridden by the catalog's 24.5.
    expect(matched?.unitPrice).toBe(CATALOG_PART_PRICE);

    const unmatched = items.find((i) => i.description === UNMATCHED_PART_NAME);
    expect(unmatched).toBeDefined();
    // No catalog match -> the AI's estimated price stands.
    expect(unmatched?.unitPrice).toBe(AI_UNMATCHED_PRICE);
  });

  it("tells an inventory caller which parts are catalog-priced vs estimated and flags low stock", async () => {
    await runSuggestionFlow(inventoryStaff.cookie);
    expect(capturedSuggest).not.toBeNull();
    const pricing = capturedSuggest?.partsPricing;
    expect(pricing).toBeDefined();

    const matched = pricing?.find((p) => p.description === CATALOG_PART_NAME);
    expect(matched).toBeDefined();
    expect(matched?.fromCatalog).toBe(true);
    expect(matched?.unitPrice).toBe(CATALOG_PART_PRICE);
    expect(matched?.partId).toBe(catalogPart.id);
    expect(matched?.quantityOnHand).toBe(2);
    // Seeded with qtyOnHand 2 <= reorderLevel 5, so the match is low stock.
    expect(matched?.lowStock).toBe(true);

    const unmatched = pricing?.find((p) => p.description === UNMATCHED_PART_NAME);
    expect(unmatched).toBeDefined();
    expect(unmatched?.fromCatalog).toBe(false);
    expect(unmatched?.partId).toBeNull();
    // No catalog match -> no stock signal leaks for it.
    expect(unmatched?.lowStock).toBeNull();

    // The deterministic note names both the firm and the estimated parts and the
    // low-stock warning so the assistant can read it aloud verbatim.
    expect(capturedSuggest?.pricingNote).toContain(CATALOG_PART_NAME);
    expect(capturedSuggest?.pricingNote).toContain(UNMATCHED_PART_NAME);
    expect(capturedSuggest?.pricingNote?.toLowerCase()).toContain("low stock");
  });

  it("keeps the AI price for a caller without the inventory permission", async () => {
    const estimateId = await runSuggestionFlow(woStaff.cookie);
    const items = await db
      .select()
      .from(estimateLineItemsTable)
      .where(eq(estimateLineItemsTable.estimateId, estimateId));

    const matched = items.find((i) => i.description === CATALOG_PART_NAME);
    expect(matched).toBeDefined();
    // Without inventory access the catalog price is never consulted, so the AI's
    // original price is written as-is.
    expect(matched?.unitPrice).toBe(AI_PART_PRICE);
  });

  it("leaks no catalog or stock detail to a caller without inventory permission", async () => {
    await runSuggestionFlow(woStaff.cookie);
    expect(capturedSuggest).not.toBeNull();
    // No per-part catalog/stock provenance and no catalog-specific note: an
    // estimates-only caller must not learn anything about inventory.
    expect(capturedSuggest?.partsPricing).toBeUndefined();
    expect(capturedSuggest?.pricingNote).toBeUndefined();
  });
});
