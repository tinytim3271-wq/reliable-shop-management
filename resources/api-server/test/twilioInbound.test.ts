import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, customersTable, messagesTable } from "@workspace/db";
import { agent, uniqueName } from "./helpers";
import { verifyTwilioSignature } from "../src/lib/sms";

// The inbound webhook authenticates Twilio by recomputing the X-Twilio-Signature
// against the account auth token. We drive that token through the
// TWILIO_AUTH_TOKEN env override so the suite never needs a live connection.
const AUTH_TOKEN = "test-twilio-auth-token-abc123";
const WEBHOOK_URL = "https://shop.example.com/api/twilio/inbound";

// Compute the signature Twilio would send: base64(HMAC-SHA1(authToken, url +
// concat(sortedKey + value))).
function signTwilio(url: string, params: Record<string, string>, token = AUTH_TOKEN): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  return createHmac("sha1", token).update(data, "utf8").digest("base64");
}

// POST a form-encoded inbound webhook the way Twilio does. The x-forwarded
// headers make the route reconstruct exactly WEBHOOK_URL for verification.
function postInbound(params: Record<string, string>, signature: string | null) {
  let req = agent()
    .post("/api/twilio/inbound")
    .type("form")
    .set("X-Forwarded-Proto", "https")
    .set("X-Forwarded-Host", "shop.example.com");
  if (signature !== null) req = req.set("X-Twilio-Signature", signature);
  return req.send(params);
}

describe("verifyTwilioSignature (pure)", () => {
  it("accepts a correctly computed signature", () => {
    const params = { MessageSid: "SM1", From: "+15551234567", Body: "hello" };
    const sig = signTwilio(WEBHOOK_URL, params);
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: sig,
        url: WEBHOOK_URL,
        params,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const params = { MessageSid: "SM1", From: "+15551234567", Body: "hello" };
    const sig = signTwilio(WEBHOOK_URL, params);
    expect(
      verifyTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: sig,
        url: WEBHOOK_URL,
        params: { ...params, Body: "tampered" },
      }),
    ).toBe(false);
  });

  it("rejects a missing or empty signature", () => {
    const params = { MessageSid: "SM1", From: "+15551234567" };
    expect(
      verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: undefined, url: WEBHOOK_URL, params }),
    ).toBe(false);
    expect(
      verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: "", url: WEBHOOK_URL, params }),
    ).toBe(false);
  });

  it("rejects when the auth token is wrong", () => {
    const params = { MessageSid: "SM1", From: "+15551234567" };
    const sig = signTwilio(WEBHOOK_URL, params, "different-token");
    expect(
      verifyTwilioSignature({ authToken: AUTH_TOKEN, signature: sig, url: WEBHOOK_URL, params }),
    ).toBe(false);
  });
});

describe("POST /api/twilio/inbound", () => {
  describe("when Twilio is not connected (no auth token)", () => {
    it("is inert: returns 200 empty TwiML and records nothing", async () => {
      const sid = uniqueName("SMinert").replace(/-/g, "");
      const params = { MessageSid: sid, From: "+15557770000", Body: "anyone home?" };
      // No env token and (in this test DB) no Twilio connection => inert.
      const res = await postInbound(params, signTwilio(WEBHOOK_URL, params));
      expect(res.status).toBe(200);
      expect(res.text).toContain("<Response>");

      const rows = await db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.providerMessageId, sid));
      expect(rows).toHaveLength(0);
    });
  });

  describe("when Twilio is connected", () => {
    beforeEach(() => {
      process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    });
    afterEach(() => {
      delete process.env.TWILIO_AUTH_TOKEN;
    });

    it("rejects a bad signature with 403 and records nothing", async () => {
      const sid = uniqueName("SMbad").replace(/-/g, "");
      const params = { MessageSid: sid, From: "+15558881111", Body: "hi" };
      const res = await postInbound(params, "not-a-valid-signature");
      expect(res.status).toBe(403);

      const rows = await db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.providerMessageId, sid));
      expect(rows).toHaveLength(0);
    });

    it("records a verified reply and matches it to a customer by phone", async () => {
      const phone = "+1 (555) 246-8013";
      const [customer] = await db
        .insert(customersTable)
        .values({ name: uniqueName("Texter"), phone })
        .returning();

      const sid = uniqueName("SMok").replace(/-/g, "");
      const params = { MessageSid: sid, From: "+15552468013", To: "+15559990000", Body: "Yes, see you then" };
      const res = await postInbound(params, signTwilio(WEBHOOK_URL, params));
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.providerMessageId, sid));
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.direction).toBe("inbound");
      expect(row.channel).toBe("sms");
      expect(row.status).toBe("received");
      expect(row.source).toBe("customer");
      expect(row.body).toBe("Yes, see you then");
      expect(row.customerId).toBe(customer.id);
      expect(row.toAddress).toBe("+15552468013");
    });

    it("records an unmatched number with a null customer", async () => {
      const sid = uniqueName("SMunknown").replace(/-/g, "");
      const params = { MessageSid: sid, From: "+15550009999", Body: "wrong number" };
      const res = await postInbound(params, signTwilio(WEBHOOK_URL, params));
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.providerMessageId, sid));
      expect(rows).toHaveLength(1);
      expect(rows[0].customerId).toBeNull();
    });

    it("is idempotent: a redelivered MessageSid records a single row", async () => {
      const sid = uniqueName("SMdup").replace(/-/g, "");
      const params = { MessageSid: sid, From: "+15553334444", Body: "first and only" };
      const sig = signTwilio(WEBHOOK_URL, params);

      const res1 = await postInbound(params, sig);
      const res2 = await postInbound(params, sig);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const rows = await db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.providerMessageId, sid));
      expect(rows).toHaveLength(1);
    });
  });
});
