import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, reorderDismissalsTable } from "@workspace/db";
import { agent, seedAdmin, seedPart, uniqueName, type SeededAdmin } from "./helpers";

// A dismissed "Reorder needed after billing" nudge stays dismissed forever for a
// record. These tests pin the rule that restocking a part back above its reorder
// level clears prior dismissals for that part, so a genuinely new low-stock
// episode later resurfaces instead of staying hidden by the stale dismissal.

let admin: SeededAdmin;

// recordId has no FK, so an arbitrary number stands in for an invoice/work order.
const REC_TYPE = "invoice";
let recId = 9_000_000;

async function seedDismissal(partId: number): Promise<number> {
  recId += 1;
  await db.insert(reorderDismissalsTable).values({
    recordType: REC_TYPE,
    recordId: recId,
    partId,
    dismissedByUserId: admin.id,
  });
  return recId;
}

function countDismissals(partId: number): Promise<number> {
  return db
    .select({ id: reorderDismissalsTable.id })
    .from(reorderDismissalsTable)
    .where(eq(reorderDismissalsTable.partId, partId))
    .then((rows) => rows.length);
}

function patchPart(partId: number, body: Record<string, unknown>) {
  return agent()
    .patch(`/api/parts/${partId}`)
    .set("Cookie", admin.cookie)
    .set("X-Forwarded-Proto", "https")
    .send(body);
}

beforeAll(async () => {
  admin = await seedAdmin();
});

describe("reorder dismissal cleanup on replenishment", () => {
  it("clears prior dismissals when a manual stock edit lifts a part above its reorder level", async () => {
    const part = await seedPart({
      name: uniqueName("Spark Plug"),
      quantityOnHand: 1,
      reorderLevel: 3,
    });
    await seedDismissal(part.id);
    expect(await countDismissals(part.id)).toBe(1);

    const res = await patchPart(part.id, { quantityOnHand: 10 });
    expect(res.status).toBe(200);
    expect(await countDismissals(part.id)).toBe(0);
  });

  it("keeps dismissals when a manual stock edit leaves the part at or below reorder level", async () => {
    const part = await seedPart({
      name: uniqueName("Air Filter"),
      quantityOnHand: 1,
      reorderLevel: 3,
    });
    await seedDismissal(part.id);

    // Still at/below reorder (3) — the low-stock episode is ongoing, so the
    // dismissal must survive.
    const res = await patchPart(part.id, { quantityOnHand: 3 });
    expect(res.status).toBe(200);
    expect(await countDismissals(part.id)).toBe(1);
  });

  it("only clears dismissals for the replenished part, not other parts", async () => {
    const restocked = await seedPart({
      name: uniqueName("Wiper Blade"),
      quantityOnHand: 1,
      reorderLevel: 3,
    });
    const untouched = await seedPart({
      name: uniqueName("Cabin Filter"),
      quantityOnHand: 1,
      reorderLevel: 3,
    });
    await seedDismissal(restocked.id);
    await seedDismissal(untouched.id);

    const res = await patchPart(restocked.id, { quantityOnHand: 8 });
    expect(res.status).toBe(200);
    expect(await countDismissals(restocked.id)).toBe(0);
    expect(await countDismissals(untouched.id)).toBe(1);
  });

  it("clears dismissals when receiving a purchase order lifts a part above its reorder level", async () => {
    const part = await seedPart({
      name: uniqueName("Brake Rotor"),
      quantityOnHand: 1,
      reorderLevel: 3,
    });
    await seedDismissal(part.id);

    const create = await agent()
      .post("/api/purchase-orders")
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({
        vendor: "Test Vendor",
        lineItems: [{ partId: part.id, description: "Brake Rotor", quantity: 5, unitCost: 20 }],
      });
    expect(create.status).toBe(201);
    const poId = create.body.id;

    const received = await agent()
      .patch(`/api/purchase-orders/${poId}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ status: "received" });
    expect(received.status).toBe(200);

    expect(await countDismissals(part.id)).toBe(0);
  });

  it("keeps dismissals when a received PO does not lift the part above reorder level", async () => {
    const part = await seedPart({
      name: uniqueName("Fuel Pump"),
      quantityOnHand: 1,
      reorderLevel: 10,
    });
    const keptRecord = await seedDismissal(part.id);

    const create = await agent()
      .post("/api/purchase-orders")
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({
        vendor: "Test Vendor",
        lineItems: [{ partId: part.id, description: "Fuel Pump", quantity: 2, unitCost: 50 }],
      });
    expect(create.status).toBe(201);

    const received = await agent()
      .patch(`/api/purchase-orders/${create.body.id}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ status: "received" });
    expect(received.status).toBe(200);

    // 1 + 2 = 3, still <= reorder level (10), so the dismissal stays.
    const remaining = await db
      .select({ id: reorderDismissalsTable.id })
      .from(reorderDismissalsTable)
      .where(
        and(
          eq(reorderDismissalsTable.partId, part.id),
          eq(reorderDismissalsTable.recordId, keptRecord),
        ),
      );
    expect(remaining).toHaveLength(1);
  });
});
