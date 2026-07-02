import { Router, type IRouter, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { and, eq, sql } from "drizzle-orm";
import { db, usersTable, withCriticalSection } from "@workspace/db";
import {
  AuthSetupBody,
  AuthLoginBody,
  AuthNeedsSetupResponse,
  AuthMeResponse,
  AuthTokenResponse,
  GetUserResponse,
} from "@workspace/api-zod";
import {
  PERMISSION_KEYS,
  hashPassword,
  verifyPassword,
  toPublicUser,
  csrfCheck,
  issueAuthToken,
  revokeAuthToken,
} from "../lib/auth";
import { isSetupProtected, setupCodeMatches } from "../lib/setupGuard";

const router: IRouter = Router();

// Constant dummy hash used to ensure the login handler always spends time in
// bcrypt regardless of whether the submitted username matches a real account.
// This prevents a timing side-channel that would otherwise let an attacker
// distinguish valid usernames (slow bcrypt path) from nonexistent ones (fast
// early-return path). The hash is a fixed bcrypt digest of an arbitrary string
// at cost 12 — the same cost used for real passwords.
const DUMMY_HASH =
  "$2b$12$GxLMNrKHpAMQSBpL/9J.MewpbbBTNGSFLfGiTdvNDqkB9e9YvuKSW";

// ---------------------------------------------------------------------------
// IP-based rate limiters
// ---------------------------------------------------------------------------

// Login: 5 failed attempts per IP per 15 minutes.
// This must be kept well below ACCOUNT_LOCKOUT_THRESHOLD so that a single
// attacker IP cannot accumulate enough failures to trigger a per-account
// lockout on its own. Requiring at least ceil(threshold / limit) distinct
// source IPs to lock out a target account transforms the attack from a
// trivial single-IP denial-of-service into a coordinated distributed effort.
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
  skipSuccessfulRequests: true,
});

// Setup: 5 attempts per IP per hour.
const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many setup attempts. Please try again later." },
});

// ---------------------------------------------------------------------------
// Per-account lockout (in-memory)
// After ACCOUNT_LOCKOUT_THRESHOLD consecutive failures the account is locked
// for ACCOUNT_LOCKOUT_MS milliseconds. Entries expire automatically once the
// lockout window has passed and the entry has not been updated, so the map
// stays bounded even under a distributed brute-force attack. A hard size cap
// evicts expired entries first, then the oldest entry, to prevent
// memory-exhaustion via unique-username flooding.
// ---------------------------------------------------------------------------

// ACCOUNT_LOCKOUT_THRESHOLD must be significantly higher than the per-IP rate
// limit (currently 5) so that a single IP cannot reach the lockout threshold
// before being blocked by the IP limiter. Setting it to 50 means an attacker
// needs failures from at least 10 distinct source IPs within a single 15-minute
// window to lock any one account — a coordinated distributed attack rather than
// a trivial single-machine denial-of-service.
const ACCOUNT_LOCKOUT_THRESHOLD = 50;
const ACCOUNT_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
// Entries are considered stale once they are past their lockout window and
// have not seen a new failure for one full lockout period.
const ACCOUNT_STATE_TTL_MS = ACCOUNT_LOCKOUT_MS * 2; // 30 minutes
// Maximum number of accounts tracked at once. Prevents unbounded heap growth
// from unique-username flooding via the public login endpoint.
const MAX_ACCOUNT_STATES = 5_000;

interface AccountState {
  failedAttempts: number;
  lockedUntil: number; // epoch ms; 0 = not locked
  updatedAt: number;   // epoch ms; used for TTL eviction
}

const accountStates = new Map<string, AccountState>();

/** Evict all expired entries; if the map is still at capacity, remove the oldest
 *  unlocked entry. Active lockouts are never evicted so that a flooding attacker
 *  cannot force the map to discard a live lockout for a targeted account. */
const evictAccountStates = (): void => {
  const now = Date.now();
  for (const [key, val] of accountStates) {
    if (now - val.updatedAt > ACCOUNT_STATE_TTL_MS && val.lockedUntil <= now) {
      accountStates.delete(key);
    }
  }
  if (accountStates.size >= MAX_ACCOUNT_STATES) {
    // Map iteration order is insertion order. Find and remove the oldest entry
    // that does NOT have an active lockout. This prevents an eviction flood from
    // displacing a locked-out target account before the window expires.
    for (const [key, val] of accountStates) {
      if (val.lockedUntil <= now) {
        accountStates.delete(key);
        return;
      }
    }
    // All tracked entries are actively locked. As a last resort evict the oldest
    // one — this is an extreme edge case (5 000 accounts simultaneously locked)
    // and still better than letting memory grow without bound.
    const oldestKey = accountStates.keys().next().value;
    if (oldestKey !== undefined) accountStates.delete(oldestKey);
  }
};

const getAccountState = (username: string): AccountState => {
  const now = Date.now();
  let state = accountStates.get(username);

  // Reap this specific entry if it has expired.
  if (state && now - state.updatedAt > ACCOUNT_STATE_TTL_MS && state.lockedUntil <= now) {
    accountStates.delete(username);
    state = undefined;
  }

  if (!state) {
    if (accountStates.size >= MAX_ACCOUNT_STATES) {
      evictAccountStates();
    }
    state = { failedAttempts: 0, lockedUntil: 0, updatedAt: now };
    accountStates.set(username, state);
  }
  return state;
};

const recordFailedAttempt = (username: string): void => {
  const state = getAccountState(username);
  state.failedAttempts += 1;
  state.updatedAt = Date.now();
  if (state.failedAttempts >= ACCOUNT_LOCKOUT_THRESHOLD) {
    state.lockedUntil = Date.now() + ACCOUNT_LOCKOUT_MS;
    state.failedAttempts = 0; // reset counter for next window after lockout expires
  }
  // Re-insert the entry so its Map insertion-order position moves to the tail.
  // Without this a targeted account stays at its original (possibly oldest)
  // position and becomes the first candidate for overflow eviction, letting an
  // attacker flood the map with bogus usernames to evict an active lockout.
  accountStates.delete(username);
  accountStates.set(username, state);
};

const clearAccountState = (username: string): void => {
  accountStates.delete(username);
};

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

const regenerateSession = (req: Request): Promise<void> =>
  new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve())),
  );

const saveSession = (req: Request): Promise<void> =>
  new Promise((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve())),
  );

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/auth/needs-setup", async (_req, res): Promise<void> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(usersTable);
  const count = row?.count ?? 0;
  res.json(
    AuthNeedsSetupResponse.parse({
      needsSetup: count === 0,
      // Tells the first-run screen whether to ask for a setup code. False on a
      // normal local install (fail-open), true when SETUP_SECRET protection is
      // configured for an internet-facing deployment.
      setupProtected: isSetupProtected(),
    }),
  );
});

// POST /auth/setup — protected by CSRF check + rate limiter.
// Requires the setupSecret body field to match the SETUP_SECRET env var so
// that a fresh deployment cannot be claimed by an external actor.
//
// The transaction acquires a PostgreSQL advisory lock before checking user
// count, guaranteeing only one setup call can proceed at a time regardless of
// READ COMMITTED isolation — eliminating the concurrent-insert race window.
router.post(
  "/auth/setup",
  csrfCheck,
  setupLimiter,
  async (req, res): Promise<void> => {
    const parsed = AuthSetupBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    // Authorize the first-run setup before touching the DB.
    //
    // Setup is FAIL-OPEN by default so a fresh local/private install needs no
    // configuration and can never be bricked. The optional SETUP_SECRET
    // safeguard (see lib/setupGuard.ts) closes the public-internet exposure:
    // when configured, the body must echo the matching code, otherwise this
    // call is rejected. setupCodeMatches() returns true when no protection is
    // configured. A localhost gate is deliberately NOT used: behind the shared
    // reverse proxy with `trust proxy` on, req.socket.remoteAddress is always
    // the proxy's loopback address and would offer no real protection.
    if (!setupCodeMatches(parsed.data.setupSecret)) {
      res.status(403).json({
        error: "An incorrect or missing setup code. Check the server console.",
        code: "SETUP_SECRET_REQUIRED",
      });
      return;
    }

    const passwordHash = await hashPassword(parsed.data.password);

    // Acquire an exclusive transaction-level advisory lock (key 42) before
    // the existence check so that two concurrent setup calls serialize rather
    // than both observing zero users. The lock is released automatically when
    // the transaction commits or rolls back.
    let user;
    try {
      user = await withCriticalSection(42, async (tx) => {
        const [row] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(usersTable);
        if ((row?.count ?? 0) > 0) {
          throw Object.assign(new Error("already_setup"), { status: 409 });
        }

        const [inserted] = await tx
          .insert(usersTable)
          .values({
            username: parsed.data.username,
            passwordHash,
            displayName: parsed.data.displayName,
            role: "admin",
            permissions: [...PERMISSION_KEYS],
            active: true,
          })
          .returning();
        return inserted;
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err as Error & { status?: number }).status === 409
      ) {
        res.status(409).json({ error: "Setup has already been completed" });
        return;
      }
      throw err;
    }

    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);

    res.status(201).json(GetUserResponse.parse(toPublicUser(user)));
  },
);

// POST /auth/login — protected by CSRF check + IP rate limiter + per-account lockout.
router.post(
  "/auth/login",
  csrfCheck,
  loginIpLimiter,
  async (req, res): Promise<void> => {
    const parsed = AuthLoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const username = parsed.data.username;

    // Per-account lockout check: reject immediately if the account is locked,
    // without performing any DB lookup or bcrypt work.
    const state = getAccountState(username);
    if (state.lockedUntil > Date.now()) {
      const retryAfterSec = Math.ceil((state.lockedUntil - Date.now()) / 1000);
      res.setHeader("Retry-After", retryAfterSec);
      res
        .status(429)
        .json({ error: "Account temporarily locked. Please try again later." });
      return;
    }

    const [user] = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.username, username), eq(usersTable.active, true)));

    // Always run bcrypt — even when no user row was found — so both code paths
    // spend the same amount of time and an attacker cannot enumerate valid
    // usernames via response latency.
    const ok =
      (await verifyPassword(
        parsed.data.password,
        user ? user.passwordHash : DUMMY_HASH,
      )) && !!user;

    if (!ok) {
      recordFailedAttempt(username);
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    // Successful login — clear any lockout state for this account.
    clearAccountState(username);

    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);

    res.json(AuthMeResponse.parse(toPublicUser(user)));
  },
);

// POST /auth/token — bearer-token login for native/mobile clients.
//
// Mirrors /auth/login's defenses (IP rate limit + per-account lockout +
// constant-time bcrypt) but returns an opaque bearer token instead of setting
// a session cookie, since React Native cannot rely on cookies. The token is
// shown to the client exactly once and replayed as `Authorization: Bearer`.
router.post(
  "/auth/token",
  csrfCheck,
  loginIpLimiter,
  async (req, res): Promise<void> => {
    const parsed = AuthLoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const username = parsed.data.username;

    const state = getAccountState(username);
    if (state.lockedUntil > Date.now()) {
      const retryAfterSec = Math.ceil((state.lockedUntil - Date.now()) / 1000);
      res.setHeader("Retry-After", retryAfterSec);
      res
        .status(429)
        .json({ error: "Account temporarily locked. Please try again later." });
      return;
    }

    const [user] = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.username, username), eq(usersTable.active, true)));

    const ok =
      (await verifyPassword(
        parsed.data.password,
        user ? user.passwordHash : DUMMY_HASH,
      )) && !!user;

    if (!ok) {
      recordFailedAttempt(username);
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    clearAccountState(username);

    const token = await issueAuthToken(user.id);
    res.json(AuthTokenResponse.parse({ token, user: toPublicUser(user) }));
  },
);

// POST /auth/logout — protected by CSRF check to prevent forced-logout attacks.
// Destroys the cookie session and, for native clients, revokes the presented
// bearer token so it can no longer authenticate.
router.post("/auth/logout", csrfCheck, async (req, res): Promise<void> => {
  await revokeAuthToken(req);
  req.session.destroy(() => {
    res.clearCookie("rss.sid");
    res.sendStatus(204);
  });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user || !user.active) {
    req.session.destroy(() => undefined);
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  res.json(AuthMeResponse.parse(toPublicUser(user)));
});

export default router;
