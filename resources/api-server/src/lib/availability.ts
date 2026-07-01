import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

// Pure capacity/availability computation shared by the authenticated
// appointments route (M2) and, later, the public booking surface (M3).
// It does NOT read the database and contains ZERO customer data so its output
// is safe to expose to anonymous callers.

export interface AvailabilityConfig {
  timezone: string;
  maxAppointmentsPerDay: number;
  slotMinutes: number;
  slotCapacity: number;
  openTime: string; // "HH:MM" wall-clock in `timezone`
  closeTime: string; // "HH:MM" wall-clock in `timezone`
  openWeekdays: number[]; // 0=Sun .. 6=Sat; a day absent here is closed
}

// Minimal view of an appointment the calculation needs. Anything PII-bearing
// (customer, phone, notes) is intentionally excluded.
export interface AvailabilityAppointment {
  scheduledAt: string; // ISO instant (UTC)
  durationMinutes: number;
  status: string;
}

export interface AvailabilitySlot {
  start: string; // ISO instant (UTC)
  end: string; // ISO instant (UTC)
  count: number;
  capacity: number;
  available: boolean;
}

export interface AvailabilityDay {
  date: string; // YYYY-MM-DD (local to config.timezone)
  open: boolean;
  dayCount: number;
  maxPerDay: number;
  dayFull: boolean;
  slots: AvailabilitySlot[];
}

const MINUTES = 60_000;

// Appointments in these states do not consume capacity.
// "pending" covers unverified online bookings that have not yet been confirmed
// by staff; they must not block real customers from reserving the same slot.
const INACTIVE_STATUSES = new Set(["cancelled", "no_show", "pending"]);

const parseHhmm = (value: string): number => {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
};

const pad = (n: number): string => String(n).padStart(2, "0");

// Inclusive list of calendar dates ("YYYY-MM-DD") from `from` to `to`. Day math
// is done in UTC purely as a calendar counter so it never drifts with the
// server's local timezone or DST.
export const enumerateDates = (from: string, to: string): string[] => {
  const dates: string[] = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let cursor = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (cursor <= end) {
    const d = new Date(cursor);
    dates.push(
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    );
    cursor += 24 * 60 * MINUTES;
  }
  return dates;
};

// Day-of-week (0=Sun..6=Sat) for a calendar date, independent of any timezone.
const weekdayOf = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

export const computeAvailability = (
  dates: string[],
  appointments: AvailabilityAppointment[],
  config: AvailabilityConfig,
): AvailabilityDay[] => {
  // Pre-resolve each active appointment to its instant range plus the local
  // calendar date it falls on, so the per-slot loop stays cheap.
  const active = appointments
    .filter((a) => !INACTIVE_STATUSES.has(a.status))
    .map((a) => {
      const start = new Date(a.scheduledAt).getTime();
      const end = start + Math.max(0, a.durationMinutes) * MINUTES;
      const localDate = formatInTimeZone(
        new Date(a.scheduledAt),
        config.timezone,
        "yyyy-MM-dd",
      );
      return { start, end, localDate };
    });

  const openMinutes = parseHhmm(config.openTime);
  const closeMinutes = parseHhmm(config.closeTime);
  // Defensive: a non-positive slot length would make the slot loop never
  // advance. PUT /settings enforces the [15,30,60] enum, but this helper is
  // reused by the public M3 surface, so fail closed to an empty schedule.
  const slotStep = config.slotMinutes > 0 ? config.slotMinutes : 0;

  return dates.map((date) => {
    const dayCount = active.filter((a) => a.localDate === date).length;
    const dayFull = dayCount >= config.maxAppointmentsPerDay;
    const open = config.openWeekdays.includes(weekdayOf(date));

    if (!open) {
      return { date, open: false, dayCount, maxPerDay: config.maxAppointmentsPerDay, dayFull, slots: [] };
    }

    const slots: AvailabilitySlot[] = [];
    for (
      let m = openMinutes;
      slotStep > 0 && m + slotStep <= closeMinutes;
      m += slotStep
    ) {
      const hh = pad(Math.floor(m / 60));
      const mm = pad(m % 60);
      const slotStart = fromZonedTime(`${date} ${hh}:${mm}:00`, config.timezone);
      const startMs = slotStart.getTime();
      const endMs = startMs + slotStep * MINUTES;
      // Overlap test: appointment intersects [slotStart, slotEnd).
      const count = active.filter((a) => a.start < endMs && a.end > startMs).length;
      slots.push({
        start: slotStart.toISOString(),
        end: new Date(endMs).toISOString(),
        count,
        capacity: config.slotCapacity,
        available: count < config.slotCapacity && !dayFull,
      });
    }

    return { date, open: true, dayCount, maxPerDay: config.maxAppointmentsPerDay, dayFull, slots };
  });
};
