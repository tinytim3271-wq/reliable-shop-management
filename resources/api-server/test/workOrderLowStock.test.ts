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

// A work order has no line-item model of its own; parts are billed through a
// linked invoice (invoice.workOrderId). When that invoice commits stock and a
// matched catalog part lands at/below its reorder level, the work-order detail
// must surface the same reorder nudge the invoice already shows — so staff
// working from the work-order screen get the signal too. These tests pin that
// behavior, that drafts surface nothing, and that the numeric counts respect the
// inventory permission boundary (null for non-inventory callers).

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (
  t: ReturnType<ReturnType<typeof agent>["get"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const adminGet = (path: string) => withAuth(agent().get(path), admin.cookie);
const adminPost = (path: string) => withAuth(agent().post(path), admin.cookie);
const adminPatch = (path: string) => withAuth(agent().patch(path), admin.cookie);

async function createWorkOrder(): Promise<number> {
  const res = await adminPost("/api/work-orders").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    title: uniqueName("WO"),
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("work order surfaces reorder nudge after billing", () => {
  it("flags a part that drops to its reorder level once the linked invoice is billed", async () => {
    const part = await seedPart({
      name: uniqueName("WO Brake Pad"),
      quantityOnHand: 5,
      reorderLevel: 2,
    });
    const workOrderId = await createWorkOrder();

    // Bill 3 of 5 → 2 remaining, which is at the reorder level.
    const inv = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(inv.status).toBe(201);

    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.status).toBe(200);
    expect(wo.body.lowStockItems).toEqual([
      { partId: part.id, description: part.name, remaining: 2, reorderLevel: 2, dismissed: false },
    ]);
  });

  it("does not flag while the linked invoice is still a draft (no stock deducted)", async () => {
    const part = await seedPart({
      name: uniqueName("WO Draft Part"),
      quantityOnHand: 3,
      reorderLevel: 2,
    });
    const workOrderId = await createWorkOrder();

    const inv = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      lineItems: [{ description: part.name, type: "part", quantity: 2, unitPrice: 20 }],
    });
    expect(inv.status).toBe(201);
    expect(inv.body.status).toBe("draft");

    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.status).toBe(200);
    expect(wo.body.lowStockItems).toEqual([]);
  });

  it("does not flag a part still comfortably above its reorder level", async () => {
    const part = await seedPart({
      name: uniqueName("WO Plenty Part"),
      quantityOnHand: 20,
      reorderLevel: 2,
    });
    const workOrderId = await createWorkOrder();

    const inv = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 1, unitPrice: 20 }],
    });
    expect(inv.status).toBe(201);

    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.status).toBe(200);
    expect(wo.body.lowStockItems).toEqual([]);
  });

  it("redacts the numeric counts for a caller without the inventory permission", async () => {
    const part = await seedPart({
      name: uniqueName("WO Redact Part"),
      quantityOnHand: 4,
      reorderLevel: 2,
    });
    const workOrderId = await createWorkOrder();

    const inv = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 2, unitPrice: 20 }],
    });
    expect(inv.status).toBe(201);

    // A workOrders-only staff caller (no inventory) still sees the nudge but not
    // the live counts, mirroring the invoice redaction.
    const staff = await seedStaffUser(["workOrders"], "wo-only");
    const wo = await withAuth(agent().get(`/api/work-orders/${workOrderId}`), staff.cookie);
    expect(wo.status).toBe(200);
    expect(wo.body.lowStockItems).toEqual([
      { partId: null, description: part.name, remaining: null, reorderLevel: null, dismissed: false },
    ]);
  });
});
