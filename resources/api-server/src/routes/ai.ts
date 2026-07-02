import { Router, type IRouter } from "express";
import { rateLimit } from "express-rate-limit";
import {
  AiLaborEstimateBody,
  AiLaborEstimateResponse,
  AiDiagnoseBody,
  AiDiagnoseResponse,
  AiAssistantBody,
  AiAssistantResponse,
} from "@workspace/api-zod";
import {
  runLaborEstimate,
  vehicleLine,
  LaborEstimateError,
} from "../lib/aiEstimating";
import { type CatalogPart, loadCatalog } from "../lib/billing";
import { matchCatalogPart } from "../lib/partMatch";

const router: IRouter = Router();

const MODEL = "gpt-5.4";
// Keep cloud calls short so offline fallback kicks in quickly when internet/
// provider access is unavailable.
const REQUEST_OPTIONS = { timeout: 15_000, maxRetries: 0 } as const;

// AI calls are slow and cost provider credits, so bound them per IP even though
// the routes already sit behind the authenticated, permission-gated boundary.
const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many AI requests. Please wait a moment and try again." },
});

const DIAGNOSIS_DISCLAIMER =
  "AI-generated diagnostic guidance. Confirm with proper testing by a qualified technician before performing any repair.";
const ASSISTANT_DISCLAIMER =
  "AI-generated guidance. Verify against service information and proper testing before performing any repair.";
const OFFLINE_ASSISTANT_DISCLAIMER =
  "Offline assistant mode. Guidance is generated locally with rule-based logic and should be verified by a qualified technician.";

async function getOpenAiClient() {
  const mod = await import("@workspace/integrations-openai-ai-server");
  return mod.openai;
}

function isProviderConnectivityError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message.toLowerCase()
      : typeof err === "string"
        ? err.toLowerCase()
        : "";

  return (
    msg.includes("connection") ||
    msg.includes("timeout") ||
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("socket") ||
    msg.includes("econn")
  );
}

const round2 = (n: unknown): number =>
  Math.round((Number(n) || 0) * 100) / 100;

function localLaborEstimate(input: {
  jobDescription: string;
  laborRate?: number | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
}): AiLaborEstimateResponse {
  const text = input.jobDescription.toLowerCase();
  let laborHours = 2;
  const parts: Array<{ description: string; quantity: number; unitPrice: number; total: number }> = [];

  if (text.includes("brake")) {
    laborHours = 2.5;
    parts.push({ description: "Brake pad set", quantity: 1, unitPrice: 95, total: 95 });
    parts.push({ description: "Brake rotor", quantity: 2, unitPrice: 78, total: 156 });
  } else if (text.includes("alternator")) {
    laborHours = 2;
    parts.push({ description: "Alternator", quantity: 1, unitPrice: 280, total: 280 });
    parts.push({ description: "Drive belt", quantity: 1, unitPrice: 38, total: 38 });
  } else if (text.includes("battery")) {
    laborHours = 0.6;
    parts.push({ description: "Battery", quantity: 1, unitPrice: 189, total: 189 });
  } else if (text.includes("oil")) {
    laborHours = 0.8;
    parts.push({ description: "Engine oil", quantity: 5, unitPrice: 8, total: 40 });
    parts.push({ description: "Oil filter", quantity: 1, unitPrice: 12, total: 12 });
  } else if (text.includes("spark")) {
    laborHours = 1.5;
    parts.push({ description: "Spark plug", quantity: 4, unitPrice: 14, total: 56 });
    parts.push({ description: "Intake gasket set", quantity: 1, unitPrice: 24, total: 24 });
  }

  const laborRate = round2(input.laborRate ?? 125);
  const laborTotal = round2(laborRate * laborHours);
  const partsTotal = round2(parts.reduce((s, p) => s + p.total, 0));
  const grandTotal = round2(laborTotal + partsTotal);

  return AiLaborEstimateResponse.parse({
    summary: `Offline estimate for ${input.vehicleMake ?? "vehicle"} ${input.vehicleModel ?? ""} based on request: ${input.jobDescription}`,
    laborHours,
    laborRate,
    laborTotal,
    parts,
    partsTotal,
    grandTotal,
    cautions: [
      "Confirm vehicle trim/engine-specific labor guide times.",
      "Verify part numbers before quoting.",
    ],
    confidence: "low",
    disclaimer: `${DIAGNOSIS_DISCLAIMER} Running in offline fallback mode.`,
  });
}

function localDiagnosis(input: {
  dtcCodes?: string[] | null;
  symptoms?: string | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
}): AiDiagnoseResponse {
  const dtcs = (input.dtcCodes ?? []).map((x) => x.toUpperCase());
  const hasMisfire = dtcs.some((c) => c.startsWith("P030"));
  const hasLean = dtcs.includes("P0171") || dtcs.includes("P0174");

  const possibleCauses = hasMisfire
    ? [
        { cause: "Ignition fault (plug/coil)", likelihood: "high", explanation: "Misfire DTCs usually start with ignition components." },
        { cause: "Fuel delivery imbalance", likelihood: "medium", explanation: "Injector flow issues can trigger cylinder-specific misfires." },
      ]
    : hasLean
      ? [
          { cause: "Vacuum leak", likelihood: "high", explanation: "Lean trim faults frequently point to unmetered air." },
          { cause: "MAF contamination", likelihood: "medium", explanation: "Incorrect airflow reading can bias fuel trim lean." },
        ]
      : [
          { cause: "Sensor or wiring drift", likelihood: "medium", explanation: "General symptom-based local fallback diagnosis." },
          { cause: "Mechanical wear", likelihood: "low", explanation: "Compression or timing drift may contribute to drivability symptoms." },
        ];

  const suggestedParts = hasMisfire
    ? [
        { description: "Ignition coil", quantity: 1, unitPrice: 85, fromCatalog: false, partId: null, quantityOnHand: null, reorderLevel: null, lowStock: null, matchConfidence: null },
        { description: "Spark plug", quantity: 4, unitPrice: 14, fromCatalog: false, partId: null, quantityOnHand: null, reorderLevel: null, lowStock: null, matchConfidence: null },
      ]
    : [
        { description: "Throttle body cleaner", quantity: 1, unitPrice: 10, fromCatalog: false, partId: null, quantityOnHand: null, reorderLevel: null, lowStock: null, matchConfidence: null },
      ];

  return AiDiagnoseResponse.parse({
    summary: `Offline diagnosis for ${input.vehicleMake ?? "vehicle"} ${input.vehicleModel ?? ""}.`,
    severity: hasMisfire ? "high" : "medium",
    possibleCauses,
    recommendedRepairs: [
      {
        repair: "Perform visual inspection and scan-tool live data review",
        urgency: "soon",
        estimatedLaborHours: 1,
      },
      {
        repair: "Execute pinpoint tests for confirmed suspect subsystem",
        urgency: "soon",
        estimatedLaborHours: 1.5,
      },
    ],
    suggestedParts,
    diagnosticSteps: [
      "Confirm complaint and capture freeze-frame/live data.",
      "Inspect power/ground/connectors for affected components.",
      "Run low-cost verification tests before replacing parts.",
    ],
    safetyNotes: "Use proper PPE and disconnect battery before high-current component service.",
    confidence: "low",
    disclaimer: `${DIAGNOSIS_DISCLAIMER} Running in offline fallback mode.`,
  });
}

function localAssistantReply(question: string): string {
  const q = question.toLowerCase();
  if (q.includes("misfire")) {
    return [
      "Offline triage for misfire:",
      "1. Confirm DTC/freeze-frame and identify affected cylinder.",
      "2. Swap coil/plug between cylinders and recheck misfire counter.",
      "3. If misfire stays, test injector pulse and compression.",
      "4. Quote only after root cause is verified.",
    ].join("\n");
  }
  if (q.includes("estimate") || q.includes("quote")) {
    return [
      "Offline estimate workflow:",
      "1. Define labor operations and overlap adjustments.",
      "2. Validate parts list with fitment and stock.",
      "3. Apply shop matrix and taxes.",
      "4. Add explicit assumptions and exclusions.",
    ].join("\n");
  }
  return [
    "Offline assistant response:",
    "- I can still help with diagnostic flow, estimate structuring, and repair planning.",
    "- For exact specs/torques, confirm with OEM service information.",
    "- Share DTCs, symptoms, and vehicle details for a tighter recommendation.",
  ].join("\n");
}

// POST /ai/labor-estimate — vehicle + job description -> labor hours + parts.
router.post("/ai/labor-estimate", aiLimiter, async (req, res) => {
  const parsed = AiLaborEstimateBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const input = parsed.data;

  try {
    const result = await runLaborEstimate(input);

    // Pull real shop pricing in from the parts catalog where a suggested part
    // matches an inventory item; otherwise keep the AI's estimated unit price.
    // Mirrors /ai/diagnose: only users with the `inventory` permission (or
    // admins) may receive catalog prices, part IDs, or the fromCatalog flag, so
    // a workOrders-only caller can't probe inventory data through this endpoint.
    const callerHasInventory =
      req.currentUser?.role === "admin" ||
      (req.currentUser?.permissions ?? []).includes("inventory");

    let catalog: CatalogPart[] = [];
    if (callerHasInventory) {
      catalog = await loadCatalog();
    }

    const parts = result.parts.map((p) => {
      const match = callerHasInventory
        ? matchCatalogPart(p.description, catalog)
        : null;
      // Only firm (high/medium) matches adopt catalog pricing; low-confidence
      // matches keep the AI's estimated price but still surface the suspected
      // part id and confidence so the UI can flag them as estimates, not quotes.
      const useCatalogPrice =
        match !== null &&
        (match.confidence === "high" || match.confidence === "medium");
      const unitPrice = round2(
        useCatalogPrice ? match.part.unitPrice : p.unitPrice,
      );
      return {
        description: p.description,
        quantity: p.quantity,
        unitPrice,
        total: round2(p.quantity * unitPrice),
        fromCatalog: useCatalogPrice,
        partId: match ? match.part.id : null,
        quantityOnHand: match ? match.part.quantityOnHand : null,
        reorderLevel: match ? match.part.reorderLevel : null,
        lowStock: match
          ? match.part.quantityOnHand <= match.part.reorderLevel
          : null,
        matchConfidence: match ? match.confidence : null,
      };
    });

    // Recompute the totals so adopting catalog pricing keeps the estimate's
    // parts/grand totals internally consistent with the per-line unit prices.
    const partsTotal = round2(parts.reduce((sum, p) => sum + p.total, 0));
    const grandTotal = round2(result.laborTotal + partsTotal);

    res.json(
      AiLaborEstimateResponse.parse({
        ...result,
        parts,
        partsTotal,
        grandTotal,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "AI labor estimate failed");
    if (err instanceof LaborEstimateError || isProviderConnectivityError(err)) {
      res.json(localLaborEstimate(input));
      return;
    }
    throw err;
  }
});

// POST /ai/diagnose — DTC codes / symptoms + vehicle -> likely causes & repairs.
router.post("/ai/diagnose", aiLimiter, async (req, res) => {
  const parsed = AiDiagnoseBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const input = parsed.data;
  const dtcCodes = (input.dtcCodes ?? [])
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length > 0);
  const symptoms = input.symptoms?.trim() ?? "";

  if (dtcCodes.length === 0 && symptoms.length === 0) {
    res
      .status(400)
      .json({ error: "Provide at least one DTC code or a symptom description" });
    return;
  }

  const prompt = [
    `Vehicle: ${vehicleLine(input)}.`,
    dtcCodes.length ? `Diagnostic trouble codes: ${dtcCodes.join(", ")}.` : null,
    symptoms ? `Reported symptoms: ${symptoms}.` : null,
    "Provide the most likely causes (ranked), an overall severity, recommended repairs with estimated labor hours and urgency, and a logical diagnostic sequence a technician should follow.",
    "Also list the parts and materials typically required to perform the recommended repairs, each with a quantity and a realistic per-unit price in USD. Do not include labor as a part line item.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const openai = await getOpenAiClient();
    const completion = await openai.chat.completions.create(
      {
        model: MODEL,
        max_completion_tokens: 8192,
        messages: [
          {
            role: "system",
            content:
              "You are a master automotive diagnostic technician. Given trouble codes and symptoms, reason about likely root causes and a safe, cost-effective diagnostic path. Respond only with the structured JSON requested.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "diagnosis",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: [
                "summary",
                "severity",
                "possibleCauses",
                "recommendedRepairs",
                "suggestedParts",
                "diagnosticSteps",
                "safetyNotes",
                "confidence",
              ],
              properties: {
                summary: { type: "string" },
                severity: {
                  type: "string",
                  enum: ["low", "medium", "high", "critical"],
                },
                possibleCauses: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["cause", "likelihood", "explanation"],
                    properties: {
                      cause: { type: "string" },
                      likelihood: {
                        type: "string",
                        enum: ["high", "medium", "low"],
                      },
                      explanation: { type: "string" },
                    },
                  },
                },
                recommendedRepairs: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["repair", "urgency", "estimatedLaborHours"],
                    properties: {
                      repair: { type: "string" },
                      urgency: {
                        type: "string",
                        enum: ["routine", "soon", "immediate"],
                      },
                      estimatedLaborHours: { type: "number" },
                    },
                  },
                },
                suggestedParts: {
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
                diagnosticSteps: { type: "array", items: { type: "string" } },
                safetyNotes: { type: ["string", "null"] },
                confidence: { type: "string", enum: ["low", "medium", "high"] },
              },
            },
          },
        },
      },
      REQUEST_OPTIONS,
    );

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      res.status(502).json({ error: "AI provider returned an empty response" });
      return;
    }
    const ai = JSON.parse(content);

    // Pull real shop pricing in from the parts catalog where a suggested part
    // matches an inventory item; otherwise keep the AI's estimated unit price.
    // Only users with the `inventory` permission (or admins) may receive catalog
    // prices, part IDs, or the fromCatalog flag — a workOrders-only caller must
    // not be able to probe inventory data through this endpoint.
    const callerHasInventory =
      req.currentUser?.role === "admin" ||
      (req.currentUser?.permissions ?? []).includes("inventory");

    let catalog: CatalogPart[] = [];
    if (callerHasInventory) {
      catalog = await loadCatalog();
    }

    const suggestedParts = (
      (ai.suggestedParts ?? []) as Array<{
        description: string;
        quantity: number;
        unitPrice: number;
      }>
    ).map((p) => {
      const match = callerHasInventory
        ? matchCatalogPart(p.description, catalog)
        : null;
      // Only firm (high/medium) matches adopt catalog pricing; low-confidence
      // matches keep the AI's estimated price but still surface the suspected
      // part id and confidence so the UI can flag them as estimates, not quotes.
      const useCatalogPrice =
        match !== null &&
        (match.confidence === "high" || match.confidence === "medium");
      return {
        description: p.description,
        quantity: round2(p.quantity),
        unitPrice: round2(useCatalogPrice ? match.part.unitPrice : p.unitPrice),
        fromCatalog: useCatalogPrice,
        partId: match ? match.part.id : null,
        quantityOnHand: match ? match.part.quantityOnHand : null,
        reorderLevel: match ? match.part.reorderLevel : null,
        lowStock: match
          ? match.part.quantityOnHand <= match.part.reorderLevel
          : null,
        matchConfidence: match ? match.confidence : null,
      };
    });

    res.json(
      AiDiagnoseResponse.parse({
        ...ai,
        recommendedRepairs: (ai.recommendedRepairs ?? []).map(
          (r: { estimatedLaborHours: number }) => ({
            ...r,
            estimatedLaborHours: round2(r.estimatedLaborHours),
          }),
        ),
        suggestedParts,
        disclaimer: DIAGNOSIS_DISCLAIMER,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "AI diagnosis failed");
    res.json(localDiagnosis(input));
  }
});

// POST /ai/assistant — multi-turn conversational shop assistant. The client sends
// the full message history each turn (the server keeps no conversation state).
router.post("/ai/assistant", aiLimiter, async (req, res) => {
  const parsed = AiAssistantBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const input = parsed.data;

  const hasVehicle =
    input.vehicleYear ||
    input.vehicleMake ||
    input.vehicleModel ||
    input.vehicleEngine ||
    input.mileage;

  const systemContent = [
    "You are an expert master automotive technician assisting the staff of an independent repair shop.",
    "Help with diagnosis, trouble-code interpretation, repair procedures, parts, labor times, and maintenance advice.",
    "Be concise and practical. Use short paragraphs and bullet lists. Use Markdown for structure.",
    "When suggesting a diagnostic path, give the most likely cause first and the cheapest/fastest checks before expensive ones.",
    "Call out any safety hazards clearly. Never invent exact torque specs, fluid capacities, or part numbers — tell the user to confirm against service information when precision matters.",
    "If the question is unrelated to vehicles or shop operations, briefly redirect to automotive topics.",
    hasVehicle ? `The technician is working on: ${vehicleLine(input)}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const messages = [
    { role: "system" as const, content: systemContent },
    ...input.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    const openai = await getOpenAiClient();
    const completion = await openai.chat.completions.create(
      {
        model: MODEL,
        max_completion_tokens: 4096,
        messages,
      },
      REQUEST_OPTIONS,
    );

    const reply = completion.choices[0]?.message?.content?.trim();
    if (!reply) {
      res.status(502).json({ error: "AI provider returned an empty response" });
      return;
    }

    res.json(
      AiAssistantResponse.parse({
        reply,
        disclaimer: ASSISTANT_DISCLAIMER,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "AI assistant failed");
    const last = input.messages[input.messages.length - 1]?.content ?? "";
    res.json(
      AiAssistantResponse.parse({
        reply: localAssistantReply(last),
        disclaimer: OFFLINE_ASSISTANT_DISCLAIMER,
      }),
    );
  }
});

export default router;
