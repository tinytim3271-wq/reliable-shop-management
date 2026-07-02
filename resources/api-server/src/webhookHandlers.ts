import { and, eq, inArray } from "drizzle-orm";
import { db, storeOrdersTable, licensesTable, licenseDevicesTable } from "@workspace/db";
import { getStripeSync } from "./stripeClient";
import { invalidateLicenseCache } from "./lib/licensing";
import { notifyOwner } from "./lib/messaging";
import { logger } from "./lib/logger";

// Out-of-band owner alert when a sold license is reversed (a card payment was
// refunded or a chargeback/dispute was opened). The storefront revokes the key
// automatically in the background, but the in-app Sync/Integrations surfaces
// only reach an operator who is logged in and looking; this surfaces a billing
// problem to an owner who may be away. Mirrors qboSync's permanent-failure
// alert: delegated to the outreach module's owner-alert path, which is inert
// (simulated) unless a live email provider is connected, so installs that never
// wired up email stay silent. Never throws — a failure here must not abort
// webhook processing (which would make Stripe retry the whole event).
async function alertOwnerOfLicenseReversal(
  newStatus: "refunded" | "disputed",
  orders: Array<{ id: number }>,
): Promise<void> {
  const action = newStatus === "refunded" ? "refunded" : "disputed";
  const count = orders.length;
  const noun = count === 1 ? "license" : "licenses";
  const idList = orders.map((o) => `#${o.id}`).join(", ");
  try {
    const outcome = await notifyOwner({
      subject: `Action needed: a sold license was ${action}`,
      body:
        `A card payment for ${count} sold ${noun} was ${action} in Stripe, so the affected ${noun} ${count === 1 ? "has" : "have"} been revoked and any activated devices deactivated automatically.\n\n` +
        `Affected store order ${count === 1 ? "id" : "ids"}: ${idList}.\n\n` +
        `Your software is already protected — no action is required to keep it secure. You may want to review this ${action === "disputed" ? "dispute" : "refund"} in your Stripe dashboard.`,
    });
    logger.info(
      { newStatus, orderIds: orders.map((o) => o.id), delivered: outcome.delivered },
      "sold-license reversal owner alert processed",
    );
  } catch (err) {
    logger.error(
      { err, newStatus },
      "sold-license reversal owner alert threw unexpectedly",
    );
  }
}

// Reconcile store_orders + local licenses when Stripe reports a payment
// reversal or dispute. Steps:
//  1. Update store_orders.status so the key can no longer be used to activate
//     new installations (the activate endpoint filters by status = "paid").
//  2. Revoke any local licenses row provisioned with that key, and deactivate
//     all its bound devices, so already-installed software loses its valid
//     license state on the next heartbeat / gate check.
//
// paymentIntentId — the Stripe payment_intent id stored on the order row.
// newStatus       — "refunded" | "disputed" | "paid" (won-dispute restore).
async function reconcileStoreOrderByPaymentIntent(
  paymentIntentId: string | null | undefined,
  newStatus: "refunded" | "disputed" | "paid",
): Promise<void> {
  if (!paymentIntentId) return;

  // Look up the affected orders BEFORE updating so we can tell which rows
  // genuinely transition into the new status. Stripe re-delivers webhook events
  // (and a partial then full refund both arrive as charge.refunded), so the
  // owner alert below must fire only on the real state change, never on a retry.
  const matchingOrders = await db
    .select({
      id: storeOrdersTable.id,
      status: storeOrdersTable.status,
      licenseKey: storeOrdersTable.licenseKey,
    })
    .from(storeOrdersTable)
    .where(eq(storeOrdersTable.stripePaymentIntentId, paymentIntentId));

  if (matchingOrders.length === 0) return;

  // Rows that are not already in the target status — the genuine transition set.
  const transitioning = matchingOrders.filter((o) => o.status !== newStatus);

  // Step 1: update store_orders.status. Re-applying the same status is harmless,
  // and updating ALL matching rows (not just transitioning ones) keeps the
  // licenses revocation below resilient: a reconcile interrupted before Step 2
  // still completes if Stripe redelivers the event.
  await db
    .update(storeOrdersTable)
    .set({ status: newStatus })
    .where(eq(storeOrdersTable.stripePaymentIntentId, paymentIntentId));

  logger.info(
    { paymentIntentId, newStatus, orderIds: matchingOrders.map((r) => r.id) },
    "store_order status reconciled from Stripe event",
  );

  // Step 2: mirror the revocation into the local licenses table. In a hosted
  // installation where the buyer activated their key against THIS deployment,
  // the licenses row IS in this database and is updated here.
  //
  // Defense-in-depth: even if this step is skipped (e.g. the licenses row
  // doesn't exist because no activation happened yet), the license gate's
  // loadLicenseState() and the /license/validate heartbeat both cross-check
  // store_orders.status directly, so the gate blocks access as soon as
  // store_orders is marked refunded/disputed — without relying on this step.
  const licenseKeys = matchingOrders.map((r) => r.licenseKey);

  if (newStatus === "paid") {
    // Dispute won: restore the license(s) to active. This is a recovery, not a
    // failure, so no owner alert fires here.
    const restored = await db
      .update(licensesTable)
      .set({ status: "active" })
      .where(inArray(licensesTable.licenseKey, licenseKeys))
      .returning({ id: licensesTable.id });
    if (restored.length > 0) {
      invalidateLicenseCache();
      logger.info(
        { licenseIds: restored.map((r) => r.id) },
        "licenses restored to active after won dispute",
      );
    }
    return;
  }

  // Refund or dispute: revoke the license row and deactivate all bound devices.
  const revokedLicenses = await db
    .update(licensesTable)
    .set({ status: "revoked" })
    .where(inArray(licensesTable.licenseKey, licenseKeys))
    .returning({ id: licensesTable.id });

  if (revokedLicenses.length > 0) {
    const licenseIds = revokedLicenses.map((r) => r.id);
    await db
      .update(licenseDevicesTable)
      .set({ status: "deactivated", deactivatedAt: new Date().toISOString() })
      .where(
        and(
          inArray(licenseDevicesTable.licenseId, licenseIds),
          eq(licenseDevicesTable.status, "active"),
        ),
      );
    invalidateLicenseCache();
    logger.info(
      { licenseIds },
      "licenses revoked and devices deactivated after payment reversal",
    );
  }

  // Tell the owner — who may be away — that a sold license was reversed. Fire
  // exactly once, only for rows that genuinely transitioned this delivery (so
  // Stripe's webhook retries do not re-alert), and wrapped so it can never abort
  // webhook processing. Inert until an email provider is connected.
  if (transitioning.length > 0) {
    await alertOwnerOfLicenseReversal(newStatus, transitioning);
  }
}

// Minimal type for the events we inspect. The payload has already been
// signature-verified by StripeSync before we parse it.
type StripeEventPayload = {
  type: string;
  data: { object: Record<string, unknown> };
};

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    // Validate payload is a Buffer
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
          "Received type: " +
          typeof payload +
          ". " +
          "This usually means express.json() parsed the body before reaching this handler. " +
          "FIX: Ensure webhook route is registered BEFORE app.use(express.json()).",
      );
    }

    const sync = await getStripeSync();
    // StripeSync verifies the Stripe-Signature header; throws on invalid/replayed events.
    await sync.processWebhook(payload, signature);

    // Signature is now verified. Parse the raw bytes to handle events that
    // affect sold-license lifecycle. This must run AFTER sync.processWebhook so
    // we only act on cryptographically verified events.
    let event: StripeEventPayload;
    try {
      event = JSON.parse(payload.toString("utf8")) as StripeEventPayload;
    } catch (err) {
      // A valid Stripe payload is always JSON; this branch means the verifier
      // above would have also failed — this is a defensive fallback only.
      logger.warn({ err }, "Failed to parse Stripe webhook payload after sync");
      return;
    }

    const obj = event.data.object;

    // Helper: extract a string field from the event object or return null.
    const str = (key: string): string | null => {
      const v = obj[key];
      return typeof v === "string" ? v : null;
    };

    switch (event.type) {
      // A charge was refunded (full or partial). Any refund on a license sale
      // is treated as a payment reversal: mark the order and revoke the
      // corresponding license so it can no longer activate new or existing
      // installations.
      case "charge.refunded": {
        await reconcileStoreOrderByPaymentIntent(str("payment_intent"), "refunded");
        break;
      }

      // A dispute was opened or funds were withdrawn. Immediately revoke so the
      // key cannot be used to provision a new install, and so the license gate
      // blocks already-provisioned installs while the dispute is open.
      case "charge.dispute.created":
      case "charge.dispute.funds_withdrawn": {
        await reconcileStoreOrderByPaymentIntent(str("payment_intent"), "disputed");
        break;
      }

      // Dispute resolved. If the merchant won, restore the order and license to
      // paid/active so the legitimate buyer regains access. If lost, keep revoked.
      case "charge.dispute.closed": {
        const disputeStatus = str("status");
        if (disputeStatus === "won") {
          await reconcileStoreOrderByPaymentIntent(str("payment_intent"), "paid");
        } else {
          // "lost" or any other terminal state — keep (or set) revoked.
          await reconcileStoreOrderByPaymentIntent(str("payment_intent"), "disputed");
        }
        break;
      }

      default:
        break;
    }
  }
}
