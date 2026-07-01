import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  getPgPool,
  licensesTable,
  licenseDevicesTable,
  storeOrdersTable,
} from "@workspace/db";
import { agent, seedAdmin } from "./helpers";

// Hosted/pg test mode: the node-pg Pool is always available.
const pool = getPgPool();

// ─────────────────────────────────────────────────────────────────────────────
// Stripe client mock
//
// The store routes reach Stripe only through getUncachableStripeClient(), so we
// replace that module with a fake whose checkout.sessions.{retrieve,create} are
// vi.fns the tests drive per-case. No network or Stripe credentials are needed,
// and the in-process app boots without a live Stripe connection — that's the
// "startup survives Stripe being unavailable" guarantee exercised implicitly by
// every file in this suite importing `app` with Stripe mocked out.
// ─────────────────────────────────────────────────────────────────────────────
const { retrieveSession, createSession, retrievePaymentIntent } = vi.hoisted(() => ({
  retrieveSession: vi.fn(),
  createSession: vi.fn(),
  // Default: a healthy PaymentIntent with a non-refunded, non-disputed charge.
  // Tests that exercise reversal paths override this per-case.
  retrievePaymentIntent: vi.fn(async (_id: string, _opts?: unknown) => ({
    id: "pi_test_paid",
    latest_charge: { id: "ch_test", refunded: false, disputed: false },
  })),
}));

vi.mock("../src/stripeClient", () => ({
  getUncachableStripeClient: vi.fn(async () => ({
    checkout: { sessions: { retrieve: retrieveSession, create: createSession } },
    paymentIntents: { retrieve: retrievePaymentIntent },
  })),
  getStripeSync: vi.fn(),
}));

// The store mints keys via generateLicenseKey(): RSS-XXXX-XXXX-XXXX-XXXX over an
// unambiguous uppercase alphabet (a subset of [A-Z0-9]).
const LICENSE_KEY_RE = /^RSS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

// A paid Stripe Checkout Session as the store route expects it (line item ->
// price -> product.metadata carries the tier entitlements, read server-side).
// Includes metadata.orderSecretHash by default (the current required gate).
// Pass `metadata: {}` in overrides to simulate a legacy session without a hash.
function paidSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_paid",
    payment_status: "paid",
    payment_intent: "pi_test_paid",
    customer_details: { email: "buyer@example.com" },
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

// Compute SHA-256 hex of a secret string — mirrors the server's hashOrderSecret.
function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

async function countStoreOrders(): Promise<number> {
  return (await db.select().from(storeOrdersTable)).length;
}

async function countLicenses(): Promise<number> {
  return (await db.select().from(licensesTable)).length;
}

// Each test starts from a clean licensing slate. Devices reference licenses, so
// delete them first; users (and their sessions) are left intact.
beforeEach(async () => {
  retrieveSession.mockReset();
  createSession.mockReset();
  // Restore healthy-charge default so individual tests only override what they need.
  retrievePaymentIntent.mockReset();
  retrievePaymentIntent.mockResolvedValue({
    id: "pi_test_paid",
    latest_charge: { id: "ch_test", refunded: false, disputed: false },
  });
  await db.delete(licenseDevicesTable);
  await db.delete(licensesTable);
  await db.delete(storeOrdersTable);
});

// The buyer email used in all paidSession() mocks.
const BUYER_EMAIL = "buyer@example.com";

// A test order secret (64-char hex, matching server output shape) shared across
// tests that exercise the current secret-hash gate.
const TEST_SECRET = "a0b1c2d3e4f5".repeat(5) + "a0b1c2d3"; // 64 hex chars

describe("GET /store/order/:sessionId", () => {
  it("returns 404 for an id that is not a Stripe session id", async () => {
    const res = await agent().get("/api/store/order/not-a-session");
    expect(res.status).toBe(404);
    expect(retrieveSession).not.toHaveBeenCalled();
  });

  it("returns 400 when the secret query parameter is missing", async () => {
    // An explicit undefined-guard precedes the Zod parse so that a missing ?secret=
    // is rejected immediately with 400 rather than coercing to the string "undefined".
    const res = await agent().get("/api/store/order/cs_test_nosecret");
    expect(res.status).toBe(400);
    expect(retrieveSession).not.toHaveBeenCalled();
  });

  it("returns 404 when Stripe has no such session and mints nothing", async () => {
    retrieveSession.mockRejectedValue(new Error("No such checkout.session"));
    const res = await agent()
      .get("/api/store/order/cs_test_unknown")
      .query({ secret: BUYER_EMAIL });
    expect(res.status).toBe(404);
    expect(await countStoreOrders()).toBe(0);
  });

  it("reports an unpaid session without minting a key (no secret check for unpaid)", async () => {
    retrieveSession.mockResolvedValue(
      paidSession({
        id: "cs_test_unpaid",
        payment_status: "unpaid",
        customer_details: null,
        amount_total: null,
      }),
    );
    // Secret is required by the param parser but not validated against payer for unpaid sessions.
    const res = await agent()
      .get("/api/store/order/cs_test_unpaid")
      .query({ secret: "anyone" });
    expect(res.status).toBe(200);
    expect(res.body.paid).toBe(false);
    expect(res.body.licenseKey).toBeNull();
    expect(res.body.plan).toBeNull();
    expect(await countStoreOrders()).toBe(0);
  });

  // ─── Legacy session path (no metadata.orderSecretHash): now unconditionally denied ──
  // Sessions created before the secret gate was introduced have no hash in
  // metadata. The email-fallback has been removed; the route now returns 403
  // for any session (or DB row) that lacks an orderSecretHash, regardless of
  // what the caller supplies as the ?secret= value.

  it("(legacy) returns 403 for a session without orderSecretHash, even with the wrong email", async () => {
    retrieveSession.mockResolvedValue(
      paidSession({ id: "cs_test_wrong_legacy", metadata: {} }),
    );
    const res = await agent()
      .get("/api/store/order/cs_test_wrong_legacy")
      .query({ secret: "attacker@evil.com" });
    expect(res.status).toBe(403);
    expect(await countStoreOrders()).toBe(0);
  });

  it("(legacy) returns 403 for a session without orderSecretHash, even with the correct buyer email", async () => {
    // Previously this path issued a key when secret === buyer email. The
    // email-fallback has been removed: legacy sessions are unconditionally denied.
    retrieveSession.mockResolvedValue(
      paidSession({ id: "cs_test_legacy_denied", metadata: {} }),
    );
    const res = await agent()
      .get("/api/store/order/cs_test_legacy_denied")
      .query({ secret: BUYER_EMAIL });
    expect(res.status).toBe(403);
    expect(await countStoreOrders()).toBe(0);
  });

  // ─── New secret-hash path ────────────────────────────────────────────────────
  // Sessions created after the fix include metadata.orderSecretHash. The route
  // verifies callerSecret via SHA-256 comparison against the stored hash.

  it("(secret gate) issues key when the correct secret is supplied", async () => {
    const secret = "a".repeat(64); // 64-char hex-like test secret
    retrieveSession.mockResolvedValue(
      paidSession({
        id: "cs_test_secret_ok",
        metadata: { orderSecretHash: hashSecret(secret) },
      }),
    );
    const res = await agent()
      .get("/api/store/order/cs_test_secret_ok")
      .query({ secret });
    expect(res.status).toBe(200);
    expect(res.body.paid).toBe(true);
    expect(res.body.licenseKey).toMatch(LICENSE_KEY_RE);
    expect(await countStoreOrders()).toBe(1);
  });

  it("(secret gate) returns 403 when the secret does not match the stored hash", async () => {
    const correctSecret = "b".repeat(64);
    retrieveSession.mockResolvedValue(
      paidSession({
        id: "cs_test_secret_bad",
        metadata: { orderSecretHash: hashSecret(correctSecret) },
      }),
    );
    const res = await agent()
      .get("/api/store/order/cs_test_secret_bad")
      .query({ secret: "c".repeat(64) }); // attacker's guess
    expect(res.status).toBe(403);
    expect(await countStoreOrders()).toBe(0);
  });

  it("(secret gate) attacker-knows-session-id scenario: cannot claim key with buyer email when hash is present", async () => {
    // An attacker created the checkout session and knows the cs_... id.
    // They also know the victim's email, but the session has a secret hash
    // — email is not accepted as a credential when a hash is stored.
    const correctSecret = "d".repeat(64);
    retrieveSession.mockResolvedValue(
      paidSession({
        id: "cs_test_attacker",
        metadata: { orderSecretHash: hashSecret(correctSecret) },
      }),
    );
    const res = await agent()
      .get("/api/store/order/cs_test_attacker")
      .query({ secret: BUYER_EMAIL }); // attacker supplies the email, not the secret
    expect(res.status).toBe(403);
    expect(await countStoreOrders()).toBe(0);
  });

  it("(secret gate, DB row) returns 403 when the secret does not match the stored row hash", async () => {
    const correctSecret = "e".repeat(64);
    await db.insert(storeOrdersTable).values({
      stripeSessionId: "cs_test_db_hash_mismatch",
      plan: "solo",
      productName: "Solo",
      maxDevices: 1,
      licenseKey: "RSS-DBDB-DBDB-DBDB-DBDB",
      amountTotal: 19900,
      currency: "usd",
      customerEmail: BUYER_EMAIL,
      status: "paid",
      orderSecretHash: hashSecret(correctSecret),
    });
    const res = await agent()
      .get("/api/store/order/cs_test_db_hash_mismatch")
      .query({ secret: "f".repeat(64) }); // wrong secret
    expect(res.status).toBe(403);
    expect(retrieveSession).not.toHaveBeenCalled();
  });

  it("(secret gate, DB row) returns 403 on email attempt when row has a secret hash", async () => {
    // Once a row has an orderSecretHash, email is no longer accepted —
    // even if the caller supplies the correct buyer email.
    const correctSecret = "g".repeat(64);
    await db.insert(storeOrdersTable).values({
      stripeSessionId: "cs_test_db_email_bypass",
      plan: "solo",
      productName: "Solo",
      maxDevices: 1,
      licenseKey: "RSS-EMAL-EMAL-EMAL-EMAL",
      amountTotal: 19900,
      currency: "usd",
      customerEmail: BUYER_EMAIL,
      status: "paid",
      orderSecretHash: hashSecret(correctSecret),
    });
    const res = await agent()
      .get("/api/store/order/cs_test_db_email_bypass")
      .query({ secret: BUYER_EMAIL }); // attacker supplies the buyer's email
    expect(res.status).toBe(403);
    expect(retrieveSession).not.toHaveBeenCalled();
  });

  it("(legacy DB row) returns 403 for rows without a hash, even with the correct buyer email", async () => {
    // Rows seeded before the secret column was added have orderSecretHash=null.
    // The email-fallback has been removed; these rows are unconditionally denied.
    await db.insert(storeOrdersTable).values({
      stripeSessionId: "cs_test_db_legacy",
      plan: "solo",
      productName: "Solo",
      maxDevices: 1,
      licenseKey: "RSS-LGCY-LGCY-LGCY-LGCY",
      amountTotal: 19900,
      currency: "usd",
      customerEmail: BUYER_EMAIL,
      status: "paid",
      // orderSecretHash omitted → null (legacy row)
    });
    const res = await agent()
      .get("/api/store/order/cs_test_db_legacy")
      .query({ secret: BUYER_EMAIL }); // attacker supplies the email — now denied
    expect(res.status).toBe(403);
    expect(retrieveSession).not.toHaveBeenCalled();
  });

  it("is idempotent: a second lookup returns the same key without re-hitting Stripe", async () => {
    retrieveSession.mockResolvedValue(paidSession({ id: "cs_test_idem" }));
    const first = await agent()
      .get("/api/store/order/cs_test_idem")
      .query({ secret: TEST_SECRET });
    expect(first.status).toBe(200);
    const key = first.body.licenseKey;
    expect(key).toMatch(LICENSE_KEY_RE);

    const second = await agent()
      .get("/api/store/order/cs_test_idem")
      .query({ secret: TEST_SECRET });
    expect(second.status).toBe(200);
    expect(second.body.licenseKey).toBe(key);
    // The second lookup is served from store_orders, not Stripe.
    expect(retrieveSession).toHaveBeenCalledTimes(1);
    expect(await countStoreOrders()).toBe(1);
  });

  it("is race-safe: concurrent first lookups mint a single shared key", async () => {
    retrieveSession.mockResolvedValue(paidSession({ id: "cs_test_race" }));
    const [a, b] = await Promise.all([
      agent().get("/api/store/order/cs_test_race").query({ secret: TEST_SECRET }),
      agent().get("/api/store/order/cs_test_race").query({ secret: TEST_SECRET }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.licenseKey).toMatch(LICENSE_KEY_RE);
    // The unique stripe_session_id collapses the race to one row + one key.
    expect(a.body.licenseKey).toBe(b.body.licenseKey);
    expect(await countStoreOrders()).toBe(1);
  });

  it("rejects a paid order whose product is not a recognized license tier with 422", async () => {
    retrieveSession.mockResolvedValue(
      paidSession({
        id: "cs_test_notlicense",
        line_items: {
          data: [{ price: { product: { name: "Sticker", metadata: {} } } }],
        },
      }),
    );
    const res = await agent()
      .get("/api/store/order/cs_test_notlicense")
      .query({ secret: TEST_SECRET });
    expect(res.status).toBe(422);
    expect(await countStoreOrders()).toBe(0);
  });

  it("never writes a sold license into the single-row licenses table", async () => {
    retrieveSession.mockResolvedValue(paidSession({ id: "cs_test_nolic" }));
    const res = await agent()
      .get("/api/store/order/cs_test_nolic")
      .query({ secret: TEST_SECRET });
    expect(res.status).toBe(200);
    expect(res.body.licenseKey).toMatch(LICENSE_KEY_RE);
    // The whole point of store_orders: selling a key must not provision THIS
    // install's gate license, or it would 403 the shop app.
    expect(await countStoreOrders()).toBe(1);
    expect(await countLicenses()).toBe(0);
  });

  // ─── Reversal-before-first-lookup tests ────────────────────────────────────
  // Stripe's checkout session payment_status stays "paid" even after a refund
  // or dispute. The charge fields are what actually reflects the reversal.
  // These tests cover the race where a webhook arrives before the buyer's
  // first call to /store/order/:sessionId.

  it("does not mint a key when the charge was refunded before first lookup", async () => {
    retrieveSession.mockResolvedValue(paidSession({ id: "cs_test_refunded" }));
    retrievePaymentIntent.mockResolvedValue({
      id: "pi_test_paid",
      latest_charge: { id: "ch_refunded", refunded: true, disputed: false },
    });
    const res = await agent()
      .get("/api/store/order/cs_test_refunded")
      .query({ secret: TEST_SECRET });
    expect(res.status).toBe(200);
    expect(res.body.paid).toBe(false);
    expect(res.body.status).toBe("refunded");
    expect(res.body.licenseKey).toBeNull();
    // No order row must be inserted for a refunded payment.
    expect(await countStoreOrders()).toBe(0);
  });

  it("does not mint a key when the charge is disputed before first lookup", async () => {
    retrieveSession.mockResolvedValue(paidSession({ id: "cs_test_disputed" }));
    retrievePaymentIntent.mockResolvedValue({
      id: "pi_test_paid",
      latest_charge: { id: "ch_disputed", refunded: false, disputed: true },
    });
    const res = await agent()
      .get("/api/store/order/cs_test_disputed")
      .query({ secret: TEST_SECRET });
    expect(res.status).toBe(200);
    expect(res.body.paid).toBe(false);
    expect(res.body.status).toBe("disputed");
    expect(res.body.licenseKey).toBeNull();
    expect(await countStoreOrders()).toBe(0);
  });

  it("suppresses the license key in subsequent lookups when status is not paid", async () => {
    // Seed a revoked order directly (simulating webhook reconciliation).
    // Must include an orderSecretHash — rows without one are now unconditionally denied.
    await db.insert(storeOrdersTable).values({
      stripeSessionId: "cs_test_revoked_lookup",
      stripePaymentIntentId: "pi_revoked",
      customerEmail: BUYER_EMAIL,
      plan: "solo",
      productName: "Solo",
      maxDevices: 1,
      licenseKey: "RSS-REVK-REVK-REVK-REVK",
      amountTotal: 19900,
      currency: "usd",
      status: "refunded",
      orderSecretHash: hashSecret(TEST_SECRET),
    });
    const res = await agent()
      .get("/api/store/order/cs_test_revoked_lookup")
      .query({ secret: TEST_SECRET });
    expect(res.status).toBe(200);
    expect(res.body.paid).toBe(false);
    expect(res.body.status).toBe("refunded");
    // The key must not be disclosed once the order is revoked.
    expect(res.body.licenseKey).toBeNull();
    // Stripe must not be called for a cached (already-inserted) order.
    expect(retrieveSession).not.toHaveBeenCalled();
  });
});

describe("POST /license/activate — store-order bridge", () => {
  // Inserts a paid store order as if a buyer already completed checkout.
  async function seedPaidOrder(opts: {
    sessionId: string;
    licenseKey: string;
    plan: string;
    maxDevices: number;
  }): Promise<void> {
    await db.insert(storeOrdersTable).values({
      stripeSessionId: opts.sessionId,
      plan: opts.plan,
      productName: opts.plan,
      maxDevices: opts.maxDevices,
      licenseKey: opts.licenseKey,
      amountTotal: 39900,
      currency: "usd",
      status: "paid",
    });
  }

  it("provisions exactly one license row from a paid store order and binds the device", async () => {
    const admin = await seedAdmin();
    const soldKey = "RSS-AAAA-BBBB-CCCC-DDDD";
    await seedPaidOrder({
      sessionId: "cs_activate_ok",
      licenseKey: soldKey,
      plan: "shop",
      maxDevices: 3,
    });

    const res = await agent()
      .post("/api/license/activate")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", admin.cookie)
      .send({
        licenseKey: soldKey,
        deviceFingerprint: "device-fp-1",
        deviceName: "Front Desk PC",
      });

    expect(res.status).toBe(200);
    expect(typeof res.body.deviceToken).toBe("string");

    const licenses = await db.select().from(licensesTable);
    expect(licenses).toHaveLength(1);
    expect(licenses[0].licenseKey).toBe(soldKey);
    expect(licenses[0].plan).toBe("shop");
    expect(licenses[0].maxDevices).toBe(3);

    const devices = await db.select().from(licenseDevicesTable);
    expect(devices).toHaveLength(1);
  });

  it("returns 409 when the install is already licensed with a different key", async () => {
    const admin = await seedAdmin();
    // This install already has its own gate license.
    await db
      .insert(licensesTable)
      .values({ licenseKey: "RSS-ZZZZ-ZZZZ-ZZZZ-ZZZZ", plan: "solo", maxDevices: 1 });

    const soldKey = "RSS-1111-2222-3333-4444";
    await seedPaidOrder({
      sessionId: "cs_activate_conflict",
      licenseKey: soldKey,
      plan: "unlimited",
      maxDevices: 99,
    });

    const res = await agent()
      .post("/api/license/activate")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", admin.cookie)
      .send({
        licenseKey: soldKey,
        deviceFingerprint: "device-fp-2",
        deviceName: "Bay 2 Tablet",
      });

    expect(res.status).toBe(409);
    // The sold key must not have overridden the existing single-row license.
    const licenses = await db.select().from(licensesTable);
    expect(licenses).toHaveLength(1);
    expect(licenses[0].licenseKey).toBe("RSS-ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  });

  it("is race-safe: concurrent activations of two different sold keys provision exactly one license", async () => {
    const admin = await seedAdmin();
    await seedPaidOrder({
      sessionId: "cs_race_a",
      licenseKey: "RSS-RACE-AAAA-AAAA-AAAA",
      plan: "solo",
      maxDevices: 1,
    });
    await seedPaidOrder({
      sessionId: "cs_race_b",
      licenseKey: "RSS-RACE-BBBB-BBBB-BBBB",
      plan: "shop",
      maxDevices: 3,
    });

    const [a, b] = await Promise.all([
      agent()
        .post("/api/license/activate")
        .set("X-Forwarded-Proto", "https")
        .set("Cookie", admin.cookie)
        .send({
          licenseKey: "RSS-RACE-AAAA-AAAA-AAAA",
          deviceFingerprint: "race-fp-a",
          deviceName: "A",
        }),
      agent()
        .post("/api/license/activate")
        .set("X-Forwarded-Proto", "https")
        .set("Cookie", admin.cookie)
        .send({
          licenseKey: "RSS-RACE-BBBB-BBBB-BBBB",
          deviceFingerprint: "race-fp-b",
          deviceName: "B",
        }),
    ]);

    // Exactly one activation wins (200); the other is told the install is
    // already licensed (409) — the advisory lock serializes the check+insert.
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    // The single-row invariant holds: only one license row exists, and it is
    // one of the two sold keys (never both).
    const licenses = await db.select().from(licensesTable);
    expect(licenses).toHaveLength(1);
    expect(["RSS-RACE-AAAA-AAAA-AAAA", "RSS-RACE-BBBB-BBBB-BBBB"]).toContain(
      licenses[0].licenseKey,
    );
  });

  it("returns 404 for a key that exists nowhere", async () => {
    const admin = await seedAdmin();
    const res = await agent()
      .post("/api/license/activate")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", admin.cookie)
      .send({
        licenseKey: "RSS-9999-9999-9999-9999",
        deviceFingerprint: "device-fp-3",
        deviceName: "Unknown",
      });
    expect(res.status).toBe(404);
    expect(await countLicenses()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Catalog + checkout
//
// loadCatalog() reads the synced `stripe` schema directly (pool.query). The test
// template database only carries the app's public schema, so we create a minimal
// stripe.products / stripe.prices matching the columns the query reads (shape per
// stripe-replit-sync's migrations) and seed license + non-license rows.
// ─────────────────────────────────────────────────────────────────────────────
describe("store catalog and checkout", () => {
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS stripe`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS stripe.products (
         id text PRIMARY KEY,
         name text,
         description text,
         active boolean,
         metadata jsonb,
         created integer
       )`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS stripe.prices (
         id text PRIMARY KEY,
         product text,
         active boolean,
         type text,
         unit_amount integer,
         currency text,
         created integer
       )`,
    );
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS stripe.prices`);
    await pool.query(`DROP TABLE IF EXISTS stripe.products`);
    await pool.query(`DROP SCHEMA IF EXISTS stripe CASCADE`);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE stripe.prices, stripe.products`);
    // Three license tiers (seeded out of tier order to prove server-side sort)
    // plus a non-license product that must be filtered out of the catalog.
    await pool.query(`
      INSERT INTO stripe.products (id, name, description, active, metadata, created) VALUES
        ('prod_shop', 'Shop', 'Up to 3 devices', true, '{"plan":"shop","maxDevices":"3","tierOrder":"2"}', 200),
        ('prod_solo', 'Solo', 'Single device', true, '{"plan":"solo","maxDevices":"1","tierOrder":"1"}', 100),
        ('prod_unlimited', 'Unlimited', 'Up to 99 devices', true, '{"plan":"unlimited","maxDevices":"99","tierOrder":"3"}', 300),
        ('prod_sticker', 'Sticker Pack', 'Not a license', true, '{}', 400)
    `);
    await pool.query(`
      INSERT INTO stripe.prices (id, product, active, type, unit_amount, currency, created) VALUES
        ('price_solo', 'prod_solo', true, 'one_time', 19900, 'usd', 100),
        ('price_shop', 'prod_shop', true, 'one_time', 39900, 'usd', 200),
        ('price_unlimited', 'prod_unlimited', true, 'one_time', 79900, 'usd', 300),
        ('price_sticker', 'prod_sticker', true, 'one_time', 500, 'usd', 400)
    `);
  });

  it("lists license tiers sorted by tier order, excluding non-license products", async () => {
    const res = await agent().get("/api/store/products");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((p: { plan: string }) => p.plan)).toEqual([
      "solo",
      "shop",
      "unlimited",
    ]);
    expect(res.body[0]).toMatchObject({
      plan: "solo",
      productName: "Solo",
      priceId: "price_solo",
      unitAmount: 19900,
      currency: "usd",
      maxDevices: 1,
      tierOrder: 1,
    });
    expect(JSON.stringify(res.body)).not.toContain("Sticker");
  });

  it("opens a hosted checkout session for a known license price", async () => {
    createSession.mockResolvedValue({
      id: "cs_checkout_solo",
      url: "https://checkout.stripe.com/c/pay/cs_checkout_solo",
    });
    const res = await agent()
      .post("/api/store/checkout")
      .send({ priceId: "price_solo" });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("checkout.stripe.com");
    expect(res.body.sessionId).toBeUndefined();
    expect(createSession).toHaveBeenCalledTimes(1);
    const arg = createSession.mock.calls[0][0];
    expect(arg.mode).toBe("payment");
    expect(arg.line_items[0].price).toBe("price_solo");
    // Verify the order secret hash is stored in Stripe session metadata.
    expect(arg.metadata).toBeDefined();
    expect(typeof arg.metadata.orderSecretHash).toBe("string");
    expect(arg.metadata.orderSecretHash).toHaveLength(64); // SHA-256 hex = 64 chars
    // Verify the secret is embedded in the success URL.
    expect(typeof arg.success_url).toBe("string");
    expect(arg.success_url).toContain("{CHECKOUT_SESSION_ID}");
    // The secret must appear as a path segment after the session id placeholder.
    const secretInUrl = arg.success_url.split("{CHECKOUT_SESSION_ID}/")[1];
    expect(secretInUrl).toBeDefined();
    expect(secretInUrl).toHaveLength(64); // 32 bytes as hex = 64 chars
    // The secret in the URL must hash to the stored orderSecretHash.
    expect(hashSecret(secretInUrl)).toBe(arg.metadata.orderSecretHash);
  });

  it("rejects a price id that is not one of our license products with 400", async () => {
    const res = await agent()
      .post("/api/store/checkout")
      .send({ priceId: "price_sticker" });
    expect(res.status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects an invalid checkout body with 400", async () => {
    const res = await agent().post("/api/store/checkout").send({});
    expect(res.status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
  });
});
