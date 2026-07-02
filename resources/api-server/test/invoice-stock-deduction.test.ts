import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, partsTable } from "@workspace/db";
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

// Billing a part line should deduct on-hand catalog stock exactly once when the
// invoice reaches a committed (sent/partial/paid) status, and reverse that
// deduction when the invoice is voided, edited, or deleted. These tests pin that
// the running stock count stays trustworthy across the whole invoice lifecycle.

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (t: ReturnType<ReturnType<typeof agent>["get"]>) =>
  t.set("Cookie", admin.cookie).set("X-Forwarded-Proto", "https");
const authGet = (path: string) => withAuth(agent().get(path));
const authPost = (path: string) => withAuth(agent().post(path));
const authPatch = (path: string) => withAuth(agent().patch(path));
const authDelete = (path: string) => withAuth(agent().delete(path));

async function stockOf(partId: number): Promise<number> {
  const res = await authGet(`/api/parts/${partId}`);
  expect(res.status).toBe(200);
  return res.body.quantityOnHand;
}

async function freshPart(qty: number): Promise<{ id: number; name: string }> {
  return seedPart({
    name: uniqueName("Stock Part"),
    quantityOnHand: qty,
    reorderLevel: 0,
  });
}

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("invoice billing deducts catalog stock", () => {
  it("deducts on-hand quantity when an invoice is created in a billed status", async () => {
    const part = await freshPart(10);
    const res = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(res.status).toBe(201);
    expect(await stockOf(part.id)).toBe(7);
  });

  it("does not deduct stock while an invoice is still a draft", async () => {
    const part = await freshPart(10);
    const res = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: part.name, type: "part", quantity: 4, unitPrice: 20 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(await stockOf(part.id)).toBe(10);
  });

  it("deducts stock when a draft invoice is later moved to a billed status", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: part.name, type: "part", quantity: 2, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(await stockOf(part.id)).toBe(10);

    const patched = await authPatch(`/api/invoices/${created.body.id}`).send({ status: "sent" });
    expect(patched.status).toBe(200);
    expect(await stockOf(part.id)).toBe(8);
  });

  it("only deducts once across repeated status transitions and payments", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    await authPatch(`/api/invoices/${id}`).send({ status: "sent" });
    expect(await stockOf(part.id)).toBe(7);

    // Editing an unrelated field while still billed must not double-deduct.
    await authPatch(`/api/invoices/${id}`).send({ notes: "ready for pickup" });
    expect(await stockOf(part.id)).toBe(7);

    // Paying the invoice keeps it committed; stock stays at the single deduction.
    const pay = await authPost(`/api/invoices/${id}/payments`).send({
      amount: created.body.total,
      method: "cash",
    });
    expect(pay.status).toBe(200);
    expect(pay.body.status).toBe("paid");
    expect(await stockOf(part.id)).toBe(7);
  });

  it("restores stock when a billed invoice is voided, and re-deducts if re-billed", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 4, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(await stockOf(part.id)).toBe(6);

    const voided = await authPatch(`/api/invoices/${id}`).send({ status: "void" });
    expect(voided.status).toBe(200);
    expect(await stockOf(part.id)).toBe(10);

    const rebilled = await authPatch(`/api/invoices/${id}`).send({ status: "sent" });
    expect(rebilled.status).toBe(200);
    expect(await stockOf(part.id)).toBe(6);
  });

  it("adjusts the deduction when a billed invoice's part quantity is edited", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 2, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(await stockOf(part.id)).toBe(8);

    // Bump the billed quantity from 2 -> 5: net deduction should now be 5.
    const bumped = await authPatch(`/api/invoices/${id}`).send({
      lineItems: [{ description: part.name, type: "part", quantity: 5, unitPrice: 20 }],
    });
    expect(bumped.status).toBe(200);
    expect(await stockOf(part.id)).toBe(5);

    // Drop the billed quantity from 5 -> 1: stock should recover to 9.
    const dropped = await authPatch(`/api/invoices/${id}`).send({
      lineItems: [{ description: part.name, type: "part", quantity: 1, unitPrice: 20 }],
    });
    expect(dropped.status).toBe(200);
    expect(await stockOf(part.id)).toBe(9);
  });

  it("restores stock when a billed invoice is deleted", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(await stockOf(part.id)).toBe(7);

    const del = await authDelete(`/api/invoices/${created.body.id}`);
    expect(del.status).toBe(204);
    expect(await stockOf(part.id)).toBe(10);
  });

  it("does not change stock when a draft invoice with parts is deleted", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(await stockOf(part.id)).toBe(10);

    const del = await authDelete(`/api/invoices/${created.body.id}`);
    expect(del.status).toBe(204);
    expect(await stockOf(part.id)).toBe(10);
  });

  it("ignores labor lines and only deducts matched part lines", async () => {
    const part = await freshPart(10);
    const res = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [
        { description: "Diagnostic labor", type: "labor", quantity: 2, unitPrice: 90 },
        { description: part.name, type: "part", quantity: 1, unitPrice: 20 },
      ],
    });
    expect(res.status).toBe(201);
    expect(await stockOf(part.id)).toBe(9);
  });
});

describe("invoice billing flags parts at/below reorder level", () => {
  it("flags a part billed down to its reorder level, with numeric counts for inventory callers", async () => {
    const part = await seedPart({
      name: uniqueName("Reorder Part"),
      quantityOnHand: 5,
      reorderLevel: 2,
    });
    const res = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(res.status).toBe(201);
    expect(await stockOf(part.id)).toBe(2);
    expect(res.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 2, reorderLevel: 2, dismissed: false },
    ]);
  });

  it("does not flag a part still above its reorder level", async () => {
    const part = await seedPart({
      name: uniqueName("Healthy Part"),
      quantityOnHand: 20,
      reorderLevel: 2,
    });
    const res = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.lowStockItems).toEqual([]);
  });

  it("does not flag low stock while the invoice is still a draft (nothing deducted yet)", async () => {
    const part = await seedPart({
      name: uniqueName("Draft Reorder Part"),
      quantityOnHand: 3,
      reorderLevel: 5,
    });
    const res = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: part.name, type: "part", quantity: 1, unitPrice: 20 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.lowStockItems).toEqual([]);
  });

  it("rejects a caller without inventory permission from committing stock on an invoice", async () => {
    const part = await seedPart({
      name: uniqueName("Redacted Reorder Part"),
      quantityOnHand: 4,
      reorderLevel: 2,
    });
    // A staff user who can bill invoices/customers but cannot modify inventory.
    const staff = await seedStaffUser(["invoices", "customers"], "no-inventory");
    const res = await agent()
      .post("/api/invoices")
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        status: "sent",
        lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
      });
    // Creating a committed invoice with part line items requires inventory permission.
    expect(res.status).toBe(403);
    // Stock must not have been deducted.
    const [row] = await db.select({ qty: partsTable.quantityOnHand }).from(partsTable).where(eq(partsTable.id, part.id));
    expect(row.qty).toBe(4);
  });

  it("rejects a non-inventory caller from editing line items on a committed invoice even when replacing parts with non-parts", async () => {
    // Create a committed invoice with parts as admin, then try to replace its
    // part lines with a labor line as a non-inventory staff user. The edit
    // would return stock to inventory (reconcile reverses oldItems). The guard
    // must fire even though the *new* line items contain no parts.
    const part = await seedPart({
      name: uniqueName("Edit Bypass Part"),
      quantityOnHand: 5,
      reorderLevel: 0,
    });
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 2, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(await stockOf(part.id)).toBe(3);

    const staff = await seedStaffUser(["invoices", "customers"], "edit-bypass");
    const edited = await agent()
      .patch(`/api/invoices/${created.body.id}`)
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ lineItems: [{ description: "Labor", type: "labor", quantity: 1, unitPrice: 50 }] });
    // Must be rejected — replacing part lines restores stock (inventory mutation).
    expect(edited.status).toBe(403);
    // Stock must remain at the original committed count.
    expect(await stockOf(part.id)).toBe(3);
  });

  it("surfaces the reorder flag when an edit pushes a billed part to its reorder level", async () => {
    const part = await seedPart({
      name: uniqueName("Edit Reorder Part"),
      quantityOnHand: 8,
      reorderLevel: 3,
    });
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 1, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.lowStockItems).toEqual([]);

    const bumped = await authPatch(`/api/invoices/${created.body.id}`).send({
      lineItems: [{ description: part.name, type: "part", quantity: 5, unitPrice: 20 }],
    });
    expect(bumped.status).toBe(200);
    expect(await stockOf(part.id)).toBe(3);
    expect(bumped.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 3, reorderLevel: 3, dismissed: false },
    ]);
  });
});
