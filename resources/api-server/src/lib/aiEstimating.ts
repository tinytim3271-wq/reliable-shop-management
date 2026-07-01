import { db, shopSettingsTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { round2 } from "./ledger";

const MODEL = "gpt-5.4";
const REQUEST_OPTIONS = { timeout: 60_000, maxRetries: 2 } as const;

export const ESTIMATE_DISCLAIMER =
  "AI-generated estimate. Verify parts, prices, and labor times against your shop data before quoting the customer.";

export interface VehicleContext {
  vehicleYear?: number | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  vehicleEngine?: string | null;
  mileage?: number | null;
}

// Render a vehicle context into a single human/AI-readable line.
export function vehicleLine(v: VehicleContext): string {
  const parts = [v.vehicleYear, v.vehicleMake, v.vehicleModel]
    .filter((p) => p !== null && p !== undefined && `${p}`.trim() !== "")
    .join(" ");
  const extras: string[] = [];
  if (v.vehicleEngine) extras.push(`engine: ${v.vehicleEngine}`);
  if (v.mileage !== null && v.mileage !== undefined)
    extras.push(`mileage: ${v.mileage}`);
  const base = parts || "an unspecified vehicle";
  return extras.length ? `${base} (${extras.join(", ")})` : base;
}

export interface LaborEstimateInput extends VehicleContext {
  jobDescription: string;
  laborRate?: number | null;
  notes?: string | null;
}

export interface LaborEstimatePart {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface LaborEstimateResult {
  summary: string;
  laborHours: number;
  laborRate: number;
  laborTotal: number;
  parts: LaborEstimatePart[];
  partsTotal: number;
  grandTotal: number;
  cautions: string[];
  confidence: "low" | "medium" | "high";
  disclaimer: string;
}

// Thrown when the AI provider fails or returns an unusable response. Callers map
// this to a 502 / generic tool error rather than leaking provider internals.
export class LaborEstimateError extends Error {}

// Core labor-estimate logic shared by the POST /ai/labor-estimate route and the
// AI agent's suggestEstimateLineItems tool. Resolves the labor rate from shop
// settings when not supplied, asks the model for a structured estimate, and
// returns rounded, validated numbers.
export async function runLaborEstimate(
  input: LaborEstimateInput,
): Promise<LaborEstimateResult> {
  let laborRate = input.laborRate ?? null;
  if (laborRate === null) {
    const [settings] = await db.select().from(shopSettingsTable).limit(1);
    laborRate = settings?.defaultLaborRate ?? 0;
  }

  const prompt = [
    `Vehicle: ${vehicleLine(input)}.`,
    `Job requested: ${input.jobDescription}.`,
    input.notes ? `Additional context: ${input.notes}.` : null,
    `Shop labor rate: $${laborRate}/hour.`,
    "Estimate the total labor hours for this job and list the parts/materials typically required, with realistic per-unit prices in USD. Do not include labor as a part line item. Flag anything the service writer should verify before quoting.",
  ]
    .filter(Boolean)
    .join("\n");

  let completion;
  try {
    completion = await openai.chat.completions.create(
      {
        model: MODEL,
        max_completion_tokens: 8192,
        messages: [
          {
            role: "system",
            content:
              "You are a master automotive service estimator. Produce conservative, realistic labor-time and parts estimates for an independent repair shop. Use standard flat-rate labor guides as a reference. Respond only with the structured JSON requested.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "labor_estimate",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["summary", "laborHours", "parts", "cautions", "confidence"],
              properties: {
                summary: { type: "string" },
                laborHours: { type: "number" },
                parts: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["description", "quantity", "unitPrice"],
                    properties: {
                      description: { type: "string" },
                      quantity: { type: "number" },
                      unitPrice: { type: "number" },
                    },
                  },
                },
                cautions: { type: "array", items: { type: "string" } },
                confidence: { type: "string", enum: ["low", "medium", "high"] },
              },
            },
          },
        },
      },
      REQUEST_OPTIONS,
    );
  } catch (err) {
    throw new LaborEstimateError(
      err instanceof Error ? err.message : "AI provider failed",
    );
  }

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new LaborEstimateError("AI provider returned an empty response");
  }

  let ai: {
    summary: string;
    laborHours: number;
    parts: Array<{ description: string; quantity: number; unitPrice: number }>;
    cautions: string[];
    confidence: "low" | "medium" | "high";
  };
  try {
    ai = JSON.parse(content);
  } catch {
    throw new LaborEstimateError("AI provider returned malformed JSON");
  }

  const rate = round2(laborRate);
  const laborHours = round2(ai.laborHours);
  const laborTotal = round2(laborHours * rate);
  const parts = (ai.parts ?? []).map((p) => {
    const quantity = round2(p.quantity);
    const unitPrice = round2(p.unitPrice);
    return {
      description: p.description,
      quantity,
      unitPrice,
      total: round2(quantity * unitPrice),
    };
  });
  const partsTotal = round2(parts.reduce((sum, p) => sum + p.total, 0));
  const grandTotal = round2(laborTotal + partsTotal);

  return {
    summary: ai.summary,
    laborHours,
    laborRate: rate,
    laborTotal,
    parts,
    partsTotal,
    grandTotal,
    cautions: ai.cautions ?? [],
    confidence: ai.confidence,
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}
