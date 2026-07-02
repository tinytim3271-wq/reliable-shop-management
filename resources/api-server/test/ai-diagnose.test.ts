import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The /ai/diagnose handler calls the OpenAI integration. Mock the whole module
// so the suite never makes a real network call and we fully control the
// suggestedParts the handler enriches. Mocking the module also sidesteps the
// import-time env checks in the real OpenAI client.
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import {
  agent,
  seedAdmin,
  seedStaffUser,
  seedPart,
  uniqueName,
  type SeededAdmin,
  type SeededPart,
} from "./helpers";

const mockedCreate = vi.mocked(openai.chat.completions.create);

let admin: SeededAdmin; // has every permission, including `inventory`
let tech: SeededAdmin; // workOrders only — can hit /ai/diagnose but lacks inventory
let lowPart: SeededPart; // quantityOnHand <= reorderLevel  -> low stock
let highPart: SeededPart; // quantityOnHand >  reorderLevel  -> in stock
let equalPart: SeededPart; // quantityOnHand == reorderLevel -> low stock (boundary)
let unmatchedDescription: string;

// Builds a fully-formed diagnosis payload (matching the json_schema the handler
// requests) whose suggestedParts descriptions we control for catalog matching.
function diagnosisPayload(
  suggestedParts: Array<{ description: string; quantity: number; unitPrice: number }>,
) {
  return {
    summary: "Test diagnosis summary",
    severity: "medium",
    possibleCauses: [
      { cause: "Worn pads", likelihood: "high", explanation: "Typical wear." },
    ],
    recommendedRepairs: [
      { repair: "Replace front pads", urgency: "soon", estimatedLaborHours: 1.5 },
    ],
    suggestedParts,
    diagnosticSteps: ["Inspect brakes"],
    safetyNotes: null,
    confidence: "medium",
  };
}

function mockDiagnosis(
  suggestedParts: Array<{ description: string; quantity: number; unitPrice: number }>,
) {
  mockedCreate.mockResolvedValue({
    choices: [
      { message: { content: JSON.stringify(diagnosisPayload(suggestedParts)) } },
    ],
  } as never);
}

function diagnose(cookie: string) {
  return agent()
    .post("/api/ai/diagnose")
    .set("Cookie", cookie)
    .set("X-Forwarded-Proto", "https")
    .send({ symptoms: "Grinding noise when braking" });
}

interface SuggestedPart {
  description: string;
  unitPrice: number;
  fromCatalog: boolean;
  partId: number | null;
  quantityOnHand: number | null;
  reorderLevel: number | null;
  lowStock: boolean | null;
}

const byDescription = (parts: SuggestedPart[], description: string): SuggestedPart => {
  const found = parts.find((p) => p.description === description);
  expect(found, `expected suggested part "${description}"`).toBeDefined();
  return found as SuggestedPart;
};

beforeAll(async () => {
  admin = await seedAdmin();
  tech = await seedStaffUser(["workOrders"], "tech");
  lowPart = await seedPart({
    name: uniqueName("Brake Pad Set"),
    quantityOnHand: 2,
    reorderLevel: 5,
    unitPrice: 49.99,
  });
  highPart = await seedPart({
    name: uniqueName("Oil Filter"),
    quantityOnHand: 50,
    reorderLevel: 10,
    unitPrice: 9.99,
  });
  equalPart = await seedPart({
    name: uniqueName("Spark Plug"),
    quantityOnHand: 5,
    reorderLevel: 5,
    unitPrice: 6.5,
  });
  unmatchedDescription = uniqueName("Nonexistent Component");
});

beforeEach(() => {
  mockedCreate.mockReset();
});

describe("/ai/diagnose enriches suggested parts with catalog stock", () => {
  it("returns stock fields for a catalog match and nulls for a non-match (inventory caller)", async () => {
    mockDiagnosis([
      { description: lowPart.name, quantity: 1, unitPrice: 80 },
      { description: unmatchedDescription, quantity: 2, unitPrice: 30 },
    ]);

    const res = await diagnose(admin.cookie);
    expect(res.status).toBe(200);
    const parts = res.body.suggestedParts as SuggestedPart[];

    const matched = byDescription(parts, lowPart.name);
    expect(matched.fromCatalog).toBe(true);
    expect(matched.partId).toBe(lowPart.id);
    expect(matched.quantityOnHand).toBe(2);
    expect(matched.reorderLevel).toBe(5);
    expect(matched.lowStock).toBe(true);
    // The catalog price overrides the AI's guessed unit price.
    expect(matched.unitPrice).toBe(49.99);

    const unmatched = byDescription(parts, unmatchedDescription);
    expect(unmatched.fromCatalog).toBe(false);
    expect(unmatched.partId).toBeNull();
    expect(unmatched.quantityOnHand).toBeNull();
    expect(unmatched.reorderLevel).toBeNull();
    expect(unmatched.lowStock).toBeNull();
    // No catalog match -> keep the AI's estimated price.
    expect(unmatched.unitPrice).toBe(30);
  });

  it("computes lowStock as quantityOnHand <= reorderLevel", async () => {
    mockDiagnosis([
      { description: lowPart.name, quantity: 1, unitPrice: 80 }, // 2 <= 5  -> true
      { description: highPart.name, quantity: 1, unitPrice: 80 }, // 50 > 10 -> false
      { description: equalPart.name, quantity: 1, unitPrice: 80 }, // 5 == 5 -> true (boundary)
    ]);

    const res = await diagnose(admin.cookie);
    expect(res.status).toBe(200);
    const parts = res.body.suggestedParts as SuggestedPart[];

    expect(byDescription(parts, lowPart.name).lowStock).toBe(true);
    expect(byDescription(parts, highPart.name).lowStock).toBe(false);
    expect(byDescription(parts, equalPart.name).lowStock).toBe(true);
  });

  it("never exposes stock fields to a caller without the inventory permission", async () => {
    mockDiagnosis([
      { description: lowPart.name, quantity: 1, unitPrice: 80 },
      { description: highPart.name, quantity: 1, unitPrice: 80 },
    ]);

    const res = await diagnose(tech.cookie);
    expect(res.status).toBe(200);
    const parts = res.body.suggestedParts as SuggestedPart[];

    for (const name of [lowPart.name, highPart.name]) {
      const part = byDescription(parts, name);
      expect(part.fromCatalog).toBe(false);
      expect(part.partId).toBeNull();
      expect(part.quantityOnHand).toBeNull();
      expect(part.reorderLevel).toBeNull();
      expect(part.lowStock).toBeNull();
      // Without catalog access the AI's original price is preserved.
      expect(part.unitPrice).toBe(80);
    }
  });
});
