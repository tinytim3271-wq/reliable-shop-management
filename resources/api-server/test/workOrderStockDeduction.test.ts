import { beforeAll, describe, expect, it } from "vitest";
import { eq, desc } from "drizzle-orm";
import { db, partsTable, stockMovementsTable } from "@workspace/db";
import {
  agent,
  seedAdmin,
  seedStaffUser,
  seedCustomerVehicle,
  seedPart,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// Adding a part to a work order can optionally pull it from catalog stock
// (deductStock). When it does, the part's quantity_on_hand drops and a matching
// stock_movements ledger row is written in the same transaction, mirroring the
// invoice stockDeducted flow. Edits reverse-then-reapply the deduction and a
// delete restores it, so the ledger never drifts from the count. An over-stock
// guard blocks pulling more than is on hand (unless overridden), and the numeric
// available count is redacted from callers without the inventory permission.

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (
  t: ReturnType<ReturnType<typeof agent>["get"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const adminPost = (path: string) => withAuth(agent().post(path), admin.cookie);
const adminPatch = (path: string) => withAuth(agent().patch(path), admin.cookie);
const adminDelete = (path: string) => withAuth(agent().delete(path), admin.cookie);

const onHand = async (partId: number): Promise<number> => {
  const [p] = await db
    .select({ q: partsTable.quantityOnHand })
    .from(partsTable)
    .where(eq(partsTable.id, partId));
  return p.q;
};

const movements = async (partId: number) =>
  db
    .select()
    .from(stockMovementsTable)
    .where(eq(stockMovementsTable.partId, partId))
    .orderBy(desc(stockMovementsTable.id));

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("work order part stock deduction", () => {
  it("deducts stock and writes a ledger row when created with deductStock", async () => {
    const part = await seedPart({
      name: uniqueName("WO Pull Pad"),
      quantityOnHand: 10,
      reorderLevel: 1,
    });

    const res = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      deductStock: true,
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.stockDeducted).toBe(true);

    expect(await onHand(part.id)).toBe(7);
    const rows = await movements(part.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      delta: -3,
      sourceType: "work_order",
      sourceId: res.body.id,
      createdByUserId: admin.id,
    });
  });

  it("leaves stock untouched when deductStock is omitted (default)", async () => {
    const part = await seedPart({
      name: uniqueName("WO No Pull"),
      quantityOnHand: 5,
      reorderLevel: 1,
    });

    const res = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      lineItems: [{ description: part.name, type: "part", quantity: 2, unitPrice: 20 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.stockDeducted).toBe(false);

    expect(await onHand(part.id)).toBe(5);
    expect(await movements(part.id)).toHaveLength(0);
  });

  it("blocks pulling more than on hand (409) for inventory callers; rejects non-inventory callers with 403", async () => {
    const part = await seedPart({
      name: uniqueName("WO Scarce"),
      quantityOnHand: 2,
      reorderLevel: 0,
    });

    const blocked = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      deductStock: true,
      lineItems: [{ description: part.name, type: "part", quantity: 5, unitPrice: 20 }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/exceed available stock/i);
    expect(blocked.body.overStockItems[0]).toMatchObject({ requested: 5, available: 2 });
    // Nothing was pulled.
    expect(await onHand(part.id)).toBe(2);

    // A caller without the inventory permission cannot deduct stock at all —
    // they are rejected with 403 before the over-stock guard is evaluated.
    // (customers is needed only to link the customer/vehicle FKs.)
    const staff = await seedStaffUser(["workOrders", "customers"], "wo-deduct");
    const rejected = await withAuth(
      agent().post("/api/work-orders"),
      staff.cookie,
    ).send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      deductStock: true,
      lineItems: [{ description: part.name, type: "part", quantity: 5, unitPrice: 20 }],
    });
    expect(rejected.status).toBe(403);
    // Still nothing was pulled.
    expect(await onHand(part.id)).toBe(2);
  });

  it("allows pulling over stock when allowOverStock is set", async () => {
    const part = await seedPart({
      name: uniqueName("WO Override"),
      quantityOnHand: 1,
      reorderLevel: 0,
    });

    const res = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      deductStock: true,
      allowOverStock: true,
      lineItems: [{ description: part.name, type: "part", quantity: 4, unitPrice: 20 }],
    });
    expect(res.status).toBe(201);
    expect(await onHand(part.id)).toBe(-3);
  });

  it("reverses then reapplies the deduction when the quantity is edited", async () => {
    const part = await seedPart({
      name: uniqueName("WO Edit"),
      quantityOnHand: 10,
      reorderLevel: 1,
    });

    const created = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      deductStock: true,
      lineItems: [{ description: part.name, type: "part", quantity: 2, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(await onHand(part.id)).toBe(8);

    const edited = await adminPatch(`/api/work-orders/${created.body.id}`).send({
      lineItems: [{ description: part.name, type: "part", quantity: 5, unitPrice: 20 }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.stockDeducted).toBe(true);
    // 10 - 5, not 10 - 2 - 5 (reverse-then-apply, no double counting).
    expect(await onHand(part.id)).toBe(5);
    // create writes one row (-2); the edit merges reverse (+2) and reapply (-5)
    // into a single net delta row (-3) per part → two ledger rows total.
    const rows = await movements(part.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ delta: -3, sourceType: "work_order" });
  });

  it("allows a notes-only edit of an already-deducted work order near the stock floor", async () => {
    const part = await seedPart({
      name: uniqueName("WO Notes Edit"),
      quantityOnHand: 10,
      reorderLevel: 1,
    });

    // Pull 8 of 10 → on-hand 2, so the full requested qty (8) now exceeds the
    // remaining on-hand. A guard that ignored the prior pull would 409 here.
    const created = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      deductStock: true,
      lineItems: [{ description: part.name, type: "part", quantity: 8, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(await onHand(part.id)).toBe(2);

    const edited = await adminPatch(`/api/work-orders/${created.body.id}`).send({
      notes: "Customer approved the work.",
    });
    expect(edited.status).toBe(200);
    // No line items changed, so stock is unchanged.
    expect(await onHand(part.id)).toBe(2);
  });

  it("allows lowering the quantity on an already-deducted work order", async () => {
    const part = await seedPart({
      name: uniqueName("WO Lower Qty"),
      quantityOnHand: 10,
      reorderLevel: 1,
    });

    const created = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      deductStock: true,
      lineItems: [{ description: part.name, type: "part", quantity: 8, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(await onHand(part.id)).toBe(2);

    // Drop 8 → 5. Net change is +3 back to stock, never an additional pull.
    const edited = await adminPatch(`/api/work-orders/${created.body.id}`).send({
      lineItems: [{ description: part.name, type: "part", quantity: 5, unitPrice: 20 }],
    });
    expect(edited.status).toBe(200);
    expect(await onHand(part.id)).toBe(5);
  });

  it("blocks an already-deducted work order only when the incremental increase exceeds on-hand", async () => {
    const part = await seedPart({
      name: uniqueName("WO Incr Guard"),
      quantityOnHand: 10,
      reorderLevel: 1,
    });

    const created = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      deductStock: true,
      lineItems: [{ description: part.name, type: "part", quantity: 8, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(await onHand(part.id)).toBe(2);

    // Raising 8 → 10 is a +2 incremental pull, exactly the 2 on hand: allowed.
    const ok = await adminPatch(`/api/work-orders/${created.body.id}`).send({
      lineItems: [{ description: part.name, type: "part", quantity: 10, unitPrice: 20 }],
    });
    expect(ok.status).toBe(200);
    expect(await onHand(part.id)).toBe(0);

    // Raising 10 → 11 is a +1 pull with nothing on hand: blocked. Available is
    // reported as the credited capacity (on-hand 0 + prior pull 10 = 10).
    const blocked = await adminPatch(`/api/work-orders/${created.body.id}`).send({
      lineItems: [{ description: part.name, type: "part", quantity: 11, unitPrice: 20 }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.overStockItems[0]).toMatchObject({ requested: 11, available: 10 });
    // The blocked edit committed nothing.
    expect(await onHand(part.id)).toBe(0);
  });

  it("restores stock when deductStock is toggled off", async () => {
    const part = await seedPart({
      name: uniqueName("WO Toggle"),
      quantityOnHand: 6,
      reorderLevel: 1,
    });

    const created = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      deductStock: true,
      lineItems: [{ description: part.name, type: "part", quantity: 2, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(await onHand(part.id)).toBe(4);

    const off = await adminPatch(`/api/work-orders/${created.body.id}`).send({
      deductStock: false,
    });
    expect(off.status).toBe(200);
    expect(off.body.stockDeducted).toBe(false);
    expect(await onHand(part.id)).toBe(6);
  });

  it("restores stock when a deducted work order is deleted", async () => {
    const part = await seedPart({
      name: uniqueName("WO Delete"),
      quantityOnHand: 8,
      reorderLevel: 1,
    });

    const created = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      deductStock: true,
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(await onHand(part.id)).toBe(5);

    const del = await adminDelete(`/api/work-orders/${created.body.id}`);
    expect(del.status).toBe(204);
    expect(await onHand(part.id)).toBe(8);
  });
});
