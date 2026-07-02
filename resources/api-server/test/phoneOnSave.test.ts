import { beforeAll, describe, expect, it } from "vitest";
import { agent, seedAdmin, uniqueName, type SeededAdmin } from "./helpers";

// Customer and shop-settings save paths normalize phone numbers toward E.164 so
// real texts (Twilio) can actually be delivered, and reject numbers that cannot
// be normalized with a clear 400 instead of silently storing something Twilio
// will refuse later.
describe("phone normalization on save", () => {
  let admin: SeededAdmin;

  beforeAll(async () => {
    admin = await seedAdmin();
  });

  describe("customers", () => {
    it("normalizes a loosely-entered phone on create", async () => {
      const res = await agent()
        .post("/api/customers")
        .set("Cookie", admin.cookie)
        .send({ name: uniqueName("Phone Customer"), phone: "(555) 123-4567" });
      expect(res.status).toBe(201);
      expect(res.body.phone).toBe("+15551234567");
    });

    it("rejects an un-normalizable phone on create", async () => {
      const res = await agent()
        .post("/api/customers")
        .set("Cookie", admin.cookie)
        .send({ name: uniqueName("Bad Phone Customer"), phone: "555-1234" });
      expect(res.status).toBe(400);
    });

    it("normalizes a phone on update and clears it on empty", async () => {
      const created = await agent()
        .post("/api/customers")
        .set("Cookie", admin.cookie)
        .send({ name: uniqueName("Update Phone Customer") });
      expect(created.status).toBe(201);
      const id = created.body.id;

      const update = await agent()
        .patch(`/api/customers/${id}`)
        .set("Cookie", admin.cookie)
        .send({ phone: "1-555-987-6543" });
      expect(update.status).toBe(200);
      expect(update.body.phone).toBe("+15559876543");

      const cleared = await agent()
        .patch(`/api/customers/${id}`)
        .set("Cookie", admin.cookie)
        .send({ phone: "" });
      expect(cleared.status).toBe(200);
      expect(cleared.body.phone).toBeNull();
    });

    it("rejects an un-normalizable phone on update", async () => {
      const created = await agent()
        .post("/api/customers")
        .set("Cookie", admin.cookie)
        .send({ name: uniqueName("Bad Update Customer") });
      const id = created.body.id;

      const update = await agent()
        .patch(`/api/customers/${id}`)
        .set("Cookie", admin.cookie)
        .send({ phone: "abc" });
      expect(update.status).toBe(400);
    });
  });

  describe("shop settings", () => {
    it("normalizes the shop phone on save and rejects a bad one", async () => {
      const put = await agent()
        .put("/api/settings")
        .set("X-Forwarded-Proto", "https")
        .set("Cookie", admin.cookie)
        .send({ phone: "(555) 222-3333" });
      expect(put.status).toBe(200);
      expect(put.body.phone).toBe("+15552223333");

      const bad = await agent()
        .put("/api/settings")
        .set("X-Forwarded-Proto", "https")
        .set("Cookie", admin.cookie)
        .send({ phone: "12" });
      expect(bad.status).toBe(400);
    });
  });
});
