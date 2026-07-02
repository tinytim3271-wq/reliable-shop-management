import { beforeAll, describe, expect, it } from "vitest";
import { agent, seedAdmin, uniqueName, type SeededAdmin } from "./helpers";

/**
 * The voice assistant's display name is shop-configurable via PUT /settings.
 * Because that name doubles as the spoken wake word, the server must reject a
 * blank-after-trim value (Zod's min(1) alone lets whitespace through) and must
 * persist the trimmed value so a round-trip returns exactly what staff intended.
 *
 * Settings is a singleton row (id=1) shared across the test-run database, so
 * these tests only ever touch `assistantName` and never assert on other fields.
 */
describe("shop settings assistant name", () => {
  let admin: SeededAdmin;

  beforeAll(async () => {
    admin = await seedAdmin();
  });

  it("round-trips a custom assistant name and trims surrounding whitespace", async () => {
    const name = uniqueName("Jarvis");
    const put = await agent()
      .put("/api/settings")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", admin.cookie)
      .send({ assistantName: `  ${name}  ` });
    expect(put.status).toBe(200);
    expect(put.body.assistantName).toBe(name);

    const get = await agent()
      .get("/api/settings")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", admin.cookie);
    expect(get.status).toBe(200);
    expect(get.body.assistantName).toBe(name);
  });

  it("rejects a whitespace-only assistant name", async () => {
    const res = await agent()
      .put("/api/settings")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", admin.cookie)
      .send({ assistantName: "   " });
    expect(res.status).toBe(400);
  });
});
