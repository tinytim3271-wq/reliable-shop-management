import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// The customer portal is a public, token-gated surface. Staff mint a per-record
// token (authenticated), then an unauthenticated customer uses it to view their
// estimate/invoice and approve/decline an estimate.

const NOT_FOUND = "This link is invalid or has expired.";

let admin: SeededAdmin;
let shop: SeededShop;

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

const withAuth = (t: ReturnType<ReturnType<typeof agent>["get"]>) =>
  t.set("Cookie", admin.cookie).set("X-Forwarded-Proto", "https");

async function createEstimate(): Promise<number> {
  const res = await withAuth(agent().post("/api/estimates")).send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    lineItems: [{ description: "Diagnostic", quantity: 1, unitPrice: 50 }],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createInvoice(): Promise<number> {
  const res = await withAuth(agent().post("/api/invoices")).send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    lineItems: [
      { description: "Brake pads", type: "part", quantity: 1, unitPrice: 80 },
    ],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function mintEstimateLink(id: number): Promise<string> {
  const res = await withAuth(
    agent().post(`/api/estimates/${id}/portal-link`),
  ).send({});
  expect(res.status).toBe(201);
  expect(typeof res.body.token).toBe("string");
  expect(typeof res.body.expiresAt).toBe("string");
  return res.body.token;
}

async function mintInvoiceLink(id: number): Promise<string> {
  const res = await withAuth(
    agent().post(`/api/invoices/${id}/portal-link`),
  ).send({});
  expect(res.status).toBe(201);
  return res.body.token;
}

// Fake object paths; an admin bypasses ownership checks and the storage layer
// returns null size for unreadable objects, so we can attach photos to a work
// order without real uploads.
const PHOTO_A = "/objects/uploads/portal-a.jpg";
const PHOTO_B = "/objects/uploads/portal-b.jpg";

async function createWorkOrderWithPhotos(): Promise<number> {
  const res = await withAuth(agent().post("/api/work-orders")).send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    title: "Portal photo work order",
    photoUrls: [PHOTO_A, PHOTO_B],
    photoCaptions: { [PHOTO_A]: "front bumper", [PHOTO_B]: "rear dent" },
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createInvoiceForWorkOrder(workOrderId: number): Promise<number> {
  const res = await withAuth(agent().post("/api/invoices")).send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    workOrderId,
    lineItems: [
      { description: "Brake pads", type: "part", quantity: 1, unitPrice: 80 },
    ],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createWorkOrder(): Promise<number> {
  const res = await withAuth(agent().post("/api/work-orders")).send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    title: "Portal prior-labor work order",
    lineItems: [],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function billLabor(workOrderId: number, hours: number): Promise<number> {
  const res = await withAuth(agent().post("/api/invoices")).send({
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

describe("staff portal-link minting requires auth and a real record", () => {
  it("rejects an unauthenticated mint with 401", async () => {
    const res = await agent().post("/api/estimates/1/portal-link").send({});
    expect(res.status).toBe(401);
  });

  it("returns 404 when minting a link for a nonexistent estimate", async () => {
    const res = await withAuth(
      agent().post("/api/estimates/999999999/portal-link"),
    ).send({});
    expect(res.status).toBe(404);
  });

  it("returns 404 when minting a link for a nonexistent invoice", async () => {
    const res = await withAuth(
      agent().post("/api/invoices/999999999/portal-link"),
    ).send({});
    expect(res.status).toBe(404);
  });
});

describe("public portal view", () => {
  it("returns the estimate view for a valid token without authentication", async () => {
    const id = await createEstimate();
    const token = await mintEstimateLink(id);

    const res = await agent().get(`/api/public/portal/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("estimate");
    expect(res.body.id).toBe(id);
    expect(res.body.canRespond).toBe(true);
    expect(res.body.total).toBe(50);
    // Internal/staff-only fields must never reach the public surface.
    const serialized = JSON.stringify(res.body);
    for (const leaked of ["passwordHash", "customerId", "vehicleId"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("returns the invoice view with amountDue and no respond affordance", async () => {
    const id = await createInvoice();
    const token = await mintInvoiceLink(id);

    const res = await agent().get(`/api/public/portal/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("invoice");
    expect(res.body.id).toBe(id);
    expect(res.body.canRespond).toBe(false);
    expect(res.body.total).toBe(80);
    expect(res.body.amountDue).toBe(80);
  });

  it("collapses an unknown token to a uniform 404", async () => {
    const res = await agent().get("/api/public/portal/not-a-real-token");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(NOT_FOUND);
  });

  it("does not disclose prior-invoice metadata to a second portal-viewed invoice on the same work order", async () => {
    // Portal tokens are scoped to exactly one invoice. Returning priorBilledLabor
    // data from other invoices on the same work order leaks those invoices' IDs,
    // formatted numbers, and hours to a recipient who never received those links.
    // The portal surface must always return [] regardless of work-order history.
    const workOrderId = await createWorkOrder();
    await billLabor(workOrderId, 2.5);
    const secondId = await billLabor(workOrderId, 1);
    const token = await mintInvoiceLink(secondId);

    const res = await agent().get(`/api/public/portal/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.priorBilledLabor).toEqual([]);
  });

  it("returns no prior-billed-labor for the first invoice on a work order", async () => {
    const workOrderId = await createWorkOrder();
    const firstId = await billLabor(workOrderId, 2);
    const token = await mintInvoiceLink(firstId);

    const res = await agent().get(`/api/public/portal/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.priorBilledLabor).toEqual([]);
  });

  it("returns no prior-billed-labor on an estimate portal view", async () => {
    const id = await createEstimate();
    const token = await mintEstimateLink(id);

    const res = await agent().get(`/api/public/portal/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.priorBilledLabor).toEqual([]);
  });
});

describe("public estimate approve/decline", () => {
  it("approves a pending estimate and locks further decisions with 409", async () => {
    const id = await createEstimate();
    const token = await mintEstimateLink(id);

    const approve = await agent().post(`/api/public/portal/${token}/approve`);
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("approved");
    expect(approve.body.approvedAt).toBeTypeOf("string");
    expect(approve.body.canRespond).toBe(false);

    // The decision is final: a second response must be rejected.
    const again = await agent().post(`/api/public/portal/${token}/approve`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already been approved/i);
  });

  it("declines a pending estimate", async () => {
    const id = await createEstimate();
    const token = await mintEstimateLink(id);

    const decline = await agent().post(`/api/public/portal/${token}/decline`);
    expect(decline.status).toBe(200);
    expect(decline.body.status).toBe("declined");
    expect(decline.body.canRespond).toBe(false);
  });

  it("rejects approving via an invoice token with 400", async () => {
    const id = await createInvoice();
    const token = await mintInvoiceLink(id);

    const res = await agent().post(`/api/public/portal/${token}/approve`);
    expect(res.status).toBe(400);
  });
});

describe("work order photos on invoice detail and portal", () => {
  it("includes captioned work order photos in staff order on the invoice detail", async () => {
    const workOrderId = await createWorkOrderWithPhotos();
    const invoiceId = await createInvoiceForWorkOrder(workOrderId);

    const res = await withAuth(agent().get(`/api/invoices/${invoiceId}`));
    expect(res.status).toBe(200);
    expect(res.body.workOrderPhotos).toEqual([
      { path: PHOTO_A, caption: "front bumper" },
      { path: PHOTO_B, caption: "rear dent" },
    ]);
  });

  it("returns an empty photo list for an invoice with no work order", async () => {
    const id = await createInvoice();
    const res = await withAuth(agent().get(`/api/invoices/${id}`));
    expect(res.status).toBe(200);
    expect(res.body.workOrderPhotos).toEqual([]);
  });

  it("exposes the work order photos on the public portal view", async () => {
    const workOrderId = await createWorkOrderWithPhotos();
    const invoiceId = await createInvoiceForWorkOrder(workOrderId);
    const token = await mintInvoiceLink(invoiceId);

    const res = await agent().get(`/api/public/portal/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.photos).toEqual([
      { path: PHOTO_A, caption: "front bumper" },
      { path: PHOTO_B, caption: "rear dent" },
    ]);
  });

  it("serves a token-scoped photo only for a path on the token's work order", async () => {
    const workOrderId = await createWorkOrderWithPhotos();
    const invoiceId = await createInvoiceForWorkOrder(workOrderId);
    const token = await mintInvoiceLink(invoiceId);

    // A path that is not on the work order collapses to the uniform 404,
    // never reaching the object store.
    const foreign = await agent().get(
      `/api/public/portal/${token}/photos/objects/uploads/not-on-work-order.jpg`,
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe(NOT_FOUND);

    // A path that IS on the work order passes the binding check; the fake
    // object then 404s at the storage layer (same uniform body).
    const owned = await agent().get(
      `/api/public/portal/${token}/photos/objects/uploads/portal-a.jpg`,
    );
    expect(owned.status).toBe(404);
  });

  it("rejects photo access for an unknown token with 404", async () => {
    const res = await agent().get(
      "/api/public/portal/not-a-real-token/photos/objects/uploads/portal-a.jpg",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(NOT_FOUND);
  });
});

describe("staff link revocation", () => {
  it("revokes all active links so the token stops resolving (404)", async () => {
    const id = await createEstimate();
    const token = await mintEstimateLink(id);

    // The link works before revocation.
    const before = await agent().get(`/api/public/portal/${token}`);
    expect(before.status).toBe(200);

    const revoke = await withAuth(
      agent().delete(`/api/estimates/${id}/portal-link`),
    ).send();
    expect(revoke.status).toBe(204);

    // After revocation the same token collapses to the uniform 404.
    const after = await agent().get(`/api/public/portal/${token}`);
    expect(after.status).toBe(404);
    expect(after.body.error).toBe(NOT_FOUND);
  });
});
