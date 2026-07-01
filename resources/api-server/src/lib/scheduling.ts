import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import {
  db,
  appointmentsTable,
  shopSettingsTable,
  withCriticalSection,
} from "@workspace/db";
import {
  computeAvailability,
  enumerateDates,
  type AvailabilityConfig,
  type AvailabilityDay,
} from "./availability";
import { recordSmsConsent, SMS_CONSENT_DISCLOSURE } from "./messaging";

// Shared scheduling/capacity logic used by both the authenticated appointments
// route (M2) and the public booking surface (M3). Keeping it here means the
// capacity rules live in exactly one place and cannot drift between the two
// callers. The pure, PII-free math stays in ./availability.

const DAY_MS = 24 * 60 * 60 * 1000;

// How far in advance an online booking may be requested.
const MAX_BOOKING_HORIZON_MS = 90 * DAY_MS;

// How long an unconfirmed (pending) online booking is retained before it is
// treated as abandoned. After this TTL the booking is excluded from anti-abuse
// checks and filtered out of staff views. Kept short (4 h) so junk bookings
// self-clear within a single work shift rather than accumulating for two days.
const PENDING_BOOKING_TTL_MS = 4 * 60 * 60 * 1000;

// Maximum number of live pending online bookings allowed for any single time
// slot. Keyed on scheduledAt (not on caller-supplied phone), so rotating phone
// numbers cannot bypass this cap. Each slot can accumulate at most this many
// unreviewed requests before the endpoint rejects further submissions for it.
const MAX_PENDING_PER_SLOT = 5;

// Hard ceiling on the total number of live pending online bookings in the
// system. Prevents a distributed attacker from filling the staff review queue
// beyond a manageable size regardless of how many IPs they rotate through.
// Set well above any realistic legitimate demand for a single-shop install.
const MAX_PENDING_GLOBAL = 500;

// Advisory-lock key that serializes concurrent online bookings so the
// capacity check and insert are atomic. 42 is already used by auth setup.
const BOOKING_LOCK_KEY = 43;

// Load the singleton shop-settings row (id=1), creating it with schema defaults
// if it does not exist yet, so scheduling config is always available.
export const loadSchedulingConfig = async (): Promise<AvailabilityConfig> => {
  const [existing] = await db
    .select()
    .from(shopSettingsTable)
    .where(eq(shopSettingsTable.id, 1));
  const row =
    existing ??
    (await db.insert(shopSettingsTable).values({ id: 1 }).returning())[0];
  return {
    timezone: row.timezone,
    maxAppointmentsPerDay: row.maxAppointmentsPerDay,
    slotMinutes: row.slotMinutes,
    slotCapacity: row.slotCapacity,
    openTime: row.openTime,
    closeTime: row.closeTime,
    openWeekdays: row.openWeekdays,
  };
};

// Instant window covering [from,to] padded by a day on each side so a
// long-duration appointment near the boundary is still counted.
const capacityWindow = (
  from: string,
  to: string,
  timezone: string,
): { startISO: string; endISO: string } => ({
  startISO: new Date(
    fromZonedTime(`${from} 00:00:00`, timezone).getTime() - DAY_MS,
  ).toISOString(),
  endISO: new Date(
    fromZonedTime(`${to} 00:00:00`, timezone).getTime() + 2 * DAY_MS,
  ).toISOString(),
});

// Project only the capacity-relevant columns — no PII leaves the database.
const CAPACITY_COLUMNS = {
  scheduledAt: appointmentsTable.scheduledAt,
  durationMinutes: appointmentsTable.durationMinutes,
  status: appointmentsTable.status,
} as const;

// Compute server-side slot/day availability for an (already validated) date
// range. Shared by the authenticated and public availability endpoints.
export const computeAvailabilityForRange = async (
  from: string,
  to: string,
): Promise<AvailabilityDay[]> => {
  const config = await loadSchedulingConfig();
  const dates = enumerateDates(from, to);
  const { startISO, endISO } = capacityWindow(from, to, config.timezone);
  const rows = await db
    .select(CAPACITY_COLUMNS)
    .from(appointmentsTable)
    .where(
      and(
        gte(appointmentsTable.scheduledAt, startISO),
        lt(appointmentsTable.scheduledAt, endISO),
      ),
    );
  return computeAvailability(dates, rows, config);
};

export interface OnlineBookingInput {
  customerName: string;
  phone: string;
  serviceType?: string | null;
  notes?: string | null;
  scheduledAt: string;
  // True when the customer ticked the SMS consent box on the booking form.
  // Records an opt-in for the provided phone number after the booking succeeds.
  smsConsent?: boolean;
  // IP address of the booking request (from the HTTP layer), recorded on the
  // consent event row so the shop can demonstrate the opt-in came from a
  // specific address during a carrier audit.
  ipAddress?: string | null;
}

export interface OnlineBookingCreated {
  id: number;
  customerName: string | null;
  phone: string | null;
  serviceType: string | null;
  scheduledAt: string;
  durationMinutes: number;
  status: string;
}

export type OnlineBookingResult =
  | { ok: true; appointment: OnlineBookingCreated }
  | { ok: false; status: number; error: string };

// Create an anonymous online booking. Re-validates the requested slot against
// live capacity inside a serialized transaction so two simultaneous bookings
// cannot oversubscribe the same slot. The booking always occupies exactly one
// configured slot (durationMinutes = config.slotMinutes) and is tagged
// source='online'.
//
// Anti-abuse hardening (all checks keyed on server-controlled data, not
// caller-supplied phone/name, so they cannot be bypassed by rotating identity
// fields):
//
//   1. Same-slot per-phone dedup — trivial "submit same request twice" guard.
//   2. Per-slot cap (MAX_PENDING_PER_SLOT) — at most N live pending online
//      bookings allowed per scheduledAt value. An attacker distributing across
//      many IPs but reusing the same slot is stopped here.
//   3. Global cap (MAX_PENDING_GLOBAL) — hard ceiling on total live pending
//      online bookings system-wide. Bounds the total queue size staff must
//      review regardless of IP diversity.
//   4. Short TTL (PENDING_BOOKING_TTL_MS = 4 h) — junk self-clears within a
//      single work shift so repeated attacks do not permanently pollute the queue.
//
// Note: a per-phone cap was deliberately NOT added because the phone field is
// caller-supplied and unverified — an attacker could trivially exhaust a real
// customer's quota by spoofing their number (targeted DoS). All caps above are
// keyed on scheduledAt or are global counts, making them unbypassable by simply
// varying attacker-controlled fields.
export const createOnlineBooking = async (
  input: OnlineBookingInput,
): Promise<OnlineBookingResult> => {
  const when = Date.parse(input.scheduledAt);
  if (Number.isNaN(when)) {
    return { ok: false, status: 400, error: "scheduledAt must be a valid date/time" };
  }
  const now = Date.now();
  if (when <= now) {
    return { ok: false, status: 409, error: "The selected time is in the past" };
  }
  if (when > now + MAX_BOOKING_HORIZON_MS) {
    return { ok: false, status: 400, error: "The selected time is too far in advance" };
  }

  const config = await loadSchedulingConfig();
  const whenISO = new Date(when).toISOString();
  const localDate = formatInTimeZone(new Date(when), config.timezone, "yyyy-MM-dd");
  const nowISO = new Date(now).toISOString();
  const expiresAt = new Date(now + PENDING_BOOKING_TTL_MS).toISOString();

  const result = await withCriticalSection(
    BOOKING_LOCK_KEY,
    async (tx): Promise<OnlineBookingResult> => {
    // Anti-abuse check: same phone + same slot dedup.
    // Reject if this phone already has a non-expired pending booking at this exact time.
    // This closes the trivial "submit the same request twice" case.
    const [existing] = await tx
      .select({ id: appointmentsTable.id })
      .from(appointmentsTable)
      .where(
        and(
          eq(appointmentsTable.phone, input.phone),
          eq(appointmentsTable.source, "online"),
          eq(appointmentsTable.status, "pending"),
          eq(appointmentsTable.scheduledAt, whenISO),
          sql`(${appointmentsTable.expiresAt} IS NULL OR ${appointmentsTable.expiresAt} > ${nowISO})`,
        ),
      );

    if (existing) {
      return {
        ok: false,
        status: 409,
        error: "You already have a pending booking request for this time slot.",
      };
    }

    // Anti-abuse check: per-slot global cap.
    // Count live pending online bookings for this exact scheduledAt value.
    // Keyed on scheduledAt, not on caller-supplied phone, so rotating identity
    // fields cannot bypass this limit.
    const [slotCount] = await tx
      .select({ n: count() })
      .from(appointmentsTable)
      .where(
        and(
          eq(appointmentsTable.source, "online"),
          eq(appointmentsTable.status, "pending"),
          eq(appointmentsTable.scheduledAt, whenISO),
          sql`(${appointmentsTable.expiresAt} IS NULL OR ${appointmentsTable.expiresAt} > ${nowISO})`,
        ),
      );
    if ((slotCount?.n ?? 0) >= MAX_PENDING_PER_SLOT) {
      return {
        ok: false,
        status: 429,
        error: "This time slot has too many pending booking requests. Please choose a different time.",
      };
    }

    // Anti-abuse check: global pending queue cap.
    // Bound the total number of live pending online bookings system-wide so a
    // distributed attacker cannot flood the staff review queue beyond a
    // manageable size regardless of how many IPs they rotate through.
    const [globalCount] = await tx
      .select({ n: count() })
      .from(appointmentsTable)
      .where(
        and(
          eq(appointmentsTable.source, "online"),
          eq(appointmentsTable.status, "pending"),
          sql`(${appointmentsTable.expiresAt} IS NULL OR ${appointmentsTable.expiresAt} > ${nowISO})`,
        ),
      );
    if ((globalCount?.n ?? 0) >= MAX_PENDING_GLOBAL) {
      return {
        ok: false,
        status: 503,
        error: "Online booking is temporarily unavailable. Please call the shop directly.",
      };
    }

    // Capacity check (same as before): pending bookings do NOT count towards
    // slot capacity so real customers are not blocked. The anti-abuse checks
    // above are the defence against flooding.
    const { startISO, endISO } = capacityWindow(localDate, localDate, config.timezone);
    const rows = await tx
      .select(CAPACITY_COLUMNS)
      .from(appointmentsTable)
      .where(
        and(
          gte(appointmentsTable.scheduledAt, startISO),
          lt(appointmentsTable.scheduledAt, endISO),
        ),
      );

    const [day] = computeAvailability([localDate], rows, config);
    if (!day || !day.open) {
      return { ok: false, status: 409, error: "The shop is closed at the selected time" };
    }
    const slot = day.slots.find((s) => s.start === whenISO);
    if (!slot) {
      return { ok: false, status: 400, error: "The selected time is not a bookable slot" };
    }
    if (!slot.available) {
      return { ok: false, status: 409, error: "That time slot is no longer available" };
    }

    const [created] = await tx
      .insert(appointmentsTable)
      .values({
        customerName: input.customerName,
        phone: input.phone,
        serviceType: input.serviceType ?? null,
        notes: input.notes ?? null,
        // Online bookings start as "pending" so unverified requests from the
        // public surface do not consume capacity or block real customers.
        // Staff must confirm (change to "scheduled") before the slot is held.
        status: "pending",
        scheduledAt: whenISO,
        durationMinutes: config.slotMinutes,
        source: "online",
        // Record when this pending request expires so stale junk bookings are
        // automatically excluded from staff views and anti-abuse accounting.
        expiresAt,
      })
      .returning();

    return {
      ok: true,
      appointment: {
        id: created.id,
        customerName: created.customerName,
        phone: created.phone,
        serviceType: created.serviceType,
        scheduledAt: created.scheduledAt,
        durationMinutes: created.durationMinutes,
        status: created.status,
      },
    };
    },
  );

  // Record the SMS opt-in after the booking is committed (outside the booking
  // lock). Done only on a successful booking and only when the customer ticked
  // the box; recordSmsConsent ignores unkeyable numbers. A failure to write the
  // consent row must not fail an otherwise-successful booking.
  if (result.ok && input.smsConsent) {
    try {
      await recordSmsConsent({
        phone: input.phone,
        status: "granted",
        source: "public_booking",
        consentText: SMS_CONSENT_DISCLOSURE,
        ipAddress: input.ipAddress ?? null,
      });
    } catch {
      // Swallow — the booking itself succeeded; consent capture is best-effort.
    }
  }

  return result;
};
