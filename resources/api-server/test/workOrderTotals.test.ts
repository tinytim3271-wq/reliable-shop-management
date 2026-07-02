import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// Work orders now carry structured tasks & parts. The detail endpoint must
// expose server-computed running totals (labor / parts / fees split + grand
// total), and generating an invoice from a work order must seed the invoice's
// line items from those tasks & parts so the bill carries them over verbatim.

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (
  t: ReturnType<ReturnType<typeof agent>["get"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const adminGet = (path: string) => withAuth(agent().get(path), admin.cookie);
const adminPost = (path: string) => withAuth(agent().post(path), admin.cookie);

async function createWorkOrder(
  lineItems: { type: string; description: string; quantity: number; unitPrice: number }[],
): Promise<number> {
  const res = await adminPost("/api/work-orders").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    title: uniqueName("WO"),
    lineItems,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("work order totals and invoice seeding", () => {
  it("computes labor/parts/fees subtotals and a grand total server-side", async () => {
    const workOrderId = await createWorkOrder([
      { type: "labor", description: "Diagnose", quantity: 2, unitPrice: 100 },
      { type: "part", description: uniqueName("Filter"), quantity: 3, unitPrice: 10 },
      { type: "fee", description: "Shop supplies", quantity: 1, unitPrice: 5 },
    ]);

    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.status).toBe(200);
    expect(wo.body.totals).toEqual({
      laborTotal: 200,
      partsTotal: 30,
      feesTotal: 5,
      total: 235,
    });
  });

  it("returns zeroed totals when a work order has no line items", async () => {
    const workOrderId = await createWorkOrder([]);
    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.status).toBe(200);
    expect(wo.body.totals).toEqual({
      laborTotal: 0,
      partsTotal: 0,
      feesTotal: 0,
      total: 0,
    });
  });

  it("seeds invoice line items from the work order when none are supplied", async () => {
    const partName = uniqueName("Brake Pad");
    const workOrderId = await createWorkOrder([
      { type: "labor", description: "Replace pads", quantity: 1.5, unitPrice: 120 },
      { type: "part", description: partName, quantity: 2, unitPrice: 40 },
    ]);

    const inv = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "draft",
      lineItems: [],
    });
    expect(inv.status).toBe(201);
    expect(inv.body.lineItems).toHaveLength(2);
    expect(inv.body.lineItems.map((li: { description: string }) => li.description)).toEqual([
      "Replace pads",
      partName,
    ]);
    // 1.5 * 120 + 2 * 40 = 260
    expect(inv.body.subtotal).toBe(260);
    expect(inv.body.total).toBe(260);
  });

  it("advances the source work order to 'invoiced' when an invoice is generated", async () => {
    const workOrderId = await createWorkOrder([
      { type: "labor", description: "Oil change", quantity: 1, unitPrice: 60 },
    ]);

    const before = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(before.status).toBe(200);
    expect(before.body.status).toBe("open");

    const inv = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "draft",
      lineItems: [],
    });
    expect(inv.status).toBe(201);

    const after = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe("invoiced");
  });

  it("does not change work order status for invoices with no work order link", async () => {
    const inv = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "draft",
      lineItems: [{ type: "labor", description: "Standalone", quantity: 1, unitPrice: 20 }],
    });
    expect(inv.status).toBe(201);
    expect(inv.body.workOrderId).toBeNull();
  });

  it("does not override explicitly supplied invoice line items", async () => {
    const workOrderId = await createWorkOrder([
      { type: "labor", description: "WO labor", quantity: 1, unitPrice: 100 },
    ]);

    const inv = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "draft",
      lineItems: [{ type: "labor", description: "Custom line", quantity: 1, unitPrice: 50 }],
    });
    expect(inv.status).toBe(201);
    expect(inv.body.lineItems).toHaveLength(1);
    expect(inv.body.lineItems[0].description).toBe("Custom line");
    expect(inv.body.total).toBe(50);
  });
});
