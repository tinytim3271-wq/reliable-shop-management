import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// Voiding an invoice is financially sensitive, so the invoice itself must keep a
// durable, human-readable record of who voided it and when — not just the part
// stock-movement ledger. These tests pin that the void attribution is written on
// the void transition, surfaced by GET /invoices/{id}, and cleared if the
// invoice is later moved back off the void status.

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (t: ReturnType<ReturnType<typeof agent>["get"]>) =>
  t.set("Cookie", admin.cookie).set("X-Forwarded-Proto", "https");
const authGet = (path: string) => withAuth(agent().get(path));
const authPost = (path: string) => withAuth(agent().post(path));
const authPatch = (path: string) => withAuth(agent().patch(path));

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

async function createSentInvoice(): Promise<number> {
  const res = await authPost("/api/invoices").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    status: "sent",
    lineItems: [{ description: "Diagnostic labor", type: "labor", quantity: 1, unitPrice: 90 }],
  });
  expect(res.status).toBe(201);
  // A freshly created invoice carries no void attribution.
  expect(res.body.voidedByUserId).toBeNull();
  expect(res.body.voidedByName).toBeNull();
  expect(res.body.voidedAt).toBeNull();
  return res.body.id;
}

describe("invoice void attribution", () => {
  it("records who voided the invoice and when, and surfaces it on GET", async () => {
    const id = await createSentInvoice();

    const before = new Date();
    const voided = await authPatch(`/api/invoices/${id}`).send({ status: "void" });
    const after = new Date();
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe("void");
    expect(voided.body.voidedByUserId).toBe(admin.id);
    expect(voided.body.voidedByName).toBe("API Test Admin");
    expect(voided.body.voidedAt).not.toBeNull();
    const voidedAt = new Date(voided.body.voidedAt);
    expect(voidedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(voidedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);

    // The attribution is durable: a fresh read of the invoice still returns it.
    const fetched = await authGet(`/api/invoices/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.voidedByUserId).toBe(admin.id);
    expect(fetched.body.voidedByName).toBe("API Test Admin");
    expect(fetched.body.voidedAt).toBe(voided.body.voidedAt);
  });

  it("does not change the void attribution when an already-voided invoice is edited", async () => {
    const id = await createSentInvoice();
    const voided = await authPatch(`/api/invoices/${id}`).send({ status: "void" });
    expect(voided.status).toBe(200);
    const originalVoidedAt = voided.body.voidedAt;

    const edited = await authPatch(`/api/invoices/${id}`).send({ notes: "voided in error log" });
    expect(edited.status).toBe(200);
    expect(edited.body.status).toBe("void");
    expect(edited.body.voidedByUserId).toBe(admin.id);
    expect(edited.body.voidedAt).toBe(originalVoidedAt);
  });

  it("clears the void attribution if the invoice is moved back off the void status", async () => {
    const id = await createSentInvoice();
    const voided = await authPatch(`/api/invoices/${id}`).send({ status: "void" });
    expect(voided.status).toBe(200);
    expect(voided.body.voidedByUserId).toBe(admin.id);

    const rebilled = await authPatch(`/api/invoices/${id}`).send({ status: "sent" });
    expect(rebilled.status).toBe(200);
    expect(rebilled.body.status).toBe("sent");
    expect(rebilled.body.voidedByUserId).toBeNull();
    expect(rebilled.body.voidedByName).toBeNull();
    expect(rebilled.body.voidedAt).toBeNull();
  });
});
