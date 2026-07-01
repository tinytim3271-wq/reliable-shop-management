// Real outbound SMS delivery for the outreach module, accessed through the
// Replit Connectors proxy (Twilio). The proxy injects the account's auth, so no
// Twilio API key/auth token lives in this codebase. Integration: connector
// `twilio` (see the integrations skill).
//
// This module is the ONLY place that talks to a live SMS provider. Callers
// (the outreach send handler in routes/messages.ts and the owner-alert helper in
// lib/messaging.ts) call isSmsProviderConfigured() first and fall back to the
// simulated delivery note when no provider is connected, so hosted/dev/test
// behavior is unchanged until the shop owner connects Twilio.
import { ReplitConnectors } from "@replit/connectors-sdk";
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeToE164 } from "./phone";

// Connector name as registered with the Replit Connectors proxy.
export const TWILIO_CONNECTOR = "twilio";

// Outbound SMS calls time out so a slow provider cannot pin server resources
// (see the threat model: externally triggered integrations are a DoS target).
const SMS_TIMEOUT_MS = 15_000;

export class SmsError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "SmsError";
    this.status = status;
  }
}

// Never cache the client — the SDK refreshes tokens internally per call.
function client(): ReplitConnectors {
  return new ReplitConnectors();
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

// The SDK types the connection loosely, so read the fields defensively across
// the various names the connector may use.
function readString(obj: unknown, ...keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

// The Twilio connection settings carry the account SID (needed in the REST
// path) and, on most connections, a provisioned sender phone number and/or a
// Messaging Service SID. The auth token (when the connection exposes it) is used
// to verify inbound webhook signatures; outbound sends still go through the proxy.
interface TwilioConnection {
  accountSid: string | null;
  fromNumber: string | null;
  messagingServiceSid: string | null;
  authToken: string | null;
}

// Load the live Twilio connection (if any) and extract the account SID + sender
// number / messaging service. Returns null when the connectors proxy is absent
// (e.g. the in-process test suite) or no Twilio connection is bound. Never
// throws.
async function loadTwilioConnection(): Promise<TwilioConnection | null> {
  if (!process.env.REPLIT_CONNECTORS_HOSTNAME) return null;
  try {
    const connections = await client().listConnections({
      connector_names: TWILIO_CONNECTOR,
    });
    const conn = connections[0];
    if (!conn) return null;
    // Credentials live under `settings`; some shapes nest them under
    // `connection_settings`. Account SID is required to build the REST path.
    const settings =
      (conn as { settings?: unknown }).settings ??
      (conn as { connection_settings?: unknown }).connection_settings ??
      conn;
    const accountSid =
      readString(settings, "account_sid", "accountSid", "sid") ??
      readString(conn.metadata, "account_sid", "accountSid", "sid");
    const fromNumber =
      readString(
        settings,
        "phone_number",
        "from_number",
        "from",
        "phoneNumber",
        "fromNumber",
      ) ??
      readString(
        conn.metadata,
        "phone_number",
        "from_number",
        "from",
        "phoneNumber",
        "fromNumber",
      );
    const messagingServiceSid =
      readString(settings, "messaging_service_sid", "messagingServiceSid") ??
      readString(conn.metadata, "messaging_service_sid", "messagingServiceSid");
    const authToken =
      readString(settings, "auth_token", "authToken", "api_secret", "token") ??
      readString(conn.metadata, "auth_token", "authToken", "api_secret", "token");
    return { accountSid, fromNumber, messagingServiceSid, authToken };
  } catch {
    return null;
  }
}

// Returns true if a Twilio integration is connected to this workspace. When the
// connectors proxy environment is absent (e.g. the in-process test suite) or no
// connection is bound, this returns false so the caller simulates instead of
// attempting a live send. Never throws.
export async function isSmsProviderConfigured(): Promise<boolean> {
  return (await loadTwilioConnection()) !== null;
}

// Resolve the sender. Twilio requires either a `From` phone number or a
// MessagingServiceSid. An explicit per-message override wins, then env overrides
// (mirrors OUTREACH_FROM_EMAIL), otherwise fall back to whatever the connection
// captured.
function resolveSender(
  conn: TwilioConnection,
  inputFrom?: string | null,
): { from: string | null; messagingServiceSid: string | null } {
  const from =
    (typeof inputFrom === "string" && inputFrom.trim() ? inputFrom.trim() : null) ??
    readString(
      process.env,
      "OUTREACH_FROM_SMS",
      "OUTREACH_SMS_FROM",
      "TWILIO_FROM_NUMBER",
    ) ??
    conn.fromNumber;
  const messagingServiceSid =
    readString(process.env, "TWILIO_MESSAGING_SERVICE_SID") ??
    conn.messagingServiceSid;
  return { from, messagingServiceSid };
}

export interface SendSmsInput {
  to: string;
  // Sender number. Falls back to the env overrides, then the connection's
  // provisioned number / messaging service, when omitted.
  from?: string | null;
  body: string;
}

// Deliver one SMS via Twilio's Messages API through the connectors proxy.
// Returns the provider message SID on success. Throws SmsError on any failure so
// the caller can surface it and leave the message retryable rather than marking
// it sent.
export async function sendSms(input: SendSmsInput): Promise<{ id: string }> {
  const conn = await loadTwilioConnection();
  if (!conn) {
    throw new SmsError("No SMS provider is connected.", 409);
  }
  if (!conn.accountSid) {
    throw new SmsError(
      "The connected SMS provider is missing an account SID; reconnect Twilio.",
      409,
    );
  }

  const { from, messagingServiceSid } = resolveSender(conn, input.from);
  if (!from && !messagingServiceSid) {
    throw new SmsError(
      "No SMS sender is configured. Set OUTREACH_SMS_FROM (or TWILIO_MESSAGING_SERVICE_SID), or provision a Twilio number.",
      409,
    );
  }

  // Twilio requires the recipient in E.164. Records saved through the app are
  // normalized on write, but normalize defensively here too (legacy/imported
  // numbers, AI tools) so a loosely-formatted number is rejected with a clear
  // error instead of silently failing at the provider.
  const to = normalizeToE164(input.to);
  if (!to) {
    throw new SmsError(
      `Recipient phone number is not a valid format: ${input.to}`,
      422,
    );
  }

  const params = new URLSearchParams();
  params.set("To", to);
  if (messagingServiceSid) {
    params.set("MessagingServiceSid", messagingServiceSid);
  } else if (from) {
    params.set("From", from);
  }
  params.set("Body", input.body);

  // Bound the outbound call so a slow/unresponsive provider cannot pin the
  // request. The SDK's proxy() does not accept an AbortSignal, so race it
  // against a timeout instead.
  let resp: Response;
  try {
    resp = await Promise.race([
      client().proxy(
        TWILIO_CONNECTOR,
        `/2010-04-01/Accounts/${encodeURIComponent(conn.accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params,
        },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new SmsError("SMS provider timed out.", 504)),
          SMS_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    if (err instanceof SmsError) throw err;
    throw new SmsError(`SMS request failed: ${(err as Error).message}`);
  }
  if (!isOk(resp.status)) {
    const detail = await resp.text().catch(() => "");
    throw new SmsError(
      `SMS provider returned ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const data = (await resp.json().catch(() => ({}))) as { sid?: unknown };
  return { id: typeof data.sid === "string" ? data.sid : "" };
}

// ── Inbound (two-way texting) ────────────────────────────────────────────────
//
// The inbound webhook authenticates Twilio by recomputing the X-Twilio-Signature
// over the request, which requires the account's auth token. The connectors
// proxy injects credentials for OUTBOUND calls but does not expose the raw auth
// token through proxy(), so inbound verification reads it from the connection
// settings when present, with a TWILIO_AUTH_TOKEN env override that also makes
// the verification path testable without a live connection.

// Returns the Twilio auth token used to verify inbound webhook signatures, or
// null when neither the env override nor a connected Twilio account exposes one.
// When null, the inbound webhook stays inert (records nothing) rather than
// trusting an unverifiable request. Never throws.
export async function getTwilioAuthToken(): Promise<string | null> {
  const envToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (envToken) return envToken;
  const conn = await loadTwilioConnection();
  return conn?.authToken ?? null;
}

export interface VerifyTwilioSignatureInput {
  authToken: string;
  // The exact value of the X-Twilio-Signature request header.
  signature: string | undefined | null;
  // The full public URL Twilio POSTed to, including scheme, host, and path.
  url: string;
  // The parsed application/x-www-form-urlencoded request body (all fields).
  params: Record<string, unknown>;
}

// Verify a Twilio request signature. Twilio computes the signature as
// base64(HMAC-SHA1(authToken, url + concat(sortedKey + value for every POST
// param))). We recompute it and compare in constant time. Pure function (no I/O)
// so the inbound route stays easy to test.
export function verifyTwilioSignature(input: VerifyTwilioSignatureInput): boolean {
  const { authToken, signature, url, params } = input;
  if (!authToken || typeof signature !== "string" || !signature) return false;

  let data = url;
  for (const key of Object.keys(params).sort()) {
    const val = params[key];
    data += key + (val == null ? "" : String(val));
  }

  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
