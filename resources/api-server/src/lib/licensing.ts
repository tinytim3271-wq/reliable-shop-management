import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { db, licensesTable, licenseDevicesTable, storeOrdersTable } from "@workspace/db";
import { isCompanionRequest } from "./companionTransport";
import { logger } from "./logger";

// Header the client sends its (raw) device token on for gated requests.
export const DEVICE_TOKEN_HEADER = "x-device-token";

// License keys look like RSS-XXXX-XXXX-XXXX-XXXX (uppercase, no ambiguous chars).
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateLicenseKey(): string {
  const group = () =>
    Array.from(
      { length: 4 },
      () => KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)],
    ).join("");
  return `RSS-${group()}-${group()}-${group()}-${group()}`;
}

export function generateDeviceToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashDeviceToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function enforcementEnabled(): boolean {
  return process.env.LICENSE_ENFORCEMENT !== "off";
}

// The owner's personal master key (a "skeleton key"). It is read ONLY from the
// MASTER_LICENSE_KEY secret and is never stored in the database, so the same
// secret value can unlock any deployment of any program the owner controls.
export function getMasterKey(): string | null {
  const k = process.env.MASTER_LICENSE_KEY?.trim();
  return k && k.length > 0 ? k : null;
}

// Constant-time comparison so a configured master key cannot be guessed by
// timing. Returns false when no master key is configured.
export function isMasterKey(candidate: string): boolean {
  const master = getMasterKey();
  if (!master) return false;
  const a = Buffer.from(candidate.trim());
  const b = Buffer.from(master);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Authoritative Stripe payment-intent standing check
// ---------------------------------------------------------------------------
// A sold license records the Stripe payment-intent id at activation time.
// On every gate check (after DB cache miss) we re-verify directly against
// Stripe so a refund or chargeback is caught regardless of which database the
// licenses row lives in — closing the cross-database gap where the webhook
// only reaches the hosted storefront's DB.
//
// The result is cached per payment-intent id with a 5-minute TTL to avoid
// hammering Stripe on high-traffic installations.  When Stripe is unreachable
// or not configured the function returns "unavailable", which the gate and
// heartbeat treat as fail-closed (blocking access) for store-provisioned
// licenses — preventing perpetual access after a refund when Stripe is down.

type PaymentIntentStanding = "paid" | "reversed" | "unavailable";

const PI_STANDING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const piStandingCache = new Map<string, { standing: PaymentIntentStanding; expiresAt: number }>();

async function checkStripePaymentIntentStanding(
  paymentIntentId: string,
): Promise<PaymentIntentStanding> {
  const now = Date.now();
  const cached = piStandingCache.get(paymentIntentId);
  if (cached && cached.expiresAt > now) return cached.standing;

  try {
    // Lazy-import to avoid loading Stripe credentials on every module load and
    // to allow graceful degradation when Stripe is not configured.
    const { getCachedStripeClientOrNull } = await import("../stripeClient");
    const stripe = await getCachedStripeClientOrNull();
    if (!stripe) {
      // Stripe not configured (e.g. offline desktop install) — fall back to
      // local store_orders check in the caller.
      return "unavailable";
    }

    // List charges for this payment intent (there is typically exactly one).
    const charges = await stripe.charges.list({
      payment_intent: paymentIntentId,
      limit: 1,
    });
    const charge = charges.data[0];

    let standing: PaymentIntentStanding;
    if (!charge) {
      // No charge found — treat as unavailable so we fall back to local check.
      standing = "unavailable";
    } else if (charge.refunded || charge.amount_refunded > 0 || charge.disputed) {
      standing = "reversed";
    } else {
      standing = "paid";
    }

    // Cache the result. For confirmed reversals we use a shorter TTL so a
    // won-dispute recovery propagates sooner; "unavailable" is not cached so
    // the next gate check retries immediately.
    if (standing !== "unavailable") {
      piStandingCache.set(paymentIntentId, {
        standing,
        expiresAt: now + (standing === "reversed" ? 60_000 : PI_STANDING_CACHE_TTL_MS),
      });
    }
    return standing;
  } catch (err) {
    logger.warn({ err, paymentIntentId }, "Stripe payment-intent standing check failed; falling back to local store_orders");
    return "unavailable";
  }
}

// Exported so the validate heartbeat can reuse the same authoritative check
// without duplicating the caching logic.
export { checkStripePaymentIntentStanding };

// Fire-and-forget helper: propagate a payment-reversal revocation to the
// local licenses + license_devices rows so the webhook's normal path and
// subsequent DB-only checks find the rows already revoked.
async function propagateLicenseRevocation(licenseId: number, licenseKey: string): Promise<void> {
  try {
    await db
      .update(licensesTable)
      .set({ status: "revoked" })
      .where(eq(licensesTable.licenseKey, licenseKey));
    await db
      .update(licenseDevicesTable)
      .set({ status: "deactivated", deactivatedAt: new Date().toISOString() })
      .where(
        and(
          eq(licenseDevicesTable.licenseId, licenseId),
          eq(licenseDevicesTable.status, "active"),
        ),
      );
    invalidateLicenseCache();
  } catch (err) {
    logger.warn({ err, licenseKey }, "Failed to propagate license revocation; next gate check will retry");
  }
}

// ---------------------------------------------------------------------------
// License state cache
// ---------------------------------------------------------------------------

// Tri-state model for license enforcement:
//
//   "unlicensed" — no licenses row exists yet (or the row is inactive).
//                  licenseGate passes through so a fresh install is never
//                  bricked before the operator activates a license.
//
//   "active"     — a license is installed and payment standing confirmed.
//                  licenseGate enforces device-token registration.
//
//   "blocked"    — a license exists but payment standing could not be
//                  confirmed (reversed or unavailable from Stripe, or local
//                  store_orders shows non-paid status).
//                  licenseGate returns 403 immediately — fail-closed.
//
// This separation prevents the original design intent of "pass through on
// unlicensed" from silently also passing through revoked/refunded licenses.
type LicenseState =
  | { status: "unlicensed" }
  | { status: "active"; activeTokenHashes: Set<string> }
  | { status: "blocked"; reason: "reversed" | "unavailable" | "local_revoked" };

// Short-lived cache so the gate does not hit the DB on every request. It is
// explicitly invalidated by every license mutation so enforcement reacts
// immediately to issue/activate/deactivate/revoke.
let cache: { state: LicenseState; expires: number } | null = null;
const CACHE_TTL_MS = 15_000;

export function invalidateLicenseCache(): void {
  cache = null;
}

async function loadLicenseState(): Promise<LicenseState> {
  const [license] = await db.select().from(licensesTable).limit(1);

  // "unlicensed" is strictly "no row exists" — a fresh install with no key
  // activated yet.  Pass-through is intentional here so the API stays usable
  // while the operator completes setup.
  if (!license) {
    return { status: "unlicensed" };
  }

  // A row that exists but is not "active" (e.g. "revoked", "suspended") must
  // be treated as blocked, not as unlicensed.  This prevents the revocation
  // side-effect of propagateLicenseRevocation (which sets status → "revoked"
  // and clears the cache) from accidentally downgrading enforcement to the
  // pass-through path used for fresh installs.
  if (license.status !== "active") {
    return { status: "blocked", reason: "local_revoked" };
  }

  // Authoritative standing check for store-provisioned licenses.
  //
  // When a license was provisioned from a storefront purchase the Stripe
  // payment-intent id is stored on the row so subsequent gate checks can
  // verify payment standing from Stripe directly — the single authoritative
  // source that reflects reversals regardless of which database the licenses
  // row lives in.
  //
  // Behavior:
  //   "reversed"    → blocked (+ propagate local revocation)
  //   "unavailable" → blocked (fail-closed; prevents perpetual offline access
  //                   after a refund since Stripe is the sole truth)
  //   "paid"        → proceed to device check (no local store_orders needed)
  //
  // For licenses without a stored payment-intent id (directly issued via admin
  // or master key, or pre-dating this field) we fall back to the local
  // store_orders cross-check, which is authoritative for same-DB deployments
  // where the Stripe webhook keeps store_orders current.
  if (license.stripePaymentIntentId) {
    const standing = await checkStripePaymentIntentStanding(license.stripePaymentIntentId);
    if (standing === "reversed") {
      void propagateLicenseRevocation(license.id, license.licenseKey);
      return { status: "blocked", reason: "reversed" };
    }
    if (standing === "unavailable") {
      logger.warn(
        { licenseKey: license.licenseKey },
        "License gate: Stripe standing check unavailable for store-provisioned license; denying access (fail-closed)",
      );
      return { status: "blocked", reason: "unavailable" };
    }
    // standing === "paid" — Stripe confirmed; fall through to device check
  } else {
    // No Stripe PI stored on the licenses row.  Look up store_orders by key:
    //   • If store_orders has a payment-intent id, use it for an authoritative
    //     Stripe check — same fail-closed semantics as the PI-stored branch.
    //     This covers the cross-database gap for legacy activations (before we
    //     started recording the PI on licenses) and any standalone install where
    //     the webhook cannot reach the local DB.
    //   • Lazy-backfill: once confirmed "paid", write the PI onto the licenses
    //     row so future checks skip the join and go straight to Stripe.
    //   • If no store_orders row exists (directly-issued / master-key license),
    //     there is nothing to revoke — allow normally.
    //   • If store_orders exists but has no PI id, fall back to local status
    //     check (same-DB deployment where the webhook keeps status current).
    const [storeOrder] = await db
      .select({
        id: storeOrdersTable.id,
        status: storeOrdersTable.status,
        piId: storeOrdersTable.stripePaymentIntentId,
      })
      .from(storeOrdersTable)
      .where(eq(storeOrdersTable.licenseKey, license.licenseKey))
      .limit(1);

    if (storeOrder) {
      if (storeOrder.piId) {
        // Authoritative Stripe check via the store_orders PI id.
        const standing = await checkStripePaymentIntentStanding(storeOrder.piId);
        if (standing === "reversed") {
          void propagateLicenseRevocation(license.id, license.licenseKey);
          return { status: "blocked", reason: "reversed" };
        }
        if (standing === "unavailable") {
          logger.warn(
            { licenseKey: license.licenseKey },
            "License gate: Stripe standing check unavailable for legacy store-provisioned license; denying access (fail-closed)",
          );
          return { status: "blocked", reason: "unavailable" };
        }
        // "paid" — lazily backfill PI onto the licenses row so future checks
        // skip this join and go straight to the PI-based branch.
        void db
          .update(licensesTable)
          .set({ stripePaymentIntentId: storeOrder.piId })
          .where(eq(licensesTable.id, license.id))
          .catch((err) =>
            logger.warn({ err, licenseKey: license.licenseKey }, "License PI backfill failed"),
          );
      } else if (storeOrder.status !== "paid") {
        // No PI on the order row — fall back to local status (authoritative
        // only for same-DB deployments where webhook keeps status current).
        void propagateLicenseRevocation(license.id, license.licenseKey);
        return { status: "blocked", reason: "local_revoked" };
      }
    }
    // No store_orders row → directly-issued license (master key / admin issue).
    // Nothing to revoke; proceed to device check.
  }

  const devices = await db
    .select({ hash: licenseDevicesTable.deviceTokenHash })
    .from(licenseDevicesTable)
    .where(
      and(
        eq(licenseDevicesTable.licenseId, license.id),
        eq(licenseDevicesTable.status, "active"),
      ),
    );
  return {
    status: "active",
    activeTokenHashes: new Set(devices.map((d) => d.hash)),
  };
}

async function getLicenseState(): Promise<LicenseState> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.state;
  const state = await loadLicenseState();
  cache = { state, expires: now + CACHE_TTL_MS };
  return state;
}

// Authorization helper for the first-run setup flow when no SETUP_SECRET is
// configured. Reports whether a license is provisioned and, if so, whether the
// supplied device token maps to an active device. This lets bootstrap setup be
// gated on license ownership instead of a shared environment secret.
export async function getSetupDeviceAuthorization(
  token: string | undefined,
): Promise<{ provisioned: boolean; deviceActive: boolean }> {
  const state = await getLicenseState();
  // Both "unlicensed" and "blocked" are treated as not provisioned for the
  // setup flow. A blocked license cannot be used to authorize setup either.
  if (state.status !== "active") return { provisioned: false, deviceActive: false };
  const deviceActive =
    !!token && state.activeTokenHashes.has(hashDeviceToken(token));
  return { provisioned: true, deviceActive };
}

// Enforce device registration once a license is provisioned. Unprovisioned
// (no active license row) is a deliberate no-op so the app and the dev
// environment are never bricked. Setting LICENSE_ENFORCEMENT="off" is an
// emergency escape hatch.
export const licenseGate: RequestHandler = (req, res, next) => {
  if (!enforcementEnabled()) {
    next();
    return;
  }
  // Desktop companion (Android tablet): an authenticated client of the licensed
  // hub. Only the Windows hub itself consumes a device slot, so a companion
  // request — which has already passed authGate and carries the desktop-only
  // marker — is allowed without registering its own device token. The marker is
  // honored only in desktop mode (isCompanionRequest), so a hosted client can
  // never use it to skip device enforcement.
  if (isCompanionRequest(req)) {
    next();
    return;
  }
  void getLicenseState()
    .then((state) => {
      // "unlicensed": no license installed yet — pass through so a fresh
      // install can complete setup without bricking the API.
      if (state.status === "unlicensed") {
        next();
        return;
      }
      // "blocked": license exists but payment is reversed/disputed or Stripe
      // is unreachable for a store-provisioned key — fail-closed with 402.
      if (state.status === "blocked") {
        res.status(402).json({
          error: "License payment could not be verified. Access suspended.",
          code: "LICENSE_PAYMENT_INVALID",
          reason: state.reason,
        });
        return;
      }
      // "active": license valid — enforce device-token registration.
      const token = req.get(DEVICE_TOKEN_HEADER);
      if (token && state.activeTokenHashes.has(hashDeviceToken(token))) {
        next();
        return;
      }
      res.status(403).json({
        error: "This device is not registered to the shop license.",
        code: "DEVICE_NOT_REGISTERED",
      });
    })
    .catch(next);
};
