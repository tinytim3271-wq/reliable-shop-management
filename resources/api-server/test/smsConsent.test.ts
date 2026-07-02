import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, customersTable, shopSettingsTable } from "@workspace/db";
import { agent, seedAdmin, uniqueName, type SeededAdmin } from "./helpers";
import {
  detectSmsConsentKeyword,
  getSmsConsentStatus,
  recordInboundSms,
  recordSmsConsent,
} from "../src/lib/messaging";

// The live-SMS send path checks isSmsProviderConfigured(); we force it true so
// the outbound consent gate is exercised (it would otherwise simulate). sendSms
// is mocked so no real Twilio call is made. The mock is scoped to this file.
const sendSms = vi.fn();
const isSmsProviderConfigured = vi.fn();

vi.mock("../src/lib/sms", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/sms")>("../src/lib/sms");
  return {
    ...actual,
    isSmsProviderConfigured: () => isSmsProviderConfigured(),
    sendSms: (...args: unknown[]) => sendSms(...args),
  };
});

let admin: SeededAdmin;

beforeAll(async () => {
  admin = await seedAdmin();
});

beforeEach(() => {
  sendSms.mockReset();
  sendSms.mockResolvedValue({ id: "SM_consent_test" });
  isSmsProviderConfigured.mockReset();
  isSmsProviderConfigured.mockResolvedValue(true);
});

// Find the first bookable slot in a future window so the booking does not depend
// on which weekday the dates land on.
async function firstAvailableSlot(): Promise<string> {
  const from = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const to = new Date(Date.now() + 27 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const res = await agent().get("/api/public/availability").query({ from, to });
  expect(res.status).toBe(200);
  for (const day of res.body as Array<{
    open: boolean;
    slots: Array<{ start: string; available: boolean }>;
  }>) {
    if (!day.open) continue;
    const slot = day.slots.find((s) => s.available);
    if (slot) return slot.start;
  }
  throw new Error("no available slot found");
}

describe("detectSmsConsentKeyword (pure)", () => {
  it("treats whole-body STOP keywords (any case) as a revoke", () => {
    for (const body of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "CANCEL", "QUIT", "END"]) {
      expect(detectSmsConsentKeyword(body)).toBe("revoke");
    }
  });

  it("treats whole-body START keywords as a grant", () => {
    for (const body of ["START", "yes", "UNSTOP", "continue"]) {
      expect(detectSmsConsentKeyword(body)).toBe("grant");
    }
  });

  it("ignores ordinary replies that merely contain a keyword", () => {
    expect(detectSmsConsentKeyword("Yes, see you then")).toBeNull();
    expect(detectSmsConsentKeyword("please stop by at noon")).toBeNull();
    expect(detectSmsConsentKeyword("")).toBeNull();
    expect(detectSmsConsentKeyword(null)).toBeNull();
  });
});

describe("public booking SMS consent capture", () => {
  it("records a granted consent for the phone when the box is checked", async () => {
    const start = await firstAvailableSlot();
    const phone = "555-700-" + Math.floor(1000 + Math.random() * 8999);

    const res = await agent().post("/api/public/booking").send({
      customerName: "Consent Booker",
      phone,
      scheduledAt: start,
      smsConsent: true,
    });
    expect(res.status).toBe(201);

    expect(await getSmsConsentStatus(phone)).toBe("granted");
  });

  it("records no consent when the box is not checked", async () => {
    const start = await firstAvailableSlot();
    const phone = "555-701-" + Math.floor(1000 + Math.random() * 8999);

    const res = await agent().post("/api/public/booking").send({
      customerName: "No Consent Booker",
      phone,
      scheduledAt: start,
      smsConsent: false,
    });
    expect(res.status).toBe(201);

    expect(await getSmsConsentStatus(phone)).toBeNull();
  });
});

describe("inbound STOP / START toggles consent", () => {
  it("revokes on STOP and re-grants on START, keyed by the last 10 digits", async () => {
    const phone = "+1 (555) 802-" + Math.floor(1000 + Math.random() * 8999);

    await recordInboundSms({
      providerMessageId: uniqueName("SMstop"),
      fromPhone: phone,
      toPhone: "+15559990000",
      body: "STOP",
    });
    expect(await getSmsConsentStatus(phone)).toBe("revoked");

    await recordInboundSms({
      providerMessageId: uniqueName("SMstart"),
      fromPhone: phone,
      toPhone: "+15559990000",
      body: "START",
    });
    expect(await getSmsConsentStatus(phone)).toBe("granted");
  });
});

describe("outbound live SMS honors opt-out", () => {
  async function createApprovedSms(customerId: number) {
    const create = await agent()
      .post("/api/messages")
      .set("Cookie", admin.cookie)
      .send({
        channel: "sms",
        category: "reminder",
        audience: "customer",
        customerId,
        body: "Your car is ready for pickup.",
      });
    expect(create.status).toBe(201);
    await agent()
      .post(`/api/messages/${create.body.id}/approve`)
      .set("Cookie", admin.cookie)
      .expect(200);
    return create.body.id as number;
  }

  it("blocks a live send to a revoked number, then allows it after opt back in", async () => {
    await db
      .insert(shopSettingsTable)
      .values({ id: 1, shopName: "Reliable Automotive" })
      .onConflictDoNothing();
    const phone = "+1555803" + Math.floor(1000 + Math.random() * 8999);
    const [customer] = await db
      .insert(customersTable)
      .values({ name: uniqueName("OptOut Customer"), phone })
      .returning();

    await recordSmsConsent({ phone, status: "revoked", source: "reply_stop" });

    const blockedId = await createApprovedSms(customer.id);
    const blocked = await agent()
      .post(`/api/messages/${blockedId}/send`)
      .set("Cookie", admin.cookie);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/opted out/i);
    expect(sendSms).not.toHaveBeenCalled();

    // Opt back in -> the same recipient can now receive a live text.
    await recordSmsConsent({ phone, status: "granted", source: "reply_start" });
    const allowedId = await createApprovedSms(customer.id);
    const allowed = await agent()
      .post(`/api/messages/${allowedId}/send`)
      .set("Cookie", admin.cookie);
    expect(allowed.status).toBe(200);
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("does not block numbers that have no consent record on file", async () => {
    const phone = "+1555804" + Math.floor(1000 + Math.random() * 8999);
    const [customer] = await db
      .insert(customersTable)
      .values({ name: uniqueName("Legacy Customer"), phone })
      .returning();

    const id = await createApprovedSms(customer.id);
    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(200);
    expect(sendSms).toHaveBeenCalledTimes(1);
  });
});
