import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting an inventory part is an inventory-mutation path: it drops the part's
// on-hand count to zero. Like the update_part and manual-edit paths, it must
// leave an audit trail in the stock_movements ledger. The movement's partId FK
// is ON DELETE SET NULL (not cascade), so the row written here survives the very
// delete it records; the part's name/SKU are snapshotted inline so the audit log
// keeps a readable identity after the part is gone.
//
// This lives in its own file (not ai-staff-access.test.ts) because the agent
// message/confirm routes share a per-IP rate limiter (30 requests / 5 min); a
// separate file gets a fresh budget.

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import { db, partsTable, stockMovementsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { agent, seedAdmin, seedStaffUser, seedPart, uniqueName } from "./helpers";

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

describe("AI delete_part records a stock movement that survives the delete", () => {
  it("writes a 'Part deleted' movement with the removed on-hand qty and acting user", async () => {
    const invStaff = await seedStaffUser(["inventory"], "inv-deletepart");
    const part = await seedPart({
      name: uniqueName("AI Delete Part"),
      quantityOnHand: 9,
      reorderLevel: 0,
    });

    // First turn: the model asks to delete the part, which the agent stages as a
    // pending action awaiting confirmation.
    mockedCreate.mockResolvedValueOnce(
      toolCallCompletion("delete_part", { id: part.id }),
    );
    const turn = await post("/api/ai/agent/message", invStaff.cookie).send({
      message: "Delete that part.",
    });
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe("awaiting_confirmation");

    // Approve: the tool executes the delete and the loop returns a final reply.
    mockedCreate.mockResolvedValueOnce(finalCompletion("Done, the part is gone."));
    const res = await post("/api/ai/agent/confirm", invStaff.cookie).send({
      conversationId: turn.body.conversationId,
      pendingActionId: turn.body.pendingAction.id,
      decision: "approve",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("final");

    // The part row is gone...
    const remainingParts = await db
      .select({ id: partsTable.id })
      .from(partsTable)
      .where(eq(partsTable.id, part.id));
    expect(remainingParts).toHaveLength(0);

    // ...but the deletion movement survives, with its FK nulled out and the
    // part's identity preserved inline.
    const moves = await db
      .select()
      .from(stockMovementsTable)
      .where(eq(stockMovementsTable.partName, part.name));
    expect(moves).toHaveLength(1);
    expect(moves[0].partId).toBeNull();
    expect(moves[0].delta).toBe(-9);
    expect(moves[0].reason).toBe("Part deleted");
    expect(moves[0].createdByUserId).toBe(invStaff.id);
  });
});

describe("manual DELETE /parts/:id records a 'Part deleted' movement", () => {
  it("mirrors the AI path: writes the negative delta, snapshot, and acting user", async () => {
    const admin = await seedAdmin();
    const part = await seedPart({
      name: uniqueName("Manual Delete Part"),
      quantityOnHand: 4,
      reorderLevel: 0,
    });

    const res = await agent()
      .delete(`/api/parts/${part.id}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(204);

    const remainingParts = await db
      .select({ id: partsTable.id })
      .from(partsTable)
      .where(eq(partsTable.id, part.id));
    expect(remainingParts).toHaveLength(0);

    const moves = await db
      .select()
      .from(stockMovementsTable)
      .where(eq(stockMovementsTable.partName, part.name));
    expect(moves).toHaveLength(1);
    expect(moves[0].partId).toBeNull();
    expect(moves[0].delta).toBe(-4);
    expect(moves[0].reason).toBe("Part deleted");
    expect(moves[0].createdByUserId).toBe(admin.id);
  });

  it("surfaces the deleted part in the stock movement report with its name", async () => {
    const admin = await seedAdmin();
    const partName = uniqueName("Reported Deleted Part");
    const part = await seedPart({
      name: partName,
      quantityOnHand: 6,
      reorderLevel: 0,
    });

    await agent()
      .delete(`/api/parts/${part.id}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https");

    const report = await agent()
      .get("/api/reports/stock-movements")
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(report.status).toBe(200);

    // The orphaned (partId === null) movement still renders its name from the
    // inline snapshot, and the audit row remains visible.
    const row = report.body.rows.find(
      (r: { partName: string; reason: string }) =>
        r.partName === partName && r.reason === "Part deleted",
    );
    expect(row).toBeDefined();
    expect(row.partId).toBeNull();
    expect(row.delta).toBe(-6);
  });
});

// Deleting a part with zero on-hand still records the deletion event so the
// "who deleted it" question is always answerable, even with a zero delta.
describe("deleting a zero-stock part still records the event", () => {
  it("writes a zero-delta 'Part deleted' movement", async () => {
    const admin = await seedAdmin();
    const part = await seedPart({
      name: uniqueName("Zero Stock Delete Part"),
      quantityOnHand: 0,
      reorderLevel: 0,
    });

    await agent()
      .delete(`/api/parts/${part.id}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https");

    const moves = await db
      .select()
      .from(stockMovementsTable)
      .where(eq(stockMovementsTable.partName, part.name));
    expect(moves).toHaveLength(1);
    expect(moves[0].delta).toBe(0);
    expect(moves[0].reason).toBe("Part deleted");
  });
});
