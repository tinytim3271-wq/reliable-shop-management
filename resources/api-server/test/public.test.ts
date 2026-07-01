import { beforeAll, describe, expect, it } from "vitest";
import { agent } from "./helpers";

// The public surface is unauthenticated, so requests carry no session cookie.
// Each test run gets its own disposable database (see globalSetup.ts), so the
// appointment rows these bookings create need no per-suite cleanup.

// Far-future window for read-only availability assertions — reads have no
// horizon cap, so these never mutate data and never collide with other suites.
const FROM = "2099-07-01";
const TO = "2099-07-07";

// Online bookings are capped at 90 days out, so the create/conflict tests pick
// an open slot inside a near-future window (well within the horizon).
const isoDate = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
const NEAR_FROM = isoDate(30);
const NEAR_TO = isoDate(37);

// These tests share a database with all other api-server test files that run
// concurrently. To prevent parallel execution from exhausting the per-slot
// pending cap (MAX_PENDING_PER_SLOT=5), anti-abuse tests use a DEDICATED date
// window that no other test file touches:
//   • DEDUP_FROM/DEDUP_TO  — unique window for the same-phone dedup test
//   • CAP_FROM/CAP_TO      — unique window for the per-slot cap test
const DEDUP_FROM = isoDate(45);
const DEDUP_TO = isoDate(52);
const CAP_FROM = isoDate(55);
const CAP_TO = isoDate(62);

let slotMinutes = 0;

interface Slot {
  start: string;
  available: boolean;
  capacity: number;
  count: number;
}

// Pull the shop's configured slot length from the public profile.
beforeAll(async () => {
  const res = await agent().get("/api/public/shop-info");
  slotMinutes = res.body.slotMinutes;
});

// Find the first bookable slot in the given future window so the test does not
// depend on which weekday the dates land on.
async function firstAvailableSlotInRange(
  from: string,
  to: string,
): Promise<{ date: string; slot: Slot }> {
  const res = await agent()
    .get("/api/public/availability")
    .query({ from, to });
  expect(res.status).toBe(200);
  for (const day of res.body as Array<{ open: boolean; date: string; slots: Slot[] }>) {
    if (!day.open) continue;
    const slot = day.slots.find((s) => s.available);
    if (slot) return { date: day.date, slot };
  }
  throw new Error(`no available slot found in window ${from}..${to}`);
}

// Convenience wrapper that uses the shared NEAR window — all non-anti-abuse
// tests point here so they continue to exercise the same slot range.
const firstAvailableSlot = () => firstAvailableSlotInRange(NEAR_FROM, NEAR_TO);

describe("public shop-info", () => {
  it("returns the shop profile and scheduling hours without authentication", async () => {
    const res = await agent().get("/api/public/shop-info");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("shopName");
    expect(res.body).toHaveProperty("timezone");
    expect(res.body).toHaveProperty("openTime");
    expect(res.body).toHaveProperty("closeTime");
    expect(Array.isArray(res.body.openWeekdays)).toBe(true);
    expect(typeof res.body.slotMinutes).toBe("number");
  });
});

describe("public availability", () => {
  it("returns per-day capacity without authentication and without PII", async () => {
    const res = await agent()
      .get("/api/public/availability")
      .query({ from: FROM, to: TO });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const serialized = JSON.stringify(res.body);
    for (const leaked of ["customerName", "phone", "notes", "customerId"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("rejects a missing from date with 400", async () => {
    const res = await agent().get("/api/public/availability");
    expect(res.status).toBe(400);
  });

  it("rejects a range longer than 31 days with 400", async () => {
    const res = await agent()
      .get("/api/public/availability")
      .query({ from: "2099-07-01", to: "2099-09-01" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/31 days/i);
  });
});

describe("public booking", () => {
  it("rejects an invalid body with 400", async () => {
    const res = await agent()
      .post("/api/public/booking")
      .send({ phone: "555-1234", scheduledAt: "2099-07-01T13:00:00.000Z" });
    expect(res.status).toBe(400);
  });

  it("rejects a booking in the past with 409", async () => {
    const res = await agent()
      .post("/api/public/booking")
      .send({
        customerName: "Public Past Booker",
        phone: "555-0000",
        scheduledAt: "2000-01-01T13:00:00.000Z",
      });
    expect(res.status).toBe(409);
  });

  it("rejects a booking too far in the future with 400", async () => {
    const farOut = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString();
    const res = await agent()
      .post("/api/public/booking")
      .send({
        customerName: "Public Far Booker",
        phone: "555-0001",
        scheduledAt: farOut,
      });
    expect(res.status).toBe(400);
  });

  it("creates an online booking on an available slot and only echoes the booker's own data", async () => {
    const { slot } = await firstAvailableSlot();

    const res = await agent()
      .post("/api/public/booking")
      .send({
        customerName: "Public Slot Booker",
        phone: "555-0002",
        serviceType: "Oil change",
        notes: "Please call before noon",
        scheduledAt: slot.start,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTypeOf("number");
    expect(res.body.customerName).toBe("Public Slot Booker");
    expect(res.body.phone).toBe("555-0002");
    // Online bookings must be staged as "pending" so they do not consume
    // capacity until staff confirms them — the core fix for booking-abuse.
    expect(res.body.status).toBe("pending");
    expect(res.body.durationMinutes).toBe(slotMinutes);
    // The response must not expose internal/other-customer fields.
    expect(res.body).not.toHaveProperty("customerId");
    expect(res.body).not.toHaveProperty("notes");
  });

  it("allows a second public booking on the same slot because pending does not consume capacity", async () => {
    // Core booking-abuse regression: a pending online booking must NOT block a
    // second caller from booking the same slot. Only staff-confirmed
    // (scheduled/confirmed) appointments count toward capacity.
    const { slot } = await firstAvailableSlot();

    const first = await agent()
      .post("/api/public/booking")
      .send({
        customerName: "Public Concurrent Booker One",
        phone: "555-0003",
        scheduledAt: slot.start,
      });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("pending");

    // The slot must still show as available and accept a second public booking.
    const second = await agent()
      .post("/api/public/booking")
      .send({
        customerName: "Public Concurrent Booker Two",
        phone: "555-0004",
        scheduledAt: slot.start,
      });
    expect(second.status).toBe(201);
    expect(second.body.status).toBe("pending");
  });

  it("rejects a duplicate booking from the same phone on the same slot with 409", async () => {
    // Anti-abuse: an attacker who submits the exact same phone + scheduledAt
    // twice must receive 409 on the second attempt. This closes the trivial
    // "submit the same request twice" case without relying on IP.
    //
    // Uses a DEDICATED date window (DEDUP_FROM..DEDUP_TO) so that bookings
    // created by other concurrently-running test files cannot exhaust the
    // per-slot cap and cause a spurious 429 on the first attempt here.
    const { slot } = await firstAvailableSlotInRange(DEDUP_FROM, DEDUP_TO);

    const first = await agent()
      .post("/api/public/booking")
      .send({
        customerName: "Dedup Tester",
        phone: "555-0010",
        scheduledAt: slot.start,
      });
    expect(first.status).toBe(201);

    const duplicate = await agent()
      .post("/api/public/booking")
      .send({
        customerName: "Dedup Tester Again",
        phone: "555-0010",
        scheduledAt: slot.start,
      });
    expect(duplicate.status).toBe(409);
  });

  it("rejects further bookings on a slot once the per-slot pending cap is reached with 429", async () => {
    // Anti-abuse: the per-slot cap (MAX_PENDING_PER_SLOT) prevents an attacker
    // from flooding a single time slot with unlimited fake requests even when
    // they rotate phone numbers. The check is keyed on scheduledAt, which the
    // server controls — not on the caller-supplied phone field.
    //
    // Uses a DEDICATED date window (CAP_FROM..CAP_TO) so this test is fully
    // self-contained and unaffected by bookings in other test files or earlier
    // tests. It fills the slot from zero to the cap entirely on its own.
    const { slot } = await firstAvailableSlotInRange(CAP_FROM, CAP_TO);

    // Fill the slot up to MAX_PENDING_PER_SLOT (5). Each iteration uses a
    // distinct phone so the same-phone dedup check does not fire first.
    let capHit = false;
    for (let i = 0; i < 10; i++) {
      const res = await agent()
        .post("/api/public/booking")
        .send({
          customerName: `Cap Filler ${i}`,
          phone: `555-08${String(i).padStart(2, "0")}`,
          scheduledAt: slot.start,
        });
      if (res.status === 429) {
        capHit = true;
        break;
      }
      // Any other error is unexpected — fail fast.
      expect(res.status).toBe(201);
    }
    expect(capHit).toBe(true);
  });
});
