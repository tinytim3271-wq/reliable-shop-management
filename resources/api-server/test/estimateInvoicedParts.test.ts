import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  seedStaffUser,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// The estimate detail endpoint exposes `invoicedParts` — an array of parts
// already billed on the linked work order's prior (non-void) invoices. This
// lets the UI warn staff before re-quoting components that were already charged
// on an earlier invoice.  The field is populated by the server-side
// `fetchInvoicedParts` helper (which calls `loadInvoicedParts` in billing.ts)
// and is gated on the `workOrders` permission.

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (
  t: ReturnType<ReturnType<typeof agent>["get"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const adminGet = (path: string) => withAuth(agent().get(path), admin.cookie);
const adminPost = (path: string) => withAuth(agent().post(path), admin.cookie);

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function createEstimate(
  lineItems: { type: string; description: string; quantity: number; unitPrice: number }[],
): Promise<number> {
  const res = await adminPost("/api/estimates").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    status: "draft",
    lineItems,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function convertToWorkOrder(estimateId: number): Promise<number> {
  const res = await adminPost(`/api/estimates/${estimateId}/convert-to-work-order`).send({});
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createInvoiceWithParts(
  workOrderId: number,
  parts: { description: string; quantity: number; unitPrice: number }[],
): Promise<number> {
  const res = await adminPost("/api/invoices").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    workOrderId,
    status: "draft",
    lineItems: parts.map((p) => ({ type: "part", ...p })),
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("estimate invoicedParts field", () => {
  it("is an empty array when the estimate has no linked work order", async () => {
    const estId = await createEstimate([
      { type: "part", description: uniqueName("Brake Pad"), quantity: 2, unitPrice: 25 },
    ]);

    const res = await adminGet(`/api/estimates/${estId}`);
    expect(res.status).toBe(200);
    expect(res.body.invoicedParts).toEqual([]);
  });

  it("is empty when the linked work order has no invoices yet", async () => {
    const estId = await createEstimate([
      { type: "part", description: uniqueName("Filter"), quantity: 1, unitPrice: 15 },
    ]);
    await convertToWorkOrder(estId);

    const res = await adminGet(`/api/estimates/${estId}`);
    expect(res.status).toBe(200);
    expect(res.body.invoicedParts).toEqual([]);
  });

  it("lists parts already billed on the work order after a conversion + invoice cycle", async () => {
    const partName = uniqueName("Oil Filter");
    const estId = await createEstimate([
      { type: "part", description: partName, quantity: 2, unitPrice: 20 },
    ]);
    const workOrderId = await convertToWorkOrder(estId);
    await createInvoiceWithParts(workOrderId, [
      { description: partName, quantity: 2, unitPrice: 20 },
    ]);

    const res = await adminGet(`/api/estimates/${estId}`);
    expect(res.status).toBe(200);
    expect(res.body.invoicedParts).toEqual([
      { description: partName, quantity: 2 },
    ]);
  });

  it("sums quantities across multiple invoices for the same part", async () => {
    const partName = uniqueName("Spark Plug");
    const estId = await createEstimate([
      { type: "part", description: partName, quantity: 4, unitPrice: 8 },
    ]);
    const workOrderId = await convertToWorkOrder(estId);
    // Two separate invoices billing the same part description.
    await createInvoiceWithParts(workOrderId, [
      { description: partName, quantity: 1, unitPrice: 8 },
    ]);
    await createInvoiceWithParts(workOrderId, [
      { description: partName, quantity: 3, unitPrice: 8 },
    ]);

    const res = await adminGet(`/api/estimates/${estId}`);
    expect(res.status).toBe(200);
    expect(res.body.invoicedParts).toEqual([
      { description: partName, quantity: 4 },
    ]);
  });

  it("excludes parts from voided invoices", async () => {
    const partName = uniqueName("Air Filter");
    const estId = await createEstimate([
      { type: "part", description: partName, quantity: 1, unitPrice: 18 },
    ]);
    const workOrderId = await convertToWorkOrder(estId);
    const invId = await createInvoiceWithParts(workOrderId, [
      { description: partName, quantity: 1, unitPrice: 18 },
    ]);

    // Void the invoice.
    const voided = await withAuth(agent().patch(`/api/invoices/${invId}`), admin.cookie).send({
      status: "void",
    });
    expect(voided.status).toBe(200);

    const res = await adminGet(`/api/estimates/${estId}`);
    expect(res.status).toBe(200);
    expect(res.body.invoicedParts).toEqual([]);
  });

  it("returns an empty array to a caller without the workOrders permission", async () => {
    const partName = uniqueName("Wiper Blade");
    const estId = await createEstimate([
      { type: "part", description: partName, quantity: 2, unitPrice: 12 },
    ]);
    const workOrderId = await convertToWorkOrder(estId);
    await createInvoiceWithParts(workOrderId, [
      { description: partName, quantity: 2, unitPrice: 12 },
    ]);

    // Confirm admin sees the billed parts.
    const adminRes = await adminGet(`/api/estimates/${estId}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.invoicedParts).toEqual([{ description: partName, quantity: 2 }]);

    // A staff user with estimates but without workOrders sees an empty array.
    const noWoUser = await seedStaffUser(["estimates", "customers"]);
    const staffRes = await withAuth(agent().get(`/api/estimates/${estId}`), noWoUser.cookie);
    expect(staffRes.status).toBe(200);
    expect(staffRes.body.invoicedParts).toEqual([]);
  });

  it("does not include non-part lines (labor/fees) in invoicedParts", async () => {
    const estId = await createEstimate([
      { type: "labor", description: "Brake job", quantity: 2, unitPrice: 100 },
    ]);
    const workOrderId = await convertToWorkOrder(estId);

    // Bill a labor line and a fee on the invoice — neither should appear in invoicedParts.
    const res = await adminPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "draft",
      lineItems: [
        { type: "labor", description: "Brake job", quantity: 2, unitPrice: 100 },
        { type: "fee", description: "Shop supplies", quantity: 1, unitPrice: 5 },
      ],
    });
    expect(res.status).toBe(201);

    const estRes = await adminGet(`/api/estimates/${estId}`);
    expect(estRes.status).toBe(200);
    expect(estRes.body.invoicedParts).toEqual([]);
  });
});
