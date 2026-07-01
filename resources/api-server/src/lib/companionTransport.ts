import type { Request, RequestHandler } from "express";
import * as cookieSignature from "cookie-signature";
import onHeaders from "on-headers";
import { runtimeConfig } from "@workspace/db";

// ─────────────────────────────────────────────────────────────────────────────
// Desktop companion session transport (Android tablet -> Windows hub over LAN)
//
// The hub serves plain HTTP on the LAN and its session cookie is non-Secure +
// SameSite=Lax, so the Capacitor webview (origin capacitor://localhost or
// http(s)://localhost) cannot send that cookie cross-origin to the hub. Instead
// the companion carries the *signed session id* in a request header and reads a
// refreshed one back from a response header:
//
//   inbound:  X-Session-Id header  ->  rss.sid cookie (before express-session)
//   outbound: rss.sid value        ->  X-Session-Id header (after a successful
//                                       authenticated request)
//
// The signed value is byte-identical to what express-session writes to the
// cookie, so the inbound translation round-trips through express-session's own
// verifier — no parallel session validation logic. These middleware are PURE
// (no runtime self-gating) and are mounted ONLY in desktop mode by app.ts, so
// the hosted request pipeline is unchanged. The companion ALSO sends a fixed
// marker header so the hub can recognize this trusted same-app cross-origin
// client (used by the CSRF and license gates); that marker is honored ONLY in
// desktop mode (see `isCompanionRequest`) so a hosted client can never use it
// to bypass a gate.
// ─────────────────────────────────────────────────────────────────────────────

// Marker the Android companion sets on every request. A custom header forces a
// CORS preflight that the desktop CORS layer grants only to the companion
// origins, so a request carrying it cannot be forged cross-site.
export const COMPANION_MARKER_HEADER = "x-rss-companion";

// Header transporting the signed express-session id in both directions.
export const SESSION_ID_HEADER = "x-session-id";

// Must match the express-session cookie name configured in app.ts.
const SESSION_COOKIE_NAME = "rss.sid";

// Bound the accepted header length so a junk header can't bloat cookie parsing.
const MAX_SESSION_HEADER_LEN = 512;

// Origins the Capacitor Android webview presents. Used by the desktop CORS
// allowlist so credentials are granted only to the companion app (never via
// origin-reflection).
export const COMPANION_ORIGINS: ReadonlySet<string> = new Set([
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
]);

// True only when the request carries the companion marker. Pure helper so the
// header-detection logic is unit-testable without flipping the process runtime.
export function hasCompanionMarker(req: Request): boolean {
  return req.get(COMPANION_MARKER_HEADER) === "1";
}

// True when this is a trusted desktop companion request. The desktop gate is
// security-critical: in hosted mode the marker is ignored, so a hosted client
// cannot send it to bypass the CSRF or license gates.
export function isCompanionRequest(req: Request): boolean {
  return runtimeConfig.isDesktop && hasCompanionMarker(req);
}

// Produce the signed cookie value express-session would store for `sessionId`.
export function signSessionId(sessionId: string, secret: string): string {
  return `s:${cookieSignature.sign(sessionId, secret)}`;
}

// Inbound: translate the companion's X-Session-Id header into the rss.sid cookie
// BEFORE express-session runs so the session is looked up / validated / expired
// exactly like a normal cookie session. No-op when the header is absent, empty,
// or implausibly long. Mounted desktop-only by app.ts.
export const companionSessionInbound: RequestHandler = (req, _res, next) => {
  const headerVal = req.get(SESSION_ID_HEADER);
  if (
    headerVal &&
    headerVal.length > 0 &&
    headerVal.length <= MAX_SESSION_HEADER_LEN
  ) {
    const injected = `${SESSION_COOKIE_NAME}=${encodeURIComponent(headerVal)}`;
    req.headers.cookie = req.headers.cookie
      ? `${req.headers.cookie}; ${injected}`
      : injected;
  }
  next();
};

// Outbound: after express-session has run, surface the signed session id in a
// readable response header so the companion can capture/refresh its token. Only
// emitted for an authenticated session (userId present) — never on healthz, a
// failed login, or a post-logout (destroyed-session) response — so a stale or
// cleared token is not handed back out. Mounted desktop-only by app.ts.
export function companionSessionOutbound(secret: string): RequestHandler {
  return (req, res, next) => {
    onHeaders(res, () => {
      const sid = req.sessionID;
      if (sid && req.session && req.session.userId) {
        res.setHeader(SESSION_ID_HEADER, signSessionId(sid, secret));
      }
    });
    next();
  };
}
