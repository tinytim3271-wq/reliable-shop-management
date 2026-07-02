import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  licensesTable,
  licenseDevicesTable,
  storeOrdersTable,
} from "@workspace/db";
import { agent, seedAdmin } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Stripe client mock
//
// processWebhookMock stands in for StripeSync.processWebhook(), which in
// production verifies the Stripe-Signature header. We resolve it without
// throwing so that our test payloads are treated as cryptographically valid,
// letting the reconciliation logic (the code under test) execute fully.
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

// A fake Stripe-Signature value. Signature verification is mocked out, so this
// just needs to satisfy the "must be present" guard in the webhook route.
const FAKE_SIG = "t=1234567890,v1=fakesig";
const PAYMENT_INTENT_ID = "pi_wh_test";

// Send as a raw JSON string so express.raw({ type: "application/json" })
// parses it into a Buffer on the server (Buffer.isBuffer(req.body) === true).
// Passing a Node Buffer to supertest's .send() causes it to set the content-type
// to "application/octet-stream", which express.raw({ type: "application/json" })
// rejects, leaving req.body undefined and the webhook handler throwing.
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

// Seed a paid store_orders row. Optionally provision a local license row and
// optionally bind one device to it (to test device deactivation).
async function seedPaidOrder(
  licenseKey: string,
  opts: { withLicense?: boolean; withDevice?: boolean } = {},
) {
  await db.insert(storeOrdersTable).values({
    stripeSessionId: `cs_wh_${licenseKey.slice(-4)}`,
    stripePaymentIntentId: PAYMENT_INTENT_ID,
    plan: "solo",
    productName: "Solo",
    maxDevices: 1,
    licenseKey,
    amountTotal: 19900,
    currency: "usd",
    status: "paid",
  });

  if (opts.withLicense) {
    const [lic] = await db
      .insert(licensesTable)
      .values({ licenseKey, plan: "solo", maxDevices: 1, status: "active" })
      .returning();
    if (opts.withDevice && lic) {
      await db.insert(licenseDevicesTable).values({
        licenseId: lic.id,
        name: "Test Device",
        deviceFingerprint: "fp-test",
        deviceTokenHash: "fakehash",
        status: "active",
      });
    }
  }
}

beforeEach(async () => {
  processWebhookMock.mockReset();
  processWebhookMock.mockResolvedValue(undefined);
  await db.delete(licenseDevicesTable);
  await db.delete(licensesTable);
  await db.delete(storeOrdersTable);
});

describe("POST /api/stripe/webhook — sold-license lifecycle reconciliation", () => {
  it("charge.refunded: sets store_orders status to 'refunded'", async () => {
    await seedPaidOrder("RSS-WH01-WH01-WH01-WH01");

    const res = await postWebhook("charge.refunded", { payment_intent: PAYMENT_INTENT_ID });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    const [order] = await db.select().from(storeOrdersTable);
    expect(order.status).toBe("refunded");
  });

  it("charge.refunded: revokes the local license and deactivates all bound devices", async () => {
    await seedPaidOrder("RSS-WH02-WH02-WH02-WH02", {
      withLicense: true,
      withDevice: true,
    });

    const res = await postWebhook("charge.refunded", { payment_intent: PAYMENT_INTENT_ID });
    expect(res.status).toBe(200);

    const [license] = await db.select().from(licensesTable);
    expect(license.status).toBe("revoked");

    const [device] = await db.select().from(licenseDevicesTable);
    expect(device.status).toBe("deactivated");
    expect(device.deactivatedAt).not.toBeNull();
  });

  it("charge.refunded: handles the case where no local license was provisioned", async () => {
    await seedPaidOrder("RSS-WH03-WH03-WH03-WH03", { withLicense: false });

    const res = await postWebhook("charge.refunded", { payment_intent: PAYMENT_INTENT_ID });
    expect(res.status).toBe(200);

    const [order] = await db.select().from(storeOrdersTable);
    expect(order.status).toBe("refunded");
    const licenses = await db.select().from(licensesTable);
    expect(licenses).toHaveLength(0);
  });

  it("charge.dispute.created: sets store_orders status to 'disputed' and revokes the license", async () => {
    await seedPaidOrder("RSS-WH04-WH04-WH04-WH04", { withLicense: true });

    const res = await postWebhook("charge.dispute.created", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(res.status).toBe(200);

    const [order] = await db.select().from(storeOrdersTable);
    expect(order.status).toBe("disputed");

    const [license] = await db.select().from(licensesTable);
    expect(license.status).toBe("revoked");
  });

  it("charge.dispute.funds_withdrawn: marks disputed and revokes the license", async () => {
    await seedPaidOrder("RSS-WH05-WH05-WH05-WH05", { withLicense: true });

    const res = await postWebhook("charge.dispute.funds_withdrawn", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(res.status).toBe(200);

    const [order] = await db.select().from(storeOrdersTable);
    expect(order.status).toBe("disputed");

    const [license] = await db.select().from(licensesTable);
    expect(license.status).toBe("revoked");
  });

  it("charge.dispute.closed won: restores order to 'paid' and license to 'active'", async () => {
    // Simulate state after an earlier dispute event.
    await db.insert(storeOrdersTable).values({
      stripeSessionId: "cs_wh_won",
      stripePaymentIntentId: PAYMENT_INTENT_ID,
      plan: "solo",
      productName: "Solo",
      maxDevices: 1,
      licenseKey: "RSS-WH06-WH06-WH06-WH06",
      amountTotal: 19900,
      currency: "usd",
      status: "disputed",
    });
    await db.insert(licensesTable).values({
      licenseKey: "RSS-WH06-WH06-WH06-WH06",
      plan: "solo",
      maxDevices: 1,
      status: "revoked",
    });

    const res = await postWebhook("charge.dispute.closed", {
      payment_intent: PAYMENT_INTENT_ID,
      status: "won",
    });
    expect(res.status).toBe(200);

    const [order] = await db.select().from(storeOrdersTable);
    expect(order.status).toBe("paid");

    const [license] = await db.select().from(licensesTable);
    expect(license.status).toBe("active");
  });

  it("charge.dispute.closed lost: keeps order as 'disputed' and license revoked", async () => {
    await db.insert(storeOrdersTable).values({
      stripeSessionId: "cs_wh_lost",
      stripePaymentIntentId: PAYMENT_INTENT_ID,
      plan: "solo",
      productName: "Solo",
      maxDevices: 1,
      licenseKey: "RSS-WH07-WH07-WH07-WH07",
      amountTotal: 19900,
      currency: "usd",
      status: "disputed",
    });
    await db.insert(licensesTable).values({
      licenseKey: "RSS-WH07-WH07-WH07-WH07",
      plan: "solo",
      maxDevices: 1,
      status: "revoked",
    });

    const res = await postWebhook("charge.dispute.closed", {
      payment_intent: PAYMENT_INTENT_ID,
      status: "lost",
    });
    expect(res.status).toBe(200);

    const [order] = await db.select().from(storeOrdersTable);
    expect(order.status).toBe("disputed");

    const [license] = await db.select().from(licensesTable);
    expect(license.status).toBe("revoked");
  });

  it("unknown event types are silently ignored (no-op) with a 200 response", async () => {
    await seedPaidOrder("RSS-WH08-WH08-WH08-WH08", { withLicense: true });

    const res = await postWebhook("payment_intent.created", {
      payment_intent: PAYMENT_INTENT_ID,
    });
    expect(res.status).toBe(200);

    // Order must remain untouched.
    const [order] = await db.select().from(storeOrdersTable);
    expect(order.status).toBe("paid");
  });

  it("returns 400 when the stripe-signature header is absent", async () => {
    const res = await agent()
      .post("/api/stripe/webhook")
      .set("content-type", "application/json")
      .send(makeEventPayload("charge.refunded", { payment_intent: PAYMENT_INTENT_ID }));

    expect(res.status).toBe(400);
  });

  it("end-to-end: a refunded key cannot activate a new installation", async () => {
    const KEY = "RSS-WH09-WH09-WH09-WH09";
    await seedPaidOrder(KEY, { withLicense: false });

    // Webhook reconciles the refund.
    await postWebhook("charge.refunded", { payment_intent: PAYMENT_INTENT_ID });

    // Attempting to provision a license with the refunded key must fail.
    const admin = await seedAdmin();
    const activateRes = await agent()
      .post("/api/license/activate")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", admin.cookie)
      .send({
        licenseKey: KEY,
        deviceFingerprint: "fp-e2e",
        deviceName: "End-to-end Test",
      });

    expect(activateRes.status).toBe(404);
    expect(await db.select().from(licensesTable)).toHaveLength(0);
  });
});
