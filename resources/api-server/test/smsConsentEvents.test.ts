import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedStaffUser,
  uniqueName,
  type SeededAdmin,
} from "./helpers";
import {
  recordSmsConsent,
  recordInboundSms,
} from "../src/lib/messaging";
import { db, smsConsentEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests for the SMS consent audit log:
//   - recordSmsConsent() inserts the correct event row (old/new status, source, IP)
//   - GET /api/sms-consent-events  paginated list, phone-key filter, permission gate
//   - GET /api/sms-consent-events/export  CSV download, correct headers + rows
//   - redelivered inbound STOP does not duplicate consent events (idempotency)
// ─────────────────────────────────────────────────────────────────────────────

let admin: SeededAdmin;

const withAuth = (
  t: ReturnType<ReturnType<typeof agent>["get"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const adminGet = (path: string) => withAuth(agent().get(path), admin.cookie);

beforeAll(async () => {
  admin = await seedAdmin();
});

// ─── recordSmsConsent ────────────────────────────────────────────────────────

describe("recordSmsConsent event recording", () => {
  it("inserts a consent event row with null oldStatus on first grant", async () => {
    const phone = `+1555${Date.now().toString().slice(-7)}`;

    const result = await recordSmsConsent({
      phone,
      status: "granted",
      source: "public_booking",
      consentText: "I agree",
      ipAddress: "10.0.0.1",
    });

    expect(result).toBe("granted");

    const events = await db
      .select()
      .from(smsConsentEventsTable)
      .where(eq(smsConsentEventsTable.phone, phone.trim()));

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.oldStatus).toBeNull();
    expect(ev.newStatus).toBe("granted");
    expect(ev.source).toBe("public_booking");
    expect(ev.consentTextShown).toBe("I agree");
    expect(ev.ipAddress).toBe("10.0.0.1");
    expect(ev.phoneKey).toBe(phone.replace(/\D/g, "").slice(-10));
  });

  it("records oldStatus correctly when status changes from granted to revoked", async () => {
    const phone = `+1556${Date.now().toString().slice(-7)}`;

    await recordSmsConsent({ phone, status: "granted", source: "public_booking" });
    await recordSmsConsent({ phone, status: "revoked", source: "reply_stop", ipAddress: "192.168.1.5" });

    const events = await db
      .select()
      .from(smsConsentEventsTable)
      .where(eq(smsConsentEventsTable.phone, phone.trim()))
      .orderBy(smsConsentEventsTable.id);

    expect(events).toHaveLength(2);

    // First event: fresh grant.
    expect(events[0].oldStatus).toBeNull();
    expect(events[0].newStatus).toBe("granted");
    expect(events[0].source).toBe("public_booking");

    // Second event: revocation — oldStatus should be "granted".
    expect(events[1].oldStatus).toBe("granted");
    expect(events[1].newStatus).toBe("revoked");
    expect(events[1].source).toBe("reply_stop");
    expect(events[1].ipAddress).toBe("192.168.1.5");
  });

  it("returns null and writes no event for a number with fewer than 10 digits", async () => {
    const countBefore = (
      await db.select().from(smsConsentEventsTable)
    ).length;

    const result = await recordSmsConsent({
      phone: "1234",
      status: "granted",
      source: "staff",
    });

    expect(result).toBeNull();

    const countAfter = (
      await db.select().from(smsConsentEventsTable)
    ).length;
    expect(countAfter).toBe(countBefore);
  });
});

// ─── GET /api/sms-consent-events (paginated list) ───────────────────────────

describe("GET /api/sms-consent-events", () => {
  it("requires authentication", async () => {
    const res = await agent()
      .get("/api/sms-consent-events")
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(401);
  });

  it("requires the communications permission", async () => {
    const staff = await seedStaffUser(["invoices"], "sms-events-no-perm");
    const res = await withAuth(
      agent().get("/api/sms-consent-events"),
      staff.cookie,
    );
    expect(res.status).toBe(403);
  });

  it("returns a paginated list of events for a communications user", async () => {
    const phone = `+1557${Date.now().toString().slice(-7)}`;
    await recordSmsConsent({ phone, status: "granted", source: "staff" });

    const res = await adminGet("/api/sms-consent-events");
    expect(res.status).toBe(200);
    expect(typeof res.body.total).toBe("number");
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);

    const found = (res.body.events as Array<{ phone: string }>).find(
      (e) => e.phone === phone.trim(),
    );
    expect(found).toBeDefined();
  });

  it("filters by phone number correctly", async () => {
    const phoneA = `+1558${Date.now().toString().slice(-7)}`;
    const phoneB = `+1559${Date.now().toString().slice(-7)}`;
    await recordSmsConsent({ phone: phoneA, status: "granted", source: "staff" });
    await recordSmsConsent({ phone: phoneB, status: "granted", source: "staff" });

    const res = await adminGet(`/api/sms-consent-events?phone=${encodeURIComponent(phoneA)}`);
    expect(res.status).toBe(200);

    const events = res.body.events as Array<{ phone: string; phoneKey: string }>;
    expect(events.every((e) => e.phone === phoneA.trim())).toBe(true);

    const hasPhoneB = events.some((e) => e.phone === phoneB.trim());
    expect(hasPhoneB).toBe(false);
  });

  it("respects the limit and offset query parameters", async () => {
    const phone = `+1560${Date.now().toString().slice(-7)}`;
    // Record three events for the same phone.
    await recordSmsConsent({ phone, status: "granted", source: "staff" });
    await recordSmsConsent({ phone, status: "revoked", source: "reply_stop" });
    await recordSmsConsent({ phone, status: "granted", source: "reply_start" });

    const oneRes = await adminGet(
      `/api/sms-consent-events?phone=${encodeURIComponent(phone)}&limit=1&offset=0`,
    );
    expect(oneRes.status).toBe(200);
    expect(oneRes.body.events).toHaveLength(1);
    expect(oneRes.body.total).toBe(3);

    const offsetRes = await adminGet(
      `/api/sms-consent-events?phone=${encodeURIComponent(phone)}&limit=1&offset=1`,
    );
    expect(offsetRes.status).toBe(200);
    expect(offsetRes.body.events).toHaveLength(1);
    // The two pages must return different event ids.
    expect(offsetRes.body.events[0].id).not.toBe(oneRes.body.events[0].id);
  });
});

// ─── GET /api/sms-consent-events/export (CSV) ───────────────────────────────

describe("GET /api/sms-consent-events/export", () => {
  it("requires authentication", async () => {
    const res = await agent()
      .get("/api/sms-consent-events/export")
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(401);
  });

  it("requires the communications permission", async () => {
    const staff = await seedStaffUser(["invoices"], "sms-export-no-perm");
    const res = await withAuth(
      agent().get("/api/sms-consent-events/export"),
      staff.cookie,
    );
    expect(res.status).toBe(403);
  });

  it("returns a CSV file with the correct Content-Type and Content-Disposition headers", async () => {
    const res = await adminGet("/api/sms-consent-events/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename="consent-audit-all\.csv"/,
    );
  });

  it("CSV contains the expected header row", async () => {
    const res = await adminGet("/api/sms-consent-events/export");
    expect(res.status).toBe(200);

    const lines = (res.text as string).split("\n");
    expect(lines[0]).toBe(
      "id,phoneKey,phone,oldStatus,newStatus,source,consentTextShown,ipAddress,createdAt",
    );
  });

  it("CSV contains a data row for a recorded event", async () => {
    const phone = `+1561${Date.now().toString().slice(-7)}`;
    await recordSmsConsent({
      phone,
      status: "granted",
      source: "public_booking",
      consentText: "I agree to receive SMS",
      ipAddress: "203.0.113.1",
    });

    const res = await adminGet(
      `/api/sms-consent-events/export?phone=${encodeURIComponent(phone)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);

    const lines = (res.text as string).split("\n").filter(Boolean);
    // Header + at least one data row.
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // The data row must include relevant fields.
    const dataRow = lines[1];
    expect(dataRow).toContain("granted");
    expect(dataRow).toContain("public_booking");
    expect(dataRow).toContain("203.0.113.1");
  });

  it("filename includes the phone key when a phone filter is applied", async () => {
    const phone = `+1562${Date.now().toString().slice(-7)}`;
    await recordSmsConsent({ phone, status: "granted", source: "staff" });

    const phoneKey = phone.replace(/\D/g, "").slice(-10);
    const res = await adminGet(
      `/api/sms-consent-events/export?phone=${encodeURIComponent(phone)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain(
      `consent-audit-${phoneKey}.csv`,
    );
  });
});

// ─── Idempotency: redelivered inbound STOP ──────────────────────────────────

describe("inbound STOP keyword idempotency", () => {
  it("does not create a duplicate consent event when the same Twilio MessageSid is redelivered", async () => {
    const fromPhone = `+1563${Date.now().toString().slice(-7)}`;
    const messageSid = `SM${uniqueName("idem")}`;

    // First delivery — should record the message AND the consent revocation.
    const first = await recordInboundSms({
      providerMessageId: messageSid,
      fromPhone,
      toPhone: "+18005550001",
      body: "STOP",
    });

    expect(first.created).toBe(true);

    const eventsAfterFirst = await db
      .select()
      .from(smsConsentEventsTable)
      .where(eq(smsConsentEventsTable.phone, fromPhone.trim()));

    expect(eventsAfterFirst).toHaveLength(1);
    expect(eventsAfterFirst[0].newStatus).toBe("revoked");
    expect(eventsAfterFirst[0].source).toBe("reply_stop");

    // Second delivery of the same MessageSid (simulates Twilio retry) — must
    // be a no-op: the message row already exists (providerMessageId UNIQUE
    // conflict), so recordSmsConsent is NOT called a second time.
    const second = await recordInboundSms({
      providerMessageId: messageSid,
      fromPhone,
      toPhone: "+18005550001",
      body: "STOP",
    });

    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);

    const eventsAfterSecond = await db
      .select()
      .from(smsConsentEventsTable)
      .where(eq(smsConsentEventsTable.phone, fromPhone.trim()));

    // Still exactly one event — the duplicate delivery must not produce a second row.
    expect(eventsAfterSecond).toHaveLength(1);
  });

  it("does not create a duplicate consent event for a redelivered START keyword", async () => {
    const fromPhone = `+1564${Date.now().toString().slice(-7)}`;
    const messageSid = `SM${uniqueName("idem-start")}`;

    const first = await recordInboundSms({
      providerMessageId: messageSid,
      fromPhone,
      toPhone: "+18005550001",
      body: "YES",
    });
    expect(first.created).toBe(true);

    const second = await recordInboundSms({
      providerMessageId: messageSid,
      fromPhone,
      toPhone: "+18005550001",
      body: "YES",
    });
    expect(second.created).toBe(false);

    const events = await db
      .select()
      .from(smsConsentEventsTable)
      .where(eq(smsConsentEventsTable.phone, fromPhone.trim()));

    expect(events).toHaveLength(1);
    expect(events[0].newStatus).toBe("granted");
    expect(events[0].source).toBe("reply_start");
  });

  it("non-keyword inbound messages do not create any consent event", async () => {
    const fromPhone = `+1565${Date.now().toString().slice(-7)}`;
    const messageSid = `SM${uniqueName("no-keyword")}`;

    await recordInboundSms({
      providerMessageId: messageSid,
      fromPhone,
      toPhone: "+18005550001",
      body: "Is my car ready?",
    });

    const events = await db
      .select()
      .from(smsConsentEventsTable)
      .where(eq(smsConsentEventsTable.phone, fromPhone.trim()));

    expect(events).toHaveLength(0);
  });
});
