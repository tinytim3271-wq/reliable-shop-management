import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  seedMechanicWithEntry,
  seedPart,
  seedStaffUser,
  seedExpenseCategory,
  seedExpense,
  seedIssuedInvoice,
  seedInvoicePayment,
  seedLaborSession,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";
import { TOOLS, type AiToolContext } from "../src/lib/aiTools";

// Round to cents so delta comparisons are not tripped by float drift.
const round = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

let admin: SeededAdmin;
let shop: SeededShop;

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

const withAuth = (t: ReturnType<ReturnType<typeof agent>["get"]>) =>
  t.set("Cookie", admin.cookie).set("X-Forwarded-Proto", "https");
const authGet = (path: string) => withAuth(agent().get(path));
const authPost = (path: string) => withAuth(agent().post(path));
const authPut = (path: string) => withAuth(agent().put(path));
const authPatch = (path: string) => withAuth(agent().patch(path));

describe("auth gate", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await agent().get("/api/invoices");
    expect(res.status).toBe(401);
  });
});

describe("bad foreign keys are caught before they save", () => {
  it("rejects an estimate with a nonexistent customer as a clean 400 (no 500/SQL leak)", async () => {
    const res = await authPost("/api/estimates")
      .send({
        customerId: 999_999_999,
        vehicleId: shop.vehicleId,
        lineItems: [{ description: "Diagnostic", quantity: 1, unitPrice: 50 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer not found/i);
  });

  it("rejects an estimate with a nonexistent vehicle as a clean 400", async () => {
    const res = await authPost("/api/estimates")
      .send({
        customerId: shop.customerId,
        vehicleId: 999_999_999,
        lineItems: [{ description: "Diagnostic", quantity: 1, unitPrice: 50 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vehicle not found/i);
  });

  it("rejects an invoice with a nonexistent customer as a clean 400", async () => {
    const res = await authPost("/api/invoices")
      .send({
        customerId: 999_999_999,
        vehicleId: shop.vehicleId,
        lineItems: [{ description: "Brake pads", type: "part", quantity: 1, unitPrice: 80 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer not found/i);
  });

  it("creates a valid invoice with good foreign keys (201)", async () => {
    const res = await authPost("/api/invoices")
      .send({
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        lineItems: [{ description: "Brake pads", type: "part", quantity: 1, unitPrice: 80 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTypeOf("number");
    expect(res.body.total).toBe(80);
  });
});

describe("estimate detail exposes catalog stock on part line items", () => {
  it("attaches partId/quantityOnHand/lowStock to matched parts and nulls otherwise", async () => {
    const overStockPart = await seedPart({
      name: uniqueName("Brake Pads"),
      quantityOnHand: 2,
      reorderLevel: 1,
      unitPrice: 40,
    });
    const lowStockPart = await seedPart({
      name: uniqueName("Oil Filter"),
      quantityOnHand: 3,
      reorderLevel: 5,
      unitPrice: 12,
    });

    const created = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      // This line intentionally exceeds stock to verify the detail endpoint
      // surfaces stock info; the over-stock guard is bypassed with the override.
      allowOverStock: true,
      lineItems: [
        { description: overStockPart.name, type: "part", quantity: 5, unitPrice: 40 },
        { description: lowStockPart.name, type: "part", quantity: 1, unitPrice: 12 },
        { description: "Diagnostic labor", type: "labor", quantity: 1, unitPrice: 90 },
        { description: "Unknown widget", type: "part", quantity: 1, unitPrice: 9 },
      ],
    });
    expect(created.status).toBe(201);

    const res = await authGet(`/api/estimates/${created.body.id}`);
    expect(res.status).toBe(200);
    const items = res.body.lineItems as Array<Record<string, unknown>>;

    const over = items.find((li) => li.description === overStockPart.name)!;
    expect(over.partId).toBe(overStockPart.id);
    expect(over.quantityOnHand).toBe(2);
    expect(over.lowStock).toBe(false);

    const low = items.find((li) => li.description === lowStockPart.name)!;
    expect(low.partId).toBe(lowStockPart.id);
    expect(low.quantityOnHand).toBe(3);
    expect(low.lowStock).toBe(true);

    const labor = items.find((li) => li.description === "Diagnostic labor")!;
    expect(labor.partId).toBeNull();
    expect(labor.quantityOnHand).toBeNull();
    expect(labor.lowStock).toBeNull();

    const unmatched = items.find((li) => li.description === "Unknown widget")!;
    expect(unmatched.partId).toBeNull();
    expect(unmatched.quantityOnHand).toBeNull();
    expect(unmatched.lowStock).toBeNull();
  });

  it("hides catalog stock from a caller without the inventory permission", async () => {
    const part = await seedPart({
      name: uniqueName("Spark Plug"),
      quantityOnHand: 4,
      reorderLevel: 2,
      unitPrice: 8,
    });
    const created = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: part.name, type: "part", quantity: 1, unitPrice: 8 }],
    });
    expect(created.status).toBe(201);

    const staff = await seedStaffUser(["estimates", "customers"], "estonly_stock");
    const res = await agent()
      .get(`/api/estimates/${created.body.id}`)
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(200);
    const item = (res.body.lineItems as Array<Record<string, unknown>>)[0];
    expect(item.partId).toBeNull();
    expect(item.quantityOnHand).toBeNull();
    expect(item.lowStock).toBeNull();
  });
});

describe("invoice detail exposes catalog stock on part line items", () => {
  it("attaches partId/quantityOnHand/lowStock to matched parts and nulls otherwise", async () => {
    const overStockPart = await seedPart({
      name: uniqueName("Inv Brake Pads"),
      quantityOnHand: 2,
      reorderLevel: 1,
      unitPrice: 40,
    });
    const lowStockPart = await seedPart({
      name: uniqueName("Inv Oil Filter"),
      quantityOnHand: 3,
      reorderLevel: 5,
      unitPrice: 12,
    });

    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      // This line intentionally exceeds stock to verify the detail endpoint
      // surfaces stock info; the over-stock guard is bypassed with the override.
      allowOverStock: true,
      lineItems: [
        { description: overStockPart.name, type: "part", quantity: 5, unitPrice: 40 },
        { description: lowStockPart.name, type: "part", quantity: 1, unitPrice: 12 },
        { description: "Diagnostic labor", type: "labor", quantity: 1, unitPrice: 90 },
        { description: "Unknown widget", type: "part", quantity: 1, unitPrice: 9 },
      ],
    });
    expect(created.status).toBe(201);

    const res = await authGet(`/api/invoices/${created.body.id}`);
    expect(res.status).toBe(200);
    const items = res.body.lineItems as Array<Record<string, unknown>>;

    const over = items.find((li) => li.description === overStockPart.name)!;
    expect(over.partId).toBe(overStockPart.id);
    expect(over.quantityOnHand).toBe(2);
    expect(over.lowStock).toBe(false);

    const low = items.find((li) => li.description === lowStockPart.name)!;
    expect(low.partId).toBe(lowStockPart.id);
    expect(low.quantityOnHand).toBe(3);
    expect(low.lowStock).toBe(true);

    const labor = items.find((li) => li.description === "Diagnostic labor")!;
    expect(labor.partId).toBeNull();
    expect(labor.quantityOnHand).toBeNull();
    expect(labor.lowStock).toBeNull();

    const unmatched = items.find((li) => li.description === "Unknown widget")!;
    expect(unmatched.partId).toBeNull();
    expect(unmatched.quantityOnHand).toBeNull();
    expect(unmatched.lowStock).toBeNull();
  });

  it("hides catalog stock from a caller without the inventory permission", async () => {
    const part = await seedPart({
      name: uniqueName("Inv Spark Plug"),
      quantityOnHand: 4,
      reorderLevel: 2,
      unitPrice: 8,
    });
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: part.name, type: "part", quantity: 1, unitPrice: 8 }],
    });
    expect(created.status).toBe(201);

    const staff = await seedStaffUser(["invoices", "customers"], "invonly_stock_detail");
    const res = await agent()
      .get(`/api/invoices/${created.body.id}`)
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(200);
    const item = (res.body.lineItems as Array<Record<string, unknown>>)[0];
    expect(item.partId).toBeNull();
    expect(item.quantityOnHand).toBeNull();
    expect(item.lowStock).toBeNull();
  });
});

describe("estimate detail surfaces linked work order photos", () => {
  const A = "/objects/uploads/est-photo-a.jpg";
  const B = "/objects/uploads/est-photo-b.jpg";

  async function createEstimateLinkedToWorkOrder(): Promise<{ estimateId: number; woId: number }> {
    const wo = await authPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "Estimate photo work order",
      photoUrls: [A, B],
      photoCaptions: { [A]: "front bumper", [B]: "rear dent" },
    });
    expect(wo.status).toBe(201);

    const est = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId: wo.body.id,
      lineItems: [{ description: "Labor", type: "labor", quantity: 1, unitPrice: 90 }],
    });
    expect(est.status).toBe(201);
    return { estimateId: est.body.id, woId: wo.body.id };
  }

  it("returns captioned, ordered photos from the linked work order", async () => {
    const { estimateId } = await createEstimateLinkedToWorkOrder();

    const res = await authGet(`/api/estimates/${estimateId}`);
    expect(res.status).toBe(200);
    expect(res.body.workOrderPhotos).toEqual([
      { path: A, caption: "front bumper" },
      { path: B, caption: "rear dent" },
    ]);
  });

  it("returns an empty list when there is no linked work order", async () => {
    const est = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: "Labor", type: "labor", quantity: 1, unitPrice: 50 }],
    });
    expect(est.status).toBe(201);

    const res = await authGet(`/api/estimates/${est.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.workOrderPhotos).toEqual([]);
  });

  it("hides work order photos from a caller without the workOrders permission", async () => {
    const { estimateId } = await createEstimateLinkedToWorkOrder();

    const staff = await seedStaffUser(["estimates", "customers"], "estonly_photos");
    const res = await agent()
      .get(`/api/estimates/${estimateId}`)
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(200);
    expect(res.body.workOrderPhotos).toEqual([]);
  });

  it("includes work order photos in the approve response", async () => {
    const { estimateId } = await createEstimateLinkedToWorkOrder();

    const res = await authPost(`/api/estimates/${estimateId}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.workOrderPhotos).toEqual([
      { path: A, caption: "front bumper" },
      { path: B, caption: "rear dent" },
    ]);
  });

  it("includes work order photos in the decline response", async () => {
    const { estimateId } = await createEstimateLinkedToWorkOrder();

    const res = await authPost(`/api/estimates/${estimateId}/decline`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
    expect(res.body.workOrderPhotos).toEqual([
      { path: A, caption: "front bumper" },
      { path: B, caption: "rear dent" },
    ]);
  });
});

describe("invoice payments cannot exceed the total", () => {
  async function createInvoice(unitPrice: number): Promise<{ id: number; total: number }> {
    const res = await authPost("/api/invoices")
      .send({
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        lineItems: [{ description: "Labor", type: "labor", quantity: 1, unitPrice }],
      });
    expect(res.status).toBe(201);
    return { id: res.body.id, total: res.body.total };
  }

  it("rejects a payment greater than the amount due", async () => {
    const inv = await createInvoice(100);
    const res = await authPost(`/api/invoices/${inv.id}/payments`)
      .send({ amount: inv.total + 0.01, method: "cash" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the amount due/i);
  });

  it("rejects a non-positive payment amount", async () => {
    const inv = await createInvoice(100);
    const res = await authPost(`/api/invoices/${inv.id}/payments`)
      .send({ amount: 0, method: "cash" });
    expect(res.status).toBe(400);
  });

  it("accepts an exact final payment and marks the invoice paid", async () => {
    const inv = await createInvoice(100);
    const res = await authPost(`/api/invoices/${inv.id}/payments`)
      .send({ amount: inv.total, method: "cash" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
    expect(res.body.amountDue).toBe(0);
  });

  it("rejects a payment once the invoice is already fully paid", async () => {
    const inv = await createInvoice(100);
    const first = await authPost(`/api/invoices/${inv.id}/payments`)
      .send({ amount: inv.total, method: "cash" });
    expect(first.status).toBe(200);

    const second = await authPost(`/api/invoices/${inv.id}/payments`)
      .send({ amount: 1, method: "cash" });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already fully paid/i);
  });

  it("allows a partial payment followed by the exact remaining balance", async () => {
    const inv = await createInvoice(100);
    const partial = await authPost(`/api/invoices/${inv.id}/payments`)
      .send({ amount: 40, method: "cash" });
    expect(partial.status).toBe(200);
    expect(partial.body.status).toBe("partial");
    expect(partial.body.amountDue).toBe(60);

    const rest = await authPost(`/api/invoices/${inv.id}/payments`)
      .send({ amount: 60, method: "cash" });
    expect(rest.status).toBe(200);
    expect(rest.body.status).toBe("paid");
    expect(rest.body.amountDue).toBe(0);
  });
});

describe("invoice payment history records each individual payment", () => {
  async function createInvoice(unitPrice: number): Promise<{ id: number; total: number }> {
    const res = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: "Labor", type: "labor", quantity: 1, unitPrice }],
    });
    expect(res.status).toBe(201);
    return { id: res.body.id, total: res.body.total };
  }

  it("starts with an empty payment history", async () => {
    const inv = await createInvoice(100);
    const got = await authGet(`/api/invoices/${inv.id}`);
    expect(got.status).toBe(200);
    expect(got.body.payments).toEqual([]);
  });

  it("accumulates multiple payments as individual history rows, oldest first", async () => {
    const inv = await createInvoice(100);

    const first = await authPost(`/api/invoices/${inv.id}/payments`).send({
      amount: 30,
      method: "cash",
      note: "Deposit",
    });
    expect(first.status).toBe(200);

    const second = await authPost(`/api/invoices/${inv.id}/payments`).send({
      amount: 70,
      method: "card",
    });
    expect(second.status).toBe(200);

    const got = await authGet(`/api/invoices/${inv.id}`);
    expect(got.status).toBe(200);
    expect(got.body.amountPaid).toBe(100);
    expect(got.body.payments).toHaveLength(2);

    const [p1, p2] = got.body.payments;
    expect(p1.amount).toBe(30);
    expect(p1.method).toBe("cash");
    expect(p1.note).toBe("Deposit");
    expect(p1.id).toBeLessThan(p2.id);
    expect(p2.amount).toBe(70);
    expect(p2.method).toBe("card");
    expect(p2.note).toBeNull();

    // amountPaid must equal the sum of the recorded payment rows.
    const sum = got.body.payments.reduce(
      (acc: number, p: { amount: number }) => acc + p.amount,
      0,
    );
    expect(sum).toBe(got.body.amountPaid);
  });

  it("attributes each payment to the staff member who recorded it", async () => {
    const inv = await createInvoice(50);
    const pay = await authPost(`/api/invoices/${inv.id}/payments`).send({
      amount: 50,
      method: "cash",
    });
    expect(pay.status).toBe(200);
    expect(pay.body.payments).toHaveLength(1);
    expect(pay.body.payments[0].createdByUserId).not.toBeNull();
    expect(pay.body.payments[0].createdByName).toBeTruthy();
    expect(pay.body.payments[0].createdAt).toBeTruthy();
  });

  it("returns the payment list directly on the record-payment response", async () => {
    const inv = await createInvoice(100);
    const res = await authPost(`/api/invoices/${inv.id}/payments`).send({
      amount: 40,
      method: "check",
    });
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0].method).toBe("check");
    expect(res.body.payments[0].amount).toBe(40);
  });
});

describe("invoice payments keep the balance correct and flow to reports", () => {
  // A dedicated far-future month so only this block's seeded invoices land in
  // the window; we still measure report deltas against a baseline so any
  // pre-existing rows in the window cannot make the assertions flaky.
  const start = "2099-08-01";
  const end = "2099-08-31";
  const inWindow = "2099-08-15";
  const outStart = "2099-10-01";
  const outEnd = "2099-10-31";

  // Issues an invoice with a controllable createdAt (so reports can be exercised
  // over an exact window) and returns its id plus computed total.
  async function issueInvoice(args: {
    subtotal: number;
    taxRate: number;
    createdAt?: string;
  }): Promise<{ id: number; total: number; subtotal: number }> {
    const { invoiceId } = await seedIssuedInvoice({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      createdAt: `${args.createdAt ?? inWindow}T12:00:00.000Z`,
      subtotal: args.subtotal,
      taxRate: args.taxRate,
    });
    const got = await authGet(`/api/invoices/${invoiceId}`);
    expect(got.status).toBe(200);
    return { id: invoiceId, total: got.body.total, subtotal: got.body.subtotal };
  }

  it("a payment reduces the outstanding balance and moves status partial -> paid", async () => {
    // subtotal 500 + 10% tax = 550 total.
    const inv = await issueInvoice({ subtotal: 500, taxRate: 10 });
    expect(inv.total).toBe(550);

    const before = await authGet(`/api/invoices/${inv.id}`);
    expect(before.body.amountPaid).toBe(0);
    expect(before.body.amountDue).toBe(550);

    const partial = await authPost(`/api/invoices/${inv.id}/payments`).send({
      amount: 200,
      method: "card",
    });
    expect(partial.status).toBe(200);
    expect(partial.body.status).toBe("partial");
    expect(partial.body.amountPaid).toBe(200);
    expect(partial.body.amountDue).toBe(350);

    const rest = await authPost(`/api/invoices/${inv.id}/payments`).send({
      amount: 350,
      method: "cash",
    });
    expect(rest.status).toBe(200);
    expect(rest.body.status).toBe("paid");
    expect(rest.body.amountPaid).toBe(550);
    expect(rest.body.amountDue).toBe(0);
    expect(rest.body.paidAt).toBeTruthy();
  });

  it("rejects a negative (refund-style) payment and leaves the balance untouched", async () => {
    const inv = await issueInvoice({ subtotal: 100, taxRate: 0 });

    const paid = await authPost(`/api/invoices/${inv.id}/payments`).send({
      amount: 40,
      method: "cash",
    });
    expect(paid.status).toBe(200);
    expect(paid.body.amountDue).toBe(60);

    // Refunds have their own dedicated endpoint; the payment endpoint must still
    // reject a negative amount so a payment can never push the balance the wrong way.
    const refund = await authPost(`/api/invoices/${inv.id}/payments`).send({
      amount: -25,
      method: "cash",
    });
    expect(refund.status).toBe(400);

    const after = await authGet(`/api/invoices/${inv.id}`);
    expect(after.body.amountPaid).toBe(40);
    expect(after.body.amountDue).toBe(60);
  });

  it("rejects an overpayment beyond the remaining balance after a partial payment", async () => {
    const inv = await issueInvoice({ subtotal: 100, taxRate: 0 });

    const partial = await authPost(`/api/invoices/${inv.id}/payments`).send({
      amount: 30,
      method: "cash",
    });
    expect(partial.status).toBe(200);
    expect(partial.body.amountDue).toBe(70);

    const over = await authPost(`/api/invoices/${inv.id}/payments`).send({
      amount: 70.01,
      method: "cash",
    });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/exceeds the amount due/i);

    const after = await authGet(`/api/invoices/${inv.id}`);
    expect(after.body.amountPaid).toBe(30);
    expect(after.body.status).toBe("partial");
  });

  it("collected payments and invoiced revenue land only in the matching report window", async () => {
    // Baselines captured before this test seeds anything, for both the in-window
    // (August) and out-of-window (October) ranges.
    const plBefore = await authGet("/api/reports/profit-loss").query({
      startDate: start,
      endDate: end,
    });
    const salesInBefore = await authGet("/api/reports/sales-summary").query({
      startDate: start,
      endDate: end,
    });
    const salesOutBefore = await authGet("/api/reports/sales-summary").query({
      startDate: outStart,
      endDate: outEnd,
    });
    expect(plBefore.status).toBe(200);
    expect(salesInBefore.status).toBe(200);
    expect(salesOutBefore.status).toBe(200);

    // subtotal 800 + 5% tax = 840 total, issued inside the August window.
    const inv = await issueInvoice({ subtotal: 800, taxRate: 5 });
    expect(inv.total).toBe(840);

    const pay = await authPost(`/api/invoices/${inv.id}/payments`).send({
      amount: 840,
      method: "card",
    });
    expect(pay.status).toBe(200);
    expect(pay.body.status).toBe("paid");

    const plAfter = await authGet("/api/reports/profit-loss").query({
      startDate: start,
      endDate: end,
    });
    const salesInAfter = await authGet("/api/reports/sales-summary").query({
      startDate: start,
      endDate: end,
    });
    const salesOutAfter = await authGet("/api/reports/sales-summary").query({
      startDate: outStart,
      endDate: outEnd,
    });
    expect(plAfter.status).toBe(200);
    expect(salesInAfter.status).toBe(200);
    expect(salesOutAfter.status).toBe(200);

    // Profit/loss recognizes the invoice's subtotal + tax as revenue in the
    // window it was issued.
    expect(round(plAfter.body.revenue - plBefore.body.revenue)).toBe(800);
    expect(round(plAfter.body.taxCollected - plBefore.body.taxCollected)).toBe(40);

    // Sales summary reflects both the invoiced amount and the money actually
    // collected for the same window.
    expect(round(salesInAfter.body.grossSales - salesInBefore.body.grossSales)).toBe(800);
    expect(round(salesInAfter.body.totalInvoiced - salesInBefore.body.totalInvoiced)).toBe(840);
    expect(round(salesInAfter.body.totalCollected - salesInBefore.body.totalCollected)).toBe(840);
    expect(salesInAfter.body.paidCount - salesInBefore.body.paidCount).toBe(1);

    // The October window saw none of it — the payment and revenue stay scoped to
    // the invoice's own date.
    expect(round(salesOutAfter.body.totalCollected - salesOutBefore.body.totalCollected)).toBe(0);
    expect(round(salesOutAfter.body.totalInvoiced - salesOutBefore.body.totalInvoiced)).toBe(0);
  });
});

describe("invoice refunds lower the amount paid and reopen the balance", () => {
  // A dedicated far-future month so only this block's seeded invoices land in
  // the reporting window.
  const start = "2099-09-01";
  const end = "2099-09-30";
  const inWindow = "2099-09-15";

  async function issueInvoice(args: {
    subtotal: number;
    taxRate: number;
  }): Promise<{ id: number; total: number }> {
    const { invoiceId } = await seedIssuedInvoice({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      createdAt: `${inWindow}T12:00:00.000Z`,
      subtotal: args.subtotal,
      taxRate: args.taxRate,
    });
    const got = await authGet(`/api/invoices/${invoiceId}`);
    expect(got.status).toBe(200);
    return { id: invoiceId, total: got.body.total };
  }

  async function payInFull(id: number, amount: number): Promise<void> {
    const pay = await authPost(`/api/invoices/${id}/payments`).send({
      amount,
      method: "cash",
    });
    expect(pay.status).toBe(200);
    expect(pay.body.status).toBe("paid");
  }

  it("a partial refund moves a paid invoice back to partial and reopens the balance", async () => {
    const inv = await issueInvoice({ subtotal: 100, taxRate: 0 });
    await payInFull(inv.id, 100);

    const refund = await authPost(`/api/invoices/${inv.id}/refunds`).send({
      amount: 30,
      method: "cash",
    });
    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe("partial");
    expect(refund.body.amountPaid).toBe(70);
    expect(refund.body.amountDue).toBe(30);
    expect(refund.body.paidAt).toBeNull();
  });

  it("a full refund clears the balance back to sent/unpaid and clears paidAt", async () => {
    const inv = await issueInvoice({ subtotal: 200, taxRate: 0 });
    await payInFull(inv.id, 200);

    const refund = await authPost(`/api/invoices/${inv.id}/refunds`).send({
      amount: 200,
      method: "card",
    });
    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe("sent");
    expect(refund.body.amountPaid).toBe(0);
    expect(refund.body.amountDue).toBe(200);
    expect(refund.body.paidAt).toBeNull();
  });

  it("rejects a refund greater than the amount paid", async () => {
    const inv = await issueInvoice({ subtotal: 100, taxRate: 0 });
    await payInFull(inv.id, 100);

    const refund = await authPost(`/api/invoices/${inv.id}/refunds`).send({
      amount: 100.01,
      method: "cash",
    });
    expect(refund.status).toBe(400);
    expect(refund.body.error).toMatch(/exceeds the amount paid/i);

    const after = await authGet(`/api/invoices/${inv.id}`);
    expect(after.body.amountPaid).toBe(100);
    expect(after.body.status).toBe("paid");
  });

  it("rejects a refund on an invoice with no payments", async () => {
    const inv = await issueInvoice({ subtotal: 100, taxRate: 0 });

    const refund = await authPost(`/api/invoices/${inv.id}/refunds`).send({
      amount: 10,
      method: "cash",
    });
    expect(refund.status).toBe(400);
    expect(refund.body.error).toMatch(/no payments to refund/i);
  });

  it("rejects a non-positive refund amount", async () => {
    const inv = await issueInvoice({ subtotal: 100, taxRate: 0 });
    await payInFull(inv.id, 100);

    const refund = await authPost(`/api/invoices/${inv.id}/refunds`).send({
      amount: 0,
      method: "cash",
    });
    expect(refund.status).toBe(400);
  });

  it("a refund reduces totalCollected in the sales summary for the invoice's window", async () => {
    const before = await authGet("/api/reports/sales-summary").query({
      startDate: start,
      endDate: end,
    });
    expect(before.status).toBe(200);

    // subtotal 500 + 10% tax = 550, paid in full then partly refunded.
    const inv = await issueInvoice({ subtotal: 500, taxRate: 10 });
    expect(inv.total).toBe(550);
    await payInFull(inv.id, 550);

    const refund = await authPost(`/api/invoices/${inv.id}/refunds`).send({
      amount: 150,
      method: "cash",
    });
    expect(refund.status).toBe(200);

    const after = await authGet("/api/reports/sales-summary").query({
      startDate: start,
      endDate: end,
    });
    expect(after.status).toBe(200);

    // Net collected = 550 paid - 150 refunded = 400.
    expect(round(after.body.totalCollected - before.body.totalCollected)).toBe(400);
    // Invoiced revenue is accrual-based and unaffected by the refund.
    expect(round(after.body.totalInvoiced - before.body.totalInvoiced)).toBe(550);
    // The invoice is no longer fully paid, so it counts as partial, not paid.
    expect(after.body.partialCount - before.body.partialCount).toBe(1);
  });
});

describe("payments-by-method report groups collected money by tender and window", () => {
  // A dedicated far-future month so only this block's seeded payments land in
  // the reporting window.
  const start = "2099-11-01";
  const end = "2099-11-30";
  const inWindow = "2099-11-15T12:00:00.000Z";
  const outOfWindow = "2099-12-15T12:00:00.000Z";

  it("buckets payments by method and excludes ones outside the date window", async () => {
    const { invoiceId } = await seedIssuedInvoice({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      createdAt: inWindow,
      subtotal: 1000,
      taxRate: 0,
    });

    const before = await authGet("/api/reports/payments-by-method").query({
      startDate: start,
      endDate: end,
    });
    expect(before.status).toBe(200);
    const beforeByMethod = new Map<string, { amount: number; count: number }>(
      before.body.methods.map((m: { method: string; amount: number; count: number }) => [
        m.method,
        { amount: m.amount, count: m.count },
      ]),
    );

    // In-window: two cash payments and one card payment.
    await seedInvoicePayment({ invoiceId, amount: 100, method: "cash", createdAt: inWindow });
    await seedInvoicePayment({ invoiceId, amount: 50, method: "cash", createdAt: inWindow });
    await seedInvoicePayment({ invoiceId, amount: 200, method: "card", createdAt: inWindow });
    // Out-of-window card payment must not count toward this window.
    await seedInvoicePayment({ invoiceId, amount: 999, method: "card", createdAt: outOfWindow });

    const after = await authGet("/api/reports/payments-by-method").query({
      startDate: start,
      endDate: end,
    });
    expect(after.status).toBe(200);
    const afterByMethod = new Map<string, { amount: number; count: number }>(
      after.body.methods.map((m: { method: string; amount: number; count: number }) => [
        m.method,
        { amount: m.amount, count: m.count },
      ]),
    );

    const cashBefore = beforeByMethod.get("cash") ?? { amount: 0, count: 0 };
    const cardBefore = beforeByMethod.get("card") ?? { amount: 0, count: 0 };
    const cashAfter = afterByMethod.get("cash") ?? { amount: 0, count: 0 };
    const cardAfter = afterByMethod.get("card") ?? { amount: 0, count: 0 };

    // Cash bucket gains the two in-window cash payments (100 + 50).
    expect(round(cashAfter.amount - cashBefore.amount)).toBe(150);
    expect(cashAfter.count - cashBefore.count).toBe(2);
    // Card bucket gains only the single in-window card payment (200); the 999
    // December payment is excluded by the date filter.
    expect(round(cardAfter.amount - cardBefore.amount)).toBe(200);
    expect(cardAfter.count - cardBefore.count).toBe(1);

    // The grand total and count reflect only the three in-window payments.
    expect(round(after.body.total - before.body.total)).toBe(350);
    expect(after.body.paymentCount - before.body.paymentCount).toBe(3);
  });

  it("nets a cash refund out of the cash bucket and the grand total", async () => {
    // The payment/refund endpoints stamp rows with the current date, so this
    // case queries the whole trail (no date filter) and isolates its effect via
    // the before/after diff rather than a far-future window.
    const { invoiceId } = await seedIssuedInvoice({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      createdAt: inWindow,
      subtotal: 300,
      taxRate: 0,
    });

    const before = await authGet("/api/reports/payments-by-method");
    expect(before.status).toBe(200);
    const beforeByMethod = new Map<string, { amount: number; count: number }>(
      before.body.methods.map((m: { method: string; amount: number; count: number }) => [
        m.method,
        { amount: m.amount, count: m.count },
      ]),
    );
    const cashBefore = beforeByMethod.get("cash") ?? { amount: 0, count: 0 };

    // Collect 300 in cash, then refund 120 in cash. The refund must lower the
    // cash bucket so the report reflects net cash in the drawer.
    const pay = await authPost(`/api/invoices/${invoiceId}/payments`).send({
      amount: 300,
      method: "cash",
    });
    expect(pay.status).toBe(200);

    const refund = await authPost(`/api/invoices/${invoiceId}/refunds`).send({
      amount: 120,
      method: "cash",
    });
    expect(refund.status).toBe(200);

    const after = await authGet("/api/reports/payments-by-method");
    expect(after.status).toBe(200);
    const afterByMethod = new Map<string, { amount: number; count: number }>(
      after.body.methods.map((m: { method: string; amount: number; count: number }) => [
        m.method,
        { amount: m.amount, count: m.count },
      ]),
    );
    const cashAfter = afterByMethod.get("cash") ?? { amount: 0, count: 0 };

    // Net cash = 300 collected - 120 refunded = 180.
    expect(round(cashAfter.amount - cashBefore.amount)).toBe(180);
    // The refund nets the amount but is not itself a payment: only the single
    // cash collection bumps the count.
    expect(cashAfter.count - cashBefore.count).toBe(1);
    // Grand total nets the refund too.
    expect(round(after.body.total - before.body.total)).toBe(180);
    expect(after.body.paymentCount - before.body.paymentCount).toBe(1);
  });

  it("breaks each method into distinct gross collected, refunded, and net amounts", async () => {
    // Whole-trail diff (the payment/refund endpoints stamp the current date), so
    // isolate this case's effect via the before/after delta on the cash bucket.
    const { invoiceId } = await seedIssuedInvoice({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      createdAt: inWindow,
      subtotal: 300,
      taxRate: 0,
    });

    const before = await authGet("/api/reports/payments-by-method");
    expect(before.status).toBe(200);
    const beforeByMethod = new Map<
      string,
      { collected: number; refunded: number; amount: number; count: number }
    >(
      before.body.methods.map(
        (m: { method: string; collected: number; refunded: number; amount: number; count: number }) => [
          m.method,
          { collected: m.collected, refunded: m.refunded, amount: m.amount, count: m.count },
        ],
      ),
    );
    const cashBefore = beforeByMethod.get("cash") ?? {
      collected: 0,
      refunded: 0,
      amount: 0,
      count: 0,
    };

    // Collect 300 in cash, then refund 120 in cash.
    const pay = await authPost(`/api/invoices/${invoiceId}/payments`).send({
      amount: 300,
      method: "cash",
    });
    expect(pay.status).toBe(200);
    const refund = await authPost(`/api/invoices/${invoiceId}/refunds`).send({
      amount: 120,
      method: "cash",
    });
    expect(refund.status).toBe(200);

    const after = await authGet("/api/reports/payments-by-method");
    expect(after.status).toBe(200);
    const afterByMethod = new Map<
      string,
      { collected: number; refunded: number; amount: number; count: number }
    >(
      after.body.methods.map(
        (m: { method: string; collected: number; refunded: number; amount: number; count: number }) => [
          m.method,
          { collected: m.collected, refunded: m.refunded, amount: m.amount, count: m.count },
        ],
      ),
    );
    const cashAfter = afterByMethod.get("cash") ?? {
      collected: 0,
      refunded: 0,
      amount: 0,
      count: 0,
    };

    // Gross collected rises by the full 300 (refunds do not touch it).
    expect(round(cashAfter.collected - cashBefore.collected)).toBe(300);
    // Refunded rises by 120, surfaced as a positive figure.
    expect(round(cashAfter.refunded - cashBefore.refunded)).toBe(120);
    // Net == collected - refunded == 180, matching the existing amount field.
    expect(round(cashAfter.amount - cashBefore.amount)).toBe(180);
    // Only the single collection counts as a payment.
    expect(cashAfter.count - cashBefore.count).toBe(1);
  });

  it("rolls up shop-wide collected, refunded, and net totals across methods", async () => {
    // A dedicated far-future window so only these seeded rows land in scope,
    // letting us assert absolute shop-wide totals rather than before/after diffs.
    const wStart = "2099-10-01";
    const wEnd = "2099-10-31";
    const wIn = "2099-10-15T12:00:00.000Z";

    const { invoiceId } = await seedIssuedInvoice({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      createdAt: wIn,
      subtotal: 5000,
      taxRate: 0,
    });

    // Collect across two methods, then refund part of the cash via a negative
    // row stamped into the same window.
    await seedInvoicePayment({ invoiceId, amount: 300, method: "cash", createdAt: wIn });
    await seedInvoicePayment({ invoiceId, amount: 200, method: "card", createdAt: wIn });
    await seedInvoicePayment({ invoiceId, amount: -120, method: "cash", createdAt: wIn });

    const res = await authGet("/api/reports/payments-by-method").query({
      startDate: wStart,
      endDate: wEnd,
    });
    expect(res.status).toBe(200);

    // Gross collected sums only positive rows (300 + 200 = 500); the refund does
    // not touch it.
    expect(round(res.body.totalCollected)).toBe(500);
    // Total refunded is the absolute value of the negative cash row.
    expect(round(res.body.totalRefunded)).toBe(120);
    // Net == collected - refunded == 380, matching the grand total field.
    expect(round(res.body.total)).toBe(380);
    // Only the two collections count as payments; the refund does not.
    expect(res.body.paymentCount).toBe(2);
  });
});

describe("appointment availability endpoint", () => {
  it("is reachable (not swallowed by the :id route) and returns per-day capacity", async () => {
    const res = await authGet("/api/appointments/availability").query({
      from: "2099-06-01",
      to: "2099-06-03",
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
    const day = res.body[0];
    expect(day).toHaveProperty("date");
    expect(day).toHaveProperty("open");
    expect(day).toHaveProperty("dayCount");
    expect(day).toHaveProperty("maxPerDay");
    expect(day).toHaveProperty("dayFull");
    expect(Array.isArray(day.slots)).toBe(true);
  });

  it("never leaks customer PII in the response", async () => {
    const res = await authGet("/api/appointments/availability").query({
      from: "2099-06-01",
      to: "2099-06-07",
    });
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    for (const leaked of ["customerName", "phone", "notes", "customerId"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("rejects a missing from date with 400", async () => {
    const res = await authGet("/api/appointments/availability");
    expect(res.status).toBe(400);
  });

  it("rejects a range longer than 31 days with 400", async () => {
    const res = await authGet("/api/appointments/availability").query({
      from: "2099-06-01",
      to: "2099-08-01",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/31 days/i);
  });
});

describe("appointment list source filter", () => {
  // Create one shop-entered appointment and one online (anonymous) booking so
  // we can verify the ?source= filter correctly isolates each kind.
  //
  // Uses a DEDICATED date window (65-72 days) that no other test file touches
  // to avoid per-slot cap collisions under parallel test execution.
  let shopApptId: number;
  let onlineApptId: number;

  const isoDateOffset = (days: number) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const FILTER_FROM = isoDateOffset(65);
  const FILTER_TO = isoDateOffset(72);

  beforeAll(async () => {
    // Resolve a valid bookable slot in the dedicated window. The public booking
    // endpoint validates that scheduledAt is an exact slot start time, so we
    // must look it up from the availability response.
    const avail = await agent()
      .get("/api/public/availability")
      .query({ from: FILTER_FROM, to: FILTER_TO });
    let onlineSlotStart: string | null = null;
    for (const day of avail.body as Array<{ open: boolean; slots: Array<{ start: string; available: boolean }> }>) {
      if (!day.open) continue;
      const s = day.slots.find((sl) => sl.available);
      if (s) { onlineSlotStart = s.start; break; }
    }
    if (!onlineSlotStart) throw new Error("no available slot in source-filter window");

    // Staff-entered appointment (source="shop"). Staff endpoint accepts any
    // future datetime — does not require an exact slot boundary.
    const shopRes = await authPost("/api/appointments").send({
      customerName: "Source Filter Shop",
      phone: "555-8001",
      scheduledAt: new Date(Date.now() + 65 * 24 * 60 * 60 * 1000).toISOString(),
      durationMinutes: 60,
      status: "scheduled",
    });
    expect(shopRes.status).toBe(201);
    shopApptId = shopRes.body.id;

    // Anonymous online booking via public endpoint (source="online").
    // Must use an exact slot start so createOnlineBooking does not 400.
    const onlineRes = await agent().post("/api/public/booking").send({
      customerName: "Source Filter Online",
      phone: "555-8002",
      scheduledAt: onlineSlotStart,
    });
    expect(onlineRes.status).toBe(201);
    onlineApptId = onlineRes.body.id;
  });

  it("?source=shop returns shop-entered appointments and excludes online bookings", async () => {
    const res = await authGet("/api/appointments").query({ source: "shop" });
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((a) => a.id);
    expect(ids).toContain(shopApptId);
    expect(ids).not.toContain(onlineApptId);
  });

  it("?source=online returns only online bookings and excludes shop-entered ones", async () => {
    const res = await authGet("/api/appointments").query({ source: "online" });
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((a) => a.id);
    expect(ids).toContain(onlineApptId);
    expect(ids).not.toContain(shopApptId);
  });

  it("default (no source) excludes pending online bookings from the staff queue", async () => {
    // Core regression: unverified anonymous online requests must never appear
    // in the default staff list regardless of their TTL. Staff who want to
    // review them must explicitly request ?source=online.
    const res = await authGet("/api/appointments");
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((a) => a.id);
    expect(ids).not.toContain(onlineApptId);
    // Shop-entered appointment is still visible in the default view.
    expect(ids).toContain(shopApptId);
  });
});

describe("payday report respects its date range", () => {
  const inWindowDate = "2024-06-10";
  const beforeWindow = "2024-01-01";
  const start = "2024-06-01";
  const end = "2024-06-30";

  it("includes a mechanic's hours when the entry falls inside the range", async () => {
    const { mechanicId } = await seedMechanicWithEntry(inWindowDate);
    const res = await authGet("/api/reports/payday").query({ startDate: start, endDate: end });
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { mechanicId: number }) => r.mechanicId === mechanicId);
    expect(row).toBeDefined();
    expect(row.hours).toBe(10);
    expect(row.grossPay).toBe(400);
  });

  it("excludes a mechanic's hours when the entry falls outside the range", async () => {
    const { mechanicId } = await seedMechanicWithEntry(beforeWindow);
    const res = await authGet("/api/reports/payday").query({ startDate: start, endDate: end });
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { mechanicId: number }) => r.mechanicId === mechanicId);
    // The mechanic may still appear (all mechanics are listed) but with zeroed
    // hours because the only time entry is outside the requested window.
    if (row) {
      expect(row.hours).toBe(0);
      expect(row.grossPay).toBe(0);
    }
  });
});

describe("AI estimate tools", () => {
  const adminCtx = (): AiToolContext => ({
    userId: admin.id,
    isAdmin: true,
    permissions: [],
  });
  // A non-admin with estimates access but NOT customers access, to verify the
  // cross-module disclosure guard.
  const estimatesOnlyCtx = (): AiToolContext => ({
    userId: admin.id,
    isAdmin: false,
    permissions: ["estimates"],
  });

  const call = (name: string, args: unknown, ctx: AiToolContext) =>
    TOOLS[name].execute(args, ctx) as Promise<Record<string, unknown>>;

  it("create_estimate creates a draft with line items and reports a number + totals via get_estimate", async () => {
    const created = await call(
      "create_estimate",
      {
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        taxRate: 10,
        lineItems: [
          { type: "labor", description: "Diagnose brakes", quantity: 2, unitPrice: 100 },
          { type: "part", description: "Brake pads", quantity: 1, unitPrice: 80 },
        ],
      },
      adminCtx(),
    );
    const createdInfo = created.created as { id: number; number: string };
    expect(createdInfo.id).toBeTypeOf("number");
    expect(createdInfo.number).toBe(`EST-${1000 + createdInfo.id}`);
    expect(created.lineItemsAdded).toBe(2);

    const got = await call("get_estimate", { id: createdInfo.id }, adminCtx());
    const estimate = got.estimate as Record<string, unknown>;
    expect(estimate.status).toBe("draft");
    expect(estimate.subtotal).toBe(280);
    expect(estimate.taxAmount).toBe(28);
    expect(estimate.total).toBe(308);
    expect(estimate.customerName).toBeTruthy();
    expect((estimate.lineItems as unknown[]).length).toBe(2);
  });

  it("hides customer identity when the caller lacks the customers permission", async () => {
    const created = await call(
      "create_estimate",
      { customerId: shop.customerId, vehicleId: shop.vehicleId },
      adminCtx(),
    );
    const id = (created.created as { id: number }).id;
    const got = await call("get_estimate", { id }, estimatesOnlyCtx());
    const estimate = got.estimate as Record<string, unknown>;
    expect(estimate.customerName).toBeNull();
    expect(estimate.vehicleLabel).toBeNull();
  });

  it("refuses to create an estimate referencing a nonexistent customer", async () => {
    const res = await call(
      "create_estimate",
      { customerId: 999_999_999, vehicleId: shop.vehicleId },
      adminCtx(),
    );
    expect(res.error).toMatch(/customer/i);
  });

  it("add/update/remove line item and update_estimate_status work end to end", async () => {
    const created = await call(
      "create_estimate",
      { customerId: shop.customerId, vehicleId: shop.vehicleId },
      adminCtx(),
    );
    const estimateId = (created.created as { id: number }).id;

    const added = await call(
      "add_estimate_line_item",
      { estimateId, type: "part", description: "Oil filter", quantity: 1, unitPrice: 15 },
      adminCtx(),
    );
    const lineItemId = (added.created as { id: number }).id;
    expect(lineItemId).toBeTypeOf("number");

    const updated = await call(
      "update_estimate_line_item",
      { id: lineItemId, quantity: 3 },
      adminCtx(),
    );
    expect((updated.updated as { quantity: number }).quantity).toBe(3);

    const items = await call("get_estimate_line_items", { estimateId }, adminCtx());
    expect((items.lineItems as unknown[]).length).toBe(1);

    const removed = await call("remove_estimate_line_item", { id: lineItemId }, adminCtx());
    expect(removed.deleted).toBe(true);

    const approved = await call(
      "update_estimate_status",
      { id: estimateId, status: "approved" },
      adminCtx(),
    );
    expect((approved.updated as { status: string }).status).toBe("approved");
    const afterApprove = await call("get_estimate", { id: estimateId }, adminCtx());
    expect((afterApprove.estimate as { approvedAt: string | null }).approvedAt).toBeTruthy();
  });

  it("find_estimates filters by status and returns computed totals", async () => {
    const created = await call(
      "create_estimate",
      {
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        status: "sent",
        lineItems: [{ type: "fee", description: "Shop fee", quantity: 1, unitPrice: 25 }],
      },
      adminCtx(),
    );
    const id = (created.created as { id: number }).id;
    const res = await call("find_estimates", { status: "sent" }, adminCtx());
    const list = res.estimates as Array<{ id: number; status: string; total: number }>;
    const ours = list.find((e) => e.id === id);
    expect(ours).toBeDefined();
    expect(ours!.status).toBe("sent");
    expect(ours!.total).toBe(25);
  });

  it("write-tool summaries are deterministic and reference the estimate number", async () => {
    const summary = await TOOLS["update_estimate_status"].summarize!(
      { id: 3, status: "approved" },
      adminCtx(),
    );
    expect(summary).toBe("mark EST-1003 as approved");
  });

  it("convert_estimate_to_invoice creates an invoice copying line items", async () => {
    const created = await call(
      "create_estimate",
      {
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        lineItems: [
          { type: "labor", description: "Diag", quantity: 1, unitPrice: 80 },
        ],
      },
      adminCtx(),
    );
    const estimateId = (created.created as { id: number }).id;

    const res = await call(
      "convert_estimate_to_invoice",
      { estimateId },
      adminCtx(),
    );
    const invoice = res.created as { id: number; number: string };
    expect(invoice.id).toBeTypeOf("number");
    expect(invoice.number).toBe(`INV-${2000 + invoice.id}`);

    const fetched = await authGet(`/api/invoices/${invoice.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.estimateId).toBe(estimateId);
    expect(fetched.body.lineItems).toHaveLength(1);
    expect(fetched.body.subtotal).toBe(80);
  });

  it("convert_estimate_to_invoice refuses a second conversion of the same estimate", async () => {
    const created = await call(
      "create_estimate",
      {
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        lineItems: [
          { type: "labor", description: "Diag", quantity: 1, unitPrice: 40 },
        ],
      },
      adminCtx(),
    );
    const estimateId = (created.created as { id: number }).id;

    const first = await call("convert_estimate_to_invoice", { estimateId }, adminCtx());
    expect(first.created).toBeDefined();

    const second = await call("convert_estimate_to_invoice", { estimateId }, adminCtx());
    expect(second.error).toMatch(/already been converted/i);
  });

  it("convert_estimate_to_invoice fails closed without the invoices permission", async () => {
    const created = await call(
      "create_estimate",
      {
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        lineItems: [
          { type: "labor", description: "Diag", quantity: 1, unitPrice: 40 },
        ],
      },
      adminCtx(),
    );
    const estimateId = (created.created as { id: number }).id;

    // estimatesOnlyCtx has "estimates" but not "invoices" → must fail closed.
    const res = await call(
      "convert_estimate_to_invoice",
      { estimateId },
      estimatesOnlyCtx(),
    );
    expect(res.error).toMatch(/permission to create invoices/i);
    expect(res.created).toBeUndefined();
  });

  it("convert_estimate_to_invoice summary references the estimate number", async () => {
    const summary = await TOOLS["convert_estimate_to_invoice"].summarize!(
      { estimateId: 3 },
      adminCtx(),
    );
    expect(summary).toBe("convert EST-1003 into a new invoice");
  });

  it("convert_estimate_to_work_order creates a work order linked to the estimate", async () => {
    const created = await call(
      "create_estimate",
      {
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        notes: "Replace front brakes",
        lineItems: [
          { type: "labor", description: "Diag", quantity: 1, unitPrice: 80 },
        ],
      },
      adminCtx(),
    );
    const estimateId = (created.created as { id: number }).id;

    const res = await call(
      "convert_estimate_to_work_order",
      { estimateId },
      adminCtx(),
    );
    const wo = res.created as { id: number };
    expect(wo.id).toBeTypeOf("number");

    const fetchedWo = await authGet(`/api/work-orders/${wo.id}`);
    expect(fetchedWo.status).toBe(200);
    expect(fetchedWo.body.customerId).toBe(shop.customerId);
    expect(fetchedWo.body.vehicleId).toBe(shop.vehicleId);
    expect(fetchedWo.body.description).toBe("Replace front brakes");

    const fetchedEst = await authGet(`/api/estimates/${estimateId}`);
    expect(fetchedEst.status).toBe(200);
    expect(fetchedEst.body.workOrderId).toBe(wo.id);
  });

  it("convert_estimate_to_work_order refuses a second conversion of the same estimate", async () => {
    const created = await call(
      "create_estimate",
      {
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        lineItems: [
          { type: "labor", description: "Diag", quantity: 1, unitPrice: 40 },
        ],
      },
      adminCtx(),
    );
    const estimateId = (created.created as { id: number }).id;

    const first = await call(
      "convert_estimate_to_work_order",
      { estimateId },
      adminCtx(),
    );
    expect(first.created).toBeDefined();

    const second = await call(
      "convert_estimate_to_work_order",
      { estimateId },
      adminCtx(),
    );
    expect(second.error).toMatch(/already linked to a work order/i);
  });

  it("convert_estimate_to_work_order fails closed without the workOrders permission", async () => {
    const created = await call(
      "create_estimate",
      {
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        lineItems: [
          { type: "labor", description: "Diag", quantity: 1, unitPrice: 40 },
        ],
      },
      adminCtx(),
    );
    const estimateId = (created.created as { id: number }).id;

    // estimatesOnlyCtx has "estimates" but not "workOrders" → must fail closed.
    const res = await call(
      "convert_estimate_to_work_order",
      { estimateId },
      estimatesOnlyCtx(),
    );
    expect(res.error).toMatch(/permission to create work orders/i);
    expect(res.created).toBeUndefined();
  });

  it("convert_estimate_to_work_order summary references the estimate number", async () => {
    const summary = await TOOLS["convert_estimate_to_work_order"].summarize!(
      { estimateId: 3 },
      adminCtx(),
    );
    expect(summary).toBe("convert EST-1003 into a new work order");
  });
});

describe("work order tasks & parts line items", () => {
  it("persists added line items and exposes catalog stock on parts", async () => {
    const part = await seedPart({
      name: uniqueName("WO Brake Pads"),
      quantityOnHand: 3,
      reorderLevel: 5,
      unitPrice: 40,
    });

    const created = await authPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "Brake job",
      lineItems: [
        { type: "labor", description: "Replace pads", quantity: 2, unitPrice: 90 },
        { type: "part", description: part.name, quantity: 1, unitPrice: 40 },
        { type: "part", description: "Unknown widget", quantity: 1, unitPrice: 9 },
      ],
    });
    expect(created.status).toBe(201);
    const woId = created.body.id as number;

    const res = await authGet(`/api/work-orders/${woId}`);
    expect(res.status).toBe(200);
    const items = res.body.lineItems as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);

    const labor = items.find((li) => li.description === "Replace pads")!;
    expect(labor.type).toBe("labor");
    expect(labor.quantity).toBe(2);
    expect(labor.total).toBe(180);
    expect(labor.partId).toBeNull();

    const matched = items.find((li) => li.description === part.name)!;
    expect(matched.partId).toBe(part.id);
    expect(matched.quantityOnHand).toBe(3);
    expect(matched.lowStock).toBe(true);

    const unmatched = items.find((li) => li.description === "Unknown widget")!;
    expect(unmatched.partId).toBeNull();
    expect(unmatched.quantityOnHand).toBeNull();
    expect(unmatched.lowStock).toBeNull();
  });

  it("replaces line items on PATCH (edit and remove)", async () => {
    const created = await authPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "Diag",
      lineItems: [
        { type: "labor", description: "Diag", quantity: 1, unitPrice: 100 },
        { type: "fee", description: "Shop fee", quantity: 1, unitPrice: 20 },
      ],
    });
    expect(created.status).toBe(201);
    const woId = created.body.id as number;

    // Replace with a single edited item; the fee should be removed.
    const patched = await authPatch(`/api/work-orders/${woId}`).send({
      lineItems: [{ type: "labor", description: "Diag", quantity: 3, unitPrice: 100 }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.lineItems).toHaveLength(1);
    expect(patched.body.lineItems[0].quantity).toBe(3);
    expect(patched.body.lineItems[0].total).toBe(300);

    // A PATCH that omits lineItems leaves existing items untouched.
    const untouched = await authPatch(`/api/work-orders/${woId}`).send({
      status: "in_progress",
    });
    expect(untouched.status).toBe(200);
    expect(untouched.body.lineItems).toHaveLength(1);
  });

  it("hides catalog stock from a caller without the inventory permission", async () => {
    const part = await seedPart({
      name: uniqueName("WO Spark Plug"),
      quantityOnHand: 4,
      reorderLevel: 2,
      unitPrice: 8,
    });
    const created = await authPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "Tune up",
      lineItems: [{ type: "part", description: part.name, quantity: 1, unitPrice: 8 }],
    });
    expect(created.status).toBe(201);

    const staff = await seedStaffUser(["workOrders"], "woonly_stock");
    const res = await agent()
      .get(`/api/work-orders/${created.body.id}`)
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(200);
    const item = (res.body.lineItems as Array<Record<string, unknown>>)[0];
    expect(item.partId).toBeNull();
    expect(item.quantityOnHand).toBeNull();
    expect(item.lowStock).toBeNull();
  });

  it("converting an estimate copies its line items into the work order", async () => {
    const estimate = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [
        { type: "labor", description: "Replace alternator", quantity: 2, unitPrice: 95 },
        { type: "part", description: "Alternator", quantity: 1, unitPrice: 220 },
      ],
    });
    expect(estimate.status).toBe(201);

    const converted = await authPost(
      `/api/estimates/${estimate.body.id}/convert-to-work-order`,
    );
    expect(converted.status).toBe(201);
    // The converted work order carries the quoted items as structured line
    // items, not a notes-based reference dump.
    expect(converted.body.lineItems).toHaveLength(2);
    expect(converted.body.notes).toBe(`Converted from EST-${1000 + estimate.body.id}.`);
    expect(converted.body.notes).not.toMatch(/Quoted items/);

    const labor = (converted.body.lineItems as Array<Record<string, unknown>>).find(
      (li) => li.description === "Replace alternator",
    )!;
    expect(labor.quantity).toBe(2);
    expect(labor.total).toBe(190);

    // Items are also visible on the work order detail fetch.
    const fetched = await authGet(`/api/work-orders/${converted.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.lineItems).toHaveLength(2);
  });
});

describe("estimate -> invoice conversion preserves totals", () => {
  async function createEstimate(taxRate: number, lineItems: unknown[]): Promise<number> {
    const res = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      taxRate,
      lineItems,
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it("carries the estimate's line items and tax through to the invoice total", async () => {
    const estimateId = await createEstimate(8.5, [
      { description: "Diagnostic", type: "labor", quantity: 1, unitPrice: 100 },
      { description: "Brake pads", type: "part", quantity: 2, unitPrice: 50 },
    ]);

    const res = await authPost(`/api/estimates/${estimateId}/convert-to-invoice`);
    expect(res.status).toBe(201);
    // subtotal 100 + (2 * 50) = 200; tax 8.5% = 17; total 217.
    expect(res.body.subtotal).toBe(200);
    expect(res.body.taxAmount).toBe(17);
    expect(res.body.total).toBe(217);
    expect(res.body.status).toBe("draft");
    expect(res.body.estimateId).toBe(estimateId);
    expect(res.body.lineItems).toHaveLength(2);
  });

  it("refuses to convert the same estimate twice (409)", async () => {
    const estimateId = await createEstimate(0, [
      { description: "Oil change", type: "labor", quantity: 1, unitPrice: 60 },
    ]);

    const first = await authPost(`/api/estimates/${estimateId}/convert-to-invoice`);
    expect(first.status).toBe(201);

    const second = await authPost(`/api/estimates/${estimateId}/convert-to-invoice`);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already been converted/i);
  });

  it("refuses to convert an estimate with no line items (400)", async () => {
    const estimateId = await createEstimate(0, []);
    const res = await authPost(`/api/estimates/${estimateId}/convert-to-invoice`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no line items/i);
  });
});

describe("estimate -> work order conversion (REST)", () => {
  async function createEstimate(): Promise<number> {
    const res = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: "Diagnostic", type: "labor", quantity: 1, unitPrice: 80 }],
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it("creates an open work order linked to the estimate's customer/vehicle and back-links the estimate (201)", async () => {
    const estimateId = await createEstimate();

    const res = await authPost(`/api/estimates/${estimateId}/convert-to-work-order`);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTypeOf("number");
    expect(res.body.customerId).toBe(shop.customerId);
    expect(res.body.vehicleId).toBe(shop.vehicleId);
    expect(res.body.status).toBe("open");

    // The estimate is now back-linked to the new work order.
    const est = await authGet(`/api/estimates/${estimateId}`);
    expect(est.status).toBe(200);
    expect(est.body.workOrderId).toBe(res.body.id);
  });

  it("copies the estimate's quoted line items into the work order's structured tasks & parts", async () => {
    const created = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [
        { description: "Front brake job", type: "labor", quantity: 2, unitPrice: 90 },
        { description: "Brake pads", type: "part", quantity: 1, unitPrice: 45 },
      ],
    });
    expect(created.status).toBe(201);

    const res = await authPost(`/api/estimates/${created.body.id}/convert-to-work-order`);
    expect(res.status).toBe(201);

    const wo = await authGet(`/api/work-orders/${res.body.id}`);
    expect(wo.status).toBe(200);
    // Work orders now carry structured line items, so the quote is copied over
    // verbatim instead of being folded into the notes as a text summary. The
    // notes retain only a short provenance reference.
    expect(wo.body.notes).toMatch(/^Converted from EST-\d+\.$/);
    expect(wo.body.notes).not.toMatch(/Quoted items/);
    const items = wo.body.lineItems as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);

    const labor = items.find((li) => li.description === "Front brake job")!;
    expect(labor.type).toBe("labor");
    expect(labor.quantity).toBe(2);
    expect(labor.total).toBe(180);

    const part = items.find((li) => li.description === "Brake pads")!;
    expect(part.type).toBe("part");
    expect(part.quantity).toBe(1);
    expect(part.total).toBe(45);
  });

  it("refuses to convert the same estimate twice (409)", async () => {
    const estimateId = await createEstimate();

    const first = await authPost(`/api/estimates/${estimateId}/convert-to-work-order`);
    expect(first.status).toBe(201);

    const second = await authPost(`/api/estimates/${estimateId}/convert-to-work-order`);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already linked to a work order/i);
  });

  it("fails closed (403) for a caller lacking the workOrders permission", async () => {
    const estimateId = await createEstimate();

    const staff = await seedStaffUser(["estimates"], "estonly_to_wo");
    const res = await agent()
      .post(`/api/estimates/${estimateId}/convert-to-work-order`)
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permission to create work orders/i);
  });
});

describe("estimates are blocked when parts exceed on-hand stock", () => {
  it("rejects a part line item quoting more than stock (409) and lists offenders", async () => {
    const { id: partId, name } = await seedPart({
      name: uniqueName("OverStock Brake"),
      quantityOnHand: 3,
      reorderLevel: 1,
      unitPrice: 40,
    });

    const res = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: name, type: "part", quantity: 5, unitPrice: 40, partId }],
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/exceed available stock/i);
    expect(res.body.overStockItems).toHaveLength(1);
    expect(res.body.overStockItems[0]).toMatchObject({ requested: 5, available: 3 });
  });

  it("allows quoting over stock when allowOverStock is set", async () => {
    const { id: partId, name } = await seedPart({
      name: uniqueName("Override Filter"),
      quantityOnHand: 1,
      reorderLevel: 0,
      unitPrice: 10,
    });

    const res = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      allowOverStock: true,
      lineItems: [{ description: name, type: "part", quantity: 9, unitPrice: 10, partId }],
    });

    expect(res.status).toBe(201);
    expect(res.body.lineItems).toHaveLength(1);
  });

  it("matches by description when no partId is supplied", async () => {
    const { name } = await seedPart({
      name: uniqueName("Cabin Air Filter"),
      quantityOnHand: 2,
      reorderLevel: 0,
      unitPrice: 25,
    });

    const res = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: name, type: "part", quantity: 4, unitPrice: 25 }],
    });

    expect(res.status).toBe(409);
    expect(res.body.overStockItems[0]).toMatchObject({ requested: 4, available: 2 });
  });

  it("permits a part within stock and ignores non-part lines", async () => {
    const { id: partId, name } = await seedPart({
      name: uniqueName("In Stock Pads"),
      quantityOnHand: 10,
      reorderLevel: 2,
      unitPrice: 30,
    });

    const res = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [
        { description: name, type: "part", quantity: 4, unitPrice: 30, partId },
        { description: "Labor", type: "labor", quantity: 99, unitPrice: 100 },
      ],
    });

    expect(res.status).toBe(201);
  });

  it("blocks an update that pushes a part over stock (409)", async () => {
    const { id: partId, name } = await seedPart({
      name: uniqueName("Update Guard Part"),
      quantityOnHand: 2,
      reorderLevel: 0,
      unitPrice: 15,
    });

    const created = await authPost("/api/estimates").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: name, type: "part", quantity: 1, unitPrice: 15, partId }],
    });
    expect(created.status).toBe(201);

    const res = await authPatch(`/api/estimates/${created.body.id}`).send({
      lineItems: [{ description: name, type: "part", quantity: 8, unitPrice: 15, partId }],
    });
    expect(res.status).toBe(409);
    expect(res.body.overStockItems[0]).toMatchObject({ requested: 8, available: 2 });
  });
});

describe("invoices are blocked when parts exceed on-hand stock", () => {
  it("rejects a part line item billing more than stock (409) and lists offenders", async () => {
    const { id: partId, name } = await seedPart({
      name: uniqueName("Invoice OverStock Brake"),
      quantityOnHand: 3,
      reorderLevel: 1,
      unitPrice: 40,
    });

    const res = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: name, type: "part", quantity: 5, unitPrice: 40, partId }],
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/exceed available stock/i);
    expect(res.body.overStockItems).toHaveLength(1);
    expect(res.body.overStockItems[0]).toMatchObject({ requested: 5, available: 3 });
  });

  it("allows billing over stock when allowOverStock is set", async () => {
    const { id: partId, name } = await seedPart({
      name: uniqueName("Invoice Override Filter"),
      quantityOnHand: 1,
      reorderLevel: 0,
      unitPrice: 10,
    });

    const res = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      allowOverStock: true,
      lineItems: [{ description: name, type: "part", quantity: 9, unitPrice: 10, partId }],
    });

    expect(res.status).toBe(201);
    expect(res.body.lineItems).toHaveLength(1);
  });

  it("matches by description when no partId is supplied", async () => {
    const { name } = await seedPart({
      name: uniqueName("Invoice Cabin Air Filter"),
      quantityOnHand: 2,
      reorderLevel: 0,
      unitPrice: 25,
    });

    const res = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: name, type: "part", quantity: 4, unitPrice: 25 }],
    });

    expect(res.status).toBe(409);
    expect(res.body.overStockItems[0]).toMatchObject({ requested: 4, available: 2 });
  });

  it("permits a part within stock and ignores non-part lines", async () => {
    const { id: partId, name } = await seedPart({
      name: uniqueName("Invoice In Stock Pads"),
      quantityOnHand: 10,
      reorderLevel: 2,
      unitPrice: 30,
    });

    const res = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [
        { description: name, type: "part", quantity: 4, unitPrice: 30, partId },
        { description: "Labor", type: "labor", quantity: 99, unitPrice: 100 },
      ],
    });

    expect(res.status).toBe(201);
  });

  it("blocks an update that pushes a part over stock (409)", async () => {
    const { id: partId, name } = await seedPart({
      name: uniqueName("Invoice Update Guard Part"),
      quantityOnHand: 2,
      reorderLevel: 0,
      unitPrice: 15,
    });

    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: name, type: "part", quantity: 1, unitPrice: 15, partId }],
    });
    expect(created.status).toBe(201);

    const res = await authPatch(`/api/invoices/${created.body.id}`).send({
      lineItems: [{ description: name, type: "part", quantity: 8, unitPrice: 15, partId }],
    });
    expect(res.status).toBe(409);
    expect(res.body.overStockItems[0]).toMatchObject({ requested: 8, available: 2 });
  });

  it("redacts the available count from a caller without inventory permission", async () => {
    const { id: partId, name } = await seedPart({
      name: uniqueName("Invoice Redacted Stock"),
      quantityOnHand: 1,
      reorderLevel: 0,
      unitPrice: 20,
    });

    const staff = await seedStaffUser(["invoices", "customers"], "invonly_stock");
    const res = await agent()
      .post("/api/invoices")
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({
        customerId: shop.customerId,
        vehicleId: shop.vehicleId,
        lineItems: [{ description: name, type: "part", quantity: 5, unitPrice: 20, partId }],
      });

    expect(res.status).toBe(409);
    expect(res.body.overStockItems[0]).toMatchObject({ requested: 5, available: null });
  });
});

describe("work order labor totals add up across sessions", () => {
  async function createWorkOrder(): Promise<number> {
    const res = await authPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "Test Work Order",
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it("sums only completed sessions and flags an active one", async () => {
    const workOrderId = await createWorkOrder();
    await seedLaborSession({ workOrderId, minutes: 30 });
    await seedLaborSession({ workOrderId, minutes: 45 });
    await seedLaborSession({ workOrderId, minutes: null }); // still running

    const res = await authGet(`/api/work-orders/${workOrderId}`);
    expect(res.status).toBe(200);
    expect(res.body.totalLaborMinutes).toBe(75);
    expect(res.body.hasActiveSession).toBe(true);
    expect(res.body.laborSessions).toHaveLength(3);
  });

  it("reports zero labor minutes and no active session when there are none", async () => {
    const workOrderId = await createWorkOrder();
    const res = await authGet(`/api/work-orders/${workOrderId}`);
    expect(res.status).toBe(200);
    expect(res.body.totalLaborMinutes).toBe(0);
    expect(res.body.hasActiveSession).toBe(false);
  });
});

describe("generating an invoice from a work order bills tracked labor time", () => {
  async function createWorkOrder(): Promise<number> {
    const res = await authPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("Labor billing WO"),
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  function laborLines(lineItems: Array<Record<string, unknown>>) {
    return lineItems.filter(
      (li) => li.type === "labor" && li.description === "Tracked labor time",
    );
  }

  it("adds a priced labor line from reviewed hours at the supplied rate", async () => {
    const workOrderId = await createWorkOrder();
    await seedLaborSession({ workOrderId, minutes: 90 });

    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "draft",
      lineItems: [],
      laborHours: 1.5,
      laborRate: 120,
    });
    expect(created.status).toBe(201);

    const res = await authGet(`/api/invoices/${created.body.id}`);
    expect(res.status).toBe(200);
    const labor = laborLines(res.body.lineItems);
    expect(labor).toHaveLength(1);
    expect(labor[0]).toMatchObject({ quantity: 1.5, unitPrice: 120 });
    expect(res.body.subtotal).toBe(180);
  });

  it("falls back to the shop default labor rate when no rate is supplied", async () => {
    const settings = await authPut("/api/settings").send({ defaultLaborRate: 95 });
    expect(settings.status).toBe(200);

    const workOrderId = await createWorkOrder();
    await seedLaborSession({ workOrderId, minutes: 120 });

    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "draft",
      lineItems: [],
      laborHours: 2,
    });
    expect(created.status).toBe(201);

    const res = await authGet(`/api/invoices/${created.body.id}`);
    expect(res.status).toBe(200);
    const labor = laborLines(res.body.lineItems);
    expect(labor).toHaveLength(1);
    expect(labor[0]).toMatchObject({ quantity: 2, unitPrice: 95 });
  });

  it("does not add a labor line when laborHours is omitted or zero", async () => {
    const workOrderId = await createWorkOrder();
    await seedLaborSession({ workOrderId, minutes: 60 });

    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      workOrderId,
      status: "draft",
      lineItems: [],
    });
    expect(created.status).toBe(201);

    const res = await authGet(`/api/invoices/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(laborLines(res.body.lineItems)).toHaveLength(0);
  });
});

describe("receiving a purchase order adds stock to linked parts", () => {
  async function createPurchaseOrder(partId: number, quantity: number, unitCost: number) {
    const res = await authPost("/api/purchase-orders").send({
      vendor: "Test Vendor",
      lineItems: [{ partId, description: "Restock brake pads", quantity, unitCost }],
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function getPart(partId: number) {
    const res = await authGet(`/api/parts/${partId}`);
    expect(res.status).toBe(200);
    return res.body;
  }

  it("increments quantityOnHand by the received quantity and computes the PO total", async () => {
    const { id: partId } = await seedPart({
      name: uniqueName("Part"),
      quantityOnHand: 5,
      reorderLevel: 2,
      unitPrice: 9,
    });
    const po = await createPurchaseOrder(partId, 10, 3);
    expect(po.total).toBe(30);
    expect(po.status).toBe("draft");

    const received = await authPatch(`/api/purchase-orders/${po.id}`).send({ status: "received" });
    expect(received.status).toBe(200);
    expect(received.body.status).toBe("received");

    const part = await getPart(partId);
    expect(part.quantityOnHand).toBe(15);
  });

  it("does not double-count stock when a received PO is patched again", async () => {
    const { id: partId } = await seedPart({
      name: uniqueName("Part"),
      quantityOnHand: 0,
      reorderLevel: 2,
      unitPrice: 9,
    });
    const po = await createPurchaseOrder(partId, 4, 2);

    const firstReceive = await authPatch(`/api/purchase-orders/${po.id}`).send({
      status: "received",
    });
    expect(firstReceive.status).toBe(200);
    expect((await getPart(partId)).quantityOnHand).toBe(4);

    // A redundant PATCH to the same status must not add the quantity again.
    const secondReceive = await authPatch(`/api/purchase-orders/${po.id}`).send({
      status: "received",
    });
    expect(secondReceive.status).toBe(200);
    expect((await getPart(partId)).quantityOnHand).toBe(4);
  });
});

describe("financial reports respect their date filters", () => {
  // Each run gets a fresh, isolated database (see test/globalSetup.ts), so these
  // tests can assert absolute totals. Each test still uses its own distinct
  // window so seeds from neighbouring tests in this file never overlap.

  it("profit/loss counts only in-range revenue, payroll, and expenses", async () => {
    const start = "2025-03-01";
    const end = "2025-03-31";
    const inWindow = "2025-03-15";
    const outOfWindow = "2025-09-15";

    const { categoryId } = await seedExpenseCategory(true);
    await seedExpense({ date: inWindow, amount: 123.45, taxAmount: 10, categoryId });
    await seedExpense({ date: outOfWindow, amount: 999, taxAmount: 50, categoryId });
    await seedIssuedInvoice({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      createdAt: `${inWindow}T12:00:00.000Z`,
      subtotal: 500,
      taxRate: 10,
    });
    await seedIssuedInvoice({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      createdAt: `${outOfWindow}T12:00:00.000Z`,
      subtotal: 4000,
      taxRate: 10,
    });
    await seedMechanicWithEntry(inWindow); // 10 hours @ 40 = 400 gross pay

    const res = await authGet("/api/reports/profit-loss").query({ startDate: start, endDate: end });
    expect(res.status).toBe(200);

    // Only the in-window rows are counted; the out-of-window ones are excluded.
    expect(round(res.body.revenue)).toBe(500);
    expect(round(res.body.taxCollected)).toBe(50);
    expect(round(res.body.payroll)).toBe(400);
    expect(round(res.body.totalExpenses)).toBe(123.45);
    // netProfit = revenue - expenses - payroll => 500 - 123.45 - 400.
    expect(round(res.body.netProfit)).toBe(round(500 - 123.45 - 400));
  });

  it("excludes out-of-range expenses but includes them when the window widens", async () => {
    const start = "2027-07-01";
    const narrowEnd = "2027-07-31";
    const wideEnd = "2027-12-31";
    const outOfWindow = "2027-09-15";

    const { categoryId } = await seedExpenseCategory(true);
    await seedExpense({ date: outOfWindow, amount: 250, taxAmount: 20, categoryId });

    const narrow = await authGet("/api/reports/expenses").query({
      startDate: start,
      endDate: narrowEnd,
    });
    const wide = await authGet("/api/reports/expenses").query({
      startDate: start,
      endDate: wideEnd,
    });
    expect(narrow.status).toBe(200);
    expect(wide.status).toBe(200);

    // The September expense is absent from the July window but appears once the
    // window widens to cover September.
    expect(round(narrow.body.total)).toBe(0);
    expect(round(wide.body.total)).toBe(250);
    expect(round(wide.body.taxPaid)).toBe(20);
  });

  it("splits deductible from non-deductible expenses in range", async () => {
    const start = "2028-07-01";
    const end = "2028-07-31";
    const inWindow = "2028-07-15";

    const { categoryId: deductibleCat } = await seedExpenseCategory(true);
    const { categoryId: nonDeductibleCat } = await seedExpenseCategory(false);
    await seedExpense({ date: inWindow, amount: 80, categoryId: deductibleCat });
    await seedExpense({ date: inWindow, amount: 30, categoryId: nonDeductibleCat });

    const res = await authGet("/api/reports/expenses").query({
      startDate: start,
      endDate: end,
    });
    expect(res.status).toBe(200);
    expect(round(res.body.deductibleTotal)).toBe(80);
    expect(round(res.body.nonDeductibleTotal)).toBe(30);
    expect(round(res.body.total)).toBe(110);
  });
});

describe("expense receipt photos", () => {
  it("persists receiptUrls on create and returns them on list/detail", async () => {
    const { categoryId } = await seedExpenseCategory(true);
    const receiptUrls = ["/objects/uploads/receipt-a", "/objects/uploads/receipt-b"];

    const created = await authPost("/api/expenses").send({
      categoryId,
      date: "2029-01-10",
      description: "Receipt round-trip",
      amount: 42.5,
      receiptUrls,
    });
    expect(created.status).toBe(201);
    expect(created.body.receiptUrls).toEqual(receiptUrls);

    const list = await authGet("/api/expenses");
    expect(list.status).toBe(200);
    const found = list.body.find((e: { id: number }) => e.id === created.body.id);
    expect(found).toBeDefined();
    expect(found.receiptUrls).toEqual(receiptUrls);
  });

  it("defaults receiptUrls to an empty array when omitted", async () => {
    const { categoryId } = await seedExpenseCategory(true);
    const created = await authPost("/api/expenses").send({
      categoryId,
      date: "2029-02-10",
      description: "No receipts",
      amount: 10,
    });
    expect(created.status).toBe(201);
    expect(created.body.receiptUrls).toEqual([]);
  });

  it("preserves receiptUrls across an unrelated PATCH", async () => {
    const { categoryId } = await seedExpenseCategory(true);
    const receiptUrls = ["/objects/uploads/receipt-keep"];
    const created = await authPost("/api/expenses").send({
      categoryId,
      date: "2029-03-10",
      description: "Patch me",
      amount: 5,
      receiptUrls,
    });
    expect(created.status).toBe(201);

    const patched = await authPatch(`/api/expenses/${created.body.id}`).send({
      amount: 7.5,
    });
    expect(patched.status).toBe(200);
    expect(round(patched.body.amount)).toBe(7.5);
    expect(patched.body.receiptUrls).toEqual(receiptUrls);
  });
});
