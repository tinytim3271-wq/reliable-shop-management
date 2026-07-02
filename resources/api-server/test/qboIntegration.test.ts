import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, qboOauthStatesTable, qboSyncLogTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { agent, seedAdmin, seedStaffUser, type SeededAdmin } from "./helpers";

/**
 * QuickBooks Online integration module.
 *
 * The whole module is inert until Intuit app credentials (QBO_CLIENT_ID /
 * QBO_CLIENT_SECRET) are present in the environment. The test environment never
 * sets them, so this suite verifies the "configured: false / not connected"
 * posture: status reports inert, connect refuses with 503, sync/accounts fail
 * closed, and the mapping + log surfaces still behave for an authenticated
 * caller. It also pins the auth boundary — the protected routes sit behind the
 * "accounting" permission, and the OAuth callback stays public.
 */
describe("QuickBooks Online integration (inert without credentials)", () => {
  let admin: SeededAdmin;

  beforeAll(async () => {
    admin = await seedAdmin();
  });

  const authed = (method: "get" | "post" | "delete" | "put", path: string) =>
    agent()
      [method](path)
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", admin.cookie);

  it("reports not configured and not connected", async () => {
    const res = await authed("get", "/api/integrations/qbo/status");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.connected).toBe(false);
  });

  it("refuses to mint a connect URL when not configured", async () => {
    const res = await authed("get", "/api/integrations/qbo/connect");
    expect(res.status).toBe(503);
  });

  it("disconnect is a safe no-op that returns inert status", async () => {
    const res = await authed("delete", "/api/integrations/qbo/disconnect");
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
  });

  it("returns the saved (empty) account mapping for an authenticated caller", async () => {
    const res = await authed("get", "/api/integrations/qbo/mapping");
    expect(res.status).toBe(200);
    expect(res.body).toBeTypeOf("object");
  });

  it("persists an account mapping round-trip", async () => {
    const put = await authed("put", "/api/integrations/qbo/mapping").send({
      incomeAccount: "100",
      paymentAccounts: { cash: "10", card: "11", check: "12" },
      expenseAccounts: { "1": "200" },
    });
    expect(put.status).toBe(200);
    expect(put.body.incomeAccount).toBe("100");
    expect(put.body.paymentAccounts.card).toBe("11");

    const get = await authed("get", "/api/integrations/qbo/mapping");
    expect(get.status).toBe(200);
    expect(get.body.incomeAccount).toBe("100");
    expect(get.body.expenseAccounts["1"]).toBe("200");
  });

  it("serves an empty, paginated sync log", async () => {
    const res = await authed("get", "/api/integrations/qbo/log?limit=10&offset=0");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  it("accepts entityType and status filters on the sync log", async () => {
    const res = await authed(
      "get",
      "/api/integrations/qbo/log?entityType=invoice&status=failed&limit=10&offset=0",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("filters the sync log by entityId", async () => {
    await db.insert(qboSyncLogTable).values([
      { entityType: "invoice", entityId: 90001, status: "synced" },
      { entityType: "invoice", entityId: 90002, status: "failed" },
      { entityType: "payment", entityId: 90001, status: "pending" },
    ]);

    const res = await authed(
      "get",
      "/api/integrations/qbo/log?entityId=90001&limit=50&offset=0",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(
      res.body.items.every((i: { entityId: number }) => i.entityId === 90001),
    ).toBe(true);

    const combined = await authed(
      "get",
      "/api/integrations/qbo/log?entityId=90001&entityType=invoice&limit=50&offset=0",
    );
    expect(combined.status).toBe(200);
    expect(combined.body.total).toBe(1);
    expect(combined.body.items[0].entityType).toBe("invoice");
    expect(combined.body.items[0].entityId).toBe(90001);
  });

  it("rejects a non-numeric entityId filter", async () => {
    const res = await authed(
      "get",
      "/api/integrations/qbo/log?entityId=abc",
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown sync-log status filter", async () => {
    const res = await authed(
      "get",
      "/api/integrations/qbo/log?status=bogus",
    );
    expect(res.status).toBe(400);
  });

  it("requires authentication for the protected routes", async () => {
    const res = await agent()
      .get("/api/integrations/qbo/status")
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(401);
  });

  it("requires the accounting permission for the protected routes", async () => {
    const staff = await seedStaffUser(["invoices"], "qbo-noperm");
    const res = await agent()
      .get("/api/integrations/qbo/status")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", staff.cookie);
    expect(res.status).toBe(403);
  });

  it("allows a staff user holding the accounting permission", async () => {
    const staff = await seedStaffUser(["accounting"], "qbo-perm");
    const res = await agent()
      .get("/api/integrations/qbo/status")
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", staff.cookie);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
  });

  it("reports permanentFailureCount and clears it when the row is resolved", async () => {
    // Baseline: a fresh log has no permanently-failed records.
    await db.delete(qboSyncLogTable);
    const zero = await authed("get", "/api/integrations/qbo/status");
    expect(zero.status).toBe(200);
    expect(zero.body.permanentFailureCount).toBe(0);

    // Two records the auto-retry sweep gave up on, plus a non-terminal failure
    // that must NOT count toward the alert.
    await db.insert(qboSyncLogTable).values([
      { entityType: "invoice", entityId: 9001, status: "failed_permanent" },
      { entityType: "expense", entityId: 9002, status: "failed_permanent" },
      { entityType: "payment", entityId: 9003, status: "failed" },
    ]);

    const flagged = await authed("get", "/api/integrations/qbo/status");
    expect(flagged.status).toBe(200);
    expect(flagged.body.permanentFailureCount).toBe(2);

    // Resolving the terminal rows (manual retry success / clear) drops the alert.
    await db
      .delete(qboSyncLogTable)
      .where(eq(qboSyncLogTable.status, "failed_permanent"));
    const cleared = await authed("get", "/api/integrations/qbo/status");
    expect(cleared.status).toBe(200);
    expect(cleared.body.permanentFailureCount).toBe(0);

    await db.delete(qboSyncLogTable);
  });

  it("keeps the OAuth callback public (no session) and redirects on bad state", async () => {
    const res = await agent()
      .get("/api/integrations/qbo/callback?state=bogus&code=abc&realmId=1")
      .set("X-Forwarded-Proto", "https")
      .redirects(0);
    // Public route: not a 401. It redirects back to settings with an error flag.
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.location).toContain("qbo=error");
  });
});

/**
 * OAuth callback state -> initiating-session binding. With credentials present,
 * the callback validates the single-use state AND requires the returning browser
 * to carry the same logged-in session that minted it, so a leaked/replayed state
 * cannot complete the link from another context.
 */
describe("QuickBooks Online OAuth callback session binding", () => {
  let admin: SeededAdmin;
  const savedEnv = {
    id: process.env.QBO_CLIENT_ID,
    secret: process.env.QBO_CLIENT_SECRET,
    redirect: process.env.QBO_REDIRECT_URI,
  };

  beforeAll(async () => {
    admin = await seedAdmin();
    process.env.QBO_CLIENT_ID = "test-client-id";
    process.env.QBO_CLIENT_SECRET = "test-client-secret";
    process.env.QBO_REDIRECT_URI =
      "https://example.test/api/integrations/qbo/callback";
  });

  afterAll(() => {
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore("QBO_CLIENT_ID", savedEnv.id);
    restore("QBO_CLIENT_SECRET", savedEnv.secret);
    restore("QBO_REDIRECT_URI", savedEnv.redirect);
  });

  it("rejects a callback whose session does not match the initiating user", async () => {
    const state = "state-bound-to-admin";
    await db
      .insert(qboOauthStatesTable)
      .values({ state, userId: admin.id });

    // No session cookie: the state belongs to admin, so the binding check fails
    // before any token exchange is attempted.
    const res = await agent()
      .get(`/api/integrations/qbo/callback?state=${state}&code=abc&realmId=1`)
      .set("X-Forwarded-Proto", "https")
      .redirects(0);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.location).toContain("qbo=error");
    expect(decodeURIComponent(res.headers.location)).toMatch(/session mismatch/i);

    // The single-use state was consumed (deleted) even on a rejected binding.
    const remaining = await db
      .select()
      .from(qboOauthStatesTable)
      .where(eq(qboOauthStatesTable.state, state));
    expect(remaining.length).toBe(0);
  });
});
