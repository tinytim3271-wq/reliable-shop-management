import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, storeIssuanceAlertsTable, storeOrdersTable } from "@workspace/db";
import { agent } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Combined scenario: issuance failure + subsequent reversal webhook on a session
// that NEVER got a store_orders row.
//
// When a buyer pays through Stripe Checkout but the confirmation page cannot
// mint an RSS-XXXX key (e.g. unrecognized product), the issuance-failure alert
// fires once and records an anchor row in store_issuance_alerts. At this point
// there is NO store_orders row for that payment. Later, Stripe may deliver a
// refund or dispute webhook for the same payment_intent.
//
// The two concerns this file tests:
//   1. The issuance-failure alert fires exactly once — idempotent against polls.
//   2. The subsequent reversal webhook stays silent (no double alert) because
//      reconcileStoreOrderByPaymentIntent finds no store_orders row and returns
//      early — the store_issuance_alerts table is not consulted by the webhook
//      handler and must not interfere.
//
// Both the order-lookup route and the webhook route are exercised in the same
// describe block so the shared mock setup covers both paths in combination.
// ─────────────────────────────────────────────────────────────────────────────

const { processWebhookMock, retrieveSession, retrievePaymentIntent } = vi.hoisted(() => ({
  processWebhookMock: vi.fn(),
  retrieveSession: vi.fn(),
  retrievePaymentIntent: vi.fn(),
}));

vi.mock("../src/stripeClient", () => ({
  getStripeSync: vi.fn(async () => ({ processWebhook: processWebhookMock })),
  getUncachableStripeClient: vi.fn(async () => ({
    checkout: { sessions: { retrieve: retrieveSession, create: vi.fn() } },
    paymentIntents: { retrieve: retrievePaymentIntent },
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

import crypto from "node:crypto";

function hashSecret(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

const BUYER_EMAIL = "combined-buyer@example.com";
const PAYMENT_INTENT_ID = "pi_combined_test";
const SESSION_ID = "cs_combined_test";
const TEST_SECRET = "c3d4e5f6a7b8".repeat(5) + "c3d4e5f6"; // 64 hex chars

// Paid session whose product has NO recognizable license metadata — triggers
// the unrecognized_product issuance failure path. Includes orderSecretHash so
// the secret gate passes and the product-validation failure is actually reached.
function unrecognizedPaidSession() {
  return {
    id: SESSION_ID,
    payment_status: "paid",
    payment_intent: PAYMENT_INTENT_ID,
    customer_details: { email: BUYER_EMAIL },
    amount_total: 19900,
    currency: "usd",
    metadata: { orderSecretHash: hashSecret(TEST_SECRET) },
    line_items: {
      data: [
        {
          price: {
            product: {
              name: "Mystery Item",
              metadata: {},
            },
          },
        },
      ],
    },
  };
}

function lookupOrder() {
  return agent()
    .get(`/api/store/order/${SESSION_ID}`)
    .query({ secret: TEST_SECRET });
}

async function postWebhook(type: string, obj: Record<string, unknown>) {
  return agent()
    .post("/api/stripe/webhook")
    .set("content-type", "application/json")
    .set("stripe-signature", "t=1234567890,v1=fakesig")
    .send(JSON.stringify({ type, data: { object: obj } }));
}

beforeEach(async () => {
  retrieveSession.mockReset();
  retrievePaymentIntent.mockReset();
  processWebhookMock.mockReset();
  notifyOwner.mockReset();

  retrieveSession.mockResolvedValue(unrecognizedPaidSession());
  retrievePaymentIntent.mockResolvedValue({
    id: PAYMENT_INTENT_ID,
    latest_charge: { id: "ch_combined", refunded: false, disputed: false },
  });
  processWebhookMock.mockResolvedValue(undefined);
  notifyOwner.mockResolvedValue({ delivered: false, note: "simulated", toAddress: null });

  await db.delete(storeIssuanceAlertsTable);
  await db.delete(storeOrdersTable);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("combined: issuance failure then reversal webhook on a key-less order", () => {
  it("issuance alert fires once; refund webhook stays silent with no store_orders row", async () => {
    // Step 1: order lookup fails — unrecognized product, no key issued.
    const lookupRes = await lookupOrder();
    expect(lookupRes.status).toBe(422);

    // Issuance-failure alert must have fired exactly once.
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const issuanceCall = notifyOwner.mock.calls[0][0] as { subject: string };
    expect(issuanceCall.subject).toMatch(/license key/i);

    // The idempotency anchor must be recorded.
    const alertsBefore = await db.select().from(storeIssuanceAlertsTable);
    expect(alertsBefore).toHaveLength(1);
    expect(alertsBefore[0].stripeSessionId).toBe(SESSION_ID);

    // No store_orders row was created by the failed issuance.
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);

    // Step 2: Stripe delivers a refund webhook for the same payment intent.
    notifyOwner.mockClear();
    const webhookRes = await postWebhook("charge.refunded", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(webhookRes.status).toBe(200);

    // The reversal handler must stay silent — no store_orders row to match.
    expect(notifyOwner).not.toHaveBeenCalled();

    // The issuance alert anchor is unchanged — no extra rows were inserted.
    const alertsAfter = await db.select().from(storeIssuanceAlertsTable);
    expect(alertsAfter).toHaveLength(1);
    expect(alertsAfter[0].stripeSessionId).toBe(SESSION_ID);

    // store_orders remains empty throughout.
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);
  });

  it("issuance alert fires once; dispute webhook stays silent with no store_orders row", async () => {
    // Step 1: trigger the issuance failure.
    const lookupRes = await lookupOrder();
    expect(lookupRes.status).toBe(422);
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    // Step 2: dispute webhook for the same payment intent.
    notifyOwner.mockClear();
    const webhookRes = await postWebhook("charge.dispute.created", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(webhookRes.status).toBe(200);

    // Reversal handler must stay silent — no store_orders row.
    expect(notifyOwner).not.toHaveBeenCalled();

    // store_issuance_alerts is still exactly one row (not duplicated by webhook).
    const alerts = await db.select().from(storeIssuanceAlertsTable);
    expect(alerts).toHaveLength(1);
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);
  });

  it("repeated polls before webhook do not double-fire the issuance alert", async () => {
    // Three polls, all failing with unrecognized product.
    await lookupOrder();
    await lookupOrder();
    await lookupOrder();

    // Issuance alert deduped to one call despite three polls.
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(await db.select().from(storeIssuanceAlertsTable)).toHaveLength(1);

    // Refund webhook arrives — must not add a second alert.
    notifyOwner.mockClear();
    const webhookRes = await postWebhook("charge.refunded", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(webhookRes.status).toBe(200);
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(await db.select().from(storeIssuanceAlertsTable)).toHaveLength(1);
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);
  });

  it("a later webhook for a different payment intent does not alert either", async () => {
    // Issuance failure for our known session.
    await lookupOrder();
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    // Refund webhook for a completely different payment intent.
    notifyOwner.mockClear();
    const webhookRes = await postWebhook("charge.refunded", {
      payment_intent: "pi_unrelated_other",
    });
    expect(webhookRes.status).toBe(200);
    expect(notifyOwner).not.toHaveBeenCalled();

    // Nothing changed in either table.
    expect(await db.select().from(storeIssuanceAlertsTable)).toHaveLength(1);
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// payment_status_unverifiable: paymentIntents.retrieve throws mid-race.
//
// When the route calls stripe.paymentIntents.retrieve and the call throws
// (network error, Stripe outage, etc.) the route must:
//   1. Return 502 with { error: "Could not verify payment status" }
//   2. Fire alertOwnerOfIssuanceFailure exactly once
//   3. Record the idempotency anchor in store_issuance_alerts
//   4. Mint no store_orders row
//
// Subsequent polls must dedupe the alert (idempotent anchor already present).
// A refund or dispute webhook arriving after the failed verify must stay silent.
// ─────────────────────────────────────────────────────────────────────────────

describe("payment_status_unverifiable: paymentIntents.retrieve throws", () => {
  beforeEach(() => {
    // Use a recognized-product session so the route passes product validation
    // and actually reaches the paymentIntents.retrieve call.
    retrieveSession.mockResolvedValue(recognizedPaidSession());
    // Simulate a transient Stripe/network failure.
    retrievePaymentIntent.mockRejectedValue(new Error("Stripe network error"));
  });

  it("returns 502, fires exactly one issuance-failure alert, records anchor, mints no store_orders row", async () => {
    const res = await lookupOrder();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/verify payment status/i);

    // Alert must have fired exactly once.
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const call = notifyOwner.mock.calls[0][0] as { subject: string };
    expect(call.subject).toMatch(/license key/i);

    // Idempotency anchor must be present.
    const alerts = await db.select().from(storeIssuanceAlertsTable);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].stripeSessionId).toBe(SESSION_ID);

    // No key was issued.
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);
  });

  it("second poll dedupes the alert — notifyOwner called only once total across both polls", async () => {
    await lookupOrder();
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    // Second poll: retrieve still throws.
    const res2 = await lookupOrder();
    expect(res2.status).toBe(502);

    // Alert must NOT fire again.
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    // Anchor row count unchanged.
    expect(await db.select().from(storeIssuanceAlertsTable)).toHaveLength(1);
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);
  });

  it("subsequent refund webhook stays silent after payment_status_unverifiable failure", async () => {
    // Step 1: trigger the unverifiable path.
    const lookupRes = await lookupOrder();
    expect(lookupRes.status).toBe(502);
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    // Step 2: refund webhook for the same payment intent.
    notifyOwner.mockClear();
    const webhookRes = await postWebhook("charge.refunded", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(webhookRes.status).toBe(200);

    // Reversal handler finds no store_orders row → no-op, no second alert.
    expect(notifyOwner).not.toHaveBeenCalled();

    // Tables unchanged from after the initial failure.
    expect(await db.select().from(storeIssuanceAlertsTable)).toHaveLength(1);
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);
  });

  it("subsequent dispute webhook stays silent after payment_status_unverifiable failure", async () => {
    // Step 1: trigger the unverifiable path.
    const lookupRes = await lookupOrder();
    expect(lookupRes.status).toBe(502);
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    // Step 2: dispute webhook for the same payment intent.
    notifyOwner.mockClear();
    const webhookRes = await postWebhook("charge.dispute.created", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(webhookRes.status).toBe(200);

    expect(notifyOwner).not.toHaveBeenCalled();
    expect(await db.select().from(storeIssuanceAlertsTable)).toHaveLength(1);
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Symmetric race: refund/dispute webhook arrives BEFORE the buyer's first
// order-lookup (so no store_orders row exists yet), then the buyer polls the
// confirmation page.
//
// store.ts handles this via the paymentIntents.retrieve check at the
// charge.refunded / charge.disputed branch (lines ~424-455). The route returns
// the reversal status without minting a key and without firing an
// issuance-failure alert — because the charge check is a normal, expected exit
// path, not an error path.
//
// The two concerns this block tests:
//   1. The reversal webhook stays silent (no store_orders row → early return).
//   2. The subsequent order-lookup returns the correct reversal status, mints no
//      key, and fires no issuance-failure alert.
// ─────────────────────────────────────────────────────────────────────────────

// A session that carries recognized license metadata so the route passes the
// product-validation step and reaches the payment-intent charge check.
function recognizedPaidSession() {
  return {
    id: SESSION_ID,
    payment_status: "paid",
    payment_intent: PAYMENT_INTENT_ID,
    customer_details: { email: BUYER_EMAIL },
    amount_total: 19900,
    currency: "usd",
    metadata: { orderSecretHash: hashSecret(TEST_SECRET) },
    line_items: {
      data: [
        {
          price: {
            product: {
              name: "RSS Pro (1 device)",
              metadata: { plan: "pro", maxDevices: "1" },
            },
          },
        },
      ],
    },
  };
}

describe("symmetric race: refund/dispute webhook arrives before buyer's first lookup", () => {
  beforeEach(() => {
    // Use a recognized-product session so the route reaches the charge check.
    retrieveSession.mockResolvedValue(recognizedPaidSession());
    // Default: charge is refunded.
    retrievePaymentIntent.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      latest_charge: { id: "ch_combined_refund", refunded: true, disputed: false },
    });
  });

  it("charge.refunded webhook stays silent (no store_orders row); subsequent lookup returns refunded status without minting a key or firing an alert", async () => {
    // Step 1: refund webhook arrives before any store_orders row exists.
    const webhookRes = await postWebhook("charge.refunded", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(webhookRes.status).toBe(200);
    // reconcileStoreOrderByPaymentIntent finds no store_orders row → no-op.
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);

    // Step 2: buyer polls the confirmation page.
    notifyOwner.mockClear();
    const lookupRes = await lookupOrder();
    expect(lookupRes.status).toBe(200);
    expect(lookupRes.body.status).toBe("refunded");
    expect(lookupRes.body.licenseKey).toBeNull();

    // The charge-refunded branch is a normal exit — no issuance-failure alert.
    expect(notifyOwner).not.toHaveBeenCalled();

    // No store_orders row was minted.
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);
    // No store_issuance_alerts anchor row either.
    expect(await db.select().from(storeIssuanceAlertsTable)).toHaveLength(0);
  });

  it("charge.dispute.created webhook stays silent (no store_orders row); subsequent lookup returns disputed status without minting a key or firing an alert", async () => {
    // Override: charge is disputed, not refunded.
    retrievePaymentIntent.mockResolvedValue({
      id: PAYMENT_INTENT_ID,
      latest_charge: { id: "ch_combined_dispute", refunded: false, disputed: true },
    });

    // Step 1: dispute webhook arrives before any store_orders row exists.
    const webhookRes = await postWebhook("charge.dispute.created", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(webhookRes.status).toBe(200);
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);

    // Step 2: buyer polls the confirmation page.
    notifyOwner.mockClear();
    const lookupRes = await lookupOrder();
    expect(lookupRes.status).toBe(200);
    expect(lookupRes.body.status).toBe("disputed");
    expect(lookupRes.body.licenseKey).toBeNull();

    // Disputed branch is also a normal exit — no issuance-failure alert.
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);
    expect(await db.select().from(storeIssuanceAlertsTable)).toHaveLength(0);
  });

  it("repeated lookups after a refund-first race all return refunded, mint no key, and fire no alert", async () => {
    // Refund webhook arrives first.
    const webhookRes = await postWebhook("charge.refunded", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(webhookRes.status).toBe(200);
    expect(notifyOwner).not.toHaveBeenCalled();

    // Three polls — each must return refunded and never mint a key or alert.
    for (let i = 0; i < 3; i++) {
      const res = await lookupOrder();
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("refunded");
      expect(res.body.licenseKey).toBeNull();
    }

    expect(notifyOwner).not.toHaveBeenCalled();
    expect(await db.select().from(storeOrdersTable)).toHaveLength(0);
    expect(await db.select().from(storeIssuanceAlertsTable)).toHaveLength(0);
  });
});
