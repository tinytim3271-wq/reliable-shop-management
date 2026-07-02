import { beforeAll, describe, expect, it } from "vitest";
import { db, customersTable } from "@workspace/db";
import { agent, seedAdmin, seedStaffUser, uniqueName, type SeededAdmin } from "./helpers";

// The outreach/messaging surface is gated by the `communications` permission.
// Sending is simulated (no live email/SMS provider), and every message — staff-
// or AI-authored — must pass through the draft -> approved -> sent gate.

let admin: SeededAdmin;
let customerId: number;

beforeAll(async () => {
  admin = await seedAdmin();
  const [customer] = await db
    .insert(customersTable)
    .values({
      name: uniqueName("Outreach Customer"),
      email: "outreach@example.com",
      phone: "555-0100",
    })
    .returning();
  customerId = customer.id;
});

describe("messages permission boundary", () => {
  it("rejects a staff user without the communications permission", async () => {
    const staff = await seedStaffUser(["workOrders"], "no-comms");
    const res = await agent()
      .get("/api/messages")
      .set("Cookie", staff.cookie);
    expect(res.status).toBe(403);
  });

  it("allows a staff user with the communications permission", async () => {
    const staff = await seedStaffUser(["communications"], "comms");
    const res = await agent()
      .get("/api/messages")
      .set("Cookie", staff.cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("message draft -> approve -> send (simulated)", () => {
  it("resolves the recipient from the linked customer and runs the full gate", async () => {
    // Create a draft for a customer with no explicit address — the recipient
    // email should be filled in from the customer record.
    const create = await agent()
      .post("/api/messages")
      .set("Cookie", admin.cookie)
      .send({
        channel: "email",
        category: "reminder",
        audience: "customer",
        customerId,
        subject: "Time for your service",
        body: "Hi, your vehicle is due for a checkup.",
      });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe("draft");
    expect(create.body.source).toBe("staff");
    expect(create.body.toAddress).toBe("outreach@example.com");
    const id = create.body.id;

    // A draft cannot be sent before approval.
    const earlySend = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(earlySend.status).toBe(409);

    // Approve records the approver and flips status to approved.
    const approve = await agent()
      .post(`/api/messages/${id}/approve`)
      .set("Cookie", admin.cookie);
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("approved");
    expect(approve.body.approvedByUserId).toBe(admin.id);

    // Approved messages are locked against edits.
    const editLocked = await agent()
      .patch(`/api/messages/${id}`)
      .set("Cookie", admin.cookie)
      .send({ body: "changed" });
    expect(editLocked.status).toBe(409);

    // Send is simulated: status flips to sent and a delivery note is recorded.
    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(200);
    expect(send.body.status).toBe("sent");
    expect(send.body.sentAt).toBeTruthy();
    expect(send.body.deliveryNote).toMatch(/[Ss]imulated/);
  });

  it("sends an SMS through the full gate, simulated when no provider is connected", async () => {
    // No connectors proxy is bound in the test env, so the SMS channel must fall
    // back to the simulated delivery note rather than attempting a live send.
    const create = await agent()
      .post("/api/messages")
      .set("Cookie", admin.cookie)
      .send({
        channel: "sms",
        category: "reminder",
        audience: "customer",
        customerId,
        body: "Your vehicle is ready for pickup.",
      });
    expect(create.status).toBe(201);
    // The recipient is resolved from the customer's phone for the SMS channel.
    expect(create.body.toAddress).toBe("555-0100");
    const id = create.body.id;

    await agent()
      .post(`/api/messages/${id}/approve`)
      .set("Cookie", admin.cookie)
      .expect(200);

    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(200);
    expect(send.body.status).toBe("sent");
    expect(send.body.deliveryNote).toMatch(/[Ss]imulated/);
  });

  it("refuses to send when no recipient address can be resolved", async () => {
    const create = await agent()
      .post("/api/messages")
      .set("Cookie", admin.cookie)
      .send({
        channel: "email",
        category: "marketing",
        audience: "lead",
        toName: "Walk-in Lead",
        body: "Spring promo!",
      });
    expect(create.status).toBe(201);
    expect(create.body.toAddress).toBeNull();
    const id = create.body.id;

    await agent()
      .post(`/api/messages/${id}/approve`)
      .set("Cookie", admin.cookie)
      .expect(200);

    const send = await agent()
      .post(`/api/messages/${id}/send`)
      .set("Cookie", admin.cookie);
    expect(send.status).toBe(409);
  });

  it("canceled messages can no longer be sent", async () => {
    const create = await agent()
      .post("/api/messages")
      .set("Cookie", admin.cookie)
      .send({
        channel: "sms",
        category: "review",
        audience: "customer",
        customerId,
        body: "How did we do? Leave us a review.",
      });
    const id = create.body.id;

    const cancel = await agent()
      .post(`/api/messages/${id}/cancel`)
      .set("Cookie", admin.cookie);
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("canceled");

    const approve = await agent()
      .post(`/api/messages/${id}/approve`)
      .set("Cookie", admin.cookie);
    expect(approve.status).toBe(409);
  });

  it("filters the outbox by status", async () => {
    const res = await agent()
      .get("/api/messages")
      .query({ status: "sent" })
      .set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const m of res.body) expect(m.status).toBe("sent");
  });
});

describe("message templates CRUD", () => {
  it("creates, lists, updates, and deletes a template", async () => {
    const name = uniqueName("Service reminder");
    const create = await agent()
      .post("/api/message-templates")
      .set("Cookie", admin.cookie)
      .send({
        name,
        channel: "email",
        category: "reminder",
        subject: "Service due",
        body: "Hi {{customerName}}, your service is due.",
      });
    expect(create.status).toBe(201);
    const id = create.body.id;

    const list = await agent()
      .get("/api/message-templates")
      .set("Cookie", admin.cookie);
    expect(list.status).toBe(200);
    expect(list.body.some((t: { id: number }) => t.id === id)).toBe(true);

    const update = await agent()
      .patch(`/api/message-templates/${id}`)
      .set("Cookie", admin.cookie)
      .send({ body: "Updated body" });
    expect(update.status).toBe(200);
    expect(update.body.body).toBe("Updated body");

    const del = await agent()
      .delete(`/api/message-templates/${id}`)
      .set("Cookie", admin.cookie);
    expect(del.status).toBe(204);
  });
});
