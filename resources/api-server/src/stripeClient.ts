import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";

/**
 * Fetches Stripe credentials from the Replit connection API.
 * Not cached -- tokens can rotate, so fetch fresh each time.
 */
async function getStripeCredentials(): Promise<{
  secretKey: string;
  webhookSecret?: string;
}> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      "Missing Replit environment variables. " +
        "Ensure the Stripe integration is connected via the Integrations tab.",
    );
  }

  const resp = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`,
    {
      headers: { Accept: "application/json", X_REPLIT_TOKEN: xReplitToken },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!resp.ok) {
    throw new Error(
      `Failed to fetch Stripe credentials: ${resp.status} ${resp.statusText}`,
    );
  }

  const data = (await resp.json()) as {
    items?: Array<{
      settings?: {
        secret_key?: string;
        secret?: string;
        webhook_secret?: string;
      };
    }>;
  };
  const settings = data.items?.[0]?.settings;

  // The Replit Stripe connector exposes the secret key as `secret`; older
  // templates used `secret_key`. Accept either so we are robust to connector
  // versions. Managed webhooks store their own signing secret server-side, so
  // `webhook_secret` is typically absent here (handled by getStripeSync).
  const secretKey = settings?.secret_key ?? settings?.secret;

  if (!secretKey) {
    throw new Error(
      "Stripe integration not connected or missing secret key. " +
        "Connect Stripe via the Integrations tab first.",
    );
  }

  return {
    secretKey,
    webhookSecret: settings?.webhook_secret,
  };
}

/**
 * Returns a fresh authenticated Stripe client.
 * Not cached -- fetches credentials on every call so rotated keys are picked up.
 */
export async function getUncachableStripeClient(): Promise<Stripe> {
  const { secretKey } = await getStripeCredentials();
  // Bound outbound calls: the storefront reaches Stripe on behalf of
  // unauthenticated callers, so a slow/hung Stripe response must not pin a
  // worker. One network retry smooths transient blips without unbounded waits.
  return new Stripe(secretKey, { timeout: 15_000, maxNetworkRetries: 1 });
}

// --- Cached plain Stripe client -------------------------------------------
// Used by the license gate for payment-intent standing checks. Caches the
// Stripe instance (not just the credential fetch) so a burst of gate checks
// within the TTL window only pays one round-trip to the Replit connectors API.
const STRIPE_CLIENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let stripeClientCache: { client: Stripe; expiresAt: number } | null = null;

/**
 * Returns a cached Stripe client, refreshing credentials at most once every
 * 5 minutes. Returns null when Stripe credentials are not available so callers
 * can degrade gracefully instead of throwing.
 */
export async function getCachedStripeClientOrNull(): Promise<Stripe | null> {
  const now = Date.now();
  if (stripeClientCache && stripeClientCache.expiresAt > now) {
    return stripeClientCache.client;
  }
  try {
    const { secretKey } = await getStripeCredentials();
    const client = new Stripe(secretKey, { timeout: 10_000, maxNetworkRetries: 1 });
    stripeClientCache = { client, expiresAt: now + STRIPE_CLIENT_CACHE_TTL_MS };
    return client;
  } catch {
    return null;
  }
}

// --- StripeSync cache ------------------------------------------------------
// A flood of unauthenticated webhook requests (all bearing a dummy stripe-signature
// header) cannot each trigger an outbound Replit connector API fetch. The cache
// TTL is short enough that legitimately rotated keys are picked up within minutes.
// A flood of fake requests still hits Stripe's own signature verification and is
// rejected there, but the expensive credential I/O is only incurred once per TTL window.
const STRIPE_SYNC_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let stripeSyncCache: { sync: StripeSync; expiresAt: number } | null = null;

/**
 * Returns a cached StripeSync instance, refreshing credentials at most once
 * every 5 minutes. Rotated keys are picked up within the TTL window.
 */
export async function getStripeSync(): Promise<StripeSync> {
  const now = Date.now();
  if (stripeSyncCache && stripeSyncCache.expiresAt > now) {
    return stripeSyncCache.sync;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const { secretKey, webhookSecret } = await getStripeCredentials();
  const sync = new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey: secretKey,
    stripeWebhookSecret: webhookSecret ?? "",
  });

  stripeSyncCache = { sync, expiresAt: now + STRIPE_SYNC_CACHE_TTL_MS };
  return sync;
}
