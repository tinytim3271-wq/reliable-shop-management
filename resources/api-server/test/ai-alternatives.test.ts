import { beforeEach, describe, expect, it, vi } from "vitest";

// When the model resolves a write from an ambiguous record lookup (several
// similarly-named parts match "brake pad"), it lists the other top candidate
// labels in the write tool's `alternatives` argument. The agent loop must:
//   - surface those labels on the pending confirmation so the client can read
//     them back when the user rejects the best guess, and
//   - keep `alternatives` out of the tool's executed args (it is advertised on
//     the JSON schema but never part of the tool's argsSchema).
// A separate file keeps a fresh per-IP rate-limit budget (see ai-stock-movement).

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import { db, partsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { agent, seedStaffUser, seedPart } from "./helpers";

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
  return agent().post(path).set("Cookie", cookie).set("X-Forwarded-Proto", "https");
}

beforeEach(() => {
  mockedCreate.mockReset();
});

describe("AI write staging surfaces ambiguous-match alternatives", () => {
  it("returns the model-supplied alternatives on the pending action", async () => {
    const invStaff = await seedStaffUser(["inventory"], "alt-staff");
    const part = await seedPart({
      name: "Front brake pads",
      quantityOnHand: 5,
      reorderLevel: 0,
    });

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("update_part", {
        id: part.id,
        quantityOnHand: 12,
        alternatives: ["Rear brake pads", "Bosch brake set"],
      }),
    );
    const turn = await post("/api/ai/agent/message", invStaff.cookie).send({
      message: "Set the brake pads stock to 12.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");
    expect(turn.body.pendingAction.alternatives).toEqual([
      "Rear brake pads",
      "Bosch brake set",
    ]);

    // The executed args must not carry `alternatives`: approving applies the
    // real stock change and nothing else.
    mockedCreate.mockResolvedValueOnce(finalCompletion("Done, stock is now 12."));
    const res = await post("/api/ai/agent/confirm", invStaff.cookie).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    const [row] = await db
      .select()
      .from(partsTable)
      .where(eq(partsTable.id, part.id));
    expect(row.quantityOnHand).toBe(12);
  });

  it("sanitizes alternatives: trims, drops empties, dedupes, caps at 3", async () => {
    const invStaff = await seedStaffUser(["inventory"], "alt-sanitize");
    const part = await seedPart({
      name: "Oil filter",
      quantityOnHand: 3,
      reorderLevel: 0,
    });

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("update_part", {
        id: part.id,
        quantityOnHand: 9,
        alternatives: [
          "  Cabin filter  ",
          "",
          "Cabin filter",
          "Air filter",
          "Fuel filter",
        ],
      }),
    );
    const turn = await post("/api/ai/agent/message", invStaff.cookie).send({
      message: "Set the filter stock to 9.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.pendingAction.alternatives).toEqual([
      "Cabin filter",
      "Air filter",
      "Fuel filter",
    ]);
  });

  it("omits alternatives entirely on an unambiguous match", async () => {
    const invStaff = await seedStaffUser(["inventory"], "alt-none");
    const part = await seedPart({
      name: "Serpentine belt",
      quantityOnHand: 2,
      reorderLevel: 0,
    });

    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("update_part", { id: part.id, quantityOnHand: 7 }),
    );
    const turn = await post("/api/ai/agent/message", invStaff.cookie).send({
      message: "Set the serpentine belt stock to 7.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.pendingAction.alternatives).toBeUndefined();
  });
});
