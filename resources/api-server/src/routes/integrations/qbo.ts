import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { rateLimit } from "express-rate-limit";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  db,
  qboConnectionsTable,
  qboOauthStatesTable,
  qboSyncLogTable,
} from "@workspace/db";
import {
  GetQboStatusResponse,
  GetQboConnectUrlResponse,
  DisconnectQboResponse,
  RunQboSyncResponse,
  GetQboAccountsResponse,
  GetQboMappingResponse,
  UpdateQboMappingBody,
  UpdateQboMappingResponse,
  GetQboSyncLogQueryParams,
  GetQboSyncLogResponse,
  RetryQboSyncLogParams,
  RetryQboSyncLogResponse,
  RetryAllPermanentlyFailedQboSyncLogResponse,
} from "@workspace/api-zod";
import {
  getQboConfig,
  isQboConfigured,
  loadConnectionRow,
  isConnected,
  buildAuthorizeUrl,
  exchangeCodeAndStore,
  revokeAndClear,
  saveAccountMapping,
  QboNotConfiguredError,
  QboNotConnectedError,
} from "../../lib/qboClient";
import {
  runFullSync,
  pullAccounts,
  retrySyncLog,
  requeuePermanentlyFailed,
  type QboEntityType,
} from "../../lib/qboSync";
import { logger } from "../../lib/logger";

// ---------------------------------------------------------------------------
// QuickBooks Online integration routes.
//
// The OAuth callback is PUBLIC (Intuit redirects the browser to it with a code
// and the state we minted), so it lives on its own router mounted before
// authGate. Every other endpoint is protected and mapped to the "accounting"
// permission via ROUTE_PERMISSIONS ("/integrations/qbo" -> accounting).
// ---------------------------------------------------------------------------

// How long a minted OAuth state stays valid before the callback rejects it.
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

// Where to send the browser after the OAuth round-trip completes.
function settingsRedirect(status: "connected" | "error", detail?: string): string {
  const base = "/settings?tab=integrations&qbo=";
  return detail
    ? `${base}${status}&message=${encodeURIComponent(detail.slice(0, 200))}`
    : `${base}${status}`;
}

function buildStatusPayload() {
  return async () => {
    const configured = isQboConfigured();
    const row = await loadConnectionRow();
    const connected = configured && isConnected(row);
    // Count records the background sweep gave up on so the UI can proactively
    // alert the operator (nav badge + Integrations banner). Counted regardless
    // of connection state: a row can stay `failed_permanent` after a disconnect
    // and still represents accounting data that never reached QuickBooks.
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(qboSyncLogTable)
      .where(eq(qboSyncLogTable.status, "failed_permanent"));
    return {
      configured,
      connected,
      companyName: connected ? row.companyName : null,
      realmId: connected ? row.realmId : null,
      connectedAt: connected ? row.connectedAt : null,
      lastSyncAt: row.lastSyncAt,
      permanentFailureCount: count,
    };
  };
}

// ===========================================================================
// Public callback router (mounted before authGate)
// ===========================================================================

export const qboCallbackRouter: IRouter = Router();

// Bounded: the callback hits Intuit's token endpoint on behalf of a redirect.
const callbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

qboCallbackRouter.get(
  "/integrations/qbo/callback",
  callbackLimiter,
  async (req, res) => {
    const cfg = getQboConfig();
    if (!cfg) {
      res.redirect(settingsRedirect("error", "QuickBooks is not configured"));
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const realmId =
      typeof req.query.realmId === "string" ? req.query.realmId : "";
    const oauthError =
      typeof req.query.error === "string" ? req.query.error : "";

    if (oauthError) {
      res.redirect(settingsRedirect("error", oauthError));
      return;
    }
    if (!code || !state || !realmId) {
      res.redirect(settingsRedirect("error", "Missing OAuth parameters"));
      return;
    }

    // Validate + consume the single-use state (CSRF/replay guard). Delete first
    // so a replayed callback cannot reuse it.
    const [stateRow] = await db
      .delete(qboOauthStatesTable)
      .where(eq(qboOauthStatesTable.state, state))
      .returning();
    if (!stateRow) {
      res.redirect(settingsRedirect("error", "Invalid or expired state"));
      return;
    }
    if (
      Date.now() - new Date(stateRow.createdAt).getTime() >
      OAUTH_STATE_TTL_MS
    ) {
      res.redirect(settingsRedirect("error", "Authorization request expired"));
      return;
    }
    // Bind the callback to the session that initiated the connect. The state row
    // records the initiating user; the returning browser must carry that same
    // logged-in session (its cookie rides the top-level OAuth redirect), so a
    // state leaked/replayed from another context cannot complete the link.
    if (
      stateRow.userId != null &&
      req.session?.userId !== stateRow.userId
    ) {
      res.redirect(settingsRedirect("error", "Session mismatch — reconnect from Settings"));
      return;
    }

    try {
      await exchangeCodeAndStore(cfg, code, realmId);
      res.redirect(settingsRedirect("connected"));
    } catch (err) {
      logger.error({ err }, "QBO OAuth token exchange failed");
      res.redirect(settingsRedirect("error", "Could not connect to QuickBooks"));
    }
  },
);

// ===========================================================================
// Protected router (mounted after authGate; "accounting" permission)
// ===========================================================================

const router: IRouter = Router();

// GET /integrations/qbo/status
router.get("/integrations/qbo/status", async (_req, res) => {
  const payload = await buildStatusPayload()();
  res.json(GetQboStatusResponse.parse(payload));
});

// GET /integrations/qbo/connect — mint state, return the Intuit authorize URL.
router.get("/integrations/qbo/connect", async (req, res) => {
  const cfg = getQboConfig();
  if (!cfg) {
    res
      .status(503)
      .json({ error: "QuickBooks Online is not configured on this install" });
    return;
  }
  // Opportunistically prune stale states.
  await db
    .delete(qboOauthStatesTable)
    .where(
      lt(
        qboOauthStatesTable.createdAt,
        new Date(Date.now() - OAUTH_STATE_TTL_MS).toISOString(),
      ),
    );
  const state = crypto.randomBytes(32).toString("hex");
  await db.insert(qboOauthStatesTable).values({
    state,
    userId: req.currentUser?.id ?? null,
  });
  const url = buildAuthorizeUrl(cfg, state);
  res.json(GetQboConnectUrlResponse.parse({ url }));
});

// DELETE /integrations/qbo/disconnect — revoke + clear stored tokens.
router.delete("/integrations/qbo/disconnect", async (_req, res) => {
  const cfg = getQboConfig();
  const row = await loadConnectionRow();
  if (cfg && isConnected(row)) {
    await revokeAndClear(cfg, row);
  }
  const payload = await buildStatusPayload()();
  res.json(DisconnectQboResponse.parse(payload));
});

// POST /integrations/qbo/sync — full reconcile (pull then push).
router.post("/integrations/qbo/sync", async (_req, res) => {
  try {
    const result = await runFullSync();
    res.json(RunQboSyncResponse.parse(result));
  } catch (err) {
    handleQboError(err, res);
  }
});

// GET /integrations/qbo/accounts — chart of accounts for the mapping UI.
router.get("/integrations/qbo/accounts", async (_req, res) => {
  try {
    const accounts = await pullAccounts();
    res.json(GetQboAccountsResponse.parse(accounts));
  } catch (err) {
    handleQboError(err, res);
  }
});

// GET /integrations/qbo/mapping
router.get("/integrations/qbo/mapping", async (_req, res) => {
  const row = await loadConnectionRow();
  res.json(GetQboMappingResponse.parse(row.accountMapping ?? {}));
});

// PUT /integrations/qbo/mapping
router.put("/integrations/qbo/mapping", async (req, res) => {
  const parsed = UpdateQboMappingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid mapping" });
    return;
  }
  const row = await loadConnectionRow();
  const saved = await saveAccountMapping(row.id, parsed.data);
  // A missing/incorrect account mapping is the most common cause of records the
  // background sweep gave up on. Once the operator corrects the mapping, reset
  // any `failed_permanent` rows back to eligible so the sweep re-attempts them
  // automatically without a manual click.
  try {
    const requeued = await requeuePermanentlyFailed();
    if (requeued.length > 0) {
      logger.info(
        { requeued: requeued.length },
        "QBO mapping updated: requeued permanently-failed sync records",
      );
    }
  } catch (err) {
    // Never fail the mapping save because the requeue bookkeeping hiccupped.
    logger.error({ err }, "Failed to requeue permanently-failed QBO records");
  }
  res.json(UpdateQboMappingResponse.parse(saved));
});

// GET /integrations/qbo/log — paginated per-record sync log.
router.get("/integrations/qbo/log", async (req, res) => {
  const parsed = GetQboSyncLogQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const { entityType, status, entityId, limit = 50, offset = 0 } = parsed.data;
  const filters = [
    entityType ? eq(qboSyncLogTable.entityType, entityType) : undefined,
    status ? eq(qboSyncLogTable.status, status) : undefined,
    entityId !== undefined ? eq(qboSyncLogTable.entityId, entityId) : undefined,
  ].filter(Boolean);
  const whereClause = filters.length ? and(...filters) : undefined;

  // Grouped failure-reason summary computed globally across all failed /
  // failed_permanent records, independent of the page's filters. Lets the
  // operator see exactly what to fix before clicking "Retry all".
  const failedWhere = inArray(qboSyncLogTable.status, [
    "failed",
    "failed_permanent",
  ]);
  const [countResult, items, rawReasons] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(qboSyncLogTable)
      .where(whereClause)
      .then((r) => r[0]),
    db
      .select()
      .from(qboSyncLogTable)
      .where(whereClause)
      .orderBy(desc(qboSyncLogTable.lastAttemptedAt), desc(qboSyncLogTable.id))
      .limit(limit)
      .offset(offset),
    db
      .select({
        reason: qboSyncLogTable.error,
        count: sql<number>`count(*)::int`,
      })
      .from(qboSyncLogTable)
      .where(failedWhere)
      .groupBy(qboSyncLogTable.error)
      .orderBy(desc(sql<number>`count(*)`)),
  ]);

  const failureReasons = rawReasons.map((r) => ({
    reason: r.reason?.trim() || "Unknown error",
    count: r.count,
  }));

  res.json(
    GetQboSyncLogResponse.parse({
      items: items.map((i) => ({
        id: i.id,
        entityType: i.entityType,
        entityId: i.entityId,
        qboId: i.qboId,
        status: i.status,
        attempts: i.attempts,
        lastAttemptedAt: i.lastAttemptedAt,
        error: i.error,
        createdAt: i.createdAt,
      })),
      total: countResult.count,
      limit,
      offset,
      failureReasons,
    }),
  );
});

// POST /integrations/qbo/log/:id/retry — re-push one record.
router.post("/integrations/qbo/log/:id/retry", async (req, res) => {
  const parsed = RetryQboSyncLogParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [entry] = await db
    .select()
    .from(qboSyncLogTable)
    .where(eq(qboSyncLogTable.id, parsed.data.id))
    .limit(1);
  if (!entry) {
    res.status(404).json({ error: "Sync log entry not found" });
    return;
  }
  if (!isQboConfigured() || !isConnected(await loadConnectionRow())) {
    res.status(409).json({ error: "Not connected to QuickBooks Online" });
    return;
  }
  // A manual retry restarts the bounded auto-retry cycle: zero the counter so a
  // record the background sweep had given up on (`failed_permanent`) becomes
  // eligible for automatic re-attempts again. retrySyncLog overwrites the status
  // to synced/failed below, so this only matters for the still-failing path.
  await db
    .update(qboSyncLogTable)
    .set({ attempts: 0 })
    .where(eq(qboSyncLogTable.id, entry.id));
  try {
    await retrySyncLog(entry.entityType as QboEntityType, entry.entityId);
  } catch (err) {
    handleQboError(err, res);
    return;
  }
  const [updated] = await db
    .select()
    .from(qboSyncLogTable)
    .where(eq(qboSyncLogTable.id, entry.id))
    .limit(1);
  res.json(
    RetryQboSyncLogResponse.parse({
      id: updated.id,
      entityType: updated.entityType,
      entityId: updated.entityId,
      qboId: updated.qboId,
      status: updated.status,
      attempts: updated.attempts,
      lastAttemptedAt: updated.lastAttemptedAt,
      error: updated.error,
      createdAt: updated.createdAt,
    }),
  );
});

// POST /integrations/qbo/log/retry-all — re-attempt every permanently-failed
// record at once (after the operator fixed the underlying cause). Each row is
// reset and re-pushed; ones that still fail drop back to `failed` with a cleared
// counter so the background sweep resumes auto-retrying them.
router.post("/integrations/qbo/log/retry-all", async (_req, res) => {
  if (!isQboConfigured() || !isConnected(await loadConnectionRow())) {
    res.status(409).json({ error: "Not connected to QuickBooks Online" });
    return;
  }
  // Reset all failed_permanent rows to eligible (status=failed, attempts=0,
  // lastAttemptedAt=null), then re-push each once for immediate feedback.
  const requeuedRows = await requeuePermanentlyFailed();
  let recovered = 0;
  let stillFailing = 0;
  for (const row of requeuedRows) {
    let ok = false;
    try {
      ok = await retrySyncLog(row.entityType as QboEntityType, row.entityId);
    } catch (err) {
      // retrySyncLog records its own per-row failure; this only guards the loop.
      logger.error({ err, logId: row.id }, "QBO retry-all push threw");
      ok = false;
    }
    ok ? (recovered += 1) : (stillFailing += 1);
  }
  res.json(
    RetryAllPermanentlyFailedQboSyncLogResponse.parse({
      requeued: requeuedRows.length,
      recovered,
      stillFailing,
    }),
  );
});

// Maps the typed QBO errors to HTTP responses. Unknown errors bubble to the
// global error handler (which never leaks internals).
function handleQboError(err: unknown, res: import("express").Response): void {
  if (err instanceof QboNotConfiguredError) {
    res
      .status(503)
      .json({ error: "QuickBooks Online is not configured on this install" });
    return;
  }
  if (err instanceof QboNotConnectedError) {
    res.status(409).json({ error: "Not connected to QuickBooks Online" });
    return;
  }
  logger.error({ err }, "QBO request failed");
  res.status(502).json({ error: "QuickBooks request failed" });
}

export default router;
