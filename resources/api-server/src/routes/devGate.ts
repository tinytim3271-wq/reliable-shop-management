import * as oidc from "openid-client";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  DEV_GATE_COOKIE,
  constantTimeEqual,
  isDevGateEnabled,
} from "../lib/devGate";

// ---------------------------------------------------------------------------
// Developer-only gate OIDC routes
//
// Implements the Replit OIDC authorization-code + PKCE flow used by the gate
// middleware. None of this touches the application's own bcrypt/session/RBAC
// auth — on success it only writes a signed cookie recording the verified
// Replit username, which the gate middleware checks against REPLIT_ALLOWED_USER.
// ---------------------------------------------------------------------------

const ISSUER_URL = process.env.ISSUER_URL ?? "https://replit.com/oidc";

// Short-lived cookies that carry the transient OIDC handshake state between
// /login and /callback. Prefixed so they never collide with app cookies.
const OIDC_COOKIE_TTL = 10 * 60 * 1000;
const VERIFIER_COOKIE = "rss.dg.verifier";
const NONCE_COOKIE = "rss.dg.nonce";
const STATE_COOKIE = "rss.dg.state";
const RETURN_COOKIE = "rss.dg.return";

// The verified-identity cookie lives as long as a normal session (30 days).
const GATE_COOKIE_TTL = 1000 * 60 * 60 * 24 * 30;

const router: IRouter = Router();

let oidcConfig: oidc.Configuration | null = null;
async function getConfig(): Promise<oidc.Configuration> {
  if (!oidcConfig) {
    oidcConfig = await oidc.discovery(
      new URL(ISSUER_URL),
      process.env.REPL_ID!,
    );
  }
  return oidcConfig;
}

// Reconstruct the externally-visible origin from the proxy's forwarded headers
// so the redirect_uri matches what Replit's OIDC was configured with.
function getOrigin(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host =
    (req.headers["x-forwarded-host"] as string) ||
    req.headers["host"] ||
    "localhost";
  return `${proto}://${host}`;
}

// Only allow same-origin relative paths as a post-login destination so the gate
// cannot be turned into an open redirector.
function getSafeReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return "/";
  }
  return value;
}

function setHandshakeCookie(res: Response, name: string, value: string) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: OIDC_COOKIE_TTL,
  });
}

function clearHandshakeCookies(res: Response) {
  for (const name of [
    VERIFIER_COOKIE,
    NONCE_COOKIE,
    STATE_COOKIE,
    RETURN_COOKIE,
  ]) {
    res.clearCookie(name, { path: "/" });
  }
}

// GET /api/dev-gate/login — begin the OIDC authorization-code + PKCE flow.
router.get("/dev-gate/login", async (req: Request, res: Response) => {
  if (!isDevGateEnabled()) {
    res.redirect("/");
    return;
  }

  const config = await getConfig();
  const callbackUrl = `${getOrigin(req)}/api/dev-gate/callback`;
  const returnTo = getSafeReturnTo(req.query.returnTo);

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope: "openid profile email",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
    state,
    nonce,
  });

  setHandshakeCookie(res, VERIFIER_COOKIE, codeVerifier);
  setHandshakeCookie(res, NONCE_COOKIE, nonce);
  setHandshakeCookie(res, STATE_COOKIE, state);
  setHandshakeCookie(res, RETURN_COOKIE, returnTo);

  res.redirect(redirectTo.href);
});

// GET /api/dev-gate/callback — validate the OIDC response, compare the Replit
// username to the allow-list, and (on match) write the signed gate cookie.
router.get("/dev-gate/callback", async (req: Request, res: Response) => {
  if (!isDevGateEnabled()) {
    res.redirect("/");
    return;
  }

  const config = await getConfig();
  const callbackUrl = `${getOrigin(req)}/api/dev-gate/callback`;

  const codeVerifier = req.cookies?.[VERIFIER_COOKIE];
  const nonce = req.cookies?.[NONCE_COOKIE];
  const expectedState = req.cookies?.[STATE_COOKIE];
  const returnTo = getSafeReturnTo(req.cookies?.[RETURN_COOKIE]);

  if (!codeVerifier || !expectedState) {
    res.redirect("/api/dev-gate/login");
    return;
  }

  const currentUrl = new URL(
    `${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`,
  );

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
      idTokenExpected: true,
    });
  } catch (err) {
    req.log.warn({ err }, "Dev-gate OIDC callback failed");
    clearHandshakeCookies(res);
    res.redirect("/api/dev-gate/login");
    return;
  }

  clearHandshakeCookies(res);

  const claims = tokens.claims();
  const username =
    (claims?.preferred_username as string | undefined) ??
    (claims?.username as string | undefined) ??
    "";
  const allowed = process.env.REPLIT_ALLOWED_USER ?? "";

  if (!username || !constantTimeEqual(username, allowed)) {
    res
      .status(403)
      .type("text/plain")
      .send("Access denied. This deployment is restricted to its developer.");
    return;
  }

  // Signed (HMAC over the session secret) so the username cannot be forged.
  res.cookie(DEV_GATE_COOKIE, allowed, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: GATE_COOKIE_TTL,
    signed: true,
  });

  res.redirect(returnTo);
});

// GET /api/dev-gate/logout — clear the gate cookie and return to sign-in.
router.get("/dev-gate/logout", (_req: Request, res: Response) => {
  res.clearCookie(DEV_GATE_COOKIE, { path: "/" });
  res.redirect("/api/dev-gate/login");
});

export default router;
