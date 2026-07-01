import { eq, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  vendorsTable,
  shopSettingsTable,
  messagesTable,
  smsConsentsTable,
  smsConsentEventsTable,
  type Message,
} from "@workspace/db";
import { isEmailProviderConfigured, sendEmail, EmailError } from "./email";
import { isSmsProviderConfigured, sendSms, SmsError } from "./sms";
import { logger } from "./logger";

// Sending is intentionally NOT wired to a live email/SMS provider yet. The send
// step records this note instead of dispatching anything, so the whole outreach
// flow (compose -> approve -> send) can be exercised safely. When a real
// provider is connected later, only the send handler changes.
export const SIMULATED_DELIVERY_NOTE =
  "Simulated delivery — no live email/SMS provider is connected yet. Connect a provider to send for real.";

type RecipientInput = {
  channel: string;
  customerId?: number | null;
  vendorId?: number | null;
  toName?: string | null;
  toAddress?: string | null;
};

// Fill in the recipient's display name and address from the linked customer or
// vendor record when the caller did not supply them. For SMS we prefer the phone
// number, for email the email address. Whatever the caller passes explicitly
// always wins.
export async function resolveRecipient(input: RecipientInput): Promise<{
  toName: string | null;
  toAddress: string | null;
}> {
  let toName = input.toName?.trim() || null;
  let toAddress = input.toAddress?.trim() || null;

  if ((!toName || !toAddress) && input.customerId != null) {
    const [c] = await db
      .select({
        name: customersTable.name,
        email: customersTable.email,
        phone: customersTable.phone,
      })
      .from(customersTable)
      .where(eq(customersTable.id, input.customerId));
    if (c) {
      if (!toName) toName = c.name;
      if (!toAddress)
        toAddress = input.channel === "sms" ? c.phone ?? null : c.email ?? null;
    }
  }

  if ((!toName || !toAddress) && input.vendorId != null) {
    const [v] = await db
      .select({
        name: vendorsTable.name,
        email: vendorsTable.email,
        phone: vendorsTable.phone,
      })
      .from(vendorsTable)
      .where(eq(vendorsTable.id, input.vendorId));
    if (v) {
      if (!toName) toName = v.name;
      if (!toAddress)
        toAddress = input.channel === "sms" ? v.phone ?? null : v.email ?? null;
    }
  }

  return { toName, toAddress };
}

// The owner's alert-channel preference, stored in shop settings. "both" attempts
// every configured channel; an unknown/legacy value is treated as "email".
export type OwnerAlertChannel = "email" | "sms" | "both";

export interface OwnerAlertChannelResult {
  channel: "email" | "sms";
  // True only when a real message left via a live provider on this channel.
  delivered: boolean;
  // True when a live provider was connected and the delivery genuinely failed
  // (provider error or missing verified sender/address while live). False for
  // inert/simulated paths where no provider is configured.
  failed: boolean;
  // Human-readable outcome for this channel (live confirmation, the simulated
  // note, or a "not configured" explanation).
  note: string;
  // The owner address this channel targeted (email or phone), or null.
  toAddress: string | null;
}

export interface OwnerAlertResult {
  // True when at least one channel delivered for real via a live provider.
  delivered: boolean;
  // True when at least one channel genuinely failed (live provider connected
  // but delivery did not succeed). False for fully-inert installs.
  failed: boolean;
  // Human-readable summary across the attempted channels.
  note: string;
  // The owner email the alert targeted (kept for backward compatibility); when
  // the preference is SMS-only this is the owner phone instead.
  toAddress: string | null;
  // Per-channel breakdown of what was attempted and the outcome.
  channels: OwnerAlertChannelResult[];
}

// Deliver the owner alert over email. Inert (simulated) unless the live provider
// (Resend) is connected AND both an owner address and a verified sender resolve.
// Never throws — a failure is logged and reported via the result.
async function deliverOwnerEmail(
  settings: { email: string | null; shopName: string | null },
  input: { subject: string; body: string },
): Promise<OwnerAlertChannelResult> {
  const ownerEmail = settings.email?.trim() || null;

  let live = false;
  try {
    live = await isEmailProviderConfigured();
  } catch {
    live = false;
  }
  if (!live) {
    return { channel: "email", delivered: false, failed: false, note: SIMULATED_DELIVERY_NOTE, toAddress: ownerEmail };
  }

  const fromAddress = process.env.OUTREACH_FROM_EMAIL?.trim() || ownerEmail;
  if (!ownerEmail || !fromAddress) {
    return {
      channel: "email",
      delivered: false,
      failed: true,
      note: "No shop owner email is configured; the email alert was not sent. Set the shop email in Settings.",
      toAddress: ownerEmail,
    };
  }

  try {
    const result = await sendEmail({
      to: ownerEmail,
      toName: settings.shopName ?? null,
      from: fromAddress,
      fromName: settings.shopName ?? null,
      subject: input.subject,
      body: input.body,
    });
    return {
      channel: "email",
      delivered: true,
      failed: false,
      note: result.id ? `Delivered via Resend (id: ${result.id}).` : "Delivered via Resend.",
      toAddress: ownerEmail,
    };
  } catch (err) {
    logger.error({ err }, "Owner alert email delivery failed");
    return {
      channel: "email",
      delivered: false,
      failed: true,
      note:
        err instanceof EmailError
          ? `Owner alert delivery failed: ${err.message}`
          : "Owner alert delivery failed.",
      toAddress: ownerEmail,
    };
  }
}

// Deliver the owner alert over SMS. Inert (simulated) unless the live provider
// (Twilio) is connected AND an owner phone number resolves. When connected, a
// real text is sent through the connectors proxy. Never throws — a failure is
// logged and reported via the result so a background caller cannot be aborted.
async function deliverOwnerSms(
  settings: { phone: string | null },
  input: { subject: string; body: string },
): Promise<OwnerAlertChannelResult> {
  const ownerPhone = settings.phone?.trim() || null;
  if (!ownerPhone) {
    return {
      channel: "sms",
      delivered: false,
      failed: false,
      note: "No shop owner phone number is configured; the text alert was not sent. Set the shop phone in Settings.",
      toAddress: null,
    };
  }

  let live = false;
  try {
    live = await isSmsProviderConfigured();
  } catch {
    live = false;
  }
  if (!live) {
    return { channel: "sms", delivered: false, failed: false, note: SIMULATED_DELIVERY_NOTE, toAddress: ownerPhone };
  }

  try {
    const result = await sendSms({ to: ownerPhone, body: input.body });
    return {
      channel: "sms",
      delivered: true,
      failed: false,
      note: result.id ? `Delivered via Twilio (sid: ${result.id}).` : "Delivered via Twilio.",
      toAddress: ownerPhone,
    };
  } catch (err) {
    logger.error({ err }, "Owner alert SMS delivery failed");
    return {
      channel: "sms",
      delivered: false,
      failed: true,
      note:
        err instanceof SmsError
          ? `Owner alert delivery failed: ${err.message}`
          : "Owner alert delivery failed.",
      toAddress: ownerPhone,
    };
  }
}

// Deliver an internal operational alert to the shop owner (e.g. an accounting
// sync that gave up for good). Unlike customer/vendor outreach — which goes
// through the staff draft -> approved -> sent gate so nothing un-reviewed reaches
// a customer — this is a system self-notification that must reach an owner who
// may be away, so it sends directly without an approval step.
//
// It still respects the outreach module's simulated-send boundary: a real email
// is dispatched ONLY when the live provider (Resend) is connected AND a
// from/owner address resolves; SMS has no live provider yet and always
// simulates. The owner picks the channel(s) in shop settings
// (`ownerAlertChannel`: email / sms / both). With no provider wired up — hosted
// default, dev, and the in-process test suite — it is inert (nothing is sent)
// and just returns the simulated note, so behavior is unchanged until the shop
// opts in. When a requested channel has no destination configured it falls back
// to the other channel rather than failing. Never throws: a delivery failure is
// logged and reported via the result so a caller in a background sweep cannot be
// aborted by it.
//
// When a channel genuinely fails (live provider connected but delivery did not
// succeed), the failure is recorded in the messages outbox as a system row so
// staff will notice it. Inert/simulated paths do not produce outbox rows because
// that is the expected default behaviour for installs with no provider.
export async function notifyOwner(input: {
  subject: string;
  body: string;
}): Promise<OwnerAlertResult> {
  const [settings] = await db
    .select({
      email: shopSettingsTable.email,
      phone: shopSettingsTable.phone,
      shopName: shopSettingsTable.shopName,
      ownerAlertChannel: shopSettingsTable.ownerAlertChannel,
    })
    .from(shopSettingsTable)
    .where(eq(shopSettingsTable.id, 1));

  // Treat any unknown/legacy value as the original email-only behavior.
  const pref: OwnerAlertChannel =
    settings?.ownerAlertChannel === "sms" || settings?.ownerAlertChannel === "both"
      ? settings.ownerAlertChannel
      : "email";

  const channels: OwnerAlertChannelResult[] = [];
  if (pref === "email" || pref === "both") {
    channels.push(
      await deliverOwnerEmail(
        { email: settings?.email ?? null, shopName: settings?.shopName ?? null },
        input,
      ),
    );
  }
  if (pref === "sms" || pref === "both") {
    channels.push(
      await deliverOwnerSms({ phone: settings?.phone ?? null }, input),
    );
  }

  const delivered = channels.some((c) => c.delivered);
  const failed = channels.some((c) => c.failed);

  // Prefer the email target for the back-compat `toAddress` field; fall back to
  // the first channel that has one (e.g. SMS-only preference).
  const toAddress =
    channels.find((c) => c.channel === "email")?.toAddress ??
    channels.find((c) => c.toAddress)?.toAddress ??
    null;
  const note = channels
    .map((c) => (channels.length > 1 ? `${c.channel}: ${c.note}` : c.note))
    .join(" ");

  // Record a row in the messages outbox for each channel that genuinely failed
  // so staff have a visible record they can act on. Inert/simulated channels
  // are not recorded — that is the expected default for installs with no
  // connected provider.
  const failedChannels = channels.filter((c) => c.failed);
  if (failedChannels.length > 0) {
    try {
      await db.insert(messagesTable).values(
        failedChannels.map((c) => ({
          channel: c.channel,
          direction: "outbound" as const,
          category: "other" as const,
          audience: "owner" as const,
          source: "system" as const,
          toName: settings?.shopName ?? null,
          toAddress: c.toAddress,
          subject: input.subject,
          body: input.body,
          status: "failed" as const,
          deliveryNote: c.note,
        })),
      );
    } catch (err) {
      // Recording the failure row is best-effort; a DB error must never abort
      // the original caller or mask the real delivery outcome.
      logger.error({ err }, "Failed to record owner-alert failure row in outbox");
    }
  }

  return { delivered, failed, note, toAddress, channels };
}

// ── Inbound texting (two-way) ────────────────────────────────────────────────

// Reduce a phone string to its digits. North-American numbers carry a country
// code (+1) that the stored shop record may omit, so callers compare the last 10
// digits rather than requiring an exact string match.
function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? "").replace(/\D/g, "");
}

// The last 10 digits of a phone number, used as the stable consent match key so
// different formattings of the same number resolve to one consent row. Returns
// null when there aren't enough digits to be a usable key.
export function phoneConsentKey(phone: string | null | undefined): string | null {
  const digits = phoneDigits(phone);
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

// Standard carrier opt-out / opt-in keywords. Carriers match the whole message
// body against these, so we compare the trimmed, upper-cased body exactly.
const SMS_STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
const SMS_START_KEYWORDS = new Set(["START", "YES", "UNSTOP", "CONTINUE"]);

export function detectSmsConsentKeyword(
  body: string | null | undefined,
): "revoke" | "grant" | null {
  const normalized = (body ?? "").trim().toUpperCase();
  if (!normalized) return null;
  if (SMS_STOP_KEYWORDS.has(normalized)) return "revoke";
  if (SMS_START_KEYWORDS.has(normalized)) return "grant";
  return null;
}

// Canonical disclosure the customer agrees to when opting in. Stored as a
// snapshot on the consent row so the shop has a record of exactly what was
// presented. Keep this in sync with the public consent terms page.
export const SMS_CONSENT_DISCLOSURE =
  "I agree to receive SMS text messages (appointment reminders, service " +
  "updates, and billing notifications) from the shop at the phone number " +
  "provided. Message and data rates may apply. Message frequency varies. " +
  "Reply STOP to opt out at any time, or HELP for help.";

export type SmsConsentStatus = "granted" | "revoked";
export type SmsConsentSource =
  | "public_booking"
  | "reply_stop"
  | "reply_start"
  | "staff";

// Upsert the current SMS consent state for a phone number. There is exactly one
// row per number (keyed by the last 10 digits), so a later opt-in/opt-out
// overwrites the previous state and bumps `updatedAt`. Numbers without 10 usable
// digits are ignored (no row written). Returns the resulting status, or null
// when the phone could not be keyed.
//
// In the same transaction an immutable event row is appended to
// `sms_consent_events` so the shop has a complete, auditable history of every
// opt-in / opt-out event (required for A2P 10DLC carrier audits).
export async function recordSmsConsent(input: {
  phone: string;
  status: SmsConsentStatus;
  source: SmsConsentSource;
  consentText?: string | null;
  ipAddress?: string | null;
}): Promise<SmsConsentStatus | null> {
  const phoneKey = phoneConsentKey(input.phone);
  if (!phoneKey) return null;
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    // Read the current state so we can record what changed.
    const [existing] = await tx
      .select({ status: smsConsentsTable.status })
      .from(smsConsentsTable)
      .where(eq(smsConsentsTable.phoneKey, phoneKey))
      .limit(1);

    // Upsert the current-state row (single row per phone).
    await tx
      .insert(smsConsentsTable)
      .values({
        phone: input.phone.trim(),
        phoneKey,
        status: input.status,
        source: input.source,
        consentText: input.consentText ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: smsConsentsTable.phoneKey,
        set: {
          phone: input.phone.trim(),
          status: input.status,
          source: input.source,
          consentText: input.consentText ?? null,
          updatedAt: now,
        },
      });

    // Append an immutable audit event.
    await tx.insert(smsConsentEventsTable).values({
      phoneKey,
      phone: input.phone.trim(),
      oldStatus: existing?.status ?? null,
      newStatus: input.status,
      source: input.source,
      consentTextShown: input.consentText ?? null,
      ipAddress: input.ipAddress ?? null,
      createdAt: now,
    });
  });

  return input.status;
}

// Look up the current consent state for a phone number. Returns "granted" or
// "revoked" when a record exists, or null when the number has never opted in or
// out (no record on file). Outbound gating treats only an explicit "revoked" as
// a hard block so legacy customers without a consent record are unaffected.
export async function getSmsConsentStatus(
  phone: string | null | undefined,
): Promise<SmsConsentStatus | null> {
  const phoneKey = phoneConsentKey(phone);
  if (!phoneKey) return null;
  const [row] = await db
    .select({ status: smsConsentsTable.status })
    .from(smsConsentsTable)
    .where(eq(smsConsentsTable.phoneKey, phoneKey))
    .limit(1);
  return (row?.status as SmsConsentStatus | undefined) ?? null;
}

// Match an inbound sender phone to a customer by comparing the last 10 digits of
// the digits-only form. Returns the customer id + name, or null when no customer
// has a phone on file that matches (inbound replies are still recorded with a
// null customer so staff can see texts from unknown numbers).
export async function findCustomerByPhone(
  phone: string,
): Promise<{ id: number; name: string } | null> {
  const digits = phoneDigits(phone);
  if (digits.length < 10) return null;
  const last10 = digits.slice(-10);
  const [match] = await db
    .select({ id: customersTable.id, name: customersTable.name })
    .from(customersTable)
    .where(
      sql`right(regexp_replace(coalesce(${customersTable.phone}, ''), '\\D', '', 'g'), 10) = ${last10}`,
    )
    .orderBy(customersTable.id)
    .limit(1);
  return match ?? null;
}

export interface InboundSmsInput {
  // The provider message id (Twilio MessageSid). Used as the idempotency key so a
  // redelivered webhook records the reply exactly once.
  providerMessageId: string;
  // The sender's phone number (Twilio `From`).
  fromPhone: string;
  // The shop number the text was sent to (Twilio `To`), recorded for context.
  toPhone: string | null;
  body: string;
}

// Record an inbound customer SMS reply in the outbox/inbox table. Idempotent on
// `providerMessageId`: a duplicate delivery returns the already-stored row
// without inserting a second one. Matches the sender to a customer by phone when
// possible. Returns the stored message plus whether this call created it.
export async function recordInboundSms(
  input: InboundSmsInput,
): Promise<{ message: Message; created: boolean }> {
  const customer = await findCustomerByPhone(input.fromPhone);

  const [inserted] = await db
    .insert(messagesTable)
    .values({
      channel: "sms",
      direction: "inbound",
      category: "other",
      audience: "customer",
      customerId: customer?.id ?? null,
      toName: customer?.name ?? null,
      toAddress: input.fromPhone,
      body: input.body,
      status: "received",
      source: "customer",
      providerMessageId: input.providerMessageId,
      deliveryNote: input.toPhone ? `Received via Twilio to ${input.toPhone}.` : "Received via Twilio.",
    })
    .onConflictDoNothing({ target: messagesTable.providerMessageId })
    .returning();

  if (inserted) {
    // Honor opt-out / opt-in keywords. Only act when we created the row so a
    // redelivered webhook does not re-toggle consent. Keyword matching is on the
    // whole trimmed body, mirroring carrier behavior.
    const keyword = detectSmsConsentKeyword(input.body);
    if (keyword === "revoke") {
      await recordSmsConsent({
        phone: input.fromPhone,
        status: "revoked",
        source: "reply_stop",
        consentText: input.body,
      });
    } else if (keyword === "grant") {
      await recordSmsConsent({
        phone: input.fromPhone,
        status: "granted",
        source: "reply_start",
        consentText: input.body,
      });
    }
    return { message: inserted, created: true };
  }

  // Conflict: the reply was already recorded by an earlier delivery. Return the
  // existing row so the caller can stay idempotent.
  const [existing] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.providerMessageId, input.providerMessageId))
    .limit(1);
  return { message: existing, created: false };
}
