import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The /ai/labor-estimate handler (via runLaborEstimate) calls the OpenAI
// integration. Mock the whole module so the suite never makes a real network
// call and we fully control the labor hours + parts the handler turns into
// server-side totals. Mocking the module also sidesteps the import-time env
// checks in the real OpenAI client.
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

let admin: SeededAdmin;

// Builds the structured labor_estimate JSON the model is asked for. The handler
// recomputes every monetary total from laborHours/laborRate and the parts'
// quantity/unitPrice, so the payload deliberately omits any per-part `total`.
function estimatePayload(opts: {
  summary?: string;
  laborHours: number;
  parts: Array<{ description: string; quantity: number; unitPrice: number }>;
  cautions?: string[];
  confidence?: "low" | "medium" | "high";
}) {
  return {
    summary: opts.summary ?? "Test labor estimate summary",
    laborHours: opts.laborHours,
    parts: opts.parts,
    cautions: opts.cautions ?? ["Verify part fitment before quoting"],
    confidence: opts.confidence ?? "medium",
  };
}

function mockEstimate(opts: {
  summary?: string;
  laborHours: number;
  parts: Array<{ description: string; quantity: number; unitPrice: number }>;
  cautions?: string[];
  confidence?: "low" | "medium" | "high";
}) {
  mockedCreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(estimatePayload(opts)) } }],
  } as never);
}

function laborEstimate(
  cookie: string,
  body: Record<string, unknown>,
) {
  return agent()
    .post("/api/ai/labor-estimate")
    .set("Cookie", cookie)
    .set("X-Forwarded-Proto", "https")
    .send(body);
}

interface EstimatePart {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

beforeAll(async () => {
  admin = await seedAdmin();
});

beforeEach(() => {
  mockedCreate.mockReset();
});

describe("/ai/labor-estimate computes pricing server-side", () => {
  it("derives each part total, partsTotal, laborTotal, and grandTotal from inputs", async () => {
    mockEstimate({
      laborHours: 2.5,
      parts: [
        { description: "Brake pad set", quantity: 2, unitPrice: 49.99 },
        { description: "Brake rotor", quantity: 1, unitPrice: 120 },
      ],
    });

    const res = await laborEstimate(admin.cookie, {
      jobDescription: "Front brake job",
      laborRate: 100,
    });

    expect(res.status).toBe(200);
    const body = res.body as {
      laborHours: number;
      laborRate: number;
      laborTotal: number;
      parts: EstimatePart[];
      partsTotal: number;
      grandTotal: number;
    };

    expect(body.laborHours).toBe(2.5);
    expect(body.laborRate).toBe(100);
    // laborTotal = laborHours * laborRate
    expect(body.laborTotal).toBe(250);

    // total = quantity * unitPrice for each part.
    const pad = body.parts.find((p) => p.description === "Brake pad set");
    const rotor = body.parts.find((p) => p.description === "Brake rotor");
    expect(pad?.total).toBe(99.98); // 2 * 49.99
    expect(rotor?.total).toBe(120); // 1 * 120

    // partsTotal = sum of part totals; grandTotal = laborTotal + partsTotal.
    expect(body.partsTotal).toBe(219.98);
    expect(body.grandTotal).toBe(469.98);
  });

  it("ignores any AI-supplied total and rounds money to cents", async () => {
    // The model is not asked for `total`, but even a malicious/garbage value
    // must not survive: the server recomputes from quantity * unitPrice.
    mockedCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "Rounding case",
              laborHours: 1.333,
              parts: [
                {
                  description: "Coolant",
                  quantity: 3,
                  unitPrice: 12.345,
                  total: 999999,
                },
              ],
              cautions: [],
              confidence: "high",
            }),
          },
        },
      ],
    } as never);

    const res = await laborEstimate(admin.cookie, {
      jobDescription: "Coolant flush",
      laborRate: 90,
    });

    expect(res.status).toBe(200);
    const body = res.body as {
      laborHours: number;
      laborTotal: number;
      parts: EstimatePart[];
      partsTotal: number;
      grandTotal: number;
    };

    // round2 applied to all money/quantity values.
    expect(body.laborHours).toBe(1.33);
    expect(body.laborTotal).toBe(119.7); // round2(1.33 * 90)

    const coolant = body.parts[0];
    expect(coolant.unitPrice).toBe(12.35); // round2(12.345)
    expect(coolant.total).toBe(37.05); // round2(3 * 12.35) — NOT the AI's 999999
    expect(body.partsTotal).toBe(37.05);
    expect(body.grandTotal).toBe(156.75); // 119.7 + 37.05
  });

  it("handles an estimate with no parts (partsTotal 0, grandTotal = laborTotal)", async () => {
    mockEstimate({ laborHours: 0.5, parts: [] });

    const res = await laborEstimate(admin.cookie, {
      jobDescription: "Diagnostic scan",
      laborRate: 120,
    });

    expect(res.status).toBe(200);
    const body = res.body as {
      parts: EstimatePart[];
      partsTotal: number;
      laborTotal: number;
      grandTotal: number;
    };

    expect(body.parts).toEqual([]);
    expect(body.partsTotal).toBe(0);
    expect(body.laborTotal).toBe(60); // 0.5 * 120
    expect(body.grandTotal).toBe(60);
  });

  it("returns the disclaimer and passes through the model's confidence", async () => {
    mockEstimate({
      laborHours: 1,
      parts: [{ description: "Air filter", quantity: 1, unitPrice: 20 }],
      cautions: ["Confirm filter part number"],
      confidence: "low",
    });

    const res = await laborEstimate(admin.cookie, {
      jobDescription: "Replace air filter",
      laborRate: 100,
    });

    expect(res.status).toBe(200);
    const body = res.body as {
      confidence: string;
      disclaimer: string;
      cautions: string[];
    };

    expect(body.confidence).toBe("low");
    expect(typeof body.disclaimer).toBe("string");
    expect(body.disclaimer.length).toBeGreaterThan(0);
    expect(body.cautions).toContain("Confirm filter part number");
  });

  it("requires authentication", async () => {
    mockEstimate({ laborHours: 1, parts: [] });

    const res = await agent()
      .post("/api/ai/labor-estimate")
      .set("X-Forwarded-Proto", "https")
      .send({ jobDescription: "Front brake job", laborRate: 100 });

    expect(res.status).toBe(401);
  });
});

interface CatalogPart {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  fromCatalog: boolean;
  partId: number | null;
  quantityOnHand: number | null;
  reorderLevel: number | null;
  lowStock: boolean | null;
  matchConfidence: "high" | "medium" | "low" | null;
}

const findPart = (parts: CatalogPart[], description: string): CatalogPart => {
  const found = parts.find((p) => p.description === description);
  expect(found, `expected estimate part "${description}"`).toBeDefined();
  return found as CatalogPart;
};

describe("/ai/labor-estimate enriches suggested parts with the catalog", () => {
  let inventoryStaff: SeededAdmin; // has the `inventory` permission
  let woStaff: SeededAdmin; // workOrders only — can estimate but lacks inventory
  let stockPart: SeededPart; // low stock: quantityOnHand <= reorderLevel
  let unmatchedDescription: string;

  beforeAll(async () => {
    inventoryStaff = await seedStaffUser(["estimates", "inventory"], "estinv");
    woStaff = await seedStaffUser(["estimates", "workOrders"], "estwo");
    stockPart = await seedPart({
      name: uniqueName("Cabin Air Filter"),
      quantityOnHand: 2,
      reorderLevel: 5,
      unitPrice: 24.5,
    });
    unmatchedDescription = uniqueName("Nonexistent Estimate Part");
  });

  it("adopts catalog pricing and stock fields for an inventory caller", async () => {
    mockEstimate({
      laborHours: 1,
      parts: [
        // AI's guessed price (99) is overridden by the catalog price (24.5).
        { description: stockPart.name, quantity: 2, unitPrice: 99 },
        { description: unmatchedDescription, quantity: 1, unitPrice: 30 },
      ],
    });

    const res = await laborEstimate(inventoryStaff.cookie, {
      jobDescription: "Replace cabin filter",
      laborRate: 100,
    });

    expect(res.status).toBe(200);
    const parts = res.body.parts as CatalogPart[];

    const matched = findPart(parts, stockPart.name);
    expect(matched.fromCatalog).toBe(true);
    expect(matched.partId).toBe(stockPart.id);
    expect(matched.unitPrice).toBe(24.5); // catalog price, not the AI's 99
    expect(matched.total).toBe(49); // 2 * 24.5 — recomputed from catalog price
    expect(matched.quantityOnHand).toBe(2);
    expect(matched.reorderLevel).toBe(5);
    expect(matched.lowStock).toBe(true);
    expect(matched.matchConfidence).toBe("high");

    const unmatched = findPart(parts, unmatchedDescription);
    expect(unmatched.fromCatalog).toBe(false);
    expect(unmatched.partId).toBeNull();
    expect(unmatched.unitPrice).toBe(30); // AI price preserved
    expect(unmatched.total).toBe(30);
    expect(unmatched.quantityOnHand).toBeNull();
    expect(unmatched.reorderLevel).toBeNull();
    expect(unmatched.lowStock).toBeNull();
    expect(unmatched.matchConfidence).toBeNull();

    // Totals reflect the adopted catalog price: parts = 49 + 30 = 79;
    // labor = 1 * 100 = 100; grand = 179.
    expect(res.body.partsTotal).toBe(79);
    expect(res.body.laborTotal).toBe(100);
    expect(res.body.grandTotal).toBe(179);
  });

  it("never exposes catalog fields to a caller without the inventory permission", async () => {
    mockEstimate({
      laborHours: 1,
      parts: [{ description: stockPart.name, quantity: 2, unitPrice: 99 }],
    });

    const res = await laborEstimate(woStaff.cookie, {
      jobDescription: "Replace cabin filter",
      laborRate: 100,
    });

    expect(res.status).toBe(200);
    const part = findPart(res.body.parts as CatalogPart[], stockPart.name);
    expect(part.fromCatalog).toBe(false);
    expect(part.partId).toBeNull();
    expect(part.quantityOnHand).toBeNull();
    expect(part.reorderLevel).toBeNull();
    expect(part.lowStock).toBeNull();
    expect(part.matchConfidence).toBeNull();
    // Without inventory access the AI's original price stands.
    expect(part.unitPrice).toBe(99);
    expect(part.total).toBe(198); // 2 * 99
  });
});
