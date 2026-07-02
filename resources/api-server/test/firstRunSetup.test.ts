import { describe, it, expect, afterEach } from "vitest";
import type { Response } from "supertest";
import { db, usersTable, licensesTable, storeOrdersTable } from "@workspace/db";
import { agent } from "./helpers";

// The first-run onboarding wizard has a hard ordering constraint: the owner
// account must be created BEFORE the license is activated, because /license/*
// sits behind the session authGate. Activating before an owner exists was a
// real bug (401 on a fresh install). These tests walk the bootstrap path from a
// zero-users database so that ordering — and the fail-open first-run setup that
// lets a brand-new install bootstrap at all — cannot silently regress.

// Pull the rss.sid session cookie out of a Set-Cookie header so subsequent
// requests run as the just-created owner. The cookie is Secure+SameSite=None,
// so it is only emitted when the request looks like HTTPS (X-Forwarded-Proto).
function extractSid(res: Response): string {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const sid = cookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("rss.sid="));
  if (!sid) throw new Error("no session cookie returned from setup");
  return sid;
}

describe("first-run setup bootstrap flow", () => {
  // The setup route reads SETUP_SECRET live on every request. The suite default
  // leaves it unset (the normal installable build), which is the configuration
  // these tests exercise; guard against any leak from a sibling test by clearing
  // and restoring it around each case.
  const originalSecret = process.env.SETUP_SECRET;
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SETUP_SECRET;
    else process.env.SETUP_SECRET = originalSecret;
  });

  it("reports that a fresh database needs setup", async () => {
    const res = await agent().get("/api/auth/needs-setup");
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
  });

  it("rejects license activation before an owner account exists (ordering invariant)", async () => {
    // /license/activate is mounted behind authGate, so with no session it is
    // unreachable. This is exactly why the wizard creates the owner first: the
    // license step needs a logged-in session to even run.
    const res = await agent()
      .post("/api/license/activate")
      .set("X-Forwarded-Proto", "https")
      .send({
        licenseKey: "RSS-AAAA-BBBB-CCCC-DDDD",
        deviceFingerprint: "fp-before-owner",
        deviceName: "Premature Device",
      });
    expect(res.status).toBe(401);

    // The rejected activation must not have created any state.
    const users = await db.select().from(usersTable);
    expect(users).toHaveLength(0);
    const licenses = await db.select().from(licensesTable);
    expect(licenses).toHaveLength(0);
  });

  it("walks the wizard order: create owner, then activate license, then save settings", async () => {
    // Use SETUP_SECRET=off to simulate a desktop/LAN install where setup is
    // fail-open. The test is exercising the wizard bootstrap ordering (owner
    // before license), not the hosted-deployment security posture; the hosted
    // default (auto protection) is covered in authSetupGuard.test.ts.
    process.env.SETUP_SECRET = "off";

    // Step 1 — create the owner account. This is the first wizard step; its
    // response establishes the session that unlocks the gated routes below.
    const setupRes = await agent()
      .post("/api/auth/setup")
      .set("X-Forwarded-Proto", "https")
      .send({
        username: "shop-owner",
        password: "owner-pass-123",
        displayName: "Shop Owner",
      });
    expect(setupRes.status).toBe(201);
    expect(setupRes.body.username).toBe("shop-owner");
    expect(setupRes.body.role).toBe("admin");
    const cookie = extractSid(setupRes);

    // Once an owner exists the install no longer needs setup.
    const needs = await agent().get("/api/auth/needs-setup");
    expect(needs.status).toBe(200);
    expect(needs.body.needsSetup).toBe(false);

    // A buyer who completed checkout has a paid store order carrying their key;
    // redeeming it on a fresh install provisions the single device-gate license
    // row. Seed one so the wizard's license step has a real key to activate.
    const soldKey = "RSS-AAAA-BBBB-CCCC-DDDD";
    await db.insert(storeOrdersTable).values({
      stripeSessionId: "cs_bootstrap",
      plan: "shop",
      productName: "Shop License",
      maxDevices: 3,
      licenseKey: soldKey,
      amountTotal: 39900,
      currency: "usd",
      status: "paid",
    });

    // Step 2 — activate the license. This only works because step 1 logged the
    // owner in; without the session cookie it returns 401 (see the test above).
    const activateRes = await agent()
      .post("/api/license/activate")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", cookie)
      .send({
        licenseKey: soldKey,
        deviceFingerprint: "wizard-fp",
        deviceName: "Front Desk PC",
      });
    expect(activateRes.status).toBe(200);
    expect(typeof activateRes.body.deviceToken).toBe("string");
    const licenses = await db.select().from(licensesTable);
    expect(licenses).toHaveLength(1);
    expect(licenses[0].licenseKey).toBe(soldKey);

    // Step 3 — save shop details, the final data-collecting wizard step.
    const settingsRes = await agent()
      .put("/api/settings")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", cookie)
      .send({ shopName: "Reliable Automotive Services" });
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.shopName).toBe("Reliable Automotive Services");
  });
});
