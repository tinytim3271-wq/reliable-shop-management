import crypto from "node:crypto";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import devGateRouter from "../src/routes/devGate";
import { devGate, DEV_GATE_COOKIE } from "../src/lib/devGate";

// ─────────────────────────────────────────────────────────────────────────────
// Developer-only Replit identity gate
//
// These tests exercise the gate MIDDLEWARE in isolation (the OIDC login/callback
// network handshake against replit.com is not exercised here). The middleware is
// mounted the same way app.ts mounts it when the gate is enabled: cookie-parser
// (with the session secret) -> gate router -> gate middleware.
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = "test-devgate-secret";
const ALLOWED = "owner-dev";

// Reproduce express/cookie-parser's signed-cookie wire format (s:<val>.<hmac>)
// without pulling in another dependency, so we can present a validly-signed gate
// cookie to the parser.
function signedCookieValue(value: string, secret: string): string {
  const mac = crypto
    .createHmac("sha256", secret)
    .update(value)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${value}.${mac}`;
}

function gateCookieHeader(value: string, secret = SECRET): string {
  return `${DEV_GATE_COOKIE}=${encodeURIComponent(signedCookieValue(value, secret))}`;
}

function buildApp(): Express {
  const app = express();
  app.use(cookieParser(SECRET));
  app.use("/api", devGateRouter);
  app.use(devGate);
  app.get("/api/customers", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const app = buildApp();

describe("developer-only gate (disabled)", () => {
  beforeEach(() => {
    delete process.env.REPLIT_ALLOWED_USER;
  });

  it("passes every request through when REPLIT_ALLOWED_USER is unset", async () => {
    const res = await request(app).get("/api/customers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("developer-only gate (enabled)", () => {
  beforeEach(() => {
    process.env.REPLIT_ALLOWED_USER = ALLOWED;
  });
  afterEach(() => {
    delete process.env.REPLIT_ALLOWED_USER;
  });

  it("redirects an unauthenticated request to the gate sign-in, preserving returnTo", async () => {
    const res = await request(app).get("/api/customers");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `/api/dev-gate/login?returnTo=${encodeURIComponent("/api/customers")}`,
    );
  });

  it("allows a request carrying a validly-signed cookie for the allowed user", async () => {
    const res = await request(app)
      .get("/api/customers")
      .set("Cookie", gateCookieHeader(ALLOWED));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("redirects when the signed cookie names a different user", async () => {
    const res = await request(app)
      .get("/api/customers")
      .set("Cookie", gateCookieHeader("someone-else"));
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/api/dev-gate/login");
  });

  it("redirects when the cookie signature is invalid (forged value)", async () => {
    const res = await request(app)
      .get("/api/customers")
      .set("Cookie", gateCookieHeader(ALLOWED, "wrong-secret"));
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/api/dev-gate/login");
  });

  it("lets the gate's own routes through and logout clears the cookie", async () => {
    const res = await request(app).get("/api/dev-gate/logout");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/api/dev-gate/login");
    const setCookie = res.headers["set-cookie"] as unknown as
      | string[]
      | undefined;
    expect(setCookie?.some((c) => c.startsWith(`${DEV_GATE_COOKIE}=;`))).toBe(
      true,
    );
  });
});
