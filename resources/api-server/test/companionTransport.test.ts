import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import * as cookieSignature from "cookie-signature";
import app from "../src/app";
import {
  COMPANION_MARKER_HEADER,
  SESSION_ID_HEADER,
  signSessionId,
  companionSessionInbound,
  companionSessionOutbound,
} from "../src/lib/companionTransport";

// The transport middleware are PURE (no runtime self-gating) and are exercised
// here on throwaway express apps, so these tests never flip the process runtime
// and never touch Postgres. The hosted-mode security guarantee — that the
// companion marker is INERT outside desktop mode — is asserted against the real
// app, where runtimeConfig is hosted (APP_RUNTIME unset in the test harness).

const SECRET = "transport-test-secret";

describe("signSessionId", () => {
  it("produces an express-session compatible signed value that round-trips", () => {
    const sid = "session-id-abc123";
    const signed = signSessionId(sid, SECRET);
    // express-session prefixes signed cookie values with "s:".
    expect(signed.startsWith("s:")).toBe(true);
    const unsigned = cookieSignature.unsign(signed.slice(2), SECRET);
    expect(unsigned).toBe(sid);
  });

  it("does not verify under a different secret", () => {
    const signed = signSessionId("session-id-abc123", SECRET);
    expect(cookieSignature.unsign(signed.slice(2), "other-secret")).toBe(false);
  });
});

describe("companionSessionInbound", () => {
  function probeApp() {
    const a = express();
    a.use(companionSessionInbound);
    a.get("/probe", (req, res) => {
      res.json({ cookie: req.headers.cookie ?? null });
    });
    return a;
  }

  it("injects the X-Session-Id header value as the rss.sid cookie", async () => {
    const token = signSessionId("sid-1", SECRET);
    const res = await request(probeApp())
      .get("/probe")
      .set(SESSION_ID_HEADER, token);
    expect(res.body.cookie).toBe(`rss.sid=${encodeURIComponent(token)}`);
  });

  it("appends to an existing cookie header rather than replacing it", async () => {
    const token = signSessionId("sid-2", SECRET);
    const res = await request(probeApp())
      .get("/probe")
      .set("Cookie", "other=1")
      .set(SESSION_ID_HEADER, token);
    expect(res.body.cookie).toBe(
      `other=1; rss.sid=${encodeURIComponent(token)}`,
    );
  });

  it("is a no-op when the header is absent", async () => {
    const res = await request(probeApp()).get("/probe");
    expect(res.body.cookie).toBeNull();
  });

  it("ignores an implausibly long header (bounded cookie growth)", async () => {
    const res = await request(probeApp())
      .get("/probe")
      .set(SESSION_ID_HEADER, "x".repeat(513));
    expect(res.body.cookie).toBeNull();
  });
});

describe("companionSessionOutbound", () => {
  // Stand in for express-session: populate req.sessionID / req.session so the
  // outbound middleware has something to surface, toggled by a test header.
  function outboundApp() {
    const a = express();
    a.use((req, _res, next) => {
      const r = req as typeof req & {
        sessionID?: string;
        session?: { userId?: number };
      };
      r.sessionID = "sid-out";
      r.session = req.get("x-test-auth") ? { userId: 7 } : {};
      next();
    });
    a.use(companionSessionOutbound(SECRET));
    a.get("/ok", (_req, res) => res.json({ ok: true }));
    return a;
  }

  it("emits the signed session id header for an authenticated session", async () => {
    const res = await request(outboundApp()).get("/ok").set("x-test-auth", "1");
    expect(res.headers[SESSION_ID_HEADER]).toBe(signSessionId("sid-out", SECRET));
  });

  it("does not emit the header when there is no authenticated user", async () => {
    const res = await request(outboundApp()).get("/ok");
    expect(res.headers[SESSION_ID_HEADER]).toBeUndefined();
  });
});

describe("hosted mode: companion marker is inert", () => {
  it("rejects a cross-origin mutation even when the companion marker is set", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "http://attacker.example")
      .set(COMPANION_MARKER_HEADER, "1")
      .send({ username: "nobody", password: "nope" });
    // In hosted mode isCompanionRequest() is false, so the marker cannot satisfy
    // the same-origin CSRF check; the cross-origin request is still rejected.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Cross-origin request rejected");
  });

  it("does not 403 a same-origin request that carries the marker", async () => {
    // No Origin header => same-origin; the marker is irrelevant. This reaches the
    // login handler and fails on credentials (401), proving the marker neither
    // helps nor blocks in hosted mode.
    const res = await request(app)
      .post("/api/auth/login")
      .set(COMPANION_MARKER_HEADER, "1")
      .send({ username: "nobody", password: "nope" });
    expect(res.status).not.toBe(403);
  });
});
