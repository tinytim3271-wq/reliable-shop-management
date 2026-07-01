import path from "path";
import express, { type Express, type ErrorRequestHandler } from "express";
import cors from "cors";
import session from "express-session";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { rateLimit } from "express-rate-limit";
import { runtimeConfig } from "@workspace/db";
import router from "./routes";
import devGateRouter from "./routes/devGate";
import { devGate, isDevGateEnabled } from "./lib/devGate";
import { createSessionStore } from "./lib/sessionStore";
import { resolveSessionSecret } from "./lib/sessionSecret";
import { logger } from "./lib/logger";
import { WebhookHandlers } from "./webhookHandlers";
import { DEVICE_TOKEN_HEADER } from "./lib/licensing";
import {
  COMPANION_MARKER_HEADER,
  COMPANION_ORIGINS,
  SESSION_ID_HEADER,
  companionSessionInbound,
  companionSessionOutbound,
} from "./lib/companionTransport";

// Hosted requires SESSION_SECRET in the environment; desktop generates and
// persists a stable secret under the user-data dir when none is provided.
const sessionSecret = resolveSessionSecret();

const app: Express = express();

// Hosted runs behind the shared reverse proxy (TLS terminates there), so trust
// the proxy's X-Forwarded-* headers and emit Secure cookies. The desktop hub
// serves plain HTTP directly on the LAN with no proxy in front, so proxy trust
// is disabled (and cookies are not marked Secure — see the session config).
app.set("trust proxy", runtimeConfig.isDesktop ? false : 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        // Strip the query string, then redact bearer credentials carried as a
        // path segment: the opaque portal token (/api/public/portal/<token>...)
        // and the Stripe Checkout session id used to retrieve a sold license
        // (/api/store/order/<cs_...>). Logging either raw would leak a secret.
        const path = (req.url?.split("?")[0] ?? "")
          .replace(/(\/api\/public\/portal\/)[^/]+/, "$1[redacted]")
          .replace(/(\/api\/store\/order\/)[^/]+/, "$1[redacted]");
        return {
          id: req.id,
          method: req.method,
          url: path,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Developer-only Replit identity gate. Mounted BEFORE every other route so it
// fronts the entire pipeline, but it is completely inert unless the deployment
// is hosted AND REPLIT_ALLOWED_USER is set (see isDevGateEnabled). When enabled
// it locks the hosted app to a single Replit user; when disabled the request
// pipeline below is byte-identical to before. The application's own
// session/auth/RBAC/bearer-token layers are untouched either way.
if (isDevGateEnabled()) {
  // Signed gate cookie (rss.devgate) needs cookie-parser with the session
  // secret. Mounted only when the gate is active so the disabled pipeline is
  // unchanged. express-session reads the raw Cookie header, not req.cookies, so
  // this does not interfere with it.
  app.use(cookieParser(sessionSecret));
  // The gate's own OIDC routes must be reachable before the gate check; mounting
  // the router first means the login/callback/logout handlers terminate the
  // request and never fall through to the gate. Mounted under /api so the routes
  // resolve to /api/dev-gate/* (matching the OpenAPI spec and the gate's own
  // redirect/allow paths).
  app.use("/api", devGateRouter);
  app.use(devGate);
}

// Hosted serves the app same-origin through the shared proxy, so the default
// permissive CORS (no credentials) is sufficient. The desktop hub is reached
// cross-origin by the Capacitor Android companion (capacitor://localhost /
// http(s)://localhost), which authenticates with credentials and custom
// headers. It uses a STRICT origin allowlist (never origin-reflection) that
// grants credentials only to the companion's fixed scheme-origins, exposes the
// X-Session-Id response header so the companion can read its refreshed token,
// and permits the custom request headers it sends. Same-origin LAN browsers
// loading the app from the hub are unaffected: the browser does not enforce
// CORS on same-origin requests, so a missing allow-origin header does not block
// them.
const desktopCors = cors({
  origin(origin, cb) {
    // No Origin header: non-browser callers (the Electron window, curl) and
    // most same-origin GETs. These are not cross-site browser requests.
    if (!origin) {
      cb(null, true);
      return;
    }
    cb(null, COMPANION_ORIGINS.has(origin));
  },
  credentials: true,
  exposedHeaders: [SESSION_ID_HEADER],
  allowedHeaders: [
    "Content-Type",
    "Accept",
    SESSION_ID_HEADER,
    DEVICE_TOKEN_HEADER,
    COMPANION_MARKER_HEADER,
  ],
});
app.use(runtimeConfig.isDesktop ? desktopCors : cors());

// Stripe webhook: registered with the raw body parser and BEFORE
// express.json() so signature verification sees the exact bytes Stripe signed.
// It intentionally bypasses the session/auth/license gates — Stripe is an
// unauthenticated caller that authenticates itself with the signature header.
// Skipped entirely in desktop mode, which is offline and has no Stripe.
if (!runtimeConfig.isDesktop) {
  // Rate-limit the unauthenticated webhook endpoint. Stripe sends at most a
  // handful of events per payment, so a generous ceiling of 200 per 15 minutes
  // per IP comfortably covers every legitimate Stripe source address while
  // preventing a bot flood from driving repeated outbound credential fetches
  // or exhausting worker capacity before the signature check even runs.
  const webhookLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests." },
  });

  app.post(
    "/api/stripe/webhook",
    webhookLimiter,
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const signature = req.headers["stripe-signature"];
      if (!signature) {
        res.status(400).json({ error: "Missing stripe-signature" });
        return;
      }
      const sig = (Array.isArray(signature) ? signature[0] : signature) ?? "";
      try {
        await WebhookHandlers.processWebhook(req.body as Buffer, sig);
        res.status(200).json({ received: true });
      } catch (err) {
        // Return 4xx so Stripe retries transient failures; never leak internals.
        req.log.error({ err }, "Stripe webhook processing failed");
        res.status(400).json({ error: "Webhook processing error" });
      }
    },
  );
}

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// Desktop only: translate the Android companion's X-Session-Id header into the
// rss.sid cookie BEFORE express-session parses cookies, so a cross-origin
// companion (which cannot send the non-Secure SameSite=Lax cookie over LAN
// HTTP) is authenticated by the normal session machinery. Not mounted in hosted
// mode, so the hosted request pipeline is unchanged.
if (runtimeConfig.isDesktop) {
  app.use(companionSessionInbound);
}

app.use(
  session({
    name: "rss.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: createSessionStore(),
    cookie: {
      httpOnly: true,
      // Hosted: the preview/app runs in a cross-site iframe behind the TLS
      // proxy, so the cookie must be SameSite=None; Secure. Desktop: the hub
      // serves plain HTTP on the LAN where a Secure/SameSite=None cookie would
      // be dropped, so the Electron window (same-origin with its bundled API)
      // uses a non-Secure SameSite=Lax cookie.
      secure: !runtimeConfig.isDesktop,
      sameSite: runtimeConfig.isDesktop ? "lax" : "none",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  }),
);

// Desktop only: after express-session has resolved the (possibly regenerated)
// session id, surface the signed id in the X-Session-Id response header so the
// companion can capture/refresh its token. Emitted only for authenticated
// responses (see companionSessionOutbound). Not mounted in hosted mode.
if (runtimeConfig.isDesktop) {
  app.use(companionSessionOutbound(sessionSecret));
}

app.use("/api", router);

// Desktop only: serve the bundled React frontend SAME-ORIGIN with the API. The
// Electron window and LAN browsers load the app from this server and call /api
// (and /api/storage) on the same origin, which is what the non-Secure
// SameSite=Lax desktop session cookie requires. Hosted serves the frontend
// through the shared reverse proxy and never enters this branch, so its request
// pipeline is byte-identical to before.
if (runtimeConfig.isDesktop && runtimeConfig.frontendDir) {
  const frontendDir = runtimeConfig.frontendDir;
  // Real built assets (index.html, /assets/*, icons) are served directly.
  app.use(express.static(frontendDir));
  // SPA history fallback: any other GET that is not an API call returns
  // index.html so client-side routing (wouter) survives deep links and refresh.
  // POST/PUT/etc. and /api/* are left untouched (they fall through to the error
  // handler as before if unmatched).
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path === "/api" || req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(frontendDir, "index.html"));
  });
}

// Centralized error handler: keeps internal errors (including raw SQL from a
// failed DB write) out of HTTP responses. Express 5 forwards rejected async
// route handlers here automatically. Body-parser errors carry a 4xx status we
// surface with a generic message; anything else becomes a generic 500.
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  req.log.error({ err }, "Unhandled request error");
  const status =
    typeof err?.status === "number"
      ? err.status
      : typeof err?.statusCode === "number"
        ? err.statusCode
        : 500;
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: "Invalid request" });
    return;
  }
  res.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);

export default app;
