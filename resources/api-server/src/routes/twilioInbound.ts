import { Router, type IRouter } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod/v4";
import { getTwilioAuthToken, verifyTwilioSignature } from "../lib/sms";
import { recordInboundSms } from "../lib/messaging";

// Public, unauthenticated inbound SMS webhook (two-way texting). Twilio POSTs an
// application/x-www-form-urlencoded body here whenever a customer replies to one
// of the shop's texts. This router is mounted BEFORE authGate (the
// caller is Twilio, not a logged-in staff user), so it authenticates the request
// by recomputing the X-Twilio-Signature against the account auth token.
//
// Safety posture:
//  - INERT when Twilio is not connected (no auth token): respond 200 with empty
//    TwiML and record nothing, so a probe to this path does nothing.
//  - 403 when an auth token IS available but the signature does not verify.
//  - Idempotent: a redelivered webhook (same MessageSid) records the reply once.
//  - Per-IP rate limited and bounded body so it cannot be used to exhaust
//    resources (see the threat model: external integrations are a DoS target).

const router: IRouter = Router();

// Empty TwiML response — acknowledges receipt without sending an auto-reply.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function sendTwiml(res: import("express").Response, status: number): void {
  res.status(status).type("text/xml").send(EMPTY_TWIML);
}

// Per-IP limit for the inbound webhook. Generous enough for a busy shop's real
// reply volume but bounded so a flood from one source is capped. Skipped in the
// test env so the integration suite (same loopback IP) is not throttled.
const inboundLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 240,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
  skip: () => process.env.NODE_ENV === "test",
});

// Twilio sends many fields; we only need these. Bounded so an oversized body is
// rejected before it is recorded. Other fields are ignored for our purposes but
// still participate in signature verification (which uses the raw form body).
const InboundBody = z.object({
  MessageSid: z.string().min(1).max(64),
  From: z.string().min(1).max(32),
  To: z.string().max(32).optional(),
  Body: z.string().max(2000).optional(),
});

// Reconstruct the exact public URL Twilio signed. Twilio signs the URL it was
// configured to call, which behind the shared proxy is the forwarded host. An
// explicit override (TWILIO_INBOUND_WEBHOOK_URL) wins so an operator can pin it
// when the inferred host does not match what is configured in the Twilio console.
function reconstructUrl(req: import("express").Request): string {
  const override = process.env.TWILIO_INBOUND_WEBHOOK_URL?.trim();
  if (override) return override;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] || "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0] ||
    req.headers.host ||
    "";
  return `${proto}://${host}${req.originalUrl}`;
}

router.post(
  "/twilio/inbound",
  inboundLimiter,
  async (req, res): Promise<void> => {
    // Inert when Twilio is not connected: nothing to verify against, so we trust
    // nothing and record nothing. A 200 keeps probes quiet.
    const authToken = await getTwilioAuthToken();
    if (!authToken) {
      req.log.debug("Inbound SMS webhook hit but no Twilio auth token configured; ignoring.");
      sendTwiml(res, 200);
      return;
    }

    // Verify the signature over the FULL parsed form body (all fields), not just
    // the ones we parse, or the recomputed HMAC will not match Twilio's.
    const rawParams =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : {};
    const signature = req.header("X-Twilio-Signature");
    const verified = verifyTwilioSignature({
      authToken,
      signature,
      url: reconstructUrl(req),
      params: rawParams,
    });
    if (!verified) {
      req.log.warn("Inbound SMS webhook signature verification failed.");
      res.status(403).type("text/xml").send(EMPTY_TWIML);
      return;
    }

    const parsed = InboundBody.safeParse(rawParams);
    if (!parsed.success) {
      // Authentic Twilio request but missing/oversized required fields — ack so
      // Twilio does not retry, but record nothing.
      req.log.warn({ issues: parsed.error.issues }, "Inbound SMS webhook payload invalid.");
      sendTwiml(res, 200);
      return;
    }

    const { MessageSid, From, To, Body } = parsed.data;
    const { created } = await recordInboundSms({
      providerMessageId: MessageSid,
      fromPhone: From,
      toPhone: To ?? null,
      body: Body ?? "",
    });
    req.log.info({ messageSid: MessageSid, created }, "Recorded inbound customer SMS reply.");

    sendTwiml(res, 200);
  },
);

export default router;
