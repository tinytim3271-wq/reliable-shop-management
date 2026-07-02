import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { runtimeConfig } from "@workspace/db";

// ---------------------------------------------------------------------------
// Developer-only Replit identity gate
//
// A lightweight gate that locks the HOSTED deployment to a single allowed
// Replit user while the product is in active development. It sits IN FRONT of
// the entire existing request pipeline (session/auth/RBAC/bearer tokens are all
// untouched) and only fires in hosted mode when REPLIT_ALLOWED_USER is set.
//
// When the gate is disabled (no allowed user configured, or APP_RUNTIME=desktop)
// every request passes through unchanged, so the installable desktop product and
// local development are never blocked.
// ---------------------------------------------------------------------------

// Name of the signed cookie holding the verified Replit username. Distinct from
// the application's own session cookie (rss.sid) so the two never interfere.
export const DEV_GATE_COOKIE = "rss.devgate";

// Path prefix mounted by the gate's own OIDC routes. These must always be
// reachable so the sign-in / callback / logout flow can complete.
export const DEV_GATE_PATH = "/api/dev-gate";

// The gate is active only in hosted mode and only once an allowed username is
// configured. Desktop/LAN and local dev (no env var) skip it entirely.
export const isDevGateEnabled = (): boolean =>
  !runtimeConfig.isDesktop && !!process.env.REPLIT_ALLOWED_USER;

// Constant-time string comparison that tolerates differing lengths without
// leaking them through an early return.
export const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

export const devGate: RequestHandler = (req, res, next) => {
  // Inert unless explicitly enabled for a hosted deployment.
  if (!isDevGateEnabled()) {
    next();
    return;
  }

  // Always let the gate's own routes through so the OIDC handshake (login ->
  // Replit -> callback) and logout can run without being redirected onto
  // themselves.
  if (req.path === DEV_GATE_PATH || req.path.startsWith(`${DEV_GATE_PATH}/`)) {
    next();
    return;
  }

  const allowed = process.env.REPLIT_ALLOWED_USER ?? "";
  const verified = req.signedCookies?.[DEV_GATE_COOKIE];
  if (typeof verified === "string" && constantTimeEqual(verified, allowed)) {
    next();
    return;
  }

  // Not verified: send the caller to the gate sign-in, remembering where they
  // were headed so the callback can return them there.
  const returnTo = req.originalUrl || "/";
  res.redirect(
    `${DEV_GATE_PATH}/login?returnTo=${encodeURIComponent(returnTo)}`,
  );
};
