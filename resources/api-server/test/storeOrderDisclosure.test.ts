import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, storeOrdersTable } from "@workspace/db";
import { agent, uniqueName } from "./helpers";
import { generateLicenseKey } from "../src/lib/licensing";

// Compute SHA-256 hex of a secret string — mirrors the server's hashOrderSecret.
function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

// Seed a store_orders row directly (bypasses Stripe) so we can exercise the
// order-lookup endpoint in isolation with controlled statuses.
//
// When orderSecretHash is provided the row exercises the new secret gate;
// when omitted the row is treated as a legacy row and the route falls back to
// case-insensitive email comparison.
async function seedStoreOrder(opts: {
  status: "paid" | "refunded" | "disputed";
  customerEmail: string;
  orderSecretHash?: string;
}): Promise<string> {
  const sessionId = `cs_test_${uniqueName("session").replace(/[^a-zA-Z0-9_]/g, "_")}`;
  await db.insert(storeOrdersTable).values({
    stripeSessionId: sessionId,
    stripePaymentIntentId: null,
    customerEmail: opts.customerEmail,
    plan: "solo",
    productName: "Solo",
    maxDevices: 1,
    licenseKey: generateLicenseKey(),
    amountTotal: 19900,
    currency: "usd",
    status: opts.status,
    orderSecretHash: opts.orderSecretHash ?? null,
  });
  return sessionId;
}

// ─── Legacy path (orderSecretHash = null) ────────────────────────────────────
// Rows seeded before the secret gate was introduced have a null hash. The
// email-fallback has been removed: all null-hash rows are unconditionally denied
// with 403, regardless of what the caller supplies as the ?secret= value.

const getOrderByEmail = (sessionId: string, email: string) =>
  agent().get(`/api/store/order/${sessionId}?secret=${encodeURIComponent(email)}`);

describe("store order disclosure — legacy email fallback (orderSecretHash=null)", () => {
  it("(legacy) rejects a wrong email for a cached refunded order with 403", async () => {
    const email = `buyer-${uniqueName("r")}@example.com`;
    const sessionId = await seedStoreOrder({ status: "refunded", customerEmail: email });

    const res = await getOrderByEmail(sessionId, "attacker@evil.example");
    expect(res.status).toBe(403);
  });

  it("(legacy) rejects a wrong email for a cached disputed order with 403", async () => {
    const email = `buyer-${uniqueName("d")}@example.com`;
    const sessionId = await seedStoreOrder({ status: "disputed", customerEmail: email });

    const res = await getOrderByEmail(sessionId, "attacker@evil.example");
    expect(res.status).toBe(403);
  });

  it("(legacy) rejects the correct buyer email for a refunded null-hash row with 403", async () => {
    // The email-fallback has been removed. Even the correct buyer email returns
    // 403 for rows that lack an orderSecretHash.
    const email = `buyer-${uniqueName("rok")}@example.com`;
    const sessionId = await seedStoreOrder({ status: "refunded", customerEmail: email });

    const res = await getOrderByEmail(sessionId, email);
    expect(res.status).toBe(403);
  });

  it("(legacy) rejects the correct buyer email for a disputed null-hash row with 403", async () => {
    const email = `buyer-${uniqueName("dok")}@example.com`;
    const sessionId = await seedStoreOrder({ status: "disputed", customerEmail: email });

    const res = await getOrderByEmail(sessionId, email);
    expect(res.status).toBe(403);
  });

  it("(legacy) rejects the correct buyer email for a paid null-hash row with 403 (email is not a credential)", async () => {
    // Previously the correct email issued the key for paid legacy rows. The
    // email-fallback is now gone: null-hash rows are denied unconditionally.
    const email = `buyer-${uniqueName("p")}@example.com`;
    const sessionId = await seedStoreOrder({ status: "paid", customerEmail: email });

    const wrong = await getOrderByEmail(sessionId, "wrong@example.com");
    expect(wrong.status).toBe(403);

    const correct = await getOrderByEmail(sessionId, email);
    expect(correct.status).toBe(403);
  });
});

// ─── Secret-hash path (orderSecretHash set) ──────────────────────────────────
// Rows created by the updated checkout flow store a SHA-256 hash of the order
// secret embedded in the buyer's confirmation URL. Only the holder of the raw
// secret (the buyer's browser, redirected by Stripe) can pass this gate.

const getOrderBySecret = (sessionId: string, secret: string) =>
  agent().get(`/api/store/order/${sessionId}?secret=${encodeURIComponent(secret)}`);

describe("store order disclosure — secret-hash gate (orderSecretHash set)", () => {
  it("allows the holder of the correct secret to retrieve a paid order", async () => {
    const secret = "correct-secret-hex-string-for-testing";
    const email = `buyer-${uniqueName("sh")}@example.com`;
    const sessionId = await seedStoreOrder({
      status: "paid",
      customerEmail: email,
      orderSecretHash: hashSecret(secret),
    });

    const res = await getOrderBySecret(sessionId, secret);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
    expect(res.body.licenseKey).toBeTruthy();
    expect(res.body.customerEmail).toBe(email);
  });

  it("rejects a caller supplying a wrong secret (403)", async () => {
    const correctSecret = "the-real-buyer-secret";
    const email = `buyer-${uniqueName("sw")}@example.com`;
    const sessionId = await seedStoreOrder({
      status: "paid",
      customerEmail: email,
      orderSecretHash: hashSecret(correctSecret),
    });

    const res = await getOrderBySecret(sessionId, "attacker-guessed-secret");
    expect(res.status).toBe(403);
  });

  it("rejects the buyer's own email when a secret hash is stored (email is not a credential)", async () => {
    // This is the key regression: once a row has a hash, the buyer's email alone
    // is not sufficient — an attacker who knows the email cannot bypass the gate.
    const correctSecret = "only-buyer-knows-this";
    const email = `buyer-${uniqueName("ep")}@example.com`;
    const sessionId = await seedStoreOrder({
      status: "paid",
      customerEmail: email,
      orderSecretHash: hashSecret(correctSecret),
    });

    // Attacker supplies the buyer's email as the ?secret= value.
    const res = await getOrderBySecret(sessionId, email);
    expect(res.status).toBe(403);
  });

  it("withholds the key for refunded orders (403 for wrong secret, null key for correct)", async () => {
    const secret = "refund-test-secret";
    const email = `buyer-${uniqueName("rsh")}@example.com`;
    const sessionId = await seedStoreOrder({
      status: "refunded",
      customerEmail: email,
      orderSecretHash: hashSecret(secret),
    });

    const wrongRes = await getOrderBySecret(sessionId, "wrong-secret");
    expect(wrongRes.status).toBe(403);

    const okRes = await getOrderBySecret(sessionId, secret);
    expect(okRes.status).toBe(200);
    expect(okRes.body.status).toBe("refunded");
    expect(okRes.body.licenseKey).toBeNull(); // key withheld for non-paid orders
  });

  it("attacker-created-session scenario: attacker cannot claim key with buyer email", async () => {
    // An attacker creates a checkout session and forwards the URL to a victim.
    // After the victim pays, the attacker knows the session id — but the row
    // was written with an orderSecretHash that only the buyer's browser saw.
    // The attacker supplies the victim's email: this must be rejected.
    const actualSecret = "victim-browser-received-this-secret";
    const victimEmail = `victim-${uniqueName("av")}@example.com`;
    const sessionId = await seedStoreOrder({
      status: "paid",
      customerEmail: victimEmail,
      orderSecretHash: hashSecret(actualSecret),
    });

    // Attacker tries victim's email — must be rejected.
    const emailAttempt = await getOrderBySecret(sessionId, victimEmail);
    expect(emailAttempt.status).toBe(403);

    // Attacker guesses a random string — must be rejected.
    const guessAttempt = await getOrderBySecret(sessionId, "random-attacker-guess");
    expect(guessAttempt.status).toBe(403);

    // Legitimate buyer with the correct secret — must succeed.
    const legitimateRes = await getOrderBySecret(sessionId, actualSecret);
    expect(legitimateRes.status).toBe(200);
    expect(legitimateRes.body.licenseKey).toBeTruthy();
  });
});
