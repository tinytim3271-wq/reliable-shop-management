import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QBO push must fire when an invoice transitions into `paid` via the general
 * edit path (PATCH /invoices/:id), not only through the payment/refund handlers.
 * The hook is fire-and-forget and a no-op internally when QBO is not configured,
 * so we spy on `enqueueInvoiceSync` to assert it is (and isn't) enqueued.
 */

const { enqueueSpy } = vi.hoisted(() => ({ enqueueSpy: vi.fn() }));

vi.mock("../src/lib/qboSync", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/qboSync")>();
  return { ...actual, enqueueInvoiceSync: enqueueSpy };
});

import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (t: ReturnType<ReturnType<typeof agent>["get"]>) =>
  t.set("Cookie", admin.cookie).set("X-Forwarded-Proto", "https");
const authPost = (path: string) => withAuth(agent().post(path));
const authPatch = (path: string) => withAuth(agent().patch(path));

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

beforeEach(() => {
  enqueueSpy.mockClear();
});

async function createSentInvoice(): Promise<number> {
  const res = await authPost("/api/invoices").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    status: "sent",
    lineItems: [
      { description: "Diagnostic labor", type: "labor", quantity: 1, unitPrice: 90 },
    ],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe("QBO sync hook on invoice PATCH paid transition", () => {
  it("enqueues a sync when an edit transitions the invoice to paid", async () => {
    const id = await createSentInvoice();
    enqueueSpy.mockClear();

    const res = await authPatch(`/api/invoices/${id}`).send({ status: "paid" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
    expect(enqueueSpy).toHaveBeenCalledWith(id);
  });

  it("does not enqueue when the status changes to something other than paid", async () => {
    const id = await createSentInvoice();
    enqueueSpy.mockClear();

    const res = await authPatch(`/api/invoices/${id}`).send({ status: "void" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("void");
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does not re-enqueue when editing an already-paid invoice (no transition)", async () => {
    const id = await createSentInvoice();
    await authPatch(`/api/invoices/${id}`).send({ status: "paid" });
    enqueueSpy.mockClear();

    // A non-status edit on a paid invoice must not re-fire the hook.
    const res = await authPatch(`/api/invoices/${id}`).send({ notes: "thanks" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
