import { beforeEach, describe, expect, it, vi } from "vitest";

// The AI `update_part` write tool must mirror the manual-edit and PO-receive
// paths: changing a part's on-hand count has to write a stock_movements row in
// the same transaction so the AI path can't move stock without an audit trail.
//
// This lives in its own file (not ai-staff-access.test.ts) because the agent
// message/confirm routes share a per-IP rate limiter (30 requests / 5 min); all
// requests in a file share one in-memory limiter, and that suite is already near
// the cap. A separate file gets a fresh budget.

// Mock the OpenAI integration so agent turns never make a real network call and
// the tool/loop output is fully controlled. Mocking the module also sidesteps
// the import-time env checks in the real client.
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import { db, stockMovementsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { agent, seedStaffUser, seedPart } from "./helpers";

const mockedCreate = vi.mocked(openai.chat.completions.create);

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

beforeEach(() => {
  mockedCreate.mockReset();
});

describe("AI update_part records a stock movement when on-hand changes", () => {
  it("writes a movement row attributed to the acting staff user", async () => {
    const invStaff = await seedStaffUser(["inventory"], "inv-stockmove");
    const part = await seedPart({
      name: "AI Stock Part",
      quantityOnHand: 5,
      reorderLevel: 0,
    });

    // First turn: the model asks to bump the part's on-hand count, which the
    // agent stages as a pending action awaiting confirmation.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("update_part", { id: part.id, quantityOnHand: 12 }),
    );
    const turn = await post("/api/ai/agent/message", invStaff.cookie).send({
      message: "Set that part's stock to 12.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");

    // Approve: the tool executes the update and the loop returns a final reply.
    mockedCreate.mockResolvedValueOnce(finalCompletion("Done, stock is now 12."));
    const res = await post("/api/ai/agent/confirm", invStaff.cookie).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    const moves = await db
      .select()
      .from(stockMovementsTable)
      .where(eq(stockMovementsTable.partId, part.id));
    expect(moves).toHaveLength(1);
    expect(moves[0].delta).toBe(7);
    expect(moves[0].reason).toBe("AI assistant adjustment");
    expect(moves[0].createdByUserId).toBe(invStaff.id);
  });

  it("does not write a movement when the on-hand count is unchanged", async () => {
    const invStaff = await seedStaffUser(["inventory"], "inv-nostockmove");
    const part = await seedPart({
      name: "AI Stock Part Unchanged",
      quantityOnHand: 8,
      reorderLevel: 0,
    });

    // Change an unrelated field only; the on-hand count stays the same.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("update_part", { id: part.id, reorderLevel: 3 }),
    );
    const turn = await post("/api/ai/agent/message", invStaff.cookie).send({
      message: "Set that part's reorder level to 3.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");

    mockedCreate.mockResolvedValueOnce(finalCompletion("Reorder level updated."));
    const res = await post("/api/ai/agent/confirm", invStaff.cookie).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    const moves = await db
      .select()
      .from(stockMovementsTable)
      .where(eq(stockMovementsTable.partId, part.id));
    expect(moves).toEqual([]);
  });
});
