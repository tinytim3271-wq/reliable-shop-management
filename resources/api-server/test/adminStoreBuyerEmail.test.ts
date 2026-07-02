import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, storeIssuanceAlertsTable, storeOrdersTable } from "@workspace/db";
import { agent, seedAdmin, type SeededAdmin } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/store-alerts/:id/issue-key — buyer key email behaviour
//
// After the admin manually issues a license key the route calls
// sendBuyerKeyEmail(), which is inert when no email provider is connected or
// when the order has no customerEmail. These tests verify:
//
//   1. When isEmailProviderConfigured() returns true and the order carries a
//      customerEmail, sendEmail is called with that address and the license
//      key appears in the message body.
//   2. When isEmailProviderConfigured() returns false the route still returns
//      200 and sendEmail is never called.
//   3. When the order's customerEmail is null the route still returns 200 and
//      sendEmail is never called.
//
// The Stripe client is mocked so no network or credentials are required. The
// email module is mocked via vi.hoisted so stubs are in place before the
// Express app loads.
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

const { isEmailProviderConfigured, sendEmail } = vi.hoisted(() => ({
  isEmailProviderConfigured: vi.fn<() => Promise<boolean>>(),
  sendEmail: vi.fn<() => Promise<{ id: string }>>(),
}));

vi.mock("../src/lib/email", () => ({
  isEmailProviderConfigured,
  sendEmail,
  EmailError: class EmailError extends Error {
    readonly status: number;
    constructor(message: string, status = 502) {
      super(message);
      this.name = "EmailError";
      this.status = status;
    }
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Stripe session factory
// ─────────────────────────────────────────────────────────────────────────────

const BUYER_EMAIL = "admin-email-test-buyer@example.com";
const SESSION_ID = "cs_adminstore_email_test";
const PAYMENT_INTENT_ID = "pi_adminstore_email_test";

function paidSession(customerEmail: string | null = BUYER_EMAIL) {
  return {
    id: SESSION_ID,
    payment_status: "paid",
    payment_intent: PAYMENT_INTENT_ID,
    customer_details: customerEmail ? { email: customerEmail } : null,
    amount_total: 19900,
    currency: "usd",
    metadata: {},
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let admin: SeededAdmin;

// Insert an unresolved issuance alert with no matching store_orders row so the
// route reaches the Stripe → insert → email path.
async function seedAlert(overrides: { stripeSessionId?: string } = {}): Promise<number> {
  const [row] = await db
    .insert(storeIssuanceAlertsTable)
    .values({
      stripeSessionId: overrides.stripeSessionId ?? SESSION_ID,
      reason: "order_row_not_created",
    })
    .returning();
  return row.id;
}

function issueKey(alertId: number) {
  return agent()
    .post(`/api/admin/store-alerts/${alertId}/issue-key`)
    .set("Cookie", admin.cookie)
    .set("X-Forwarded-Proto", "https");
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  admin = await seedAdmin();
  // Provide a sender address so the sendBuyerKeyEmail helper never bails out
  // on a missing from-address before reaching sendEmail.
  process.env.OUTREACH_FROM_EMAIL = "noreply@reliableshop.test";
});

beforeEach(async () => {
  retrieveSession.mockReset();
  retrievePaymentIntent.mockReset();
  isEmailProviderConfigured.mockReset();
  sendEmail.mockReset();

  retrieveSession.mockResolvedValue(paidSession());
  retrievePaymentIntent.mockResolvedValue({
    id: PAYMENT_INTENT_ID,
    latest_charge: { id: "ch_adminstore_email", refunded: false, disputed: false },
  });
  // Default: provider configured, send succeeds.
  isEmailProviderConfigured.mockResolvedValue(true);
  sendEmail.mockResolvedValue({ id: "email_test_id" });

  await db.delete(storeIssuanceAlertsTable);
  await db.delete(storeOrdersTable);
});

afterAll(() => {
  delete process.env.OUTREACH_FROM_EMAIL;
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /admin/store-alerts/:id/issue-key — buyer key email", () => {
  it("sends the license key email to customerEmail when the provider is configured", async () => {
    const alertId = await seedAlert();

    const res = await issueKey(alertId);

    expect(res.status).toBe(200);
    expect(isEmailProviderConfigured).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const call = sendEmail.mock.calls[0][0];
    // Destination must be the buyer email from the Stripe session.
    expect(call.to).toBe(BUYER_EMAIL);
    // The issued license key must appear in the message body.
    const issuedKey: string = res.body.storeOrder?.licenseKey ?? "";
    expect(issuedKey).toMatch(/^RSS-/);
    expect(call.body).toContain(issuedKey);
    // Sender must be the configured outreach address.
    expect(call.from).toBe("noreply@reliableshop.test");
  });

  it("still returns 200 and skips sendEmail when the provider is not configured", async () => {
    isEmailProviderConfigured.mockResolvedValue(false);

    const alertId = await seedAlert();
    const res = await issueKey(alertId);

    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
    // The store_orders row must still have been created.
    const orders = await db.select().from(storeOrdersTable);
    expect(orders).toHaveLength(1);
    expect(orders[0].licenseKey).toMatch(/^RSS-/);
  });

  it("still returns 200 and skips sendEmail when customerEmail is null", async () => {
    // Stripe returns a session with no customer email.
    retrieveSession.mockResolvedValue(paidSession(null));

    const alertId = await seedAlert();
    const res = await issueKey(alertId);

    expect(res.status).toBe(200);
    // isEmailProviderConfigured is never even reached when there is no address.
    expect(sendEmail).not.toHaveBeenCalled();
    // The store_orders row must still have been created.
    const orders = await db.select().from(storeOrdersTable);
    expect(orders).toHaveLength(1);
    expect(orders[0].customerEmail).toBeNull();
  });
});
