import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, shopSettingsTable } from "@workspace/db";
import { agent, seedAdmin, uniqueName, type SeededAdmin } from "./helpers";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { EmailError } from "../src/lib/email";

// Live-email delivery path for the outreach send handler. The route imports the
// provider helpers from "../lib/email"; we mock that module so no real Resend
// call is made. isEmailProviderConfigured() is forced true here to exercise the
// real-delivery branch (it returns false in this environment otherwise, which is
// why the rest of the suite simulates). vi.mock is hoisted above the imports.
// Each test file gets its own DB and module registry, so this mock is scoped to
// this file only.
const sendEmail = vi.fn();
const isEmailProviderConfigured = vi.fn();

vi.mock("../src/lib/email", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/email")>("../src/lib/email");
  return {
    ...actual,
    isEmailProviderConfigured: () => isEmailProviderConfigured(),
    sendEmail: (...args: unknown[]) => sendEmail(...args),
  };
});

let admin: SeededAdmin;
let customerId: number;

beforeAll(async () => {
  admin = await seedAdmin();
  // Shop settings provide the verified "from" address for real sends.
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
      name: uniqueName("Live Email Customer"),
      email: "recipient@example.com",
      phone: "555-0199",
    })
    .returning();
  customerId = customer.id;
});

beforeEach(() => {
  sendEmail.mockReset();
  isEmailProviderConfigured.mockReset();
  isEmailProviderConfigured.mockResolvedValue(true);
});

async function createApprovedEmail(overrides: Record<string, unknown> = {}) {
  const create = await agent()
    .post("/api/messages")
    .set("Cookie", admin.cookie)
    .send({
      channel: "email",
      category: "invoice",
      audience: "customer",
      customerId,
      subject: "Your service report",
      body: "Please find your report attached.",
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

describe("outreach live email delivery", () => {
  it("delivers through the provider and records a real delivery note", async () => {
    sendEmail.mockResolvedValue({ id: "re_test_123" });
    const id = await createApprovedEmail();

    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(200);
    expect(send.body.status).toBe("sent");
    expect(send.body.deliveryNote).toMatch(/Resend/);
    expect(send.body.deliveryNote).toContain("re_test_123");

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0];
    expect(arg.to).toBe("recipient@example.com");
    expect(arg.from).toBe("shop@reliable.example");
    expect(arg.subject).toBe("Your service report");
    expect(arg.attachments).toBeUndefined();
  });

  it("relays the attachment bytes to the provider", async () => {
    sendEmail.mockResolvedValue({ id: "re_attach_1" });
    vi.spyOn(ObjectStorageService.prototype, "readObjectBytes").mockResolvedValue({
      bytes: Buffer.from("%PDF-1.4 fake report"),
      contentType: "application/pdf",
    });

    const id = await createApprovedEmail({
      attachmentPath: "/objects/uploads/report-001",
      attachmentName: "report.pdf",
      attachmentMimeType: "application/pdf",
    });

    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(200);
    expect(send.body.status).toBe("sent");

    const arg = sendEmail.mock.calls[0][0];
    expect(arg.attachments).toHaveLength(1);
    expect(arg.attachments[0].filename).toBe("report.pdf");
    expect(arg.attachments[0].contentType).toBe("application/pdf");
    expect(Buffer.isBuffer(arg.attachments[0].content)).toBe(true);

    vi.restoreAllMocks();
  });

  it("leaves the message approved and returns 502 when delivery fails", async () => {
    sendEmail.mockRejectedValue(new EmailError("Email provider returned 422"));
    const id = await createApprovedEmail();

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
    // Failure reason persisted so the outbox can surface it and staff can retry.
    expect(get.body.deliveryNote).toMatch(/delivery failed/i);
  });

  it("refuses to send when no from address is configured", async () => {
    await db
      .update(shopSettingsTable)
      .set({ email: null })
      .where(eq(shopSettingsTable.id, 1));
    const id = await createApprovedEmail();

    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(409);
    expect(sendEmail).not.toHaveBeenCalled();

    // Restore for any later assertions.
    await db
      .update(shopSettingsTable)
      .set({ email: "shop@reliable.example" })
      .where(eq(shopSettingsTable.id, 1));
  });

  it("never uses the live provider for SMS even when configured", async () => {
    const create = await agent()
      .post("/api/messages")
      .set("Cookie", admin.cookie)
      .send({
        channel: "sms",
        category: "reminder",
        audience: "customer",
        customerId,
        body: "Your car is ready.",
      });
    const id = create.body.id;
    await agent()
      .post(`/api/messages/${id}/approve`)
      .set("Cookie", admin.cookie)
      .expect(200);

    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(200);
    expect(send.body.deliveryNote).toMatch(/[Ss]imulated/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
