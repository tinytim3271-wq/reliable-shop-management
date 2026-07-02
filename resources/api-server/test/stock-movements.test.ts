import { beforeAll, describe, expect, it } from "vitest";
import { db, stockMovementsTable } from "@workspace/db";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  seedPart,
  seedStaffUser,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// The stock movement ledger records every change to a part's on-hand count, in
// the same transaction as the change. These tests pin that PO receipts, invoice
// billing, edits, and deletes each write a movement row with the right signed
// delta and source, so a suspicious count can always be traced to its origin.

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (t: ReturnType<ReturnType<typeof agent>["get"]>) =>
  t.set("Cookie", admin.cookie).set("X-Forwarded-Proto", "https");
const authGet = (path: string) => withAuth(agent().get(path));
const authPost = (path: string) => withAuth(agent().post(path));
const authPatch = (path: string) => withAuth(agent().patch(path));
const authDelete = (path: string) => withAuth(agent().delete(path));

interface Movement {
  id: number;
  partId: number;
  delta: number;
  reason: string;
  sourceType: string | null;
  sourceId: number | null;
  createdByUserId: number | null;
  createdByName: string | null;
  createdAt: string;
}

async function movementsOf(partId: number): Promise<Movement[]> {
  const res = await authGet(`/api/parts/${partId}/movements`);
  expect(res.status).toBe(200);
  return res.body;
}

async function freshPart(qty: number): Promise<{ id: number; name: string }> {
  return seedPart({
    name: uniqueName("Movement Part"),
    quantityOnHand: qty,
    reorderLevel: 0,
  });
}

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("part stock movement ledger", () => {
  it("returns an empty ledger for a part with no movements", async () => {
    const part = await freshPart(5);
    expect(await movementsOf(part.id)).toEqual([]);
  });

  it("404s for an unknown part", async () => {
    const res = await authGet("/api/parts/99999999/movements");
    expect(res.status).toBe(404);
  });

  it("records a negative movement when an invoice bills a part", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);

    const moves = await movementsOf(part.id);
    expect(moves).toHaveLength(1);
    expect(moves[0].delta).toBe(-3);
    expect(moves[0].sourceType).toBe("invoice");
    expect(moves[0].sourceId).toBe(created.body.id);
    expect(moves[0].reason).toBe("Billed on invoice");
  });

  it("does not record a movement for a draft invoice", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      lineItems: [{ description: part.name, type: "part", quantity: 2, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    expect(await movementsOf(part.id)).toEqual([]);
  });

  it("records a reversing movement when a billed invoice is edited down", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 4, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    // 4 -> 1: net change of +3 back to stock recorded as an edit movement.
    const edited = await authPatch(`/api/invoices/${id}`).send({
      lineItems: [{ description: part.name, type: "part", quantity: 1, unitPrice: 20 }],
    });
    expect(edited.status).toBe(200);

    const moves = await movementsOf(part.id);
    // Newest first: the edit movement, then the original billing movement.
    expect(moves).toHaveLength(2);
    expect(moves[0].delta).toBe(3);
    expect(moves[0].reason).toBe("Invoice edited");
    expect(moves[1].delta).toBe(-4);
    expect(moves[1].reason).toBe("Billed on invoice");
  });

  it("records a restoring movement when a billed invoice is deleted", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);

    const del = await authDelete(`/api/invoices/${created.body.id}`);
    expect(del.status).toBe(204);

    const moves = await movementsOf(part.id);
    expect(moves).toHaveLength(2);
    expect(moves[0].delta).toBe(3);
    expect(moves[0].reason).toBe("Invoice deleted");
  });

  it("records a movement when on-hand is manually adjusted up", async () => {
    const part = await freshPart(5);
    const patched = await authPatch(`/api/parts/${part.id}`).send({ quantityOnHand: 12 });
    expect(patched.status).toBe(200);

    const moves = await movementsOf(part.id);
    expect(moves).toHaveLength(1);
    expect(moves[0].delta).toBe(7);
    expect(moves[0].reason).toBe("Manual adjustment");
    expect(moves[0].sourceType).toBeNull();
    expect(moves[0].sourceId).toBeNull();
  });

  it("records a negative movement when on-hand is manually adjusted down", async () => {
    const part = await freshPart(10);
    const patched = await authPatch(`/api/parts/${part.id}`).send({ quantityOnHand: 4 });
    expect(patched.status).toBe(200);

    const moves = await movementsOf(part.id);
    expect(moves).toHaveLength(1);
    expect(moves[0].delta).toBe(-6);
    expect(moves[0].reason).toBe("Manual adjustment");
  });

  it("does not record a movement when on-hand is unchanged", async () => {
    const part = await freshPart(8);
    // Same quantity plus an unrelated field change.
    const patched = await authPatch(`/api/parts/${part.id}`).send({
      quantityOnHand: 8,
      reorderLevel: 3,
    });
    expect(patched.status).toBe(200);
    expect(await movementsOf(part.id)).toEqual([]);
  });

  it("does not record a movement when the count field is omitted", async () => {
    const part = await freshPart(8);
    const patched = await authPatch(`/api/parts/${part.id}`).send({ reorderLevel: 2 });
    expect(patched.status).toBe(200);
    expect(await movementsOf(part.id)).toEqual([]);
  });

  it("records a positive movement when a purchase order is received", async () => {
    const part = await freshPart(2);
    const po = await authPost("/api/purchase-orders").send({
      vendor: uniqueName("Vendor"),
      lineItems: [{ partId: part.id, description: part.name, quantity: 8, unitCost: 5 }],
    });
    expect(po.status).toBe(201);

    // No stock change until it is received.
    expect(await movementsOf(part.id)).toEqual([]);

    const received = await authPatch(`/api/purchase-orders/${po.body.id}`).send({
      status: "received",
    });
    expect(received.status).toBe(200);

    const moves = await movementsOf(part.id);
    expect(moves).toHaveLength(1);
    expect(moves[0].delta).toBe(8);
    expect(moves[0].sourceType).toBe("purchase_order");
    expect(moves[0].sourceId).toBe(po.body.id);
    expect(moves[0].reason).toBe("Received purchase order");
  });
});

// Every stock movement records who triggered it (createdByUserId), surfaced via
// the movements endpoint as createdByName (the actor's display name). These
// tests pin that attribution end-to-end across each write path that mutates
// stock (invoice billing, edit, delete, and PO receipt), and that legacy/system
// rows with no actor still come back (createdByName null) instead of being
// dropped by the user join.
//
// Note: the refund endpoint does NOT emit a stock movement in normal use — every
// post-refund status (sent/partial/paid) is still stock-committed, so the count
// never moves and there is nothing to attribute. Stock decommit only happens
// when a billed invoice is voided (status -> "void"), which flows through the
// PATCH status-change path and so records an "Invoice voided" movement; that
// void/cancel attribution is pinned below.
describe("part stock movement attribution", () => {
  it("attributes an invoice billing movement to the acting user", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 2, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);

    const moves = await movementsOf(part.id);
    expect(moves).toHaveLength(1);
    expect(moves[0].reason).toBe("Billed on invoice");
    expect(moves[0].createdByUserId).toBe(admin.id);
    expect(moves[0].createdByName).toBe("API Test Admin");
  });

  it("attributes an invoice edit movement to the acting user", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 4, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);

    // 4 -> 2: net +2 back to stock, recorded as an "Invoice edited" movement.
    const edited = await authPatch(`/api/invoices/${created.body.id}`).send({
      lineItems: [{ description: part.name, type: "part", quantity: 2, unitPrice: 20 }],
    });
    expect(edited.status).toBe(200);

    const moves = await movementsOf(part.id);
    const editMove = moves.find((m) => m.reason === "Invoice edited");
    expect(editMove).toBeDefined();
    expect(editMove?.createdByUserId).toBe(admin.id);
    expect(editMove?.createdByName).toBe("API Test Admin");
  });

  it("attributes an invoice delete movement to the acting user", async () => {
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);

    const del = await authDelete(`/api/invoices/${created.body.id}`);
    expect(del.status).toBe(204);

    const moves = await movementsOf(part.id);
    const deleteMove = moves.find((m) => m.reason === "Invoice deleted");
    expect(deleteMove).toBeDefined();
    expect(deleteMove?.delta).toBe(3);
    expect(deleteMove?.createdByUserId).toBe(admin.id);
    expect(deleteMove?.createdByName).toBe("API Test Admin");
  });

  it("attributes a void's stock-restoring movement to the user who voided it", async () => {
    // Bill the part as the admin, then void the invoice as a *different* staff
    // user. Voiding decommits stock, so the restoring movement must be pinned to
    // the person who voided — not the original biller — which is the financially
    // sensitive attribution this test guards.
    const invoiceStaff = await seedStaffUser(["invoices", "inventory", "accounting"], "void-staff");
    const part = await freshPart(10);
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);

    const voided = await agent()
      .patch(`/api/invoices/${created.body.id}`)
      .set("Cookie", invoiceStaff.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ status: "void" });
    expect(voided.status).toBe(200);

    const moves = await movementsOf(part.id);
    // Newest first: the void's restoring movement, then the original billing.
    expect(moves).toHaveLength(2);
    const restore = moves[0];
    expect(restore.delta).toBe(3);
    expect(restore.reason).toBe("Invoice voided");
    expect(restore.sourceType).toBe("invoice");
    expect(restore.sourceId).toBe(created.body.id);
    expect(restore.createdByUserId).toBe(invoiceStaff.id);
    expect(restore.createdByName).toBe("API Test Staff");

    // The original billing stays attributed to the admin who created it.
    expect(moves[1].delta).toBe(-3);
    expect(moves[1].reason).toBe("Billed on invoice");
    expect(moves[1].createdByUserId).toBe(admin.id);
    expect(moves[1].createdByName).toBe("API Test Admin");
  });

  it("attributes a manual stock adjustment movement to the acting user", async () => {
    const part = await freshPart(5);
    const patched = await authPatch(`/api/parts/${part.id}`).send({ quantityOnHand: 11 });
    expect(patched.status).toBe(200);

    const moves = await movementsOf(part.id);
    expect(moves).toHaveLength(1);
    expect(moves[0].reason).toBe("Manual adjustment");
    expect(moves[0].delta).toBe(6);
    expect(moves[0].createdByUserId).toBe(admin.id);
    expect(moves[0].createdByName).toBe("API Test Admin");
  });

  it("attributes a manual adjustment to the specific staff member who made it", async () => {
    // A second, distinctly-named staff user makes the change so the assertion
    // proves the actor is read from the authenticated session, not just that
    // *some* name is attached.
    const inventoryStaff = await seedStaffUser(["inventory"], "inv-staff");
    const part = await freshPart(10);
    const patched = await agent()
      .patch(`/api/parts/${part.id}`)
      .set("Cookie", inventoryStaff.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ quantityOnHand: 3 });
    expect(patched.status).toBe(200);

    const moves = await movementsOf(part.id);
    expect(moves).toHaveLength(1);
    expect(moves[0].delta).toBe(-7);
    expect(moves[0].createdByUserId).toBe(inventoryStaff.id);
    expect(moves[0].createdByName).toBe("API Test Staff");
  });

  it("attributes a purchase order receipt movement to the acting user", async () => {
    const part = await freshPart(2);
    const po = await authPost("/api/purchase-orders").send({
      vendor: uniqueName("Vendor"),
      lineItems: [{ partId: part.id, description: part.name, quantity: 6, unitCost: 5 }],
    });
    expect(po.status).toBe(201);
    const received = await authPatch(`/api/purchase-orders/${po.body.id}`).send({
      status: "received",
    });
    expect(received.status).toBe(200);

    const moves = await movementsOf(part.id);
    expect(moves).toHaveLength(1);
    expect(moves[0].createdByUserId).toBe(admin.id);
    expect(moves[0].createdByName).toBe("API Test Admin");
  });

  it("returns legacy/system rows with a null actor instead of dropping them", async () => {
    const part = await freshPart(7);
    // Simulate a movement written before attribution existed (or by an automated
    // system path): no createdByUserId. The user left-join must keep it visible.
    await db.insert(stockMovementsTable).values({
      partId: part.id,
      delta: -1,
      reason: "Manual adjustment",
      createdByUserId: null,
    });

    const moves = await movementsOf(part.id);
    expect(moves).toHaveLength(1);
    expect(moves[0].createdByUserId).toBeNull();
    expect(moves[0].createdByName).toBeNull();
  });

  it("keeps a null-actor row alongside an attributed row", async () => {
    const part = await freshPart(10);
    // One legacy row (no actor) ...
    await db.insert(stockMovementsTable).values({
      partId: part.id,
      delta: 2,
      reason: "Received purchase order",
      sourceType: "purchase_order",
      sourceId: null,
      createdByUserId: null,
    });
    // ... and one real attributed billing movement.
    const created = await authPost("/api/invoices").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 1, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);

    const moves = await movementsOf(part.id);
    expect(moves).toHaveLength(2);
    const attributed = moves.find((m) => m.createdByUserId !== null);
    const legacy = moves.find((m) => m.createdByUserId === null);
    expect(attributed?.createdByName).toBe("API Test Admin");
    expect(legacy?.createdByName).toBeNull();
  });
});
