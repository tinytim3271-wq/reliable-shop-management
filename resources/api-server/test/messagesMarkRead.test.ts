import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, messagesTable } from "@workspace/db";
import { agent, seedAdmin, uniqueName } from "./helpers";

// POST /api/messages/mark-read stamps readAt on the given inbound replies so the
// Inbox unread badge stays meaningful. It must only touch inbound, still-unread
// rows, must leave outbound messages alone, and must be idempotent.

async function seedInbound(opts: { read?: boolean } = {}): Promise<number> {
  const [row] = await db
    .insert(messagesTable)
    .values({
      channel: "sms",
      direction: "inbound",
      category: "other",
      audience: "customer",
      status: "received",
      source: "customer",
      body: "customer reply",
      toAddress: uniqueName("+1555").replace(/-/g, ""),
      providerMessageId: uniqueName("SMmr").replace(/-/g, ""),
      readAt: opts.read ? new Date().toISOString() : null,
    })
    .returning();
  return row.id;
}

async function seedOutbound(): Promise<number> {
  const [row] = await db
    .insert(messagesTable)
    .values({
      channel: "sms",
      direction: "outbound",
      category: "other",
      audience: "customer",
      status: "sent",
      source: "staff",
      body: "shop text",
      toAddress: uniqueName("+1555").replace(/-/g, ""),
    })
    .returning();
  return row.id;
}

describe("POST /api/messages/mark-read", () => {
  it("stamps readAt on unread inbound messages and returns them", async () => {
    const { cookie } = await seedAdmin();
    const a = await seedInbound();
    const b = await seedInbound();

    const res = await agent()
      .post("/api/messages/mark-read")
      .set("Cookie", cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ ids: [a, b] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const id of [a, b]) {
      const [row] = await db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.id, id));
      expect(row.readAt).not.toBeNull();
    }
  });

  it("never marks outbound messages read", async () => {
    const { cookie } = await seedAdmin();
    const out = await seedOutbound();

    const res = await agent()
      .post("/api/messages/mark-read")
      .set("Cookie", cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ ids: [out] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
    const [row] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, out));
    expect(row.readAt).toBeNull();
  });

  it("is idempotent: an already-read row is not returned again", async () => {
    const { cookie } = await seedAdmin();
    const id = await seedInbound({ read: true });

    const res = await agent()
      .post("/api/messages/mark-read")
      .set("Cookie", cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ ids: [id] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("rejects an empty id list", async () => {
    const { cookie } = await seedAdmin();
    const res = await agent()
      .post("/api/messages/mark-read")
      .set("Cookie", cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ ids: [] });
    expect(res.status).toBe(400);
  });
});
