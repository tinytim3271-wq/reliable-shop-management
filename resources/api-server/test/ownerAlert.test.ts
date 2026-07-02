import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, shopSettingsTable, messagesTable } from "@workspace/db";

/**
 * notifyOwner — the outreach module's owner-alert path used for operational
 * notifications (e.g. an accounting sync that gave up for good).
 *
 * It must respect the same simulated-send boundary as customer outreach: a real
 * email leaves ONLY when the live provider is connected AND a from/owner address
 * resolves; otherwise it is inert. It must never throw, so a background caller
 * can rely on it. The email provider module is mocked so no real Resend call is
 * made and the configured/unconfigured branches can both be exercised.
 *
 * When a channel genuinely fails (live provider connected but delivery did not
 * succeed), a row is recorded in the messages outbox (source="system",
 * audience="owner") so staff have a visible record. Inert/simulated paths do
 * not produce outbox rows.
 */

const sendEmail = vi.fn();
const isEmailProviderConfigured = vi.fn();
const sendSms = vi.fn();
const isSmsProviderConfigured = vi.fn();

vi.mock("../src/lib/email", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/email")>("../src/lib/email");
  return {
    ...actual,
    isEmailProviderConfigured: () => isEmailProviderConfigured(),
    sendEmail: (...args: unknown[]) => sendEmail(...args),
  };
});

vi.mock("../src/lib/sms", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/sms")>("../src/lib/sms");
  return {
    ...actual,
    isSmsProviderConfigured: () => isSmsProviderConfigured(),
    sendSms: (...args: unknown[]) => sendSms(...args),
  };
});

import { notifyOwner } from "../src/lib/messaging";

async function setSettings(overrides: {
  email?: string | null;
  phone?: string | null;
  ownerAlertChannel?: string;
}): Promise<void> {
  const values = {
    id: 1,
    email: "owner@reliable.example",
    phone: null as string | null,
    shopName: "Reliable Automotive",
    ownerAlertChannel: "email",
    ...overrides,
  };
  await db
    .insert(shopSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: shopSettingsTable.id, set: values });
}

async function countSystemRows(): Promise<number> {
  const rows = await db
    .select()
    .from(messagesTable)
    .then((r) => r.filter((m) => m.source === "system"));
  return rows.length;
}

beforeEach(async () => {
  sendEmail.mockReset();
  isEmailProviderConfigured.mockReset();
  sendSms.mockReset();
  isSmsProviderConfigured.mockReset();
  // Default to no live SMS provider so unrelated cases stay inert/simulated.
  isSmsProviderConfigured.mockResolvedValue(false);
  await setSettings({});
  // Start each test with a clean outbox for system rows.
  await db.delete(messagesTable);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("notifyOwner inert/live boundary", () => {
  it("is inert (simulated) when no email provider is configured", async () => {
    isEmailProviderConfigured.mockResolvedValue(false);
    const out = await notifyOwner({ subject: "s", body: "b" });
    expect(out.delivered).toBe(false);
    expect(out.failed).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    // Inert path — no outbox row.
    expect(await countSystemRows()).toBe(0);
  });

  it("delivers to the owner email when a live provider is configured", async () => {
    isEmailProviderConfigured.mockResolvedValue(true);
    sendEmail.mockResolvedValue({ id: "resend-123" });
    const out = await notifyOwner({ subject: "s", body: "b" });
    expect(out.delivered).toBe(true);
    expect(out.failed).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0] as { to: string; from: string };
    expect(arg.to).toBe("owner@reliable.example");
    expect(arg.from).toBe("owner@reliable.example");
    // Successful delivery — no failure outbox row.
    expect(await countSystemRows()).toBe(0);
  });

  it("stays inert (does not throw) when delivery fails and records a failure row", async () => {
    isEmailProviderConfigured.mockResolvedValue(true);
    sendEmail.mockRejectedValue(new Error("provider down"));
    const out = await notifyOwner({ subject: "Alert subject", body: "alert body" });
    expect(out.delivered).toBe(false);
    expect(out.failed).toBe(true);
    // A system row is recorded so staff will notice the failure.
    const rows = await db.select().from(messagesTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("system");
    expect(rows[0].audience).toBe("owner");
    expect(rows[0].status).toBe("failed");
    expect(rows[0].channel).toBe("email");
    expect(rows[0].subject).toBe("Alert subject");
    expect(rows[0].deliveryNote).toMatch(/delivery failed/i);
  });
});

describe("notifyOwner channel preference", () => {
  it("does not send email when the owner prefers SMS only", async () => {
    isEmailProviderConfigured.mockResolvedValue(true);
    sendEmail.mockResolvedValue({ id: "resend-123" });
    await setSettings({ ownerAlertChannel: "sms", phone: "+15551234567" });

    const out = await notifyOwner({ subject: "s", body: "b" });

    // SMS has no live provider yet, so it simulates and never touches email.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(out.delivered).toBe(false);
    expect(out.failed).toBe(false);
    expect(out.channels).toHaveLength(1);
    expect(out.channels[0].channel).toBe("sms");
    expect(out.channels[0].toAddress).toBe("+15551234567");
    expect(out.toAddress).toBe("+15551234567");
    expect(await countSystemRows()).toBe(0);
  });

  it("explains when SMS is preferred but no phone is configured", async () => {
    await setSettings({ ownerAlertChannel: "sms", phone: null });

    const out = await notifyOwner({ subject: "s", body: "b" });

    expect(out.delivered).toBe(false);
    expect(out.failed).toBe(false);
    expect(out.channels[0].channel).toBe("sms");
    expect(out.channels[0].note).toMatch(/phone/i);
    // No-phone path is not a live-provider failure, no outbox row.
    expect(await countSystemRows()).toBe(0);
  });

  it("attempts both channels when the owner prefers both", async () => {
    isEmailProviderConfigured.mockResolvedValue(true);
    sendEmail.mockResolvedValue({ id: "resend-123" });
    await setSettings({ ownerAlertChannel: "both", phone: "+15551234567" });

    const out = await notifyOwner({ subject: "s", body: "b" });

    // Email delivers live; SMS simulates. Overall delivered is true because at
    // least one channel left for real.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(out.delivered).toBe(true);
    expect(out.failed).toBe(false);
    expect(out.channels.map((c) => c.channel)).toEqual(["email", "sms"]);
    expect(out.channels.find((c) => c.channel === "email")?.delivered).toBe(true);
    expect(out.channels.find((c) => c.channel === "sms")?.delivered).toBe(false);
  });

  it("sends a real text when SMS is preferred and Twilio is connected", async () => {
    isSmsProviderConfigured.mockResolvedValue(true);
    sendSms.mockResolvedValue({ id: "SM_test_123" });
    await setSettings({ ownerAlertChannel: "sms", phone: "+15551234567" });

    const out = await notifyOwner({ subject: "s", body: "Sync failed" });

    expect(sendSms).toHaveBeenCalledTimes(1);
    const arg = sendSms.mock.calls[0][0] as { to: string; body: string };
    expect(arg.to).toBe("+15551234567");
    expect(arg.body).toBe("Sync failed");
    expect(out.delivered).toBe(true);
    expect(out.failed).toBe(false);
    expect(out.channels[0].channel).toBe("sms");
    expect(out.channels[0].delivered).toBe(true);
    expect(out.channels[0].note).toMatch(/Twilio/);
    expect(await countSystemRows()).toBe(0);
  });

  it("stays inert (does not throw) when the live SMS send fails and records a failure row", async () => {
    isSmsProviderConfigured.mockResolvedValue(true);
    sendSms.mockRejectedValue(new Error("twilio down"));
    await setSettings({ ownerAlertChannel: "sms", phone: "+15551234567" });

    const out = await notifyOwner({ subject: "SMS alert", body: "b" });

    expect(out.delivered).toBe(false);
    expect(out.failed).toBe(true);
    expect(out.channels[0].channel).toBe("sms");
    // Failure row recorded.
    const rows = await db.select().from(messagesTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("system");
    expect(rows[0].audience).toBe("owner");
    expect(rows[0].status).toBe("failed");
    expect(rows[0].channel).toBe("sms");
    expect(rows[0].subject).toBe("SMS alert");
    expect(rows[0].toAddress).toBe("+15551234567");
    expect(rows[0].deliveryNote).toMatch(/delivery failed/i);
  });

  it("delivers both channels for real when both providers are connected", async () => {
    isEmailProviderConfigured.mockResolvedValue(true);
    sendEmail.mockResolvedValue({ id: "resend-123" });
    isSmsProviderConfigured.mockResolvedValue(true);
    sendSms.mockResolvedValue({ id: "SM_test_456" });
    await setSettings({ ownerAlertChannel: "both", phone: "+15551234567" });

    const out = await notifyOwner({ subject: "s", body: "b" });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(out.delivered).toBe(true);
    expect(out.failed).toBe(false);
    expect(out.channels.find((c) => c.channel === "sms")?.delivered).toBe(true);
    expect(out.channels.find((c) => c.channel === "email")?.delivered).toBe(true);
    expect(await countSystemRows()).toBe(0);
  });

  it("treats a legacy/unknown channel value as email-only", async () => {
    isEmailProviderConfigured.mockResolvedValue(true);
    sendEmail.mockResolvedValue({ id: "resend-123" });
    await setSettings({ ownerAlertChannel: "carrier-pigeon" });

    const out = await notifyOwner({ subject: "s", body: "b" });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(out.channels).toHaveLength(1);
    expect(out.channels[0].channel).toBe("email");
  });

  it("records one failure row per failed channel when both fail", async () => {
    isEmailProviderConfigured.mockResolvedValue(true);
    sendEmail.mockRejectedValue(new Error("email down"));
    isSmsProviderConfigured.mockResolvedValue(true);
    sendSms.mockRejectedValue(new Error("sms down"));
    await setSettings({ ownerAlertChannel: "both", phone: "+15551234567" });

    const out = await notifyOwner({ subject: "Both failed", body: "b" });

    expect(out.delivered).toBe(false);
    expect(out.failed).toBe(true);
    const rows = await db.select().from(messagesTable);
    expect(rows).toHaveLength(2);
    const channels = rows.map((r) => r.channel).sort();
    expect(channels).toEqual(["email", "sms"]);
    rows.forEach((r) => {
      expect(r.source).toBe("system");
      expect(r.audience).toBe("owner");
      expect(r.status).toBe("failed");
    });
  });
});
