import { Router, type IRouter } from "express";
import { desc, eq, inArray, isNull } from "drizzle-orm";
import { db, shopSettingsTable, storeIssuanceAlertsTable, storeOrdersTable } from "@workspace/db";
import {
  ListStoreAlertsResponse,
  ResolveStoreAlertParams,
  ResolveStoreAlertBody,
  ResolveStoreAlertResponse,
  IssueStoreAlertKeyParams,
  IssueStoreAlertKeyResponse,
} from "@workspace/api-zod";
import { isAdmin } from "../lib/auth";
import { generateLicenseKey } from "../lib/licensing";
import { getUncachableStripeClient } from "../stripeClient";
import { logger } from "../lib/logger";
import { isEmailProviderConfigured, sendEmail, EmailError } from "../lib/email";

const router: IRouter = Router();

// Admin gate: all routes in this file require an active admin session.
router.use((req, res, next) => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
});

type EmailOutcome = { sent: boolean; note: string };

// Send the license key to the buyer email after a successful manual issuance.
// Inert (returns without error) when no email provider is connected or when
// the order has no customerEmail. Never throws — a failure is logged so the
// admin response can still succeed.
// Returns an EmailOutcome describing what happened for the admin UI.
async function sendBuyerKeyEmail(order: typeof storeOrdersTable.$inferSelect): Promise<EmailOutcome> {
  const buyerEmail = order.customerEmail?.trim() || null;
  if (!buyerEmail) {
    return { sent: false, note: "No buyer email on record — contact the buyer manually." };
  }

  let live = false;
  try {
    live = await isEmailProviderConfigured();
  } catch {
    live = false;
  }
  if (!live) {
    return { sent: false, note: "No email provider configured — buyer must be contacted manually." };
  }

  // Resolve sender: prefer OUTREACH_FROM_EMAIL, fall back to shop settings email
  // (same pattern as deliverOwnerEmail in messaging.ts).
  let fromAddress = process.env.OUTREACH_FROM_EMAIL?.trim() || null;
  if (!fromAddress) {
    const [settings] = await db
      .select({ email: shopSettingsTable.email })
      .from(shopSettingsTable)
      .where(eq(shopSettingsTable.id, 1))
      .limit(1);
    fromAddress = settings?.email?.trim() || null;
  }
  if (!fromAddress) {
    logger.warn(
      { sessionId: order.stripeSessionId },
      "adminStore: no sender address configured (OUTREACH_FROM_EMAIL or shop email); skipping buyer key email",
    );
    return { sent: false, note: "No sender address configured — buyer must be contacted manually." };
  }

  const planLabel = order.productName ?? order.plan;
  const subject = `Your Reliable Shop Systems license key — ${planLabel}`;
  const body = [
    `Thank you for your purchase of ${planLabel}!`,
    "",
    `Your license key is:`,
    "",
    `  ${order.licenseKey}`,
    "",
    `To activate:`,
    `  1. Install Reliable Shop Systems on your Windows hub machine.`,
    `  2. When prompted for a license key during first launch, enter the key above.`,
    `  3. Your key supports up to ${order.maxDevices} device(s).`,
    "",
    `If you have any questions, reply to this email.`,
  ].join("\n");

  try {
    await sendEmail({
      to: buyerEmail,
      from: fromAddress,
      fromName: "Reliable Shop Systems",
      subject,
      body,
    });
    logger.info(
      { sessionId: order.stripeSessionId, to: buyerEmail },
      "adminStore: buyer key email delivered",
    );
    return { sent: true, note: `Key emailed to ${buyerEmail}.` };
  } catch (err) {
    logger.error(
      { err, sessionId: order.stripeSessionId, to: buyerEmail },
      err instanceof EmailError
        ? `adminStore: buyer key email failed: ${err.message}`
        : "adminStore: buyer key email failed",
    );
    // Non-fatal: the admin action has already succeeded; log and continue.
    return {
      sent: false,
      note:
        err instanceof EmailError
          ? `Email delivery failed: ${err.message} — contact the buyer manually.`
          : "Email delivery failed — contact the buyer manually.",
    };
  }
}

// Shape a joined alert + optional store order row into the API response shape.
function shapeAlert(
  alert: typeof storeIssuanceAlertsTable.$inferSelect,
  order: typeof storeOrdersTable.$inferSelect | null,
) {
  return {
    id: alert.id,
    stripeSessionId: alert.stripeSessionId,
    reason: alert.reason,
    createdAt: alert.createdAt,
    resolvedAt: alert.resolvedAt ?? null,
    resolvedNote: alert.resolvedNote ?? null,
    storeOrder: order
      ? {
          licenseKey: order.licenseKey,
          customerEmail: order.customerEmail ?? null,
          plan: order.plan,
          productName: order.productName,
          maxDevices: order.maxDevices,
          amountTotal: order.amountTotal,
          currency: order.currency,
          status: order.status,
        }
      : null,
  };
}

async function getAlertWithOrder(id: number) {
  const [alert] = await db
    .select()
    .from(storeIssuanceAlertsTable)
    .where(eq(storeIssuanceAlertsTable.id, id))
    .limit(1);
  if (!alert) return null;
  const [order] = await db
    .select()
    .from(storeOrdersTable)
    .where(eq(storeOrdersTable.stripeSessionId, alert.stripeSessionId))
    .limit(1);
  return { alert, order: order ?? null };
}

// GET /admin/store-alerts — list issuance alerts, newest first.
router.get("/admin/store-alerts", async (req, res) => {
  const includeResolved = req.query["includeResolved"] === "true";
  const rows = await db
    .select()
    .from(storeIssuanceAlertsTable)
    .where(includeResolved ? undefined : isNull(storeIssuanceAlertsTable.resolvedAt))
    .orderBy(desc(storeIssuanceAlertsTable.id));

  // Load any matching store_orders rows for enrichment.
  const sessionIds = rows.map((r) => r.stripeSessionId);
  const orders =
    sessionIds.length > 0
      ? await db.select().from(storeOrdersTable).where(
          sessionIds.length === 1
            ? eq(storeOrdersTable.stripeSessionId, sessionIds[0]!)
            : inArray(storeOrdersTable.stripeSessionId, sessionIds),
        )
      : [];

  const orderMap = new Map(orders.map((o) => [o.stripeSessionId, o]));

  res.json(
    ListStoreAlertsResponse.parse(
      rows.map((alert) => shapeAlert(alert, orderMap.get(alert.stripeSessionId) ?? null)),
    ),
  );
});

// POST /admin/store-alerts/:id/resolve — dismiss without issuing a key.
router.post("/admin/store-alerts/:id/resolve", async (req, res) => {
  const params = ResolveStoreAlertParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = ResolveStoreAlertBody.safeParse(req.body ?? {});
  const note = body.success ? (body.data.note ?? null) : null;

  const row = await getAlertWithOrder(params.data.id);
  if (!row) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  if (row.alert.resolvedAt !== null) {
    res.status(409).json({ error: "Alert is already resolved" });
    return;
  }

  const resolvedAt = new Date().toISOString();
  const [updated] = await db
    .update(storeIssuanceAlertsTable)
    .set({ resolvedAt, resolvedNote: note ?? "Resolved by admin" })
    .where(eq(storeIssuanceAlertsTable.id, params.data.id))
    .returning();

  res.json(
    ResolveStoreAlertResponse.parse(shapeAlert(updated!, row.order)),
  );
});

// POST /admin/store-alerts/:id/issue-key — look up Stripe, mint a key,
// insert into store_orders, then resolve the alert.
router.post("/admin/store-alerts/:id/issue-key", async (req, res) => {
  const params = IssueStoreAlertKeyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const row = await getAlertWithOrder(params.data.id);
  if (!row) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  if (row.alert.resolvedAt !== null) {
    res.status(409).json({ error: "Alert is already resolved" });
    return;
  }

  const { alert, order: existingOrder } = row;

  // If a store_orders row already exists (e.g. the key was issued via the
  // normal flow after the alert was recorded), just resolve the alert.
  if (existingOrder) {
    const resolvedAt = new Date().toISOString();
    const [updated] = await db
      .update(storeIssuanceAlertsTable)
      .set({ resolvedAt, resolvedNote: "Key already exists in store_orders" })
      .where(eq(storeIssuanceAlertsTable.id, alert.id))
      .returning();
    res.json(
      IssueStoreAlertKeyResponse.parse({
        ...shapeAlert(updated!, existingOrder),
        emailSent: false,
        emailNote: "Key was already on record — no email sent.",
      }),
    );
    return;
  }

  // Fetch the Stripe session to confirm payment and get entitlements.
  const stripe = await getUncachableStripeClient();
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(alert.stripeSessionId, {
      expand: ["line_items.data.price.product"],
    });
  } catch (err) {
    req.log.error({ err, alertId: alert.id }, "adminStore: Stripe session retrieve failed");
    res.status(502).json({ error: "Could not reach Stripe to verify payment" });
    return;
  }

  if (session.payment_status !== "paid") {
    res.status(422).json({
      error: `Payment is not in 'paid' state (current: ${session.payment_status ?? "unknown"}). Cannot issue a key.`,
    });
    return;
  }

  // Verify the payment hasn't been reversed.
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  if (paymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge"],
      });
      const lc = pi.latest_charge;
      if (lc && typeof lc === "object" && "refunded" in lc && lc.refunded) {
        res.status(422).json({ error: "Payment has been refunded; cannot issue a key." });
        return;
      }
      if (lc && typeof lc === "object" && "disputed" in lc && lc.disputed) {
        res.status(422).json({ error: "Payment is under dispute; cannot issue a key." });
        return;
      }
    } catch (err) {
      req.log.warn({ err, alertId: alert.id }, "adminStore: could not verify charge standing");
      // Non-fatal for admin: proceed with a warning but still issue.
    }
  }

  // Extract tier entitlements from product metadata.
  const product = session.line_items?.data?.[0]?.price?.product;
  const meta =
    product && typeof product === "object" && "metadata" in product
      ? (product.metadata as Record<string, string>)
      : null;
  const plan = meta?.["plan"] ?? null;
  const maxDevices = Number(meta?.["maxDevices"]);
  const productName =
    product && typeof product === "object" && "name" in product
      ? (product as { name: string }).name
      : null;

  if (!plan || !Number.isFinite(maxDevices) || maxDevices < 1) {
    res.status(422).json({
      error:
        "Cannot determine license entitlement from Stripe product metadata. " +
        "Verify the product has 'plan' and 'maxDevices' metadata set.",
    });
    return;
  }

  const stripeEmail = session.customer_details?.email ?? null;
  const licenseKey = generateLicenseKey();

  // Insert the store_orders row (idempotent: onConflictDoNothing in case of a
  // race with the buyer's own confirmation page).
  await db
    .insert(storeOrdersTable)
    .values({
      stripeSessionId: alert.stripeSessionId,
      stripePaymentIntentId: paymentIntentId,
      customerEmail: stripeEmail,
      plan,
      productName: productName ?? plan,
      maxDevices,
      licenseKey,
      amountTotal: session.amount_total ?? 0,
      currency: session.currency ?? "usd",
      status: "paid",
      orderSecretHash: session.metadata?.["orderSecretHash"] ?? null,
    })
    .onConflictDoNothing({ target: storeOrdersTable.stripeSessionId });

  // Re-fetch the order row so we always return what's actually in the DB
  // (handles the case where the onConflictDoNothing hit an existing row).
  const [finalOrder] = await db
    .select()
    .from(storeOrdersTable)
    .where(eq(storeOrdersTable.stripeSessionId, alert.stripeSessionId))
    .limit(1);

  if (!finalOrder) {
    req.log.error({ alertId: alert.id }, "adminStore: store_orders row missing after insert");
    res.status(500).json({ error: "Key insert failed unexpectedly" });
    return;
  }

  // Mark the alert resolved.
  const resolvedAt = new Date().toISOString();
  const [resolved] = await db
    .update(storeIssuanceAlertsTable)
    .set({ resolvedAt, resolvedNote: "Key manually issued by admin" })
    .where(eq(storeIssuanceAlertsTable.id, alert.id))
    .returning();

  logger.info(
    { alertId: alert.id, sessionId: alert.stripeSessionId },
    "adminStore: license key manually issued for stuck order",
  );

  // Best-effort: email the buyer their key. Inert when no provider or no email.
  const emailOutcome = await sendBuyerKeyEmail(finalOrder);

  res.json(
    IssueStoreAlertKeyResponse.parse({
      ...shapeAlert(resolved!, finalOrder),
      emailSent: emailOutcome.sent,
      emailNote: emailOutcome.note,
    }),
  );
});

export default router;
