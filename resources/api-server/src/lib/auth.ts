import crypto from "node:crypto";
import type { Request, Response, RequestHandler } from "express";
import bcrypt from "bcryptjs";
import { and, eq, gt } from "drizzle-orm";
import { db, usersTable, authTokensTable, type User } from "@workspace/db";
import { isCompanionRequest } from "./companionTransport";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: User;
    }
  }
}

// Canonical list of permission keys, one per app module. Admins bypass these.
export const PERMISSION_KEYS = [
  "customers",
  "workOrders",
  "estimates",
  "invoices",
  "inventory",
  "appointments",
  "inspections",
  "timeTracking",
  "payroll",
  "accounting",
  "communications",
  "settings",
  "users",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

// Default permission preset for a shop technician/mechanic login.
export const TECHNICIAN_PERMISSIONS: PermissionKey[] = [
  "workOrders",
  "inspections",
  "timeTracking",
  "appointments",
];

// Maps URL path prefixes (relative to the /api mount) to the permission they
// require. Ordered most-specific first so e.g. /reports/tax (accounting) wins
// over a per-module rule. Reports are split: payday/dashboard are payroll,
// the financial reports are accounting.
const ROUTE_PERMISSIONS: ReadonlyArray<readonly [string, PermissionKey]> = [
  ["/reports/payday", "payroll"],
  ["/reports/dashboard", "payroll"],
  ["/reports/profit-loss", "accounting"],
  ["/reports/expenses", "accounting"],
  ["/reports/tax", "accounting"],
  ["/reports/sales-summary", "accounting"],
  ["/reports/accounts-receivable", "accounting"],
  ["/reports/top-services", "accounting"],
  ["/reports/payments-by-method", "accounting"],
  ["/reports/stock-movements", "inventory"],
  ["/customers", "customers"],
  ["/vehicles", "customers"],
  ["/import/work-orders", "workOrders"],
  ["/import/invoices", "invoices"],
  ["/import/expenses", "accounting"],
  ["/import", "customers"],
  ["/work-orders", "workOrders"],
  ["/labor-sessions", "workOrders"],
  ["/estimates", "estimates"],
  ["/invoices", "invoices"],
  ["/ai/labor-estimate", "estimates"],
  ["/ai/diagnose", "workOrders"],
  ["/line-item-presets", "settings"],
  ["/pricing-markup-tiers", "settings"],
  ["/labor-rates", "settings"],
  ["/inspection-templates", "settings"],
  ["/inspections", "inspections"],
  ["/storage", "inspections"],
  ["/parts", "inventory"],
  ["/purchase-orders", "inventory"],
  ["/vendors", "inventory"],
  ["/appointments", "appointments"],
  ["/time-entries", "timeTracking"],
  ["/mechanics", "payroll"],
  ["/employees", "payroll"],
  ["/payroll", "payroll"],
  ["/advances", "payroll"],
  ["/loans", "payroll"],
  ["/forms", "settings"],
  ["/expense-categories", "accounting"],
  ["/expenses", "accounting"],
  ["/integrations/qbo", "accounting"],
  ["/messages", "communications"],
  ["/message-templates", "communications"],
  ["/sms-consent-events", "communications"],
  ["/settings", "settings"],
  ["/users", "users"],
];

export const getRequiredPermission = (path: string): PermissionKey | null => {
  for (const [prefix, perm] of ROUTE_PERMISSIONS) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return perm;
  }
  return null;
};

export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, 12);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

// ---------------------------------------------------------------------------
// Bearer-token auth for native/mobile clients
//
// The browser app uses cookie-backed sessions. React Native cannot rely on
// cookies, so the Expo client logs in via POST /auth/token and receives an
// opaque bearer token. Only its SHA-256 hash is persisted; the raw value is
// returned to the client exactly once and replayed on every request as
// `Authorization: Bearer <token>`.
// ---------------------------------------------------------------------------

// Native bearer tokens live as long as the cookie session (30 days).
export const AUTH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export const generateAuthToken = (): string =>
  crypto.randomBytes(32).toString("hex");

export const hashAuthToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

// Pull a bearer token out of the Authorization header, or null when absent.
const extractBearerToken = (req: Request): string | null => {
  const header = req.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
};

// Issue and persist a new bearer token for a user. Returns the raw token.
export const issueAuthToken = async (userId: number): Promise<string> => {
  const token = generateAuthToken();
  const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS).toISOString();
  await db.insert(authTokensTable).values({
    userId,
    tokenHash: hashAuthToken(token),
    expiresAt,
  });
  return token;
};

// Revoke a presented bearer token (best-effort; no-op when absent/unknown).
export const revokeAuthToken = async (req: Request): Promise<void> => {
  const token = extractBearerToken(req);
  if (!token) return;
  await db
    .delete(authTokensTable)
    .where(eq(authTokensTable.tokenHash, hashAuthToken(token)));
};

// Resolve the active, unexpired user behind a bearer token. Touches lastUsedAt
// on success. Returns null when no valid token/user is found.
const resolveBearerUser = async (req: Request): Promise<User | null> => {
  const token = extractBearerToken(req);
  if (!token) return null;
  const tokenHash = hashAuthToken(token);
  const nowIso = new Date().toISOString();
  const [row] = await db
    .select({ id: authTokensTable.id, userId: authTokensTable.userId })
    .from(authTokensTable)
    .where(
      and(
        eq(authTokensTable.tokenHash, tokenHash),
        gt(authTokensTable.expiresAt, nowIso),
      ),
    );
  if (!row) return null;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, row.userId));
  if (!user || !user.active) return null;

  // Best-effort activity stamp; never blocks the request.
  void db
    .update(authTokensTable)
    .set({ lastUsedAt: nowIso })
    .where(eq(authTokensTable.id, row.id))
    .catch(() => undefined);

  return user;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF defense: because the session cookie is SameSite=None (required for the
// iframe preview), reject state-changing requests whose Origin host does not
// match the request host. Requests without an Origin header (e.g. curl, native
// clients) still require a valid session cookie below.
//
// NOTE: do NOT exempt requests merely because they carry an Authorization:
// Bearer header here. An attacker page can trivially add a fake bearer token
// to bypass this check and then have the server fall back to the victim's
// session cookie. The bearer-token exemption belongs in `authGate`, AFTER the
// token has been cryptographically verified to be valid.
const isSameOrigin = (req: Request): boolean => {
  if (SAFE_METHODS.has(req.method)) return true;
  // Desktop only: the Android companion is a trusted same-app client that
  // reaches the hub cross-origin (capacitor://localhost -> http://<lan-ip>). It
  // proves itself with the companion marker, which `isCompanionRequest` honors
  // ONLY in desktop mode, so a hosted browser can never set the marker to defeat
  // this CSRF check.
  if (isCompanionRequest(req)) return true;
  const origin = req.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get("host");
  } catch {
    return false;
  }
};

// Standalone CSRF middleware — applied to auth mutation routes (login, logout,
// setup) which are mounted before authGate and would otherwise bypass the check.
export const csrfCheck: RequestHandler = (req, res, next) => {
  if (!isSameOrigin(req)) {
    req.log.warn(
      { origin: req.get("origin"), host: req.get("host") },
      "Rejected cross-origin mutating request on auth route",
    );
    res.status(403).json({ error: "Cross-origin request rejected" });
    return;
  }
  next();
};

export const authGate: RequestHandler = async (req, res, next) => {
  // Native/mobile clients authenticate with a bearer token. Resolve it BEFORE
  // the CSRF same-origin check: a cryptographically verified bearer token proves
  // the request carries an explicit credential (not a browser-auto-attached
  // cookie), so CSRF does not apply. Crucially, we must verify the token FIRST
  // so that a fake "Authorization: Bearer x" header cannot be used to skip the
  // origin check and then fall through to the victim's session cookie.
  const bearerUser = await resolveBearerUser(req);

  let user = bearerUser;

  if (!user) {
    // No valid bearer token: this is a browser/session request. Apply the
    // same-origin CSRF check before accepting any cookie credential.
    if (!isSameOrigin(req)) {
      req.log.warn(
        { origin: req.get("origin"), host: req.get("host") },
        "Rejected cross-origin mutating request",
      );
      res.status(403).json({ error: "Cross-origin request rejected" });
      return;
    }

    const userId = req.session.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const [sessionUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    if (!sessionUser || !sessionUser.active) {
      req.session.destroy(() => undefined);
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    user = sessionUser;
  }

  req.currentUser = user;

  // Admins bypass all granular permission checks.
  if (user.role === "admin") {
    next();
    return;
  }

  // Object storage routes require at least one of the relevant module
  // permissions. Allowing any authenticated session was an IDOR gap: a
  // low-privilege account could read work-order and inspection photos by
  // guessing or copying stable object paths.
  if (req.path === "/storage" || req.path.startsWith("/storage/")) {
    if (
      user.permissions.includes("workOrders") ||
      user.permissions.includes("inspections") ||
      user.permissions.includes("accounting")
    ) {
      next();
      return;
    }
    res
      .status(403)
      .json({ error: "You do not have permission to access this resource" });
    return;
  }
  // The voice/text AI agent is reachable by any authenticated staff member: the
  // agent enforces per-tool module permissions internally (fail-closed), and
  // conversation/memory access is scoped to the current user inside the handlers.
  // The conversational shop assistant (/ai/assistant) is likewise open to all
  // staff: it has no tool access to module data, it just forwards the chat to
  // the model and returns advisory text.
  if (
    req.path === "/ai/assistant" ||
    req.path === "/ai/agent/message" ||
    req.path === "/ai/agent/confirm" ||
    req.path === "/ai/conversations" ||
    req.path.startsWith("/ai/conversations/") ||
    req.path === "/ai/memories" ||
    req.path.startsWith("/ai/memories/") ||
    req.path.startsWith("/ai/voice/")
  ) {
    next();
    return;
  }

  // Pricing reference data (markup tiers, labor rates) is *managed* under the
  // settings module, but it is *read* by other modules: the inventory "Apply
  // Matrix" action needs the markup tiers, and the estimate line-item builder
  // needs the labor rates. Allow read-only access to those consumers while all
  // mutations fall through to the settings gate below.
  if (SAFE_METHODS.has(req.method)) {
    if (
      (req.path === "/pricing-markup-tiers" ||
        req.path.startsWith("/pricing-markup-tiers/")) &&
      (user.permissions.includes("inventory") ||
        user.permissions.includes("settings"))
    ) {
      next();
      return;
    }
    if (
      (req.path === "/labor-rates" || req.path.startsWith("/labor-rates/")) &&
      (user.permissions.includes("estimates") ||
        user.permissions.includes("settings"))
    ) {
      next();
      return;
    }
  }

  // Fail-safe default-deny: unmapped protected routes require admin.
  const required = getRequiredPermission(req.path);
  if (required && user.permissions.includes(required)) {
    next();
    return;
  }

  res
    .status(403)
    .json({ error: "You do not have permission to access this resource" });
};

export const isAdmin = (req: Request): boolean =>
  req.currentUser?.role === "admin";

// Returns true when the current user is allowed to access the given permission
// key — either because they are an admin (bypasses all checks) or because the
// key is explicitly in their permissions list.
export const hasPermission = (req: Request, key: PermissionKey): boolean => {
  const user = req.currentUser;
  if (!user) return false;
  if (user.role === "admin") return true;
  return user.permissions.includes(key);
};

// Strip the password hash before sending a user row to the client. (Response
// Zod schemas also omit it, but be explicit at the boundary.)
export const toPublicUser = (user: User) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  role: user.role,
  permissions: user.permissions,
  mechanicId: user.mechanicId,
  active: user.active,
  createdAt: user.createdAt,
});
