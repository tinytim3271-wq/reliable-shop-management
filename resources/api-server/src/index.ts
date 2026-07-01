import { sql } from "drizzle-orm";
import { runtimeConfig, ensureSchema, db, usersTable } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import { runStartupUploadCleanup, runOrphanReconciliation } from "./lib/objectStorage";
import { migrateLegacyInspectionPhotos } from "./lib/migrateInspectionPhotos";
import { runMigrations } from "stripe-replit-sync";
import { logFirstRunPosture } from "./lib/setupGuard";
import { getStripeSync } from "./stripeClient";
import { runQboRetrySweep } from "./lib/qboSync";

// How often the background sweep re-attempts failed QBO sync records. The sweep
// itself self-throttles per row via exponential backoff, so a short tick only
// determines how promptly a backed-off row becomes eligible — it never causes a
// row to be retried faster than its own backoff window allows.
const QBO_RETRY_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

// Periodically re-attempt failed QBO sync records so transient Intuit/token/
// network failures heal without an operator manually clicking Retry. The sweep
// no-ops when QBO is not configured/connected (isQboReady) and never throws, so
// this is safe to run unconditionally. Skipped in desktop mode, which is an
// offline LAN appliance with no QBO connectivity.
function startQboRetryScheduler(): void {
  if (runtimeConfig.isDesktop) return;
  const tick = () => {
    void runQboRetrySweep().catch((err) => {
      logger.error({ err }, "QBO background retry sweep failed");
    });
  };
  const timer = setInterval(tick, QBO_RETRY_SWEEP_INTERVAL_MS);
  // Don't let the recurring timer keep the process alive on shutdown.
  timer.unref();
}

// Best-effort Stripe bootstrap. This api-server backs BOTH the shop app and the
// public license storefront, so a missing Stripe connection or a Stripe/network
// outage must NEVER crash startup or delay app.listen. Every failure is caught
// and logged; the app keeps serving (the storefront simply shows no catalog).
async function initStripe(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    logger.warn("Skipping Stripe init: DATABASE_URL not set");
    return;
  }
  try {
    // 1. Create/upgrade the `stripe` schema (idempotent, safe every boot).
    await runMigrations({ databaseUrl });
    // 2. StripeSync must be constructed AFTER migrations run.
    const stripeSync = await getStripeSync();
    // 3. Register (or reuse) the managed webhook pointing at this deployment.
    const domain = process.env["REPLIT_DOMAINS"]?.split(",")[0];
    if (domain) {
      const webhook = await stripeSync.findOrCreateManagedWebhook(
        `https://${domain}/api/stripe/webhook`,
      );
      logger.info({ webhookUrl: webhook.url }, "Stripe managed webhook ready");
    } else {
      logger.warn("REPLIT_DOMAINS not set; skipped Stripe webhook registration");
    }
    // 4. Backfill existing products/prices into the local stripe schema.
    await stripeSync.syncBackfill();
    logger.info("Stripe data synced");
  } catch (err) {
    logger.error(
      { err },
      "Stripe initialization failed; continuing without Stripe",
    );
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const onListen = (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Non-blocking: surface the first-run setup posture (and, in "auto" mode, the
  // one-time setup code) while setup is still pending, so an operator deploying
  // publicly can protect the owner-account bootstrap without bricking a local
  // install. Failures here must never affect serving.
  void (async () => {
    try {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(usersTable);
      logFirstRunPosture((row?.count ?? 0) === 0);
    } catch (err) {
      logger.error({ err }, "Failed to check first-run setup posture");
    }
  })();

  // Non-blocking: delete object-storage uploads (GCS hosted, local FS desktop)
  // older than the token TTL that were never confirmed (orphans from a restart).
  void runStartupUploadCleanup();

  // Non-blocking backstop: reclaim confirmed photos that were orphaned by an
  // interrupted record delete (no registry sweep ever revisits a once-linked
  // object). Grace-period protected so it never touches an in-flight upload.
  void runOrphanReconciliation();

  // Non-blocking, idempotent: move legacy inspection photos that were embedded
  // as <img> tags in item notes into the tracked photoUrls array so they can be
  // managed (removed) and freed from storage like every other photo.
  void migrateLegacyInspectionPhotos();

  // Non-blocking, non-fatal: set up the Stripe schema, managed webhook, and data
  // backfill for the public license storefront. Wrapped so a Stripe outage never
  // crashes the server that also backs the shop app. Skipped entirely in desktop
  // mode, which is offline and has no storefront.
  if (!runtimeConfig.isDesktop) {
    void initStripe();
  }

  // Non-blocking: periodically re-attempt failed QBO sync records so transient
  // failures heal without manual intervention. Self-guards via isQboReady, so it
  // stays silent on installs that never wired up QuickBooks.
  startQboRetryScheduler();
};

// Desktop binds explicitly to 0.0.0.0 so the installed hub is reachable by
// Android companions and other devices across the shop LAN. Hosted keeps Node's
// default bind so the shared reverse proxy reaches it exactly as before.
async function bootstrap(): Promise<void> {
  if (runtimeConfig.isDesktop) {
    // The embedded PGlite database is single-process, so the server process that
    // holds it open must also create/upgrade its schema. Apply the generated SQL
    // migrations before serving so a fresh install comes up with a complete
    // schema. Hosted uses drizzle-kit push and skips this. The migrations folder
    // is taken from PGLITE_MIGRATIONS_DIR (wired up by the Electron host).
    await ensureSchema();
  }

  const server = runtimeConfig.isDesktop
    ? app.listen(port, "0.0.0.0", onListen)
    : app.listen(port, onListen);

  // Global backstop: Node will respond with 408 and close the connection if any
  // single request (headers + body + response) takes longer than this. This
  // prevents slow-body and connection-hold attacks from tying up server
  // resources indefinitely across all routes, not just the upload gate.
  server.requestTimeout = 120_000; // 2 minutes
}

void bootstrap();
