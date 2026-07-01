import { beforeAll, describe, expect, it } from "vitest";
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

// Staff can dismiss a low-stock part from the "Reorder needed after billing"
// banner. The dismissal is persisted per-record so it survives a refresh /
// re-visit instead of living only in client state. For inventory-capable
// callers the dismissed part is still returned in lowStockItems, flagged
// `dismissed: true`, so the Dismissed sub-list and its Undo survive a refresh.
// These tests pin that flag, that the dismissal is scoped to the individual
// record (does not bleed across invoices / work orders), that re-dismissing is
// idempotent, and that the action is gated on the inventory permission.

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (
  t: ReturnType<ReturnType<typeof agent>["get"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const adminGet = (path: string) => withAuth(agent().get(path), admin.cookie);
const adminPost = (path: string) => withAuth(agent().post(path), admin.cookie);
const adminDelete = (path: string) => withAuth(agent().delete(path), admin.cookie);

async function createWorkOrder(): Promise<number> {
  const res = await adminPost("/api/work-orders").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    title: uniqueName("WO"),
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createBilledInvoice(
  partName: string,
  quantity: number,
  workOrderId?: number,
): Promise<number> {
  const res = await adminPost("/api/invoices").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    ...(workOrderId != null ? { workOrderId } : {}),
    status: "sent",
    lineItems: [{ description: partName, type: "part", quantity, unitPrice: 20 }],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("invoice reorder dismissals persist", () => {
  it("flags a dismissed part (dismissed: true) on subsequent reads", async () => {
    const part = await seedPart({
      name: uniqueName("Inv Dismiss Part"),
      quantityOnHand: 5,
      reorderLevel: 3,
    });
    const invoiceId = await createBilledInvoice(part.name, 3); // 2 left, at/below reorder

    const before = await adminGet(`/api/invoices/${invoiceId}`);
    expect(before.status).toBe(200);
    expect(before.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 2, reorderLevel: 3, dismissed: false },
    ]);

    const dismiss = await adminPost(`/api/invoices/${invoiceId}/reorder-dismissals`).send({
      partId: part.id,
    });
    expect(dismiss.status).toBe(204);

    // The part is still returned across a fresh read (i.e. a refresh), now
    // flagged dismissed so the Dismissed sub-list and Undo survive.
    const after = await adminGet(`/api/invoices/${invoiceId}`);
    expect(after.status).toBe(200);
    expect(after.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 2, reorderLevel: 3, dismissed: true },
    ]);
  });

  it("is idempotent when the same part is dismissed twice", async () => {
    const part = await seedPart({
      name: uniqueName("Inv Idem Part"),
      quantityOnHand: 4,
      reorderLevel: 3,
    });
    const invoiceId = await createBilledInvoice(part.name, 2);

    const first = await adminPost(`/api/invoices/${invoiceId}/reorder-dismissals`).send({
      partId: part.id,
    });
    expect(first.status).toBe(204);
    const second = await adminPost(`/api/invoices/${invoiceId}/reorder-dismissals`).send({
      partId: part.id,
    });
    expect(second.status).toBe(204);

    const after = await adminGet(`/api/invoices/${invoiceId}`);
    expect(after.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 2, reorderLevel: 3, dismissed: true },
    ]);
  });

  it("scopes the dismissal to the individual invoice", async () => {
    const part = await seedPart({
      name: uniqueName("Inv Scope Part"),
      quantityOnHand: 10,
      reorderLevel: 8,
    });
    const invoiceA = await createBilledInvoice(part.name, 1); // 9 left
    const invoiceB = await createBilledInvoice(part.name, 1); // 8 left

    const dismiss = await adminPost(`/api/invoices/${invoiceA}/reorder-dismissals`).send({
      partId: part.id,
    });
    expect(dismiss.status).toBe(204);

    const a = await adminGet(`/api/invoices/${invoiceA}`);
    expect(a.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 8, reorderLevel: 8, dismissed: true },
    ]);

    // Invoice B still nags (active) about the same part — the dismissal did not bleed over.
    const b = await adminGet(`/api/invoices/${invoiceB}`);
    expect(b.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 8, reorderLevel: 8, dismissed: false },
    ]);
  });

  it("404s for an unknown invoice or part", async () => {
    const part = await seedPart({
      name: uniqueName("Inv 404 Part"),
      quantityOnHand: 4,
      reorderLevel: 3,
    });
    const invoiceId = await createBilledInvoice(part.name, 2);

    const missingInvoice = await adminPost("/api/invoices/99999999/reorder-dismissals").send({
      partId: part.id,
    });
    expect(missingInvoice.status).toBe(404);

    const missingPart = await adminPost(`/api/invoices/${invoiceId}/reorder-dismissals`).send({
      partId: 99999999,
    });
    expect(missingPart.status).toBe(404);
  });

  it("forbids a caller without the inventory permission", async () => {
    const part = await seedPart({
      name: uniqueName("Inv Perm Part"),
      quantityOnHand: 4,
      reorderLevel: 3,
    });
    const invoiceId = await createBilledInvoice(part.name, 2);

    // An invoices-only staff caller can read the invoice but must not be able to
    // dismiss reorder nudges (the feature is inventory-scoped).
    const staff = await seedStaffUser(["invoices"], "inv-only");
    const res = await withAuth(
      agent().post(`/api/invoices/${invoiceId}/reorder-dismissals`),
      staff.cookie,
    ).send({ partId: part.id });
    expect(res.status).toBe(403);
  });

  it("restores a dismissed part back to lowStockItems via undo", async () => {
    const part = await seedPart({
      name: uniqueName("Inv Undo Part"),
      quantityOnHand: 5,
      reorderLevel: 3,
    });
    const invoiceId = await createBilledInvoice(part.name, 3); // 2 left

    const dismiss = await adminPost(`/api/invoices/${invoiceId}/reorder-dismissals`).send({
      partId: part.id,
    });
    expect(dismiss.status).toBe(204);
    const hidden = await adminGet(`/api/invoices/${invoiceId}`);
    expect(hidden.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 2, reorderLevel: 3, dismissed: true },
    ]);

    const restore = await adminDelete(`/api/invoices/${invoiceId}/reorder-dismissals`).send({
      partId: part.id,
    });
    expect(restore.status).toBe(204);

    // The part nags again (active) after the dismissal is undone.
    const after = await adminGet(`/api/invoices/${invoiceId}`);
    expect(after.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 2, reorderLevel: 3, dismissed: false },
    ]);
  });

  it("undo is idempotent and 404s for an unknown invoice", async () => {
    const part = await seedPart({
      name: uniqueName("Inv Undo Idem Part"),
      quantityOnHand: 4,
      reorderLevel: 3,
    });
    const invoiceId = await createBilledInvoice(part.name, 2);

    // Restoring a part that was never dismissed is a no-op, not an error.
    const first = await adminDelete(`/api/invoices/${invoiceId}/reorder-dismissals`).send({
      partId: part.id,
    });
    expect(first.status).toBe(204);

    const missingInvoice = await adminDelete(
      "/api/invoices/99999999/reorder-dismissals",
    ).send({ partId: part.id });
    expect(missingInvoice.status).toBe(404);
  });

  it("forbids undo for a caller without the inventory permission", async () => {
    const part = await seedPart({
      name: uniqueName("Inv Undo Perm Part"),
      quantityOnHand: 4,
      reorderLevel: 3,
    });
    const invoiceId = await createBilledInvoice(part.name, 2);
    await adminPost(`/api/invoices/${invoiceId}/reorder-dismissals`).send({
      partId: part.id,
    });

    const staff = await seedStaffUser(["invoices"], "inv-only-undo");
    const res = await withAuth(
      agent().delete(`/api/invoices/${invoiceId}/reorder-dismissals`),
      staff.cookie,
    ).send({ partId: part.id });
    expect(res.status).toBe(403);
  });
});

describe("work order reorder dismissals persist", () => {
  it("flags a dismissed part (dismissed: true) on the work order's lowStockItems", async () => {
    const part = await seedPart({
      name: uniqueName("WO Dismiss Part"),
      quantityOnHand: 5,
      reorderLevel: 3,
    });
    const workOrderId = await createWorkOrder();
    await createBilledInvoice(part.name, 3, workOrderId); // 2 left

    const before = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(before.status).toBe(200);
    expect(before.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 2, reorderLevel: 3, dismissed: false },
    ]);

    const dismiss = await adminPost(`/api/work-orders/${workOrderId}/reorder-dismissals`).send({
      partId: part.id,
    });
    expect(dismiss.status).toBe(204);

    const after = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(after.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 2, reorderLevel: 3, dismissed: true },
    ]);
  });

  it("does not bleed an invoice dismissal into the linked work order (and vice versa)", async () => {
    const part = await seedPart({
      name: uniqueName("WO Scope Part"),
      quantityOnHand: 5,
      reorderLevel: 4,
    });
    const workOrderId = await createWorkOrder();
    const invoiceId = await createBilledInvoice(part.name, 1, workOrderId); // 4 left

    // Dismiss on the invoice only.
    const dismiss = await adminPost(`/api/invoices/${invoiceId}/reorder-dismissals`).send({
      partId: part.id,
    });
    expect(dismiss.status).toBe(204);

    const inv = await adminGet(`/api/invoices/${invoiceId}`);
    expect(inv.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 4, reorderLevel: 4, dismissed: true },
    ]);

    // The work order still surfaces the nudge as active — dismissals are
    // record-scoped, and an invoice and its work order are distinct records.
    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 4, reorderLevel: 4, dismissed: false },
    ]);
  });

  it("forbids a caller without the inventory permission", async () => {
    const part = await seedPart({
      name: uniqueName("WO Perm Part"),
      quantityOnHand: 4,
      reorderLevel: 3,
    });
    const workOrderId = await createWorkOrder();
    await createBilledInvoice(part.name, 2, workOrderId);

    const staff = await seedStaffUser(["workOrders"], "wo-only-dismiss");
    const res = await withAuth(
      agent().post(`/api/work-orders/${workOrderId}/reorder-dismissals`),
      staff.cookie,
    ).send({ partId: part.id });
    expect(res.status).toBe(403);
  });

  it("restores a dismissed part back to the work order's lowStockItems via undo", async () => {
    const part = await seedPart({
      name: uniqueName("WO Undo Part"),
      quantityOnHand: 5,
      reorderLevel: 3,
    });
    const workOrderId = await createWorkOrder();
    await createBilledInvoice(part.name, 3, workOrderId); // 2 left

    const dismiss = await adminPost(`/api/work-orders/${workOrderId}/reorder-dismissals`).send({
      partId: part.id,
    });
    expect(dismiss.status).toBe(204);
    const hidden = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(hidden.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 2, reorderLevel: 3, dismissed: true },
    ]);

    const restore = await adminDelete(
      `/api/work-orders/${workOrderId}/reorder-dismissals`,
    ).send({ partId: part.id });
    expect(restore.status).toBe(204);

    const after = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(after.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 2, reorderLevel: 3, dismissed: false },
    ]);
  });

  it("forbids work order undo for a caller without the inventory permission", async () => {
    const part = await seedPart({
      name: uniqueName("WO Undo Perm Part"),
      quantityOnHand: 4,
      reorderLevel: 3,
    });
    const workOrderId = await createWorkOrder();
    await createBilledInvoice(part.name, 2, workOrderId);
    await adminPost(`/api/work-orders/${workOrderId}/reorder-dismissals`).send({
      partId: part.id,
    });

    const staff = await seedStaffUser(["workOrders"], "wo-only-undo");
    const res = await withAuth(
      agent().delete(`/api/work-orders/${workOrderId}/reorder-dismissals`),
      staff.cookie,
    ).send({ partId: part.id });
    expect(res.status).toBe(403);
  });
});
