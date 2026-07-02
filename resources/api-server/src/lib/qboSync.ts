import { and, eq, inArray, lt } from "drizzle-orm";
import {
  db,
  qboSyncLogTable,
  invoicesTable,
  invoiceLineItemsTable,
  invoicePaymentsTable,
  expensesTable,
  customersTable,
  type QboAccountMapping,
  type QboConnection,
} from "@workspace/db";
import {
  getQboConfig,
  loadConnectionRow,
  isConnected,
  qboApiRequest,
  qboQuery,
  touchLastSync,
  QboNotConfiguredError,
  QboNotConnectedError,
  type QboConfig,
} from "./qboClient";
import { computeTotals } from "./billing";
import { notifyOwner } from "./messaging";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// QBO sync engine
//
// Push: invoices (committed), their payments, and expenses -> QBO.
// Pull: chart-of-accounts (for the mapping UI) and QBO customers (imported into
//       RSS so an invoice push can resolve a CustomerRef).
//
// Every push is idempotent via the qbo_sync_log ledger: the QBO id is retained
// per (entityType, entityId), so a re-sync UPDATES the existing QBO record
// (sparse update with its current SyncToken) instead of duplicating it. Pushes
// never throw to the caller loop — each records its own pending/synced/failed
// row so a single bad record cannot abort a full sync.
// ---------------------------------------------------------------------------

export type QboEntityType = "invoice" | "payment" | "expense";

// Invoice statuses that represent a committed (billable) document worth syncing.
const PUSHABLE_INVOICE_STATUSES = ["invoiced", "sent", "partial", "paid"];

// A reusable QBO sales item all RSS invoice lines post through, tied to the
// mapped income account. RSS line items are free-form (labor/part/fee), so a
// single service item keeps the QBO mapping simple and deterministic.
const RSS_SERVICE_ITEM_NAME = "RSS Sales";

export interface QboSyncResult {
  ok: boolean;
  syncedCount: number;
  failedCount: number;
  lastSyncAt: string | null;
  message: string | null;
}

interface SyncContext {
  cfg: QboConfig;
  row: QboConnection;
  mapping: QboAccountMapping;
}

// ---------------------------------------------------------------------------
// Sync-log helpers
// ---------------------------------------------------------------------------

async function getLogQboId(
  entityType: QboEntityType,
  entityId: number,
): Promise<string | null> {
  const [existing] = await db
    .select()
    .from(qboSyncLogTable)
    .where(
      and(
        eq(qboSyncLogTable.entityType, entityType),
        eq(qboSyncLogTable.entityId, entityId),
      ),
    )
    .limit(1);
  return existing?.qboId ?? null;
}

async function recordSync(
  entityType: QboEntityType,
  entityId: number,
  fields: { qboId?: string | null; status: string; error?: string | null },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const [existing] = await db
    .select()
    .from(qboSyncLogTable)
    .where(
      and(
        eq(qboSyncLogTable.entityType, entityType),
        eq(qboSyncLogTable.entityId, entityId),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(qboSyncLogTable)
      .set({
        // Never blank out a known QBO id on a later failure.
        qboId: fields.qboId ?? existing.qboId,
        status: fields.status,
        error: fields.error ?? null,
        lastAttemptedAt: nowIso,
        // A successful push clears the background-retry counter so a record that
        // recovers is treated as healthy again (and a future failure restarts
        // the bounded retry cycle from zero).
        ...(fields.status === "synced" ? { attempts: 0 } : {}),
      })
      .where(eq(qboSyncLogTable.id, existing.id));
  } else {
    await db.insert(qboSyncLogTable).values({
      entityType,
      entityId,
      qboId: fields.qboId ?? null,
      status: fields.status,
      error: fields.error ?? null,
      lastAttemptedAt: nowIso,
    });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Connection resolution
// ---------------------------------------------------------------------------

// Resolve the active config + connected row + mapping, or throw a typed error
// the route layer maps to 503 (not configured) / 409 (not connected).
export async function resolveContext(): Promise<SyncContext> {
  const cfg = getQboConfig();
  if (!cfg) throw new QboNotConfiguredError();
  const row = await loadConnectionRow();
  if (!isConnected(row)) throw new QboNotConnectedError();
  return { cfg, row, mapping: row.accountMapping ?? {} };
}

// ---------------------------------------------------------------------------
// QBO entity helpers (customer / item / sync-token)
// ---------------------------------------------------------------------------

function escapeQbo(value: string): string {
  // QBO query strings are single-quoted; escape embedded single quotes.
  return value.replace(/'/g, "\\'");
}

// Find or create a QBO customer for an RSS customer, returning the QBO id.
// Resolution order: the persisted `qbo_customer_id` link (set by pullCustomers),
// then a DisplayName lookup, then create. The resolved id is written back onto
// the RSS customer so future pushes skip the lookup and the link stays stable.
export async function ensureQboCustomer(
  ctx: SyncContext,
  customer: { id: number; name: string; email: string | null; qboCustomerId: string | null },
): Promise<string> {
  if (customer.qboCustomerId) return customer.qboCustomerId;

  const display = customer.name.trim() || `Customer`;
  const email = customer.email?.trim() || null;
  // Resolve against QBO email first (stronger signal), then DisplayName, before
  // creating a new QBO customer — mirrors the pull-side match order so a customer
  // that already exists in QBO under either key is linked instead of duplicated.
  let id: string | undefined;
  if (email) {
    const byEmail = await qboQuery<{ Id: string }>(
      ctx.cfg,
      ctx.row,
      "Customer",
      `select * from Customer where PrimaryEmailAddr = '${escapeQbo(email)}'`,
    );
    id = byEmail[0]?.Id;
  }
  if (!id) {
    const byName = await qboQuery<{ Id: string }>(
      ctx.cfg,
      ctx.row,
      "Customer",
      `select * from Customer where DisplayName = '${escapeQbo(display)}'`,
    );
    id = byName[0]?.Id;
  }
  if (!id) {
    const created = await qboApiRequest<{ Customer?: { Id: string } }>(
      ctx.cfg,
      ctx.row,
      "POST",
      "customer",
      {
        DisplayName: display,
        ...(customer.email
          ? { PrimaryEmailAddr: { Address: customer.email } }
          : {}),
      },
    );
    id = created.Customer?.Id;
  }
  if (!id) throw new Error("QBO did not return a customer id");
  // Persist the link so subsequent pushes resolve the CustomerRef directly.
  await db
    .update(customersTable)
    .set({ qboCustomerId: id })
    .where(eq(customersTable.id, customer.id));
  return id;
}

// Find or create the shared RSS sales item tied to the mapped income account.
async function ensureServiceItem(ctx: SyncContext): Promise<string> {
  const incomeAccount = ctx.mapping.incomeAccount;
  if (!incomeAccount) {
    throw new Error(
      "No income account mapped. Set the income account in Settings before syncing invoices.",
    );
  }
  const found = await qboQuery<{ Id: string }>(
    ctx.cfg,
    ctx.row,
    "Item",
    `select * from Item where Name = '${escapeQbo(RSS_SERVICE_ITEM_NAME)}'`,
  );
  if (found[0]?.Id) return found[0].Id;
  const created = await qboApiRequest<{ Item?: { Id: string } }>(
    ctx.cfg,
    ctx.row,
    "POST",
    "item",
    {
      Name: RSS_SERVICE_ITEM_NAME,
      Type: "Service",
      IncomeAccountRef: { value: incomeAccount },
    },
  );
  const id = created.Item?.Id;
  if (!id) throw new Error("QBO did not return an item id");
  return id;
}

// Read the current SyncToken for an existing QBO entity (required for updates).
async function getSyncToken(
  ctx: SyncContext,
  resource: string,
  id: string,
): Promise<string | null> {
  try {
    const data = await qboApiRequest<Record<string, { SyncToken?: string }>>(
      ctx.cfg,
      ctx.row,
      "GET",
      `${resource}/${id}`,
    );
    const entityKey = resource.charAt(0).toUpperCase() + resource.slice(1);
    return data[entityKey]?.SyncToken ?? null;
  } catch (err) {
    logger.warn({ err, resource, id }, "Failed to read QBO SyncToken");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Push: invoice
// ---------------------------------------------------------------------------

export async function pushInvoice(invoiceId: number): Promise<boolean> {
  let ctx: SyncContext;
  try {
    ctx = await resolveContext();
  } catch (err) {
    await recordSync("invoice", invoiceId, {
      status: "failed",
      error: errMessage(err),
    });
    return false;
  }
  try {
    const [invoice] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);
    if (!invoice) throw new Error("Invoice not found");

    const [customer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.id, invoice.customerId))
      .limit(1);
    if (!customer) throw new Error("Invoice customer not found");

    const lines = await db
      .select()
      .from(invoiceLineItemsTable)
      .where(eq(invoiceLineItemsTable.invoiceId, invoiceId));

    const customerRef = await ensureQboCustomer(ctx, customer);
    const itemRef = await ensureServiceItem(ctx);

    const qboLines = (lines.length > 0 ? lines : [
      // An invoice with no structured lines still posts a single summary line so
      // the document total is preserved in QBO.
      {
        description: "Services",
        quantity: 1,
        unitPrice: 0,
        type: "labor" as const,
      },
    ]).map((line) => ({
      DetailType: "SalesItemLineDetail" as const,
      Amount: Number((line.quantity * line.unitPrice).toFixed(2)),
      Description: line.description,
      SalesItemLineDetail: {
        ItemRef: { value: itemRef },
        Qty: line.quantity,
        UnitPrice: line.unitPrice,
      },
    }));

    const payload: Record<string, unknown> = {
      CustomerRef: { value: customerRef },
      DocNumber: `RSS-${invoice.id}`,
      Line: qboLines,
    };

    const existingId = await getLogQboId("invoice", invoiceId);
    if (existingId) {
      const syncToken = await getSyncToken(ctx, "invoice", existingId);
      payload.Id = existingId;
      payload.SyncToken = syncToken ?? "0";
      payload.sparse = true;
    }

    const res = await qboApiRequest<{ Invoice?: { Id: string } }>(
      ctx.cfg,
      ctx.row,
      "POST",
      "invoice",
      payload,
    );
    const qboId = res.Invoice?.Id ?? existingId;
    await recordSync("invoice", invoiceId, {
      status: "synced",
      qboId,
      error: null,
    });
    return true;
  } catch (err) {
    await recordSync("invoice", invoiceId, {
      status: "failed",
      error: errMessage(err),
    });
    logger.error({ err, invoiceId }, "QBO invoice push failed");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Push: payment (depends on its invoice already being in QBO)
// ---------------------------------------------------------------------------

export async function pushPayment(paymentId: number): Promise<boolean> {
  let ctx: SyncContext;
  try {
    ctx = await resolveContext();
  } catch (err) {
    await recordSync("payment", paymentId, {
      status: "failed",
      error: errMessage(err),
    });
    return false;
  }
  try {
    const [payment] = await db
      .select()
      .from(invoicePaymentsTable)
      .where(eq(invoicePaymentsTable.id, paymentId))
      .limit(1);
    if (!payment) throw new Error("Payment not found");

    const [invoice] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, payment.invoiceId))
      .limit(1);
    if (!invoice) throw new Error("Payment invoice not found");

    // The payment can only link to a QBO invoice that has been pushed already.
    let invoiceQboId = await getLogQboId("invoice", payment.invoiceId);
    if (!invoiceQboId) {
      const ok = await pushInvoice(payment.invoiceId);
      if (!ok) throw new Error("Linked invoice has not synced to QBO yet");
      invoiceQboId = await getLogQboId("invoice", payment.invoiceId);
    }
    if (!invoiceQboId) throw new Error("Linked invoice has no QBO id");

    const [customer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.id, invoice.customerId))
      .limit(1);
    if (!customer) throw new Error("Payment customer not found");
    const customerRef = await ensureQboCustomer(ctx, customer);

    const depositAccount = mappedPaymentAccount(ctx.mapping, payment.method);

    const payload: Record<string, unknown> = {
      CustomerRef: { value: customerRef },
      TotalAmt: payment.amount,
      Line: [
        {
          Amount: payment.amount,
          LinkedTxn: [{ TxnId: invoiceQboId, TxnType: "Invoice" }],
        },
      ],
      ...(depositAccount
        ? { DepositToAccountRef: { value: depositAccount } }
        : {}),
    };

    const existingId = await getLogQboId("payment", paymentId);
    if (existingId) {
      const syncToken = await getSyncToken(ctx, "payment", existingId);
      payload.Id = existingId;
      payload.SyncToken = syncToken ?? "0";
      payload.sparse = true;
    }

    const res = await qboApiRequest<{ Payment?: { Id: string } }>(
      ctx.cfg,
      ctx.row,
      "POST",
      "payment",
      payload,
    );
    const qboId = res.Payment?.Id ?? existingId;
    await recordSync("payment", paymentId, {
      status: "synced",
      qboId,
      error: null,
    });
    return true;
  } catch (err) {
    await recordSync("payment", paymentId, {
      status: "failed",
      error: errMessage(err),
    });
    logger.error({ err, paymentId }, "QBO payment push failed");
    return false;
  }
}

// A synthetic payment uses the negated invoice id as its sync-log entity id.
// Real payment rows always carry positive serial ids, so the negative namespace
// can never collide with them, which keeps the synthetic payment idempotent
// (re-pushing does a sparse update of the same QBO Payment instead of creating a
// duplicate).
function syntheticPaymentKey(invoiceId: number): number {
  return -invoiceId;
}

// Reflect a paid invoice in QBO when it carries no explicit payment rows (for
// example an invoice flipped straight to "paid" by a status edit, or a paid row
// imported without a payment history). Creates a single QBO Payment for the paid
// amount, linked to the already-pushed Invoice, so QBO shows the invoice as paid
// rather than open. Idempotent via the negated-invoice-id sync-log key.
export async function pushSyntheticInvoicePayment(
  invoiceId: number,
): Promise<boolean> {
  const logKey = syntheticPaymentKey(invoiceId);
  let ctx: SyncContext;
  try {
    ctx = await resolveContext();
  } catch (err) {
    await recordSync("payment", logKey, {
      status: "failed",
      error: errMessage(err),
    });
    return false;
  }
  try {
    const [invoice] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);
    if (!invoice) throw new Error("Invoice not found");

    // Prefer the recorded paid amount; fall back to the computed invoice total
    // (a status-only "paid" edit does not set amountPaid) so a paid invoice still
    // posts a full payment.
    let amount = invoice.amountPaid;
    if (!(amount > 0)) {
      const lines = await db
        .select({
          quantity: invoiceLineItemsTable.quantity,
          unitPrice: invoiceLineItemsTable.unitPrice,
        })
        .from(invoiceLineItemsTable)
        .where(eq(invoiceLineItemsTable.invoiceId, invoiceId));
      amount = computeTotals(lines, invoice.taxRate).total;
    }
    if (!(amount > 0)) {
      // Nothing meaningful to post (zero-dollar invoice); treat as a no-op
      // success so the caller does not record a spurious failure.
      return true;
    }

    let invoiceQboId = await getLogQboId("invoice", invoiceId);
    if (!invoiceQboId) {
      const ok = await pushInvoice(invoiceId);
      if (!ok) throw new Error("Linked invoice has not synced to QBO yet");
      invoiceQboId = await getLogQboId("invoice", invoiceId);
    }
    if (!invoiceQboId) throw new Error("Linked invoice has no QBO id");

    const [customer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.id, invoice.customerId))
      .limit(1);
    if (!customer) throw new Error("Invoice customer not found");
    const customerRef = await ensureQboCustomer(ctx, customer);

    // No payment method is known for a status-only paid transition, so fall back
    // to the cash deposit account if one is mapped.
    const depositAccount = mappedPaymentAccount(ctx.mapping, "cash");

    const payload: Record<string, unknown> = {
      CustomerRef: { value: customerRef },
      TotalAmt: amount,
      Line: [
        {
          Amount: amount,
          LinkedTxn: [{ TxnId: invoiceQboId, TxnType: "Invoice" }],
        },
      ],
      ...(depositAccount
        ? { DepositToAccountRef: { value: depositAccount } }
        : {}),
    };

    const existingId = await getLogQboId("payment", logKey);
    if (existingId) {
      const syncToken = await getSyncToken(ctx, "payment", existingId);
      payload.Id = existingId;
      payload.SyncToken = syncToken ?? "0";
      payload.sparse = true;
    }

    const res = await qboApiRequest<{ Payment?: { Id: string } }>(
      ctx.cfg,
      ctx.row,
      "POST",
      "payment",
      payload,
    );
    const qboId = res.Payment?.Id ?? existingId;
    await recordSync("payment", logKey, {
      status: "synced",
      qboId,
      error: null,
    });
    return true;
  } catch (err) {
    await recordSync("payment", logKey, {
      status: "failed",
      error: errMessage(err),
    });
    logger.error({ err, invoiceId }, "QBO synthetic invoice payment push failed");
    return false;
  }
}

// Push the payment artifact(s) that make a paid invoice show as paid in QBO.
// Mirrors the spec's "Sales Receipt or Invoice + Payment depending on timing":
// when explicit payment rows exist (invoiced first, paid later) each becomes a
// linked QBO Payment; when the invoice is paid with no payment rows (paid at the
// point of sale / imported) a single synthetic Payment covers it. Returns the
// per-artifact synced/failed counts so callers can aggregate.
export async function pushInvoicePaymentArtifacts(
  invoiceId: number,
  invoiceStatus: string,
): Promise<{ synced: number; failed: number }> {
  const payments = await db
    .select({ id: invoicePaymentsTable.id })
    .from(invoicePaymentsTable)
    .where(eq(invoicePaymentsTable.invoiceId, invoiceId));

  let synced = 0;
  let failed = 0;
  if (payments.length > 0) {
    for (const p of payments) {
      (await pushPayment(p.id)) ? (synced += 1) : (failed += 1);
    }
    return { synced, failed };
  }
  if (invoiceStatus === "paid") {
    (await pushSyntheticInvoicePayment(invoiceId)) ? (synced += 1) : (failed += 1);
  }
  return { synced, failed };
}

function mappedPaymentAccount(
  mapping: QboAccountMapping,
  method: string | null,
): string | null {
  const pa = mapping.paymentAccounts;
  if (!pa) return null;
  switch ((method ?? "").toLowerCase()) {
    case "cash":
      return pa.cash ?? null;
    case "card":
    case "credit":
    case "stripe":
      return pa.card ?? null;
    case "check":
    case "cheque":
      return pa.check ?? null;
    default:
      return null;
  }
}

function qboPaymentType(method: string | null): string {
  switch ((method ?? "").toLowerCase()) {
    case "check":
    case "cheque":
      return "Check";
    case "card":
    case "credit":
    case "stripe":
      return "CreditCard";
    default:
      return "Cash";
  }
}

// ---------------------------------------------------------------------------
// Push: expense (QBO Purchase)
// ---------------------------------------------------------------------------

export async function pushExpense(expenseId: number): Promise<boolean> {
  let ctx: SyncContext;
  try {
    ctx = await resolveContext();
  } catch (err) {
    await recordSync("expense", expenseId, {
      status: "failed",
      error: errMessage(err),
    });
    return false;
  }
  try {
    const [expense] = await db
      .select()
      .from(expensesTable)
      .where(eq(expensesTable.id, expenseId))
      .limit(1);
    if (!expense) throw new Error("Expense not found");

    const payingAccount = mappedPaymentAccount(ctx.mapping, expense.paymentMethod);
    if (!payingAccount) {
      throw new Error(
        "No payment (bank) account mapped for this expense's payment method. Map cash/card/check accounts in Settings.",
      );
    }
    const expenseAccount = expense.categoryId
      ? ctx.mapping.expenseAccounts?.[String(expense.categoryId)]
      : null;
    if (!expenseAccount) {
      throw new Error(
        "No QBO expense account mapped for this expense's category. Map it in Settings.",
      );
    }

    const payload: Record<string, unknown> = {
      PaymentType: qboPaymentType(expense.paymentMethod),
      AccountRef: { value: payingAccount },
      TxnDate: expense.date,
      Line: [
        {
          Amount: expense.amount,
          DetailType: "AccountBasedExpenseLineDetail",
          Description: expense.description,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: expenseAccount },
          },
        },
      ],
    };

    const existingId = await getLogQboId("expense", expenseId);
    if (existingId) {
      const syncToken = await getSyncToken(ctx, "purchase", existingId);
      payload.Id = existingId;
      payload.SyncToken = syncToken ?? "0";
      payload.sparse = true;
    }

    const res = await qboApiRequest<{ Purchase?: { Id: string } }>(
      ctx.cfg,
      ctx.row,
      "POST",
      "purchase",
      payload,
    );
    const qboId = res.Purchase?.Id ?? existingId;
    await recordSync("expense", expenseId, {
      status: "synced",
      qboId,
      error: null,
    });
    return true;
  } catch (err) {
    await recordSync("expense", expenseId, {
      status: "failed",
      error: errMessage(err),
    });
    logger.error({ err, expenseId }, "QBO expense push failed");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pull: chart of accounts
// ---------------------------------------------------------------------------

export interface QboAccountView {
  id: string;
  name: string;
  accountType: string;
  accountSubType: string | null;
  classification: string | null;
}

export async function pullAccounts(): Promise<QboAccountView[]> {
  const ctx = await resolveContext();
  const accounts = await qboQuery<{
    Id: string;
    Name: string;
    AccountType: string;
    AccountSubType?: string;
    Classification?: string;
  }>(
    ctx.cfg,
    ctx.row,
    "Account",
    "select * from Account where Active = true MAXRESULTS 1000",
  );
  return accounts.map((a) => ({
    id: a.Id,
    name: a.Name,
    accountType: a.AccountType,
    accountSubType: a.AccountSubType ?? null,
    classification: a.Classification ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Pull: customers (import QBO customers into RSS)
// ---------------------------------------------------------------------------

export async function pullCustomers(ctx: SyncContext): Promise<number> {
  const customers = await qboQuery<{
    Id: string;
    DisplayName?: string;
    PrimaryEmailAddr?: { Address?: string };
    PrimaryPhone?: { FreeFormNumber?: string };
  }>(
    ctx.cfg,
    ctx.row,
    "Customer",
    "select * from Customer where Active = true MAXRESULTS 1000",
  );
  let imported = 0;
  for (const c of customers) {
    const name = c.DisplayName?.trim();
    if (!name) continue;
    const email = c.PrimaryEmailAddr?.Address?.trim() || null;
    const phone = c.PrimaryPhone?.FreeFormNumber?.trim() || null;
    // Match an existing RSS customer by email first, then fall back to exact
    // name. Email is the stronger signal, but a customer that exists under a
    // different/blank email must still link by name rather than duplicate.
    let existing:
      | { id: number; qboCustomerId: string | null }
      | undefined;
    if (email) {
      [existing] = await db
        .select({ id: customersTable.id, qboCustomerId: customersTable.qboCustomerId })
        .from(customersTable)
        .where(eq(customersTable.email, email))
        .limit(1);
    }
    if (!existing) {
      [existing] = await db
        .select({ id: customersTable.id, qboCustomerId: customersTable.qboCustomerId })
        .from(customersTable)
        .where(eq(customersTable.name, name))
        .limit(1);
    }
    if (existing) {
      // One-way enrichment: link the existing RSS customer to its QBO record so
      // pushes resolve the CustomerRef directly. Skip if already linked.
      if (existing.qboCustomerId !== c.Id) {
        await db
          .update(customersTable)
          .set({ qboCustomerId: c.Id })
          .where(eq(customersTable.id, existing.id));
      }
      continue;
    }
    // No RSS match: import the QBO customer, carrying the link forward.
    await db
      .insert(customersTable)
      .values({ name, email, phone, qboCustomerId: c.Id });
    imported += 1;
  }
  return imported;
}

// ---------------------------------------------------------------------------
// Full reconcile: pull then push
// ---------------------------------------------------------------------------

// Returns the set of (entityType, entityId) already in `synced` state so a full
// reconcile can push unsynced/failed records first (and re-push synced ones last
// to pick up edits). The push itself is idempotent, so ordering only affects
// which records clear soonest under the rate-limit budget.
async function loadSyncedEntityIds(
  entityType: QboEntityType,
): Promise<Set<number>> {
  const rows = await db
    .select({ entityId: qboSyncLogTable.entityId })
    .from(qboSyncLogTable)
    .where(
      and(
        eq(qboSyncLogTable.entityType, entityType),
        eq(qboSyncLogTable.status, "synced"),
      ),
    );
  return new Set(rows.map((r) => r.entityId));
}

// Order ids so the not-yet-synced/failed ones come first.
function unsyncedFirst(ids: number[], synced: Set<number>): number[] {
  return [...ids].sort((a, b) => {
    const aSynced = synced.has(a) ? 1 : 0;
    const bSynced = synced.has(b) ? 1 : 0;
    return aSynced - bSynced || a - b;
  });
}

export async function runFullSync(): Promise<QboSyncResult> {
  const ctx = await resolveContext();
  let synced = 0;
  let failed = 0;
  const messages: string[] = [];

  // Pull customers first so invoice pushes can resolve CustomerRefs.
  try {
    const importedCustomers = await pullCustomers(ctx);
    if (importedCustomers > 0) {
      messages.push(`Imported ${importedCustomers} customer(s) from QBO`);
    }
  } catch (err) {
    messages.push(`Customer import failed: ${errMessage(err)}`);
  }

  // Refresh the chart-of-accounts as part of the pull phase so the mapping
  // picklist stays current on every sync (spec: "a pull runs on each sync").
  try {
    const accounts = await pullAccounts();
    messages.push(`Refreshed ${accounts.length} chart-of-accounts`);
  } catch (err) {
    messages.push(`Account refresh failed: ${errMessage(err)}`);
  }

  // Push committed invoices and their payments, unsynced/failed first. The
  // qboApiRequest throttle paces every outbound call so the whole loop stays
  // under Intuit's ~500 req/min budget without per-record sleeping here.
  const invoiceRows = await db
    .select({ id: invoicesTable.id, status: invoicesTable.status })
    .from(invoicesTable)
    .where(inArray(invoicesTable.status, PUSHABLE_INVOICE_STATUSES));
  const syncedInvoices = await loadSyncedEntityIds("invoice");
  const invoiceRowsById = new Map(
    invoiceRows.map((i) => [i.id, i.status] as const),
  );
  const invoiceIds = unsyncedFirst(invoiceRows.map((i) => i.id), syncedInvoices);
  for (const invoiceId of invoiceIds) {
    const ok = await pushInvoice(invoiceId);
    ok ? (synced += 1) : (failed += 1);
    const counts = await pushInvoicePaymentArtifacts(
      invoiceId,
      invoiceRowsById.get(invoiceId) ?? "",
    );
    synced += counts.synced;
    failed += counts.failed;
  }

  // Push expenses, unsynced/failed first.
  const expenseRows = await db
    .select({ id: expensesTable.id })
    .from(expensesTable);
  const syncedExpenses = await loadSyncedEntityIds("expense");
  const expenseIds = unsyncedFirst(expenseRows.map((e) => e.id), syncedExpenses);
  for (const expenseId of expenseIds) {
    const ok = await pushExpense(expenseId);
    ok ? (synced += 1) : (failed += 1);
  }

  const lastSyncAt = await touchLastSync(ctx.row.id);
  return {
    ok: failed === 0,
    syncedCount: synced,
    failedCount: failed,
    lastSyncAt,
    message: messages.length > 0 ? messages.join("; ") : null,
  };
}

// Push an invoice and the payment artifact(s) that make it show as paid in QBO.
// Used by the on-paid event hook. Reflects the invoice's current paid state:
// explicit payment rows become linked Payments, while a paid invoice with no
// payment rows gets a single synthetic Payment.
export async function pushInvoiceWithPayments(
  invoiceId: number,
): Promise<void> {
  await pushInvoice(invoiceId);
  const [invoice] = await db
    .select({ status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  if (!invoice) return;
  await pushInvoicePaymentArtifacts(invoiceId, invoice.status);
}

// True only when QBO is configured AND a company is connected. Event hooks use
// this to stay completely silent on installs that never wired up QBO (so the
// sync log is not polluted with "not connected" failures on every payment).
export async function isQboReady(): Promise<boolean> {
  if (!getQboConfig()) return false;
  const row = await loadConnectionRow();
  return isConnected(row);
}

// Fire-and-forget hook: sync an invoice (and its payments) to QBO after it is
// paid/updated. Silently no-ops when QBO is not ready; never throws into the
// request path.
export function enqueueInvoiceSync(invoiceId: number): void {
  void (async () => {
    try {
      if (!(await isQboReady())) return;
      await pushInvoiceWithPayments(invoiceId);
    } catch (err) {
      logger.error({ err, invoiceId }, "Background QBO invoice sync failed");
    }
  })();
}

// Fire-and-forget hook: sync an expense to QBO after it is created/updated.
export function enqueueExpenseSync(expenseId: number): void {
  void (async () => {
    try {
      if (!(await isQboReady())) return;
      await pushExpense(expenseId);
    } catch (err) {
      logger.error({ err, expenseId }, "Background QBO expense sync failed");
    }
  })();
}

// Re-push a single sync-log record (used by the retry endpoint).
export async function retrySyncLog(
  entityType: QboEntityType,
  entityId: number,
): Promise<boolean> {
  switch (entityType) {
    case "invoice":
      return pushInvoice(entityId);
    case "payment":
      // Synthetic invoice payments are logged under a negated invoice id; route
      // their retry back through the synthetic pusher rather than a payment-row
      // lookup that would never resolve.
      return entityId < 0
        ? pushSyntheticInvoicePayment(-entityId)
        : pushPayment(entityId);
    case "expense":
      return pushExpense(entityId);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Background auto-retry of failed records
//
// A record can land in `failed` for transient reasons (an Intuit outage, an
// expired/refreshing token, a brief network blip). Rather than waiting for an
// operator to open the Integrations tab and click Retry on each row, a periodic
// sweep re-attempts failed rows on its own. Two guards keep it from looping
// forever on a permanently-bad record:
//   1. Bounded attempts: after MAX_AUTO_RETRY_ATTEMPTS consecutive failed
//      auto-retries the row is promoted to `failed_permanent` and the sweep
//      stops touching it (a manual retry is still available and resets it).
//   2. Exponential backoff: a row is only eligible once
//      backoffMs(attempts) has elapsed since its last attempt, so a flapping
//      record is not hammered every tick.
// ---------------------------------------------------------------------------

export const MAX_AUTO_RETRY_ATTEMPTS = 6;
const RETRY_BASE_BACKOFF_MS = 5 * 60_000; // 5 minutes
const RETRY_MAX_BACKOFF_MS = 6 * 60 * 60_000; // 6 hours

// Exponential backoff capped at RETRY_MAX_BACKOFF_MS: 5m, 10m, 20m, 40m, ...
function retryBackoffMs(attempts: number): number {
  const ms = RETRY_BASE_BACKOFF_MS * 2 ** attempts;
  return Math.min(ms, RETRY_MAX_BACKOFF_MS);
}

export interface QboRetrySweepResult {
  // Rows whose backoff had elapsed and were actually re-attempted this sweep.
  retried: number;
  // Of those, how many cleared to `synced`.
  recovered: number;
  // Of those, how many crossed the attempt cap into `failed_permanent`.
  exhausted: number;
}

// Reset every `failed_permanent` row back to `failed` and clear its attempt
// counter + last-attempt timestamp, so the background sweep treats it as a fresh
// eligible candidate (no backoff to wait out). Used when the operator fixes the
// underlying cause — e.g. saves a corrected account mapping — and wants records
// the sweep had given up on to be retried again. Returns the ids that were reset
// (in stable order) so a caller can re-push them immediately if desired.
export async function requeuePermanentlyFailed(): Promise<
  Array<{ id: number; entityType: string; entityId: number }>
> {
  const rows = await db
    .update(qboSyncLogTable)
    .set({ status: "failed", attempts: 0, lastAttemptedAt: null })
    .where(eq(qboSyncLogTable.status, "failed_permanent"))
    .returning({
      id: qboSyncLogTable.id,
      entityType: qboSyncLogTable.entityType,
      entityId: qboSyncLogTable.entityId,
    });
  return rows;
}

// Out-of-band owner alert when a sync record gives up for good. The in-app badge
// + Integrations banner only reach an operator who is logged in and looking; this
// surfaces the failure to an owner who may be away. Delegated to the outreach
// module's owner-alert path, which is inert (simulated) unless a live email
// provider is connected, so installs that never wired up email stay silent.
// Never throws: a failure here must not abort the sweep.
async function alertOwnerOfPermanentFailure(
  entityType: QboEntityType,
  entityId: number,
  error: string | null,
): Promise<void> {
  // Synthetic invoice payments are logged under a negated invoice id; describe
  // them in terms of their real invoice so the owner sees a meaningful record.
  const label =
    entityType === "payment" && entityId < 0
      ? `payment for invoice #${-entityId}`
      : `${entityType} #${entityId}`;
  const reason = error?.trim() ? ` Last error: ${error.trim()}` : "";
  try {
    const outcome = await notifyOwner({
      subject: "Action needed: a QuickBooks sync failed permanently",
      body:
        `A ${label} could not be synced to QuickBooks after repeated automatic retries and has been marked as a permanent failure.${reason}\n\n` +
        `This record has not reached QuickBooks. Open the Integrations tab in Reliable Shop Systems and use Retry on the Sync Log once the underlying issue is resolved.`,
    });
    logger.info(
      { entityType, entityId, delivered: outcome.delivered },
      "QBO permanent-failure owner alert processed",
    );
  } catch (err) {
    logger.error(
      { err, entityType, entityId },
      "QBO permanent-failure owner alert threw unexpectedly",
    );
  }
}

// Re-attempt eligible `failed` rows. No-ops (and records nothing) when QBO is
// not configured/connected, so installs that never wired up QBO stay silent.
// Never throws: a single bad record cannot abort the sweep or crash the caller.
export async function runQboRetrySweep(): Promise<QboRetrySweepResult> {
  const result: QboRetrySweepResult = { retried: 0, recovered: 0, exhausted: 0 };
  let ready = false;
  try {
    ready = await isQboReady();
  } catch (err) {
    logger.error({ err }, "QBO retry sweep readiness check failed");
    return result;
  }
  if (!ready) return result;

  const candidates = await db
    .select()
    .from(qboSyncLogTable)
    .where(
      and(
        eq(qboSyncLogTable.status, "failed"),
        lt(qboSyncLogTable.attempts, MAX_AUTO_RETRY_ATTEMPTS),
      ),
    );

  const now = Date.now();
  for (const entry of candidates) {
    // Backoff gate: skip rows re-attempted too recently.
    const last = entry.lastAttemptedAt
      ? new Date(entry.lastAttemptedAt).getTime()
      : 0;
    if (last && now - last < retryBackoffMs(entry.attempts)) continue;

    result.retried += 1;
    let ok = false;
    try {
      ok = await retrySyncLog(
        entry.entityType as QboEntityType,
        entry.entityId,
      );
    } catch (err) {
      // retrySyncLog already records the per-row failure via recordSync; this
      // catch only guards the sweep loop itself.
      logger.error(
        { err, logId: entry.id },
        "QBO background retry threw unexpectedly",
      );
      ok = false;
    }

    if (ok) {
      // recordSync already flipped the row to `synced` and reset attempts.
      result.recovered += 1;
      continue;
    }

    // Still failing: bump the counter (recordSync left it untouched) and, once
    // the cap is reached, promote to `failed_permanent` so it stops auto-retrying
    // and surfaces clearly in the Sync Log.
    const nextAttempts = entry.attempts + 1;
    const permanent = nextAttempts >= MAX_AUTO_RETRY_ATTEMPTS;
    await db
      .update(qboSyncLogTable)
      .set({
        attempts: nextAttempts,
        ...(permanent ? { status: "failed_permanent" } : {}),
      })
      .where(eq(qboSyncLogTable.id, entry.id));
    if (permanent) {
      result.exhausted += 1;
      // First (and only) transition into the terminal state: alert the owner out
      // of band so an away owner learns the record never reached QBO. The DB
      // write above already flipped the row to `failed_permanent`, and such rows
      // are excluded from the candidate query, so this fires exactly once per
      // record and is never re-sent on a later sweep.
      await alertOwnerOfPermanentFailure(
        entry.entityType as QboEntityType,
        entry.entityId,
        entry.error,
      );
    }
  }

  if (result.retried > 0) {
    logger.info(
      {
        retried: result.retried,
        recovered: result.recovered,
        exhausted: result.exhausted,
      },
      "QBO background retry sweep complete",
    );
  }
  return result;
}
