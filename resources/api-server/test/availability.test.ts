import { describe, expect, it } from "vitest";
import {
  computeAvailability,
  enumerateDates,
  type AvailabilityAppointment,
  type AvailabilityConfig,
} from "../src/lib/availability";

// Mon-Sat 08:00-17:00, 60-min single-bay slots, Sunday closed.
const config: AvailabilityConfig = {
  timezone: "America/New_York",
  maxAppointmentsPerDay: 12,
  slotMinutes: 60,
  slotCapacity: 1,
  openTime: "08:00",
  closeTime: "17:00",
  openWeekdays: [1, 2, 3, 4, 5, 6],
};

// 2026-06-14 is a Sunday, 2026-06-15 a Monday (both in EDT, UTC-4).
const SUNDAY = "2026-06-14";
const MONDAY = "2026-06-15";

const appt = (
  scheduledAt: string,
  durationMinutes = 60,
  status = "scheduled",
): AvailabilityAppointment => ({ scheduledAt, durationMinutes, status });

describe("enumerateDates", () => {
  it("is inclusive of both endpoints", () => {
    expect(enumerateDates("2026-06-14", "2026-06-16")).toEqual([
      "2026-06-14",
      "2026-06-15",
      "2026-06-16",
    ]);
  });

  it("crosses month boundaries", () => {
    expect(enumerateDates("2026-01-31", "2026-02-01")).toEqual([
      "2026-01-31",
      "2026-02-01",
    ]);
  });
});

describe("computeAvailability", () => {
  it("marks a closed weekday with no slots", () => {
    const [day] = computeAvailability([SUNDAY], [], config);
    expect(day.open).toBe(false);
    expect(day.slots).toHaveLength(0);
  });

  it("builds (close-open)/slot slots on an open day, all available when empty", () => {
    const [day] = computeAvailability([MONDAY], [], config);
    expect(day.open).toBe(true);
    expect(day.slots).toHaveLength(9); // 08:00..17:00 in 60-min steps
    expect(day.slots.every((s) => s.available && s.count === 0)).toBe(true);
  });

  it("counts an appointment against its slot and blocks it at capacity", () => {
    // 09:00 EDT = 13:00 UTC
    const [day] = computeAvailability([MONDAY], [appt("2026-06-15T13:00:00.000Z")], config);
    const nine = day.slots.find((s) => s.start === "2026-06-15T13:00:00.000Z");
    expect(nine?.count).toBe(1);
    expect(nine?.available).toBe(false);
    // neighbours stay open
    const eight = day.slots.find((s) => s.start === "2026-06-15T12:00:00.000Z");
    expect(eight?.available).toBe(true);
  });

  it("ignores cancelled and no_show appointments", () => {
    const [day] = computeAvailability(
      [MONDAY],
      [
        appt("2026-06-15T13:00:00.000Z", 60, "cancelled"),
        appt("2026-06-15T13:00:00.000Z", 60, "no_show"),
      ],
      config,
    );
    const nine = day.slots.find((s) => s.start === "2026-06-15T13:00:00.000Z");
    expect(nine?.count).toBe(0);
    expect(day.dayCount).toBe(0);
  });

  it("counts an overlapping appointment against every slot it spans", () => {
    // 08:30 EDT = 12:30 UTC, 60 min -> spans the 08:00 and 09:00 slots
    const [day] = computeAvailability([MONDAY], [appt("2026-06-15T12:30:00.000Z")], config);
    const eight = day.slots.find((s) => s.start === "2026-06-15T12:00:00.000Z");
    const nine = day.slots.find((s) => s.start === "2026-06-15T13:00:00.000Z");
    expect(eight?.count).toBe(1);
    expect(nine?.count).toBe(1);
  });

  it("honours multi-bay slot capacity", () => {
    const twoBay = { ...config, slotCapacity: 2 };
    const oneBooked = computeAvailability([MONDAY], [appt("2026-06-15T13:00:00.000Z")], twoBay);
    const slotA = oneBooked[0].slots.find((s) => s.start === "2026-06-15T13:00:00.000Z");
    expect(slotA?.available).toBe(true); // 1 of 2 bays used

    const twoBooked = computeAvailability(
      [MONDAY],
      [appt("2026-06-15T13:00:00.000Z"), appt("2026-06-15T13:00:00.000Z")],
      twoBay,
    );
    const slotB = twoBooked[0].slots.find((s) => s.start === "2026-06-15T13:00:00.000Z");
    expect(slotB?.count).toBe(2);
    expect(slotB?.available).toBe(false);
  });

  it("blocks the whole day once maxAppointmentsPerDay is reached", () => {
    const capped = { ...config, maxAppointmentsPerDay: 1 };
    const [day] = computeAvailability([MONDAY], [appt("2026-06-15T13:00:00.000Z")], capped);
    expect(day.dayFull).toBe(true);
    // even empty slots report unavailable when the day is full
    expect(day.slots.every((s) => !s.available)).toBe(true);
  });
});
