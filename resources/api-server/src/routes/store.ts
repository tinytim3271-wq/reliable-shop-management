import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { rateLimit } from "express-rate-limit";
import { eq } from "drizzle-orm";
import { db, getPgPool, storeOrdersTable, storeIssuanceAlertsTable } from "@workspace/db";
import {
  GetStoreProductsResponse,
  CreateStoreCheckoutBody,
  CreateStoreCheckoutResponse,
  GetStoreOrderParams,
  GetStoreOrderQueryParams,
  GetStoreOrderResponse,
} from "@workspace/api-zod";
import { csrfCheck } from "../lib/auth";
import { generateLicenseKey } from "../lib/licensing";
import { getUncachableStripeClient } from "../stripeClient";
import { notifyOwner } from "../lib/messaging";
import { logger } from "../lib/logger";

// Public license storefront. Every handler here is reachable BEFORE authGate and
// licenseGate (anonymous buyers must reach it), so the router carries its own
// per-IP rate limiting. License tiers, prices, and plan/device entitlements are
// always sourced server-side from the synced Stripe catalog or the live Stripe
// session — never trusted from the client. Sold keys are recorded in
// `store_orders`, never in the single-row `licenses` table that gates THIS app.

// Returns the canonical public origin for storefront redirect URLs.
// STOREFRONT_ORIGIN takes explicit precedence; REPLIT_DOMAINS provides the
// hosted default. Returns null when neither is configured — callers must
// refuse the request rather than falling back to the untrusted Host header.
function getStorefrontOrigin(): string | null {
  const explicit = process.env["STOREFRONT_ORIGIN"];
  if (explicit) return explicit.replace(/\/$/, "");
  const domain = process.env["REPLIT_DOMAINS"]?.split(",")[0]?.trim();
  if (domain) return `https://${domain}`;
  return null;
}

// Generate a cryptographically random order secret (64 hex chars = 32 bytes).
// This is embedded in the buyer's confirmation URL by the server at checkout
// creation time and never returned to the checkout-session creator, so only
// the actual payer's browser receives it.
function generateOrderSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

// Compute the SHA-256 hex digest of an order secret for storage.
function hashOrderSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

// Constant-time comparison of two SHA-256 hex digests to resist timing attacks.
function secretsMatch(callerSecret: string, storedHash: string): boolean {
  const callerHash = hashOrderSecret(callerSecret);
  if (callerHash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(callerHash, "hex"),
    Buffer.from(storedHash, "hex"),
  );
}

// Out-of-band owner alert when a PAID Stripe Checkout session cannot be turned
// into an issued RSS-XXXX license key (the buyer paid but the confirmation page
// can't return a key — an unrecognized product, payment standing that can't be
// verified, or a store_orders row that was never created). Mirrors the reversal
// alert in webhookHandlers.ts: delegated to the outreach module's owner-alert
// path, which is inert (simulated) unless a live email provider is connected.
//
// Idempotency: the buyer's confirmation page polls this lookup repeatedly, so a
// naive call would alert on every poll. We record the affected Stripe session id
// in store_issuance_alerts (UNIQUE) and only alert when the row is FIRST
// inserted. This anchor is separate from store_orders because the failure can BE
// the missing order row, leaving nothing else to dedupe on. The insert is done
// before notifyOwner so concurrent polls collapse to a single alert.
//
// Never throws: a failure here must not abort the buyer's response (they still
// need their error/status back) — it is caught and logged.
async function alertOwnerOfIssuanceFailure(
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    const inserted = await db
      .insert(storeIssuanceAlertsTable)
      .values({ stripeSessionId: sessionId, reason })
      .onConflictDoNothing({ target: storeIssuanceAlertsTable.stripeSessionId })
      .returning({ id: storeIssuanceAlertsTable.id });

    // Already alerted for this session (repeated polling / retry) — stay silent.
    if (inserted.length === 0) return;

    const outcome = await notifyOwner({
      subject: "Action needed: a paid customer could not get their license key",
      body:
        "A customer completed payment in the license store, but the confirmation page could not issue their license key, so they are left without it.\n\n" +
        `Stripe Checkout session: ${sessionId}\n` +
        `Reason: ${reason}\n\n` +
        "Please review this order in your Stripe dashboard and either issue a key manually or refund the customer. This alert is sent once per affected order.",
    });
    logger.info(
      { sessionId, reason, delivered: outcome.delivered },
      "store key-issuance failure owner alert processed",
    );
  } catch (err) {
    logger.error(
      { err, sessionId, reason },
      "store key-issuance failure owner alert threw unexpectedly",
    );
  }
}

const router: IRouter = Router();

// Generous, bounded reads (catalog + order lookup).
const storeReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Checkout creation hits Stripe — strict per IP to resist spam/abuse.
const storeCheckoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many checkout attempts. Please try again later." },
});

type CatalogRow = {
  plan: string;
  product_name: string;
  description: string | null;
  price_id: string;
  unit_amount: number;
  currency: string;
  max_devices: number;
  tier_order: number;
};

// One active one-time price per license product (the one tagged with a `plan`
// metadata key by the seed script). DISTINCT ON keeps it deterministic if a
// product ever has more than one matching price.
async function loadCatalog(): Promise<CatalogRow[]> {
  const { rows } = await getPgPool().query<CatalogRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (p.id)
         p.metadata->>'plan'                  AS plan,
         p.name                               AS product_name,
         p.description                        AS description,
         pr.id                                AS price_id,
         pr.unit_amount                       AS unit_amount,
         pr.currency                          AS currency,
         (p.metadata->>'maxDevices')::int     AS max_devices,
         (p.metadata->>'tierOrder')::int      AS tier_order
       FROM stripe.products p
       JOIN stripe.prices pr
         ON pr.product = p.id
        AND pr.active = true
        AND pr.type = 'one_time'
       WHERE p.active = true
         AND p.metadata ? 'plan'
         AND p.metadata ? 'tierOrder'
         AND p.metadata ? 'maxDevices'
       ORDER BY p.id, pr.created DESC
     ) t
     ORDER BY t.tier_order ASC`,
  );
  return rows;
}

// GET /store/products — public license tiers, ordered by tier.
router.get("/store/products", storeReadLimiter, async (_req, res) => {
  const catalog = await loadCatalog();
  res.json(
    GetStoreProductsResponse.parse(
      catalog.map((row) => ({
        plan: row.plan,
        productName: row.product_name,
        description: row.description,
        priceId: row.price_id,
        unitAmount: row.unit_amount,
        currency: row.currency,
        maxDevices: row.max_devices,
        tierOrder: row.tier_order,
      })),
    ),
  );
});

// POST /store/checkout — open a hosted Stripe Checkout session for a tier.
router.post(
  "/store/checkout",
  // csrfCheck first so rejected cross-origin requests don't burn rate budget.
  csrfCheck,
  storeCheckoutLimiter,
  async (req, res) => {
    const parsed = CreateStoreCheckoutBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    // Only allow checkout for a price that belongs to one of our license
    // products — never let the client check out an arbitrary price id.
    const catalog = await loadCatalog();
    const match = catalog.find((row) => row.price_id === parsed.data.priceId);
    if (!match) {
      res.status(400).json({ error: "Unknown or invalid price id" });
      return;
    }

    // Return URLs must use a server-trusted canonical origin, never the
    // incoming Host header (which an attacker can spoof to redirect buyers to
    // an attacker-controlled domain and capture the Stripe session id).
    // Priority: explicit STOREFRONT_ORIGIN env > REPLIT_DOMAINS first entry.
    // If neither is set in production the request is rejected fail-closed.
    const base = getStorefrontOrigin();
    if (!base) {
      req.log.error(
        "Storefront origin not configured (set STOREFRONT_ORIGIN or REPLIT_DOMAINS)",
      );
      res.status(503).json({ error: "Storefront not available" });
      return;
    }

    // Generate a server-side order secret. This is embedded in the success URL
    // path so only the buyer's browser (who is redirected by Stripe after
    // payment) receives it. The creator of the checkout session (who may be an
    // attacker) gets back only the Stripe-hosted checkout URL — they cannot
    // recover the success URL's content from it. The SHA-256 hash is stored in
    // the Stripe session metadata so the server can verify it later without
    // storing the raw secret.
    const orderSecret = generateOrderSecret();
    const orderSecretHash = hashOrderSecret(orderSecret);

    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "payment", // one-time purchase, never a subscription
      line_items: [{ price: match.price_id, quantity: 1 }],
      // The order secret is embedded as a path segment so Stripe includes it
      // in the redirect URL delivered exclusively to the payer's browser.
      success_url: `${base}/store/confirmation/{CHECKOUT_SESSION_ID}/${orderSecret}`,
      cancel_url: `${base}/store/canceled`,
      // Store the hash in Stripe metadata so we can verify the secret before
      // a DB row exists (on the buyer's very first order-lookup after payment).
      metadata: { orderSecretHash },
    });

    if (!session.url) {
      res.status(502).json({ error: "Could not start checkout" });
      return;
    }
    res.json(
      CreateStoreCheckoutResponse.parse({
        url: session.url,
      }),
    );
  },
);

// GET /store/order/:sessionId — look up an order; issue the key once when paid.
// Requires ?secret= matching the server-generated order secret embedded in the
// buyer's confirmation URL. An attacker who created the checkout session only
// receives the Stripe-hosted checkout URL (session.url); Stripe does not expose
// the success_url content to the session creator, so the attacker cannot
// recover the order secret even knowing the session id.
router.get("/store/order/:sessionId", storeReadLimiter, async (req, res) => {
  const params = GetStoreOrderParams.safeParse(req.params);
  if (!params.success || !params.data.sessionId.startsWith("cs_")) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  const sessionId = params.data.sessionId;

  if (req.query["secret"] === undefined) {
    res.status(400).json({ error: "secret query parameter is required" });
    return;
  }
  const query = GetStoreOrderQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "secret query parameter is required" });
    return;
  }
  const callerSecret = query.data.secret;

  // Already issued? Return the recorded key verbatim (idempotent), but only
  // after verifying the caller's secret matches the stored hash.
  let [order] = await db
    .select()
    .from(storeOrdersTable)
    .where(eq(storeOrdersTable.stripeSessionId, sessionId))
    .limit(1);

  if (order) {
    // Order already exists in DB. Verify the caller's secret before disclosing
    // any buyer details. Rows without an orderSecretHash are legacy rows that
    // pre-date the secret mechanism; deny them unconditionally — email is not a
    // sufficient credential and the legacy fallback has been removed.
    if (order.orderSecretHash === null) {
      res.status(403).json({ error: "Invalid order secret" });
      return;
    }
    if (!secretsMatch(callerSecret, order.orderSecretHash)) {
      res.status(403).json({ error: "Invalid order secret" });
      return;
    }

    const isPaid = order.status === "paid";
    res.json(
      GetStoreOrderResponse.parse({
        status: order.status,
        paid: isPaid,
        licenseKey: isPaid ? order.licenseKey : null,
        plan: order.plan,
        productName: order.productName,
        maxDevices: order.maxDevices,
        amountTotal: order.amountTotal,
        currency: order.currency,
        customerEmail: order.customerEmail,
      }),
    );
    return;
  }

  // No DB row yet — check Stripe directly.
  const stripe = await getUncachableStripeClient();
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items.data.price.product"],
    });
  } catch {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  if (session.payment_status !== "paid") {
    // Not paid yet (or canceled): report status, mint nothing. No secret check
    // needed — there is no sensitive order data to disclose for unpaid sessions.
    res.json(
      GetStoreOrderResponse.parse({
        status: session.payment_status ?? "unpaid",
        paid: false,
        licenseKey: null,
        plan: null,
        productName: null,
        maxDevices: null,
        amountTotal: null,
        currency: null,
        customerEmail: null,
      }),
    );
    return;
  }

  // Session is paid. Verify the caller's secret against the hash stored in the
  // Stripe session metadata BEFORE minting a key. Sessions created before this
  // change have no metadata hash; deny them unconditionally — email is not a
  // sufficient credential and the legacy email-fallback has been removed.
  const storedHash = session.metadata?.["orderSecretHash"] ?? null;
  if (storedHash === null) {
    res.status(403).json({ error: "Invalid order secret" });
    return;
  }
  if (!secretsMatch(callerSecret, storedHash)) {
    res.status(403).json({ error: "Invalid order secret" });
    return;
  }

  // Paid — read the tier entitlements from the product metadata server-side.
  const product = session.line_items?.data?.[0]?.price?.product;
  const meta =
    product && typeof product === "object" && "metadata" in product
      ? product.metadata
      : null;
  const plan = meta?.["plan"];
  const maxDevices = Number(meta?.["maxDevices"]);
  const productName =
    product && typeof product === "object" && "name" in product
      ? product.name
      : null;

  if (!plan || !Number.isFinite(maxDevices) || maxDevices < 1) {
    // The buyer paid, but the purchased product carries no recognizable license
    // entitlement, so no key can be minted. Alert the owner once.
    await alertOwnerOfIssuanceFailure(sessionId, "unrecognized_product");
    res
      .status(422)
      .json({ error: "Order is not a recognized license product" });
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  // Before minting a key, verify the payment hasn't been reversed since
  // the checkout session was paid. Stripe's session.payment_status stays
  // "paid" even after a refund or dispute — the reversal state lives on
  // the charge. This closes the race where a refund/dispute webhook arrives
  // before the buyer's first order-lookup, so reconcileStoreOrderByPaymentIntent
  // in the webhook handler found no row and was a no-op.
  if (paymentIntentId) {
    let charge: { refunded?: boolean; disputed?: boolean } | null = null;
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge"],
      });
      const lc = pi.latest_charge;
      if (lc && typeof lc === "object") {
        charge = lc as { refunded?: boolean; disputed?: boolean };
      }
    } catch {
      // Fail closed: if we cannot verify payment standing, refuse to mint. The
      // buyer paid but can't get their key, so alert the owner once.
      await alertOwnerOfIssuanceFailure(sessionId, "payment_status_unverifiable");
      res.status(502).json({ error: "Could not verify payment status" });
      return;
    }
    if (charge?.refunded) {
      res.json(
        GetStoreOrderResponse.parse({
          status: "refunded",
          paid: false,
          licenseKey: null,
          plan: null,
          productName: null,
          maxDevices: null,
          amountTotal: null,
          currency: null,
          customerEmail: null,
        }),
      );
      return;
    }
    if (charge?.disputed) {
      res.json(
        GetStoreOrderResponse.parse({
          status: "disputed",
          paid: false,
          licenseKey: null,
          plan: null,
          productName: null,
          maxDevices: null,
          amountTotal: null,
          currency: null,
          customerEmail: null,
        }),
      );
      return;
    }
  }

  // Idempotent + race-safe: the unique stripe_session_id means a concurrent
  // request that inserted first wins; we then re-select its row (and its
  // already-minted key) instead of issuing a second one.
  const stripeEmail = session.customer_details?.email ?? null;
  const newSecretHash = storedHash ?? null;
  await db
    .insert(storeOrdersTable)
    .values({
      stripeSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      customerEmail: stripeEmail,
      plan,
      productName: productName ?? plan,
      maxDevices,
      licenseKey: generateLicenseKey(),
      amountTotal: session.amount_total ?? 0,
      currency: session.currency ?? "usd",
      status: "paid",
      orderSecretHash: newSecretHash,
    })
    .onConflictDoNothing({ target: storeOrdersTable.stripeSessionId });

  [order] = await db
    .select()
    .from(storeOrdersTable)
    .where(eq(storeOrdersTable.stripeSessionId, session.id))
    .limit(1);

  if (!order) {
    // Payment succeeded but the store_orders row was never created (and the
    // insert above did not surface it either), so the buyer cannot get a key.
    // Alert the owner once.
    await alertOwnerOfIssuanceFailure(sessionId, "order_row_not_created");
    res.status(404).json({ error: "Order not found" });
    return;
  }

  const isPaid = order.status === "paid";
  res.json(
    GetStoreOrderResponse.parse({
      status: order.status,
      paid: isPaid,
      // Only surface the license key while the order is in good standing.
      // Refunded or disputed orders must not echo the key — it is already
      // blocked at the activation endpoint, but withholding it here removes
      // any incentive to re-poll after a payment reversal.
      licenseKey: isPaid ? order.licenseKey : null,
      plan: order.plan,
      productName: order.productName,
      maxDevices: order.maxDevices,
      amountTotal: order.amountTotal,
      currency: order.currency,
      customerEmail: order.customerEmail,
    }),
  );
});

export default router;
