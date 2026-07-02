/**
 * Regression tests for auth and session integrity fixes.
 *
 * Issue 1 — CSRF bypass via fake Bearer header (High):
 *   A cross-origin mutating request that carries a dummy `Authorization:
 *   Bearer <anything>` header must still be rejected by the CSRF check.
 *   The server must not grant a CSRF exemption based solely on the presence
 *   of a Bearer header; the exemption is earned only when the token resolves
 *   to a valid user in the database.
 *
 * Issue 2 — Password reset does not invalidate existing credentials (Medium):
 *   When an admin resets a user's password, all bearer tokens and all
 *   server-side browser sessions belonging to that user must be revoked
 *   immediately. Existing credentials must not continue to authorize requests.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { agent, loginCookie, seedAdmin, seedStaffUser, type SeededAdmin } from "./helpers";

let admin: SeededAdmin;

beforeAll(async () => {
  admin = await seedAdmin();
});

// ---------------------------------------------------------------------------
// Issue 1 — CSRF check must not be bypassed by a dummy Bearer header
// ---------------------------------------------------------------------------
describe("CSRF protection — fake Bearer header must not bypass origin check", () => {
  it("rejects a cross-origin mutating request that has a dummy Bearer header and a valid session cookie", async () => {
    // An attacker page sends a credentialed fetch() cross-origin with a fake
    // bearer token hoping the server will skip the same-origin check and then
    // fall through to the victim's session cookie.  The server must see that
    // the bearer token is invalid and still enforce the origin check.
    const res = await agent()
      .post("/api/customers")
      .set("Authorization", "Bearer this-is-a-completely-fake-token")
      .set("Origin", "https://evil.example.com")
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ name: "CSRF Injected Customer" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cross-origin/i);
  });

  it("rejects a cross-origin mutating request with no Authorization header and a valid session cookie", async () => {
    // Baseline: pure same-site=none cookie-only CSRF attempt with Origin set
    // to a different domain must also be rejected.
    const res = await agent()
      .post("/api/customers")
      .set("Origin", "https://evil.example.com")
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ name: "Cookie-Only CSRF Customer" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cross-origin/i);
  });

  it("allows a same-origin mutating request even with a dummy Bearer header (falls back to session)", async () => {
    // A request from the same origin with a non-existent bearer token should
    // pass the CSRF check and then authenticate via the valid session cookie.
    // This simulates the real browser app accidentally sending an auth header.
    const res = await agent()
      .post("/api/customers")
      .set("Authorization", "Bearer non-existent-token-but-same-origin")
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ name: "Same-Origin Fallback Customer" });

    // Should be accepted (201) or fail for business reasons (400) but never 403
    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Issue 2 — Password reset must revoke all credentials for the target user
// ---------------------------------------------------------------------------
describe("Password reset credential revocation", () => {
  it("revokes all bearer tokens for the user whose password was reset", async () => {
    const target = await seedStaffUser(["workOrders"], "bearer-revoke-target");

    // Issue a bearer token for the target user via POST /auth/token.
    const tokenRes = await agent()
      .post("/api/auth/token")
      .send({ username: target.username, password: target.password });
    expect(tokenRes.status).toBe(200);
    const bearerToken: string = tokenRes.body.token;

    // Verify the bearer token grants access to a protected endpoint.
    const beforeRes = await agent()
      .get("/api/work-orders")
      .set("Authorization", `Bearer ${bearerToken}`)
      .set("X-Forwarded-Proto", "https");
    expect(beforeRes.status).toBe(200);

    // Admin resets the target user's password.
    const patchRes = await agent()
      .patch(`/api/users/${target.id}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ password: "new-password-after-reset-789" });
    expect(patchRes.status).toBe(200);

    // The old bearer token must now be rejected.
    const afterRes = await agent()
      .get("/api/work-orders")
      .set("Authorization", `Bearer ${bearerToken}`)
      .set("X-Forwarded-Proto", "https");
    expect(afterRes.status).toBe(401);
  });

  it("revokes browser sessions for the user whose password was reset", async () => {
    const target = await seedStaffUser(["workOrders"], "session-revoke-target");

    // Capture the target user's active session cookie.
    const oldCookie = await loginCookie(target.username, target.password);

    // Verify the session grants access.
    const beforeRes = await agent()
      .get("/api/work-orders")
      .set("Cookie", oldCookie)
      .set("X-Forwarded-Proto", "https");
    expect(beforeRes.status).toBe(200);

    // Admin resets the target user's password.
    const patchRes = await agent()
      .patch(`/api/users/${target.id}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ password: "new-password-session-reset-789" });
    expect(patchRes.status).toBe(200);

    // The old session cookie must now be rejected.
    const afterRes = await agent()
      .get("/api/work-orders")
      .set("Cookie", oldCookie)
      .set("X-Forwarded-Proto", "https");
    expect(afterRes.status).toBe(401);
  });

  it("does not revoke the admin's own session when resetting another user's password", async () => {
    const target = await seedStaffUser(["workOrders"], "other-user-target");

    // Admin resets the target user's password.
    await agent()
      .patch(`/api/users/${target.id}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({ password: "another-new-password-123" });

    // The admin who performed the reset must still be authenticated.
    const adminRes = await agent()
      .get("/api/work-orders")
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(adminRes.status).toBe(200);
  });
});
