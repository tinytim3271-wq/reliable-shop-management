import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// Once a SECOND invoice is generated from a work order whose tracked labor was
// already billed on an earlier invoice, the new invoice's detail endpoint must
// surface that prior billing (priorBilledLabor) so the invoice screen and PDF
// can note "X hrs of labor previously billed on INV-#### for this work order"
// and staff/customers can reconcile without double-counting. Only the
// "Tracked labor time" labor lines on earlier, non-void linked invoices count.

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

async function billLabor(workOrderId: number, hours: number): Promise<number> {
  const res = await adminPost("/api/invoices").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    workOrderId,
    status: "draft",
    lineItems: [],
    laborHours: hours,
    laborRate: 100,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createEstimate(workOrderId: number | null): Promise<number> {
  const res = await adminPost("/api/estimates").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    ...(workOrderId === null ? {} : { workOrderId }),
    status: "draft",
    lineItems: [
      { type: "labor", description: "Quoted labor", quantity: 1, unitPrice: 100 },
    ],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("invoice priorBilledLabor", () => {
  it("is empty for an invoice with no linked work order", async () => {
    const res = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "draft",
      lineItems: [
        { type: "labor", description: "Diagnostic", quantity: 1, unitPrice: 100 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.priorBilledLabor).toEqual([]);
  });

  it("is empty for the first invoice billed from a work order", async () => {
    const workOrderId = await createWorkOrder();
    const invId = await billLabor(workOrderId, 2.5);

    const detail = await adminGet(`/api/invoices/${invId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.priorBilledLabor).toEqual([]);
  });

  it("notes labor billed on the earlier invoice for a second bill", async () => {
    const workOrderId = await createWorkOrder();
    const firstId = await billLabor(workOrderId, 2.5);
    const secondId = await billLabor(workOrderId, 1);

    const detail = await adminGet(`/api/invoices/${secondId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.priorBilledLabor).toEqual([
      { invoiceId: firstId, number: `INV-${2000 + firstId}`, hours: 2.5 },
    ]);

    // The earlier invoice still reports no prior labor (nothing before it).
    const first = await adminGet(`/api/invoices/${firstId}`);
    expect(first.body.priorBilledLabor).toEqual([]);
  });

  it("lists every earlier invoice that billed labor", async () => {
    const workOrderId = await createWorkOrder();
    const firstId = await billLabor(workOrderId, 1);
    const secondId = await billLabor(workOrderId, 0.5);
    const thirdId = await billLabor(workOrderId, 2);

    const detail = await adminGet(`/api/invoices/${thirdId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.priorBilledLabor).toEqual([
      { invoiceId: firstId, number: `INV-${2000 + firstId}`, hours: 1 },
      { invoiceId: secondId, number: `INV-${2000 + secondId}`, hours: 0.5 },
    ]);
  });

  it("excludes voided earlier invoices", async () => {
    const workOrderId = await createWorkOrder();
    const firstId = await billLabor(workOrderId, 3);
    const secondId = await billLabor(workOrderId, 1);

    const voided = await adminPatch(`/api/invoices/${firstId}`).send({
      status: "void",
    });
    expect(voided.status).toBe(200);

    const detail = await adminGet(`/api/invoices/${secondId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.priorBilledLabor).toEqual([]);
  });

  it("ignores manually-added labor lines on earlier invoices", async () => {
    const workOrderId = await createWorkOrder();

    const manual = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "draft",
      lineItems: [
        { type: "labor", description: "Custom diagnostic", quantity: 4, unitPrice: 50 },
      ],
    });
    expect(manual.status).toBe(201);

    const secondId = await billLabor(workOrderId, 1.5);
    const detail = await adminGet(`/api/invoices/${secondId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.priorBilledLabor).toEqual([]);
  });
});

describe("estimate -> invoice convert priorBilledLabor", () => {
  it("notes labor already billed on the linked work order at convert time", async () => {
    const workOrderId = await createWorkOrder();
    const firstId = await billLabor(workOrderId, 2);

    const estimateId = await createEstimate(workOrderId);
    const converted = await adminPost(
      `/api/estimates/${estimateId}/convert-to-invoice`,
    ).send({});
    expect(converted.status).toBe(201);

    // The convert response must surface prior-billed labor immediately, not an
    // empty array that only fills in on the next invoice-detail fetch.
    const expected = [
      { invoiceId: firstId, number: `INV-${2000 + firstId}`, hours: 2 },
    ];
    expect(converted.body.priorBilledLabor).toEqual(expected);

    // ...and it matches what the invoice-detail GET would return for the same
    // linked work order (no refresh required).
    const detail = await adminGet(`/api/invoices/${converted.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.priorBilledLabor).toEqual(converted.body.priorBilledLabor);
  });

  it("is empty when the estimate has no linked work order", async () => {
    const estimateId = await createEstimate(null);
    const converted = await adminPost(
      `/api/estimates/${estimateId}/convert-to-invoice`,
    ).send({});
    expect(converted.status).toBe(201);
    expect(converted.body.priorBilledLabor).toEqual([]);
  });
});
