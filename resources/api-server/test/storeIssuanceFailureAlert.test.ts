import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, storeOrdersTable, storeIssuanceAlertsTable } from "@workspace/db";
import { agent } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Owner alert when the storefront can't issue a license key after payment.
//
// The reversal alert (licenseReversalAlert.test.ts) covers refunds/disputes on a
// sold key. This is the other "quietly broke" half: a buyer pays through Stripe
// Checkout but the confirmation page can't mint/return their RSS-XXXX key. The
// owner — who may be away — must get a single notifyOwner() alert at the failure
// transition, fired once even though the confirmation page polls repeatedly,
// wrapped so it can never abort the buyer's response, and inert (simulated)
// unless a live email provider is connected. The happy path never alerts.
//
// The Stripe client is mocked so the route never touches the network; the
// outreach owner-alert is mocked so we can assert exactly when (and with what)
// it is invoked without sending email.
// ─────────────────────────────────────────────────────────────────────────────
const { retrieveSession, retrievePaymentIntent } = vi.hoisted(() => ({
  retrieveSession: vi.fn(),
  retrievePaymentIntent: vi.fn(),
}));

vi.mock("../src/stripeClient", () => ({
  getUncachableStripeClient: vi.fn(async () => ({
    checkout: { sessions: { retrieve: retrieveSession, create: vi.fn() } },
    paymentIntents: { retrieve: retrievePaymentIntent },
  })),
  getStripeSync: vi.fn(),
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

const BUYER_EMAIL = "buyer@example.com";

// A fixed test order secret for all session mocks in this file.
const TEST_SECRET = "b2c3d4e5f6a7".repeat(5) + "b2c3d4e5"; // 64 hex chars

function hashSecret(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// A paid Stripe Checkout Session as the store route expects it. Override
// line_items / payment_intent per case to drive the failure paths. Includes
// metadata.orderSecretHash by default (the current required gate).
function paidSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_issue_test",
    payment_status: "paid",
    payment_intent: "pi_issue_test",
    customer_details: { email: BUYER_EMAIL },
    amount_total: 19900,
    currency: "usd",
    metadata: { orderSecretHash: hashSecret(TEST_SECRET) },
    line_items: {
      data: [
        {
          price: {
            product: {
              name: "Solo",
              metadata: { plan: "solo", maxDevices: "1", tierOrder: "1" },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

function lookup(sessionId: string) {
  return agent()
    .get(`/api/store/order/${sessionId}`)
    .query({ secret: TEST_SECRET });
}

beforeEach(async () => {
  retrieveSession.mockReset();
  retrievePaymentIntent.mockReset();
  retrievePaymentIntent.mockResolvedValue({
    id: "pi_issue_test",
    latest_charge: { id: "ch_test", refunded: false, disputed: false },
  });
  notifyOwner.mockReset();
  notifyOwner.mockResolvedValue({ delivered: false, note: "simulated", toAddress: null });
  await db.delete(storeIssuanceAlertsTable);
  await db.delete(storeOrdersTable);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("storefront key-issuance failure owner alert", () => {
  it("alerts the owner when a paid order's product is not a recognized license tier", async () => {
    retrieveSession.mockResolvedValue(
      paidSession({
        id: "cs_issue_notlicense",
        line_items: { data: [{ price: { product: { name: "Sticker", metadata: {} } } }] },
      }),
    );

    const res = await lookup("cs_issue_notlicense");
    expect(res.status).toBe(422);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const arg = notifyOwner.mock.calls[0][0] as { subject: string; body: string };
    expect(arg.subject).toMatch(/license key/i);
    expect(arg.body).toContain("cs_issue_notlicense");
    // The idempotency anchor row was recorded.
    const alerts = await db.select().from(storeIssuanceAlertsTable);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].reason).toBe("unrecognized_product");
  });

  it("alerts the owner when the payment standing cannot be verified", async () => {
    retrieveSession.mockResolvedValue(paidSession({ id: "cs_issue_unverif" }));
    retrievePaymentIntent.mockRejectedValue(new Error("stripe down"));

    const res = await lookup("cs_issue_unverif");
    expect(res.status).toBe(502);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const alerts = await db.select().from(storeIssuanceAlertsTable);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].reason).toBe("payment_status_unverifiable");
  });

  it("fires exactly once across repeated confirmation-page polling", async () => {
    retrieveSession.mockResolvedValue(
      paidSession({
        id: "cs_issue_poll",
        line_items: { data: [{ price: { product: { name: "Sticker", metadata: {} } } }] },
      }),
    );

    const first = await lookup("cs_issue_poll");
    const second = await lookup("cs_issue_poll");
    const third = await lookup("cs_issue_poll");
    expect(first.status).toBe(422);
    expect(second.status).toBe(422);
    expect(third.status).toBe(422);

    // Idempotent: the buyer polled three times but the owner is alerted once.
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const alerts = await db.select().from(storeIssuanceAlertsTable);
    expect(alerts).toHaveLength(1);
  });

  it("is idempotent under concurrent polls (single alert)", async () => {
    retrieveSession.mockResolvedValue(
      paidSession({
        id: "cs_issue_race",
        line_items: { data: [{ price: { product: { name: "Sticker", metadata: {} } } }] },
      }),
    );

    const [a, b, c] = await Promise.all([
      lookup("cs_issue_race"),
      lookup("cs_issue_race"),
      lookup("cs_issue_race"),
    ]);
    expect(a.status).toBe(422);
    expect(b.status).toBe(422);
    expect(c.status).toBe(422);

    // The UNIQUE session-id anchor collapses concurrent polls to one alert.
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const alerts = await db.select().from(storeIssuanceAlertsTable);
    expect(alerts).toHaveLength(1);
  });

  it("does not alert on the normal happy path (key issued)", async () => {
    retrieveSession.mockResolvedValue(paidSession({ id: "cs_issue_ok" }));

    const res = await lookup("cs_issue_ok");
    expect(res.status).toBe(200);
    expect(res.body.licenseKey).toMatch(/^RSS-/);
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(await db.select().from(storeIssuanceAlertsTable)).toHaveLength(0);
  });

  it("does not alert for an unpaid session (nothing to issue yet)", async () => {
    retrieveSession.mockResolvedValue(
      paidSession({ id: "cs_issue_unpaid", payment_status: "unpaid", customer_details: null }),
    );

    const res = await lookup("cs_issue_unpaid");
    expect(res.status).toBe(200);
    expect(res.body.paid).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(await db.select().from(storeIssuanceAlertsTable)).toHaveLength(0);
  });

  it("still returns the buyer's error response when the owner alert throws", async () => {
    notifyOwner.mockRejectedValue(new Error("alert boom"));
    retrieveSession.mockResolvedValue(
      paidSession({
        id: "cs_issue_throw",
        line_items: { data: [{ price: { product: { name: "Sticker", metadata: {} } } }] },
      }),
    );

    const res = await lookup("cs_issue_throw");
    // The failed alert must not abort the request — the buyer still gets a 422.
    expect(res.status).toBe(422);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });
});
