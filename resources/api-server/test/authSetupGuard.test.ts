import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, usersTable } from "@workspace/db";
import { agent } from "./helpers";

// First-run setup protection behavior:
//   - hosted mode (default in tests, APP_RUNTIME unset): defaults to "auto"
//     protection so a fresh internet-facing deployment cannot be claimed by the
//     first visitor without a setup code.
//   - SETUP_SECRET=off: explicitly disables protection (intended for
//     desktop/LAN installs or trusted private environments).
//   - SETUP_SECRET=<code>: requires that exact code.

const validBody = {
  username: "owner",
  password: "supersecret",
  displayName: "Shop Owner",
};

const postSetup = (body: Record<string, unknown>) =>
  agent().post("/api/auth/setup").set("X-Forwarded-Proto", "https").send(body);

describe("first-run setup protection", () => {
  beforeEach(async () => {
    await db.delete(usersTable);
    delete process.env.SETUP_SECRET;
  });

  afterEach(() => {
    delete process.env.SETUP_SECRET;
  });

  it("reports setup is protected by default on hosted deployments (auto mode)", async () => {
    // APP_RUNTIME is unset in the test harness → hosted → defaults to auto protection.
    const res = await agent().get("/api/auth/needs-setup");
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
    expect(res.body.setupProtected).toBe(true);
  });

  it("rejects setup without a code on a fresh hosted deployment", async () => {
    const res = await postSetup(validBody);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SETUP_SECRET_REQUIRED");

    const rows = await db.select().from(usersTable);
    expect(rows.length).toBe(0);
  });

  it("reports setup is open and accepts no code when SETUP_SECRET=off", async () => {
    process.env.SETUP_SECRET = "off";

    const needs = await agent().get("/api/auth/needs-setup");
    expect(needs.body.setupProtected).toBe(false);

    const res = await postSetup(validBody);
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("admin");
  });

  it("reports setup is protected and rejects a missing code when SETUP_SECRET is set", async () => {
    process.env.SETUP_SECRET = "topsecret";

    const needs = await agent().get("/api/auth/needs-setup");
    expect(needs.body.setupProtected).toBe(true);

    const res = await postSetup(validBody);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SETUP_SECRET_REQUIRED");

    const rows = await db.select().from(usersTable);
    expect(rows.length).toBe(0);
  });

  it("rejects a wrong code but accepts the matching one when SETUP_SECRET is set", async () => {
    process.env.SETUP_SECRET = "topsecret";

    const wrong = await postSetup({ ...validBody, setupSecret: "nope-wrong" });
    expect(wrong.status).toBe(403);

    const ok = await postSetup({ ...validBody, setupSecret: "topsecret" });
    expect(ok.status).toBe(201);
    expect(ok.body.role).toBe("admin");
  });
});
