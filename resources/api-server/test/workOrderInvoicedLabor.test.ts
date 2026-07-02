import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// Generating an invoice from a work order can bill the tracked labor time as a
// priced "Tracked labor time" labor line. When staff generate a SECOND invoice
// from the same work order, the detail endpoint must report how much tracked
// labor was already billed (invoicedLaborHours) so the UI can warn and default
// the next bill's suggested hours to the un-billed remainder. Voided invoices
// must not count toward the already-billed total.

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
    lineItems: [],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("work order invoicedLaborHours", () => {
  it("reports zero when no labor has been billed yet", async () => {
    const workOrderId = await createWorkOrder();
    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.status).toBe(200);
    expect(wo.body.invoicedLaborHours).toBe(0);
  });

  it("sums tracked labor hours billed on prior invoices", async () => {
    const workOrderId = await createWorkOrder();

    const inv = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "draft",
      lineItems: [],
      laborHours: 2.5,
      laborRate: 100,
    });
    expect(inv.status).toBe(201);
    expect(
      inv.body.lineItems.some(
        (li: { description: string }) => li.description === "Tracked labor time",
      ),
    ).toBe(true);

    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.status).toBe(200);
    expect(wo.body.invoicedLaborHours).toBe(2.5);
  });

  it("accumulates across multiple invoices for the same work order", async () => {
    const workOrderId = await createWorkOrder();

    for (const hours of [1, 0.75]) {
      const inv = await adminPost("/api/invoices").send({
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        workOrderId,
        status: "draft",
        lineItems: [],
        laborHours: hours,
        laborRate: 80,
      });
      expect(inv.status).toBe(201);
    }

    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.status).toBe(200);
    expect(wo.body.invoicedLaborHours).toBe(1.75);
  });

  it("excludes voided invoices from the already-billed total", async () => {
    const workOrderId = await createWorkOrder();

    const inv = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "draft",
      lineItems: [],
      laborHours: 3,
      laborRate: 90,
    });
    expect(inv.status).toBe(201);

    const before = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(before.body.invoicedLaborHours).toBe(3);

    const voided = await adminPatch(`/api/invoices/${inv.body.id}`).send({
      status: "void",
    });
    expect(voided.status).toBe(200);

    const after = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(after.status).toBe(200);
    expect(after.body.invoicedLaborHours).toBe(0);
  });

  it("does not count manually-added labor lines, only tracked labor time", async () => {
    const workOrderId = await createWorkOrder();

    const inv = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "draft",
      lineItems: [
        { type: "labor", description: "Custom diagnostic", quantity: 4, unitPrice: 50 },
      ],
    });
    expect(inv.status).toBe(201);

    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.status).toBe(200);
    expect(wo.body.invoicedLaborHours).toBe(0);
  });
});
