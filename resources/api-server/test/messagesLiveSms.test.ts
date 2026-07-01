import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, customersTable, shopSettingsTable } from "@workspace/db";
import { agent, seedAdmin, uniqueName, type SeededAdmin } from "./helpers";
import { SmsError } from "../src/lib/sms";

// Live-SMS delivery path for the outreach send handler. The route imports the
// provider helpers from "../lib/sms"; we mock that module so no real Twilio call
// is made. isSmsProviderConfigured() is forced true here to exercise the
// real-delivery branch (it returns false in this environment otherwise — no
// connectors proxy is bound — which is why the rest of the suite simulates).
// vi.mock is hoisted above the imports. Each test file gets its own DB and
// module registry, so this mock is scoped to this file only.
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
let customerId: number;

beforeAll(async () => {
  admin = await seedAdmin();
  await db
    .insert(shopSettingsTable)
    .values({ id: 1, email: "shop@reliable.example", shopName: "Reliable Automotive" })
    .onConflictDoUpdate({
      target: shopSettingsTable.id,
      set: { email: "shop@reliable.example", shopName: "Reliable Automotive" },
    });
  const [customer] = await db
    .insert(customersTable)
    .values({
      name: uniqueName("Live SMS Customer"),
      email: "recipient@example.com",
      phone: "+15550100",
    })
    .returning();
  customerId = customer.id;
});

beforeEach(() => {
  sendSms.mockReset();
  isSmsProviderConfigured.mockReset();
  isSmsProviderConfigured.mockResolvedValue(true);
});

async function createApprovedSms(overrides: Record<string, unknown> = {}) {
  const create = await agent()
    .post("/api/messages")
    .set("Cookie", admin.cookie)
    .send({
      channel: "sms",
      category: "reminder",
      audience: "customer",
      customerId,
      body: "Your car is ready for pickup.",
      ...overrides,
    });
  expect(create.status).toBe(201);
  const id = create.body.id;
  await agent()
    .post(`/api/messages/${id}/approve`)
    .set("Cookie", admin.cookie)
    .expect(200);
  return id;
}

describe("outreach live SMS delivery", () => {
  it("delivers through Twilio and records a real delivery note", async () => {
    sendSms.mockResolvedValue({ id: "SM_test_123" });
    const id = await createApprovedSms();

    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(200);
    expect(send.body.status).toBe("sent");
    expect(send.body.sentAt).toBeTruthy();
    expect(send.body.deliveryNote).toMatch(/Twilio/);
    expect(send.body.deliveryNote).toContain("SM_test_123");

    expect(sendSms).toHaveBeenCalledTimes(1);
    const arg = sendSms.mock.calls[0][0] as { to: string; body: string };
    expect(arg.to).toBe("+15550100");
    expect(arg.body).toBe("Your car is ready for pickup.");
  });

  it("leaves the message approved and returns 502 when delivery fails", async () => {
    sendSms.mockRejectedValue(new SmsError("SMS provider returned 422", 502));
    const id = await createApprovedSms();

    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(502);
    expect(send.body.error).toMatch(/delivery failed/i);

    // Still approved (and therefore retryable), not sent.
    const get = await agent()
      .get(`/api/messages/${id}`)
      .set("Cookie", admin.cookie);
    expect(get.body.status).toBe("approved");
    expect(get.body.sentAt).toBeNull();
    // Failure reason persisted so the outbox can surface it.
    expect(get.body.deliveryNote).toMatch(/delivery failed/i);
  });

  it("clears the failure note when a retry succeeds", async () => {
    // First attempt fails.
    sendSms.mockRejectedValueOnce(new SmsError("SMS provider returned 503", 502));
    const id = await createApprovedSms();
    await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie)
      .expect(502);

    // Second attempt succeeds.
    sendSms.mockResolvedValue({ id: "SM_retry_ok" });
    const retry = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("sent");
    expect(retry.body.deliveryNote).toMatch(/Twilio/);
    expect(retry.body.deliveryNote).toContain("SM_retry_ok");
  });

  it("propagates a non-default SmsError status (e.g. 504 timeout) and stays retryable", async () => {
    sendSms.mockRejectedValue(new SmsError("SMS provider timed out.", 504));
    const id = await createApprovedSms();

    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(504);

    const get = await agent()
      .get(`/api/messages/${id}`)
      .set("Cookie", admin.cookie);
    expect(get.body.status).toBe("approved");
    expect(get.body.sentAt).toBeNull();
  });

  it("simulates instead of sending when no SMS provider is connected", async () => {
    isSmsProviderConfigured.mockResolvedValue(false);
    const id = await createApprovedSms();

    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(200);
    expect(send.body.deliveryNote).toMatch(/[Ss]imulated/);
    expect(sendSms).not.toHaveBeenCalled();
  });
});
