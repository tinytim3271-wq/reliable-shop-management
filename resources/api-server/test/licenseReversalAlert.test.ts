import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, licensesTable, licenseDevicesTable, storeOrdersTable } from "@workspace/db";
import { agent } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Owner alert when a sold license is reversed (Task: tell the owner the moment
// any background job fails for good — not just QuickBooks).
//
// When the Stripe webhook reconciles a refund or dispute on a sold license, the
// storefront revokes the key in the background. The owner — who may be away —
// must get a one-time out-of-band notification on that transition: once per real
// state change, never on Stripe's webhook retries, never on a won-dispute
// restore, and wrapped so a failed alert cannot abort webhook processing. The
// alert reuses the outreach module's owner-alert path, so it stays inert
// (simulated) unless a live email provider is connected.
//
// The Stripe client is mocked so payloads are treated as signature-valid; the
// outreach owner-alert is mocked so we can assert exactly when (and with what)
// it is invoked without touching email.
// ─────────────────────────────────────────────────────────────────────────────
const { processWebhookMock } = vi.hoisted(() => ({
  processWebhookMock: vi.fn(),
}));

vi.mock("../src/stripeClient", () => ({
  getStripeSync: vi.fn(async () => ({ processWebhook: processWebhookMock })),
  getUncachableStripeClient: vi.fn(async () => ({
    checkout: { sessions: { retrieve: vi.fn(), create: vi.fn() } },
    paymentIntents: { retrieve: vi.fn() },
  })),
}));

const notifyOwner = vi.fn();
vi.mock("../src/lib/messaging", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/messaging")>();
  return {
    ...actual,
    notifyOwner: (...args: unknown[]) => notifyOwner(...args),
  };
});

const FAKE_SIG = "t=1234567890,v1=fakesig";
const PAYMENT_INTENT_ID = "pi_alert_test";

function makeEventPayload(type: string, obj: Record<string, unknown>): string {
  return JSON.stringify({ type, data: { object: obj } });
}

async function postWebhook(type: string, obj: Record<string, unknown>) {
  return agent()
    .post("/api/stripe/webhook")
    .set("content-type", "application/json")
    .set("stripe-signature", FAKE_SIG)
    .send(makeEventPayload(type, obj));
}

async function seedOrder(
  licenseKey: string,
  status: string,
  opts: { withLicense?: boolean } = {},
) {
  const [order] = await db
    .insert(storeOrdersTable)
    .values({
      stripeSessionId: `cs_alert_${licenseKey.slice(-4)}`,
      stripePaymentIntentId: PAYMENT_INTENT_ID,
      plan: "solo",
      productName: "Solo",
      maxDevices: 1,
      licenseKey,
      amountTotal: 19900,
      currency: "usd",
      status,
    })
    .returning();
  if (opts.withLicense) {
    await db
      .insert(licensesTable)
      .values({ licenseKey, plan: "solo", maxDevices: 1, status: "active" });
  }
  return order.id;
}

beforeEach(async () => {
  processWebhookMock.mockReset();
  processWebhookMock.mockResolvedValue(undefined);
  notifyOwner.mockReset();
  notifyOwner.mockResolvedValue({ delivered: false, note: "simulated", toAddress: null });
  await db.delete(licenseDevicesTable);
  await db.delete(licensesTable);
  await db.delete(storeOrdersTable);
});

describe("sold-license reversal owner alert", () => {
  it("alerts the owner exactly once when a paid order is refunded", async () => {
    const orderId = await seedOrder("RSS-AL01-AL01-AL01-AL01", "paid", {
      withLicense: true,
    });

    const res = await postWebhook("charge.refunded", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(res.status).toBe(200);

    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const arg = notifyOwner.mock.calls[0][0] as { subject: string; body: string };
    expect(arg.subject).toMatch(/refunded/i);
    expect(arg.body).toContain(`#${orderId}`);
  });

  it("alerts the owner once when a paid order is disputed", async () => {
    await seedOrder("RSS-AL02-AL02-AL02-AL02", "paid", { withLicense: true });

    const res = await postWebhook("charge.dispute.created", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(res.status).toBe(200);

    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const arg = notifyOwner.mock.calls[0][0] as { subject: string };
    expect(arg.subject).toMatch(/disputed/i);
  });

  it("does not re-alert on a redelivered/duplicate refund event", async () => {
    await seedOrder("RSS-AL03-AL03-AL03-AL03", "paid", { withLicense: true });

    await postWebhook("charge.refunded", { payment_intent: PAYMENT_INTENT_ID });
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    notifyOwner.mockClear();
    // Stripe redelivers the same event; the order is already 'refunded', so no
    // genuine transition occurs and the owner must not be alerted again.
    await postWebhook("charge.refunded", { payment_intent: PAYMENT_INTENT_ID });
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("does not alert on a won-dispute restore (recovery, not a failure)", async () => {
    await seedOrder("RSS-AL04-AL04-AL04-AL04", "disputed", { withLicense: true });

    const res = await postWebhook("charge.dispute.closed", {
      payment_intent: PAYMENT_INTENT_ID,
      status: "won",
    });
    expect(res.status).toBe(200);

    const [order] = await db.select().from(storeOrdersTable);
    expect(order.status).toBe("paid");
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("does not alert for unrelated events that match no order", async () => {
    await seedOrder("RSS-AL05-AL05-AL05-AL05", "paid", { withLicense: true });

    const res = await postWebhook("charge.refunded", {
      payment_intent: "pi_some_other_charge",
    });
    expect(res.status).toBe(200);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("still reconciles (200) and revokes when the owner alert throws", async () => {
    notifyOwner.mockRejectedValue(new Error("alert boom"));
    await seedOrder("RSS-AL06-AL06-AL06-AL06", "paid", { withLicense: true });

    const res = await postWebhook("charge.refunded", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    const [order] = await db.select().from(storeOrdersTable);
    expect(order.status).toBe("refunded");
    const [license] = await db.select().from(licensesTable);
    expect(license.status).toBe("revoked");
  });
});
