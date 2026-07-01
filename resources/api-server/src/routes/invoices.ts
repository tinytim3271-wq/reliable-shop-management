import { Router, type IRouter } from "express";
import { eq, desc, and, sql, type SQL } from "drizzle-orm";
import {
  db,
  invoicesTable,
  invoiceLineItemsTable,
  invoicePaymentsTable,
  usersTable,
  customersTable,
  vehiclesTable,
  workOrdersTable,
  estimatesTable,
  partsTable,
  stockMovementsTable,
  shopSettingsTable,
} from "@workspace/db";
import {
  ListInvoicesQueryParams,
  ListInvoicesResponse,
  CreateInvoiceBody,
  GetInvoiceParams,
  GetInvoiceResponse,
  UpdateInvoiceParams,
  UpdateInvoiceBody,
  UpdateInvoiceResponse,
  DeleteInvoiceParams,
  RecordInvoicePaymentParams,
  RecordInvoicePaymentBody,
  RecordInvoiceRefundParams,
  RecordInvoiceRefundBody,
  CreateInvoicePortalLinkParams,
  RevokeInvoicePortalLinkParams,
  DismissInvoiceReorderPartParams,
  DismissInvoiceReorderPartBody,
  RestoreInvoiceReorderPartParams,
  RestoreInvoiceReorderPartBody,
} from "@workspace/api-zod";
import { enqueueInvoiceSync } from "../lib/qboSync";
import { mintPortalToken, revokePortalTokens } from "../lib/portal";
import {
  vehicleLabel,
  invoiceNumber,
  shapeLineItem,
  computeTotals,
  computeCategorySubtotals,
  normalizeLineItems,
  resolveLineItemsWithCatalog,
  matchCatalogPart,
  type CatalogPart,
  type LineItemInput,
  loadCatalog,
  loadWorkOrderLineItemsForInvoice,
  buildTrackedLaborLine,
  findOverStockItems,
  findLowStockItems,
  computePartDeductions,
  isStockCommitted,
  loadDismissedReorderPartIds,
  dismissReorderPart,
  undismissReorderPart,
  fetchPriorBilledLabor,
  type EstimatePartLine,
} from "../lib/billing";
import { round2 } from "../lib/ledger";
import { missingRef } from "../lib/refs";
import { hasPermission } from "../lib/auth";
import type { Request, Response } from "express";

const router: IRouter = Router();

const invColumns = {
  id: invoicesTable.id,
  customerId: invoicesTable.customerId,
  vehicleId: invoicesTable.vehicleId,
  workOrderId: invoicesTable.workOrderId,
  estimateId: invoicesTable.estimateId,
  status: invoicesTable.status,
  notes: invoicesTable.notes,
  taxRate: invoicesTable.taxRate,
  amountPaid: invoicesTable.amountPaid,
  stripePaymentIntentId: invoicesTable.stripePaymentIntentId,
  voidedByUserId: invoicesTable.voidedByUserId,
  voidedByName: usersTable.displayName,
  voidedAt: invoicesTable.voidedAt,
  paidAt: invoicesTable.paidAt,
  createdAt: invoicesTable.createdAt,
  customerName: customersTable.name,
  vYear: vehiclesTable.year,
  vMake: vehiclesTable.make,
  vModel: vehiclesTable.model,
};

type InvRow = {
  id: number;
  customerId: number;
  vehicleId: number;
  workOrderId: number | null;
  estimateId: number | null;
  status: string;
  notes: string | null;
  taxRate: number;
  amountPaid: number;
  stripePaymentIntentId: string | null;
  voidedByUserId: number | null;
  voidedByName: string | null;
  voidedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  customerName: string | null;
  vYear: number | null;
  vMake: string | null;
  vModel: string | null;
};

const selectInvoices = () =>
  db
    .select(invColumns)
    .from(invoicesTable)
    .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
    .leftJoin(vehiclesTable, eq(invoicesTable.vehicleId, vehiclesTable.id))
    .leftJoin(usersTable, eq(invoicesTable.voidedByUserId, usersTable.id));

type StoredLineItem = typeof invoiceLineItemsTable.$inferSelect & {
  catalogPartName: string | null;
};

const fetchLineItems = (invoiceId: number) =>
  db
    .select({
      id: invoiceLineItemsTable.id,
      invoiceId: invoiceLineItemsTable.invoiceId,
      type: invoiceLineItemsTable.type,
      description: invoiceLineItemsTable.description,
      quantity: invoiceLineItemsTable.quantity,
      unitPrice: invoiceLineItemsTable.unitPrice,
      catalogPartId: invoiceLineItemsTable.catalogPartId,
      catalogPartName: partsTable.name,
    })
    .from(invoiceLineItemsTable)
    .leftJoin(partsTable, eq(invoiceLineItemsTable.catalogPartId, partsTable.id))
    .where(eq(invoiceLineItemsTable.invoiceId, invoiceId))
    .orderBy(invoiceLineItemsTable.id);

type PaymentRow = {
  id: number;
  amount: number;
  method: string;
  note: string | null;
  createdByUserId: number | null;
  createdByName: string | null;
  createdAt: string;
};

const fetchPayments = (invoiceId: number): Promise<PaymentRow[]> =>
  db
    .select({
      id: invoicePaymentsTable.id,
      amount: invoicePaymentsTable.amount,
      method: invoicePaymentsTable.method,
      note: invoicePaymentsTable.note,
      createdByUserId: invoicePaymentsTable.createdByUserId,
      createdByName: usersTable.displayName,
      createdAt: invoicePaymentsTable.createdAt,
    })
    .from(invoicePaymentsTable)
    .leftJoin(usersTable, eq(invoicePaymentsTable.createdByUserId, usersTable.id))
    .where(eq(invoicePaymentsTable.invoiceId, invoiceId))
    .orderBy(invoicePaymentsTable.id);

const shapeInvoice = (row: InvRow, items: { type: string; quantity: number; unitPrice: number }[]) => {
  const { subtotal, taxAmount, total } = computeTotals(items, row.taxRate);
  const { laborSubtotal, partsSubtotal, feesSubtotal } = computeCategorySubtotals(items);
  return {
    id: row.id,
    customerId: row.customerId,
    vehicleId: row.vehicleId,
    workOrderId: row.workOrderId,
    estimateId: row.estimateId,
    number: invoiceNumber(row.id),
    status: row.status,
    customerName: row.customerName,
    vehicleLabel: vehicleLabel({ year: row.vYear, make: row.vMake, model: row.vModel }),
    notes: row.notes,
    taxRate: row.taxRate,
    laborSubtotal,
    partsSubtotal,
    feesSubtotal,
    subtotal,
    taxAmount,
    total,
    amountPaid: row.amountPaid,
    amountDue: round2(total - row.amountPaid),
    stripePaymentIntentId: row.stripePaymentIntentId,
    voidedByUserId: row.voidedByUserId,
    voidedByName: row.voidedByName,
    voidedAt: row.voidedAt,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
  };
};

// Pull the parts catalog so part line items can surface real shop stock. Only
// callers with the `inventory` permission (or admins) may see catalog stock
// data; everyone else gets a catalog-free view (no partId / on-hand / lowStock).
const fetchCatalog = async (req: Request): Promise<CatalogPart[]> => {
  if (!hasPermission(req, "inventory")) return [];
  return db
    .select({
      id: partsTable.id,
      name: partsTable.name,
      unitPrice: partsTable.unitPrice,
      quantityOnHand: partsTable.quantityOnHand,
      reorderLevel: partsTable.reorderLevel,
    })
    .from(partsTable);
};

// Enrich a stored line item with stock context from a matching catalog part so
// the invoice detail/edit page can warn when a billed part qty exceeds on-hand.
// catalogPartName comes from the JOIN in fetchLineItems and is surfaced for all
// users (not inventory-gated) since it's the part identity recorded at write
// time, not a live stock level.
const shapeLineItemWithStock = (li: StoredLineItem, catalog: CatalogPart[]) => {
  const base = shapeLineItem(li);
  const match = li.type === "part" ? matchCatalogPart(li.description, catalog) : null;
  return {
    ...base,
    catalogPartName: li.catalogPartName ?? null,
    partId: match ? match.id : null,
    quantityOnHand: match ? match.quantityOnHand : null,
    lowStock: match ? match.quantityOnHand <= match.reorderLevel : null,
  };
};

const detail = (row: InvRow, items: StoredLineItem[], catalog: CatalogPart[]) => ({
  ...shapeInvoice(row, items),
  lineItems: items.map((li) => shapeLineItemWithStock(li, catalog)),
});

// Captioned, ordered photos from the linked work order. Gated on the workOrders
// permission so the invoice detail never exposes work-order photo paths to a
// caller who could not read them via the storage route anyway — the same
// object-storage boundary the work order itself enforces.
const fetchWorkOrderPhotos = async (
  workOrderId: number | null,
  req: Request,
): Promise<{ path: string; caption: string }[]> => {
  if (workOrderId === null || !hasPermission(req, "workOrders")) return [];
  const [wo] = await db
    .select({
      photoUrls: workOrdersTable.photoUrls,
      photoCaptions: workOrdersTable.photoCaptions,
    })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.id, workOrderId));
  if (!wo) return [];
  const captions = wo.photoCaptions ?? {};
  return (wo.photoUrls ?? []).map((path) => ({ path, caption: captions[path] ?? "" }));
};

// Matched parts billed on this invoice that have now fallen to or below their
// reorder level, so the UI can nudge staff to restock. Only meaningful once the
// invoice has committed (deducted) stock; a draft sale has taken nothing off the
// shelf. The numeric remaining/reorderLevel are disclosed only to inventory
// callers, mirroring the stock-lookup redaction so this never leaks live counts.
const fetchLowStockItems = async (
  row: InvRow,
  items: StoredLineItem[],
  req: Request,
): Promise<
  {
    partId: number | null;
    description: string;
    remaining: number | null;
    reorderLevel: number | null;
    dismissed: boolean;
  }[]
> => {
  if (!isStockCommitted(row.status)) return [];
  const catalog = await loadCatalog();
  const canSeeStock = hasPermission(req, "inventory");
  const dismissed = await loadDismissedReorderPartIds("invoice", row.id);
  return (
    findLowStockItems(items, catalog)
      // Inventory callers keep dismissed parts (flagged) so the banner's
      // "Dismissed" sub-list — and its Undo — survive a refresh. Non-inventory
      // callers can't restore a dismissal, so dismissed parts stay hidden from
      // them entirely (also keeps the partId off the wire for that boundary).
      .filter((item) => canSeeStock || !dismissed.has(item.partId))
      .map((item) => ({
        partId: canSeeStock ? item.partId : null,
        description: item.description,
        remaining: canSeeStock ? item.remaining : null,
        reorderLevel: canSeeStock ? item.reorderLevel : null,
        dismissed: dismissed.has(item.partId),
      }))
  );
};

// Build the full invoice detail response (redacted base detail plus payments,
// work-order photos, low-stock items, and prior-billed-labor). priorBilledLabor
// is computed via the shared billing helper so the estimate->invoice convert
// builder and the public portal view stay in sync with this one.
const detailWithPhotos = async (
  row: InvRow,
  items: StoredLineItem[],
  catalog: CatalogPart[],
  req: Request,
) => ({
  ...redactInvoice(detail(row, items, catalog), req),
  payments: await fetchPayments(row.id),
  workOrderPhotos: await fetchWorkOrderPhotos(row.workOrderId, req),
  lowStockItems: await fetchLowStockItems(row, items, req),
  priorBilledLabor: await fetchPriorBilledLabor(row.id, row.workOrderId),
});

// Strip cross-module fields the caller is not permitted to read.
// customerName / vehicleLabel come from the customers module.
const redactInvoice = <T extends { customerName: string | null; vehicleLabel: string | null }>(
  shaped: T,
  req: Request,
): T => ({
  ...shaped,
  customerName: hasPermission(req, "customers") ? shaped.customerName : null,
  vehicleLabel: hasPermission(req, "customers") ? shaped.vehicleLabel : null,
});

// Reject part line items that bill more units than the matched catalog entry
// has on hand, unless the caller explicitly opts in with allowOverStock. Returns
// true and writes a 409 response when blocked; returns false to continue. The
// numeric available count is only disclosed to callers with inventory access so
// this guard does not become a side channel into stock levels. Mirrors the
// estimate over-stock guard so an invoice cannot quietly bill past on-hand stock.
const blockedForOverStock = async (
  req: Request,
  res: Response,
  lineItems: EstimatePartLine[] | undefined,
  allowOverStock: boolean | undefined,
): Promise<boolean> => {
  if (allowOverStock) return false;
  if (!lineItems?.some((li) => (li.type ?? "labor") === "part")) return false;

  const catalog = await loadCatalog();
  const offenders = findOverStockItems(lineItems, catalog);
  if (offenders.length === 0) return false;

  const canSeeStock = hasPermission(req, "inventory");
  res.status(409).json({
    error:
      "One or more parts exceed available stock. Order more, reduce the quantity, or bill anyway to override.",
    overStockItems: offenders.map((o) => ({
      description: o.description,
      requested: o.requested,
      available: canSeeStock ? o.available : null,
    })),
  });
  return true;
};

type DeductionLine = { type?: string | null; description: string; quantity?: number | null };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Describes why a stock reconciliation is happening so each net change can be
// recorded in the stock movement ledger and traced back to its invoice.
type MovementSource = { reason: string; invoiceId: number | null; userId: number | null };

// Adjust catalog stock to reflect an invoice's committed (billed) state, atomically
// within the caller's transaction. Adds back the quantities previously deducted
// (oldItems, when wasDeducted) and subtracts the new deduction (newItems, when
// nowCommitted). Used on every create/edit/payment/refund/delete so editing or
// deleting a billed invoice reverses its earlier deduction. Each non-zero net
// change is also written to the stock movement ledger in the same transaction,
// so the audit log can never drift from the count. Returns the resulting
// deducted flag, which the caller persists on the invoice row.
const reconcileStock = async (
  tx: Tx,
  wasDeducted: boolean,
  oldItems: DeductionLine[],
  nowCommitted: boolean,
  newItems: DeductionLine[],
  source: MovementSource,
): Promise<boolean> => {
  if (!wasDeducted && !nowCommitted) return false;

  const catalog = await loadCatalog();
  const deltas = new Map<number, number>();
  if (wasDeducted) {
    for (const [partId, qty] of computePartDeductions(oldItems, catalog)) {
      deltas.set(partId, (deltas.get(partId) ?? 0) + qty);
    }
  }
  if (nowCommitted) {
    for (const [partId, qty] of computePartDeductions(newItems, catalog)) {
      deltas.set(partId, (deltas.get(partId) ?? 0) - qty);
    }
  }

  for (const [partId, delta] of deltas) {
    if (delta === 0) continue;
    await tx
      .update(partsTable)
      .set({ quantityOnHand: sql`${partsTable.quantityOnHand} + ${delta}` })
      .where(eq(partsTable.id, partId));
    await tx.insert(stockMovementsTable).values({
      partId,
      delta,
      reason: source.reason,
      sourceType: "invoice",
      sourceId: source.invoiceId,
      createdByUserId: source.userId,
    });
  }
  return nowCommitted;
};

router.get("/invoices", async (req, res): Promise<void> => {
  const query = ListInvoicesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const filters: SQL[] = [];
  if (query.data.status) filters.push(eq(invoicesTable.status, query.data.status));
  if (query.data.customerId) filters.push(eq(invoicesTable.customerId, query.data.customerId));

  const base = selectInvoices();
  const rows = filters.length
    ? await base.where(and(...filters)).orderBy(desc(invoicesTable.id))
    : await base.orderBy(desc(invoicesTable.id));

  const allItems = await db.select().from(invoiceLineItemsTable);
  const shaped = rows.map((row) =>
    redactInvoice(
      shapeInvoice(
        row,
        allItems.filter((li) => li.invoiceId === row.id),
      ),
      req,
    ),
  );

  res.json(ListInvoicesResponse.parse(shaped));
});

router.post("/invoices", async (req, res): Promise<void> => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Cross-module permission guards: supplying a FK into a protected module
  // requires the caller to also hold that module's permission.
  if (parsed.data.customerId != null && !hasPermission(req, "customers")) {
    res.status(403).json({ error: "You do not have permission to link to a customer record" });
    return;
  }
  if (parsed.data.vehicleId != null && !hasPermission(req, "customers")) {
    res.status(403).json({ error: "You do not have permission to link to a vehicle record" });
    return;
  }
  if (parsed.data.workOrderId != null && !hasPermission(req, "workOrders")) {
    res.status(403).json({ error: "You do not have permission to link to a work order" });
    return;
  }
  if (parsed.data.estimateId != null && !hasPermission(req, "estimates")) {
    res.status(403).json({ error: "You do not have permission to link to an estimate" });
    return;
  }

  const refError =
    (await missingRef(customersTable, parsed.data.customerId, "Customer")) ??
    (await missingRef(vehiclesTable, parsed.data.vehicleId, "Vehicle")) ??
    (await missingRef(workOrdersTable, parsed.data.workOrderId, "Work order")) ??
    (await missingRef(estimatesTable, parsed.data.estimateId, "Estimate"));
  if (refError) {
    res.status(400).json({ error: refError });
    return;
  }

  // Relational consistency: the vehicle must belong to the specified customer,
  // the work order (if any) must belong to the same customer and vehicle, and
  // the estimate (if any) must belong to the same customer and vehicle.
  // Without these checks a staff user could manufacture cross-customer record
  // graphs that the public portal renders as if they belong to one customer.
  if (parsed.data.vehicleId != null && parsed.data.customerId != null) {
    const [v] = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(and(eq(vehiclesTable.id, parsed.data.vehicleId), eq(vehiclesTable.customerId, parsed.data.customerId)));
    if (!v) {
      res.status(400).json({ error: "Vehicle does not belong to the specified customer" });
      return;
    }
  }
  if (parsed.data.workOrderId != null) {
    const woConditions: SQL[] = [eq(workOrdersTable.id, parsed.data.workOrderId)];
    if (parsed.data.customerId != null) woConditions.push(eq(workOrdersTable.customerId, parsed.data.customerId));
    if (parsed.data.vehicleId != null) woConditions.push(eq(workOrdersTable.vehicleId, parsed.data.vehicleId));
    const [wo] = await db
      .select({ id: workOrdersTable.id })
      .from(workOrdersTable)
      .where(and(...woConditions));
    if (!wo) {
      res.status(400).json({ error: "Work order does not belong to the specified customer or vehicle" });
      return;
    }
  }
  if (parsed.data.estimateId != null) {
    const estConditions: SQL[] = [eq(estimatesTable.id, parsed.data.estimateId)];
    if (parsed.data.customerId != null) estConditions.push(eq(estimatesTable.customerId, parsed.data.customerId));
    if (parsed.data.vehicleId != null) estConditions.push(eq(estimatesTable.vehicleId, parsed.data.vehicleId));
    const [est] = await db
      .select({ id: estimatesTable.id })
      .from(estimatesTable)
      .where(and(...estConditions));
    if (!est) {
      res.status(400).json({ error: "Estimate does not belong to the specified customer or vehicle" });
      return;
    }
  }

  // When generating an invoice from a work order and no explicit line items
  // were supplied, seed them from the work order's stored tasks & parts so the
  // bill carries over the labor/parts already recorded. Totals are still
  // computed server-side from these seeded items (same money model).
  // Exclude parts already billed on this work order's prior (non-void) invoices
  // by default, so a follow-up invoice doesn't silently re-charge the same
  // components (mirrors how tracked labor defaults to the un-billed remainder).
  // Staff can opt back in with rebillParts to re-seed the already-billed parts.
  let effectiveLineItems: LineItemInput[] | undefined = parsed.data.lineItems;
  if (parsed.data.workOrderId != null && (!effectiveLineItems || effectiveLineItems.length === 0)) {
    effectiveLineItems = await loadWorkOrderLineItemsForInvoice(
      parsed.data.workOrderId,
      !parsed.data.rebillParts,
    );
  }

  // Bill the work order's tracked labor time as a priced labor line. The caller
  // supplies the (staff-reviewed) hours; the rate defaults to the shop's
  // configured default labor rate unless an explicit laborRate override is
  // given. Only applies when generating from a work order, and is appended after
  // any seeded line items so totals still recompute server-side from the full
  // set (same money model).
  if (parsed.data.workOrderId != null && (parsed.data.laborHours ?? 0) > 0) {
    let rate = parsed.data.laborRate;
    if (rate == null) {
      const [settings] = await db
        .select({ defaultLaborRate: shopSettingsTable.defaultLaborRate })
        .from(shopSettingsTable)
        .where(eq(shopSettingsTable.id, 1));
      rate = settings?.defaultLaborRate ?? 0;
    }
    const laborLine = buildTrackedLaborLine(parsed.data.laborHours as number, rate);
    if (laborLine) {
      effectiveLineItems = [...(effectiveLineItems ?? []), laborLine];
    }
  }

  if (
    await blockedForOverStock(req, res, effectiveLineItems, parsed.data.allowOverStock)
  ) {
    return;
  }

  const status = parsed.data.status ?? "draft";
  const nowCommitted = isStockCommitted(status);
  const rawInvoiceItems = normalizeLineItems(effectiveLineItems);
  const invoiceCreateCatalog =
    rawInvoiceItems.some((li) => li.type === "part") ? await loadCatalog() : [];
  const items = resolveLineItemsWithCatalog(rawInvoiceItems, invoiceCreateCatalog);

  // Creating an invoice in a committed status (sent / partial / paid) triggers
  // stock deduction for part line items. Require the inventory permission —
  // the same boundary enforced on /parts, /purchase-orders, and stock-movement
  // routes — so only authorized users can mutate canonical inventory counts.
  if (nowCommitted && items.some((li) => li.type === "part") && !hasPermission(req, "inventory")) {
    res.status(403).json({ error: "You do not have permission to commit inventory stock on an invoice" });
    return;
  }

  const created = await db.transaction(async (tx) => {
    const [inv] = await tx
      .insert(invoicesTable)
      .values({
        customerId: parsed.data.customerId,
        vehicleId: parsed.data.vehicleId,
        workOrderId: parsed.data.workOrderId ?? null,
        estimateId: parsed.data.estimateId ?? null,
        notes: parsed.data.notes ?? null,
        taxRate: parsed.data.taxRate ?? 0,
        status,
        stockDeducted: nowCommitted,
      })
      .returning();

    if (items.length) {
      await tx
        .insert(invoiceLineItemsTable)
        .values(items.map((li) => ({ ...li, invoiceId: inv.id })));
    }

    await reconcileStock(tx, false, [], nowCommitted, items, {
      reason: "Billed on invoice",
      invoiceId: inv.id,
      userId: req.currentUser?.id ?? null,
    });

    // Generating an invoice from a work order closes the billing loop: advance
    // the source work order to "invoiced" so the board reflects that it has been
    // billed (and double-invoicing is visible). The caller already holds the
    // workOrders permission (guarded above) to link the FK.
    if (parsed.data.workOrderId != null) {
      await tx
        .update(workOrdersTable)
        .set({ status: "invoiced" })
        .where(eq(workOrdersTable.id, parsed.data.workOrderId));
    }
    return inv;
  });

  const [row] = await selectInvoices().where(eq(invoicesTable.id, created.id));
  const stored = await fetchLineItems(created.id);
  res.status(201).json(UpdateInvoiceResponse.parse(await detailWithPhotos(row, stored, await fetchCatalog(req), req)));
});

router.get("/invoices/:id", async (req, res): Promise<void> => {
  const params = GetInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await selectInvoices().where(eq(invoicesTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  const stored = await fetchLineItems(row.id);
  res.json(GetInvoiceResponse.parse(await detailWithPhotos(row, stored, await fetchCatalog(req), req)));
});

router.patch("/invoices/:id", async (req, res): Promise<void> => {
  const params = UpdateInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  if (
    (parsed.data.customerId !== undefined || parsed.data.vehicleId !== undefined) &&
    !hasPermission(req, "customers")
  ) {
    res.status(403).json({ error: "You do not have permission to reassign invoice ownership" });
    return;
  }

  if (parsed.data.workOrderId !== undefined && !hasPermission(req, "workOrders")) {
    res.status(403).json({ error: "You do not have permission to link to a work order" });
    return;
  }
  // NOTE: estimateId is intentionally absent from UpdateInvoiceBody and cannot
  // be changed via PATCH. It is set once at invoice creation (POST /invoices)
  // and is thereafter read-only. UpdateInvoiceBody.safeParse strips any
  // estimateId present in the request body, so no permission gate or relational
  // consistency check is needed here — the field is simply not writable.

  const ownerRefError =
    (await missingRef(customersTable, parsed.data.customerId, "Customer")) ??
    (await missingRef(vehiclesTable, parsed.data.vehicleId, "Vehicle")) ??
    (await missingRef(workOrdersTable, parsed.data.workOrderId, "Work order"));
  if (ownerRefError) {
    res.status(400).json({ error: ownerRefError });
    return;
  }

  // Relational consistency: use the effective (new or existing) FK values so a
  // partial PATCH that only changes workOrderId is still validated against the
  // current customer/vehicle context. Run vehicle check whenever customerId or
  // vehicleId is being reassigned so a customer-only change that retains a
  // mismatched vehicle is rejected too.
  const effCustomerId = parsed.data.customerId ?? existing.customerId;
  const effVehicleId = parsed.data.vehicleId ?? existing.vehicleId;
  const effWorkOrderId =
    parsed.data.workOrderId !== undefined ? parsed.data.workOrderId : existing.workOrderId;

  if (parsed.data.vehicleId != null || parsed.data.customerId != null) {
    const [v] = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(and(eq(vehiclesTable.id, effVehicleId), eq(vehiclesTable.customerId, effCustomerId)));
    if (!v) {
      res.status(400).json({ error: "Vehicle does not belong to the specified customer" });
      return;
    }
  }
  if (effWorkOrderId != null && (parsed.data.workOrderId !== undefined || parsed.data.customerId !== undefined || parsed.data.vehicleId !== undefined)) {
    const woConditions: SQL[] = [eq(workOrdersTable.id, effWorkOrderId), eq(workOrdersTable.customerId, effCustomerId), eq(workOrdersTable.vehicleId, effVehicleId)];
    const [wo] = await db
      .select({ id: workOrdersTable.id })
      .from(workOrdersTable)
      .where(and(...woConditions));
    if (!wo) {
      res.status(400).json({ error: "Work order does not belong to the specified customer or vehicle" });
      return;
    }
  }
  // When customer or vehicle is being reassigned, verify the existing estimateId
  // (which is read-only and cannot be changed via PATCH) still belongs to the
  // effective customer/vehicle. Without this check a reassignment could leave
  // the invoice referencing an estimate from a different customer.
  if (
    existing.estimateId != null &&
    (parsed.data.customerId !== undefined || parsed.data.vehicleId !== undefined)
  ) {
    const [est] = await db
      .select({ id: estimatesTable.id })
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.id, existing.estimateId),
          eq(estimatesTable.customerId, effCustomerId),
          eq(estimatesTable.vehicleId, effVehicleId),
        ),
      );
    if (!est) {
      res.status(400).json({ error: "Cannot reassign customer or vehicle: linked estimate belongs to a different customer or vehicle" });
      return;
    }
  }

  if (
    await blockedForOverStock(req, res, parsed.data.lineItems, parsed.data.allowOverStock)
  ) {
    return;
  }

  const { lineItems, allowOverStock: _allowOverStock, ...fields } = parsed.data;

  // Revoke any outstanding portal tokens when the invoice's ownership or
  // context changes:
  //   • workOrderId change — the photo snapshot would serve photos from the
  //     wrong work order.
  //   • customerId / vehicleId change — the portal view reads the live record,
  //     so an old recipient would see the new customer's details and pricing.
  const workOrderChanging =
    parsed.data.workOrderId !== undefined &&
    parsed.data.workOrderId !== existing.workOrderId;
  const customerChanging =
    parsed.data.customerId !== undefined &&
    parsed.data.customerId !== existing.customerId;
  const vehicleChanging =
    parsed.data.vehicleId !== undefined &&
    parsed.data.vehicleId !== existing.vehicleId;
  const ownershipChanging = workOrderChanging || customerChanging || vehicleChanging;

  // Snapshot the pre-edit part lines so any prior stock deduction can be reversed
  // before the new state is applied.
  const oldItems = await fetchLineItems(params.data.id);
  const newStatus = fields.status ?? existing.status;
  const nowCommitted = isStockCommitted(newStatus);

  // Guard: transitions into or out of financially sensitive statuses require the
  // `accounting` permission. These statuses — paid, partial, void — are supposed
  // to be written only through the payment/refund accounting flow (which already
  // enforces `accounting`). Allowing them via a plain PATCH lets a low-privilege
  // invoice editor forge settled or canceled receivables without any durable
  // payment trail and without the `accounting` gate.
  //
  // Covered cases:
  //   • status → paid / partial / void  (forging a financial state)
  //   • paid / partial / void → anything else  (silently reversing one)
  //
  // A status-neutral edit (status field absent, or same value supplied) does
  // not require `accounting`, so routine edits (notes, line items on a draft
  // invoice, etc.) are unaffected.
  const ACCOUNTING_STATUSES = new Set(["paid", "partial", "void"]);
  const statusIsChanging =
    parsed.data.status !== undefined && parsed.data.status !== existing.status;
  const accountingStatusInvolved =
    statusIsChanging &&
    (ACCOUNTING_STATUSES.has(newStatus) || ACCOUNTING_STATUSES.has(existing.status));
  if (accountingStatusInvolved && !hasPermission(req, "accounting")) {
    res.status(403).json({
      error:
        "Setting invoice status to paid, partial, or void — or changing away from those states — requires accounting permission. Use the payment or refund endpoints instead.",
    });
    return;
  }
  const newItems = lineItems ? normalizeLineItems(lineItems) : oldItems;

  // Invoice edits that produce a canonical inventory mutation require the
  // inventory permission. Three cases apply:
  //   • status transitions into a committed state  — stock is newly deducted
  //   • status transitions out of a committed state — previously-deducted stock
  //     is returned (reconcile reverses the old deduction)
  //   • status remains committed AND line items are being changed — reconcile
  //     reverses oldItems then applies newItems; either set may contain parts
  //     (e.g. replacing parts with labor lines still credits stock back)
  // The third case is checked conservatively: any committed line-item edit is
  // treated as a mutation regardless of the new lines' types, so a caller
  // cannot bypass the guard by supplying only non-part replacement lines.
  const invoiceInventoryMutates =
    (existing.stockDeducted !== nowCommitted) ||
    (nowCommitted && lineItems !== undefined);
  if (invoiceInventoryMutates && !hasPermission(req, "inventory")) {
    res.status(403).json({ error: "You do not have permission to modify inventory stock on an invoice" });
    return;
  }

  // Durable, invoice-level void attribution. Voiding is financially sensitive,
  // so record who voided it and when on the invoice itself (not just the stock
  // ledger) the first time it transitions into the void status. If the invoice
  // is later moved back off void, clear the attribution so it never goes stale.
  const becomingVoid = newStatus === "void" && existing.status !== "void";
  const leavingVoid = newStatus !== "void" && existing.status === "void";
  const voidFields = becomingVoid
    ? { voidedByUserId: req.currentUser?.id ?? null, voidedAt: new Date().toISOString() }
    : leavingVoid
      ? { voidedByUserId: null, voidedAt: null }
      : {};

  if (ownershipChanging) {
    await revokePortalTokens({ invoiceId: params.data.id });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(invoicesTable)
      .set({ ...fields, ...voidFields, stockDeducted: nowCommitted })
      .where(eq(invoicesTable.id, params.data.id));

    if (lineItems) {
      await tx
        .delete(invoiceLineItemsTable)
        .where(eq(invoiceLineItemsTable.invoiceId, params.data.id));
      const rawPatchInvoiceItems = normalizeLineItems(lineItems);
      const patchInvoiceCatalog =
        rawPatchInvoiceItems.some((li) => li.type === "part") ? await loadCatalog() : [];
      const patchItems = resolveLineItemsWithCatalog(rawPatchInvoiceItems, patchInvoiceCatalog);
      if (patchItems.length) {
        await tx
          .insert(invoiceLineItemsTable)
          .values(patchItems.map((li) => ({ ...li, invoiceId: params.data.id })));
      }
    }

    await reconcileStock(tx, existing.stockDeducted, oldItems, nowCommitted, newItems, {
      reason: newStatus === "void" ? "Invoice voided" : "Invoice edited",
      invoiceId: params.data.id,
      userId: req.currentUser?.id ?? null,
    });
  });

  const [row] = await selectInvoices().where(eq(invoicesTable.id, params.data.id));
  const stored = await fetchLineItems(params.data.id);
  res.json(UpdateInvoiceResponse.parse(await detailWithPhotos(row, stored, await fetchCatalog(req), req)));

  // Fire-and-forget QBO push when an edit transitions the invoice into `paid`.
  // The payment/refund handlers cover their own money-movement paths; this
  // covers a direct status edit. Post-commit, non-blocking, and a no-op
  // internally when QBO is not configured/connected.
  if (existing.status !== "paid" && newStatus === "paid") {
    enqueueInvoiceSync(params.data.id);
  }
});

router.delete("/invoices/:id", async (req, res): Promise<void> => {
  const params = DeleteInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Deleting a committed invoice returns its deducted parts to inventory. That
  // is a canonical inventory mutation — enforce the same boundary used by
  // /parts, /purchase-orders, and the other stock-affecting invoice paths. Read
  // stockDeducted outside the transaction so we can reject before locking.
  const [preDelete] = await db
    .select({ stockDeducted: invoicesTable.stockDeducted })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, params.data.id));
  if (preDelete?.stockDeducted && !hasPermission(req, "inventory")) {
    res.status(403).json({ error: "You do not have permission to delete an invoice that has committed inventory stock" });
    return;
  }

  // Revoke any outstanding portal tokens so customers holding an existing link
  // can no longer access the portal view or any photos once the invoice is gone.
  await revokePortalTokens({ invoiceId: params.data.id });

  const deleted = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, params.data.id));
    if (!existing) return null;

    // Restore any stock this invoice had deducted before its line items cascade away.
    if (existing.stockDeducted) {
      const oldItems = await tx
        .select()
        .from(invoiceLineItemsTable)
        .where(eq(invoiceLineItemsTable.invoiceId, params.data.id));
      await reconcileStock(tx, true, oldItems, false, [], {
        reason: "Invoice deleted",
        invoiceId: params.data.id,
        userId: req.currentUser?.id ?? null,
      });
    }

    await tx.delete(invoicesTable).where(eq(invoicesTable.id, params.data.id));
    return existing;
  });

  if (!deleted) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  res.sendStatus(204);
});

// Mint a customer portal link for this invoice (read-only view; card payment is
// a future phase). The raw token is returned exactly once; only its hash is
// stored.
router.post("/invoices/:id/portal-link", async (req, res): Promise<void> => {
  const params = CreateInvoicePortalLinkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  if (!hasPermission(req, "customers")) {
    res.status(403).json({ error: "customers permission required to mint portal links" });
    return;
  }
  if (!hasPermission(req, "workOrders")) {
    res.status(403).json({ error: "workOrders permission required to mint portal links" });
    return;
  }

  const [existing] = await db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  const link = await mintPortalToken({
    invoiceId: params.data.id,
    createdByUserId: req.currentUser?.id ?? null,
  });
  res.status(201).json(link);
});

router.delete("/invoices/:id/portal-link", async (req, res): Promise<void> => {
  const params = RevokeInvoicePortalLinkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  if (!hasPermission(req, "customers")) {
    res.status(403).json({ error: "customers permission required to revoke portal links" });
    return;
  }
  if (!hasPermission(req, "workOrders")) {
    res.status(403).json({ error: "workOrders permission required to revoke portal links" });
    return;
  }

  const [existing] = await db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  await revokePortalTokens({ invoiceId: params.data.id });
  res.sendStatus(204);
});

// Persist a dismissal of a low-stock part from this invoice's reorder banner so
// it stays dismissed across refreshes. Requires the inventory permission (the
// reorder nudge is inventory-scoped; non-inventory callers never see partIds to
// dismiss). The dismissal is filtered back out of lowStockItems on read.
router.post("/invoices/:id/reorder-dismissals", async (req, res): Promise<void> => {
  const params = DismissInvoiceReorderPartParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = DismissInvoiceReorderPartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!hasPermission(req, "inventory")) {
    res.status(403).json({ error: "You do not have permission to manage inventory" });
    return;
  }

  const [existing] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  const [part] = await db
    .select({ id: partsTable.id })
    .from(partsTable)
    .where(eq(partsTable.id, parsed.data.partId));
  if (!part) {
    res.status(404).json({ error: "Part not found" });
    return;
  }

  await dismissReorderPart({
    recordType: "invoice",
    recordId: params.data.id,
    partId: parsed.data.partId,
    userId: req.currentUser?.id ?? null,
  });
  res.sendStatus(204);
});

// Restore a previously-dismissed low-stock part to this invoice's reorder
// banner, so staff who dismissed a part by mistake can bring the reminder back.
// Requires the inventory permission (same boundary as dismissing). The dismissal
// row is removed so the part reappears in lowStockItems on read. Idempotent.
router.delete("/invoices/:id/reorder-dismissals", async (req, res): Promise<void> => {
  const params = RestoreInvoiceReorderPartParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = RestoreInvoiceReorderPartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!hasPermission(req, "inventory")) {
    res.status(403).json({ error: "You do not have permission to manage inventory" });
    return;
  }

  const [existing] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  await undismissReorderPart({
    recordType: "invoice",
    recordId: params.data.id,
    partId: parsed.data.partId,
  });
  res.sendStatus(204);
});

router.post("/invoices/:id/payments", async (req, res): Promise<void> => {
  if (!hasPermission(req, "accounting")) {
    res.status(403).json({ error: "You do not have permission to record payments" });
    return;
  }

  const params = RecordInvoicePaymentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = RecordInvoicePaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Validate existence and fetch line items before entering the transaction.
  // Line items are not mutated by concurrent payment/refund requests so they
  // are safe to read outside the lock.
  const [preCheck] = await db
    .select({ id: invoicesTable.id, taxRate: invoicesTable.taxRate, status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, params.data.id));
  if (!preCheck) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  const stored = await fetchLineItems(params.data.id);
  const { total } = computeTotals(stored, preCheck.taxRate);

  // Body-level validations that do not depend on the concurrent amountPaid state.
  if (parsed.data.amount <= 0) {
    res.status(400).json({ error: "Payment amount must be greater than zero" });
    return;
  }
  if (preCheck.status === "void" || preCheck.status === "cancelled") {
    res.status(400).json({ error: `Cannot record a payment on a ${preCheck.status} invoice` });
    return;
  }
  if (total <= 0) {
    res.status(400).json({ error: "Invoice has no amount to pay" });
    return;
  }

  // All amount-dependent checks and the invoice UPDATE happen inside a single
  // transaction with a SELECT FOR UPDATE row lock. Concurrent payment or refund
  // requests will block on that lock, so each request sees the authoritative
  // amountPaid written by the previous one instead of a stale pre-read value.
  let routeError: { httpStatus: number; message: string } | null = null;

  await db.transaction(async (tx) => {
    // Lock this invoice row for the duration of the transaction. Any concurrent
    // payment or refund will wait here until we commit or roll back, ensuring
    // each request computes its amountDue / newPaid from up-to-date state.
    const [locked] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, params.data.id))
      .for("update");

    if (!locked) {
      routeError = { httpStatus: 404, message: "Invoice not found" };
      return;
    }

    // Re-check status inside the lock to catch a concurrent void or cancel.
    if (locked.status === "void" || locked.status === "cancelled") {
      routeError = { httpStatus: 400, message: `Cannot record a payment on a ${locked.status} invoice` };
      return;
    }

    // Recompute amountDue from the authoritative locked row, not the stale pre-read.
    const { total: lockedTotal } = computeTotals(stored, locked.taxRate);
    const amountDue = round2(lockedTotal - locked.amountPaid);
    if (amountDue <= 0) {
      routeError = { httpStatus: 400, message: "Invoice is already fully paid" };
      return;
    }
    // Compare in cents so an exact final payment is not rejected by float drift.
    if (Math.round(parsed.data.amount * 100) > Math.round(amountDue * 100)) {
      routeError = { httpStatus: 400, message: "Payment exceeds the amount due" };
      return;
    }

    const newPaid = round2(locked.amountPaid + parsed.data.amount);
    const fullyPaid = newPaid >= lockedTotal;
    const status = fullyPaid ? "paid" : "partial";
    // A payment can move a draft invoice into a committed state, so reconcile stock.
    const nowCommitted = isStockCommitted(status);

    // Recording a payment may be the first event that transitions this invoice into
    // a committed status (partial / paid). If the invoice carries part line items
    // and was not yet stock-deducted, this operation mutates canonical inventory —
    // require the inventory permission, consistent with the boundary on /parts,
    // /purchase-orders, and the work-order deductStock paths.
    if (!locked.stockDeducted && nowCommitted && stored.some((li) => li.type === "part") && !hasPermission(req, "inventory")) {
      routeError = { httpStatus: 403, message: "You do not have permission to commit inventory stock via invoice payment" };
      return;
    }

    // Persist the individual payment event so the invoice keeps a durable, per-row
    // money trail (amount, method, who, when). amountPaid is kept in sync as the
    // running sum of these rows.
    await tx.insert(invoicePaymentsTable).values({
      invoiceId: params.data.id,
      amount: parsed.data.amount,
      method: parsed.data.method ?? "cash",
      note: parsed.data.note ?? null,
      createdByUserId: req.currentUser?.id ?? null,
    });

    await tx
      .update(invoicesTable)
      .set({
        amountPaid: newPaid,
        status,
        stockDeducted: nowCommitted,
        ...(fullyPaid ? { paidAt: new Date().toISOString() } : {}),
      })
      .where(eq(invoicesTable.id, params.data.id));

    await reconcileStock(tx, locked.stockDeducted, stored, nowCommitted, stored, {
      reason: "Billed on invoice",
      invoiceId: params.data.id,
      userId: req.currentUser?.id ?? null,
    });
  });

  if (routeError !== null) {
    const err = routeError as { httpStatus: number; message: string };
    res.status(err.httpStatus).json({ error: err.message });
    return;
  }

  // Mirror the paid invoice (and its payments) into QuickBooks Online. No-ops
  // unless QBO is connected; never blocks or fails the payment response.
  enqueueInvoiceSync(params.data.id);

  const [row] = await selectInvoices().where(eq(invoicesTable.id, params.data.id));
  res.json(UpdateInvoiceResponse.parse(await detailWithPhotos(row, stored, await fetchCatalog(req), req)));
});

router.post("/invoices/:id/refunds", async (req, res): Promise<void> => {
  if (!hasPermission(req, "accounting")) {
    res.status(403).json({ error: "You do not have permission to issue refunds" });
    return;
  }

  const params = RecordInvoiceRefundParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = RecordInvoiceRefundBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Validate existence and fetch line items before entering the transaction.
  // Line items are not mutated by concurrent payment/refund requests so they
  // are safe to read outside the lock.
  const [preCheck] = await db
    .select({ id: invoicesTable.id, taxRate: invoicesTable.taxRate, status: invoicesTable.status })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, params.data.id));
  if (!preCheck) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  const stored = await fetchLineItems(params.data.id);
  const { total } = computeTotals(stored, preCheck.taxRate);

  // Body-level validations that do not depend on the concurrent amountPaid state.
  if (parsed.data.amount <= 0) {
    res.status(400).json({ error: "Refund amount must be greater than zero" });
    return;
  }
  if (preCheck.status === "void" || preCheck.status === "cancelled") {
    res.status(400).json({ error: `Cannot refund a ${preCheck.status} invoice` });
    return;
  }

  // All amount-dependent checks and the invoice UPDATE happen inside a single
  // transaction with a SELECT FOR UPDATE row lock. Concurrent payment or refund
  // requests will block on that lock, so each request sees the authoritative
  // amountPaid written by the previous one instead of a stale pre-read value.
  let routeError: { httpStatus: number; message: string } | null = null;

  await db.transaction(async (tx) => {
    // Lock this invoice row for the duration of the transaction. Any concurrent
    // payment or refund will wait here until we commit or roll back, ensuring
    // each request computes its newPaid from up-to-date state.
    const [locked] = await tx
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, params.data.id))
      .for("update");

    if (!locked) {
      routeError = { httpStatus: 404, message: "Invoice not found" };
      return;
    }

    // Re-check status inside the lock to catch a concurrent void or cancel.
    if (locked.status === "void" || locked.status === "cancelled") {
      routeError = { httpStatus: 400, message: `Cannot refund a ${locked.status} invoice` };
      return;
    }

    // Re-check amountPaid from the authoritative locked row.
    if (locked.amountPaid <= 0) {
      routeError = { httpStatus: 400, message: "Invoice has no payments to refund" };
      return;
    }
    // Compare in cents so an exact full refund is not rejected by float drift.
    if (Math.round(parsed.data.amount * 100) > Math.round(locked.amountPaid * 100)) {
      routeError = { httpStatus: 400, message: "Refund exceeds the amount paid" };
      return;
    }

    const { total: lockedTotal } = computeTotals(stored, locked.taxRate);
    const newPaid = round2(locked.amountPaid - parsed.data.amount);
    const fullyPaid = lockedTotal > 0 && newPaid >= lockedTotal;
    const status = newPaid <= 0 ? "sent" : fullyPaid ? "paid" : "partial";
    const nowCommitted = isStockCommitted(status);

    // A full refund that drives a committed invoice back to "sent" restores
    // previously deducted parts to inventory. That is a canonical inventory
    // mutation — enforce the same boundary used by the delete and payment
    // paths, which already guard equivalent stock transitions.
    if (locked.stockDeducted && !nowCommitted && !hasPermission(req, "inventory")) {
      routeError = {
        httpStatus: 403,
        message: "You do not have permission to refund an invoice that would restore committed inventory stock",
      };
      return;
    }

    // Persist the refund as a negative-amount payment row carrying its tender
    // method and date. This keeps the per-method drawer reconciliation honest:
    // a cash refund must reduce the "Cash" bucket, not just the invoice's
    // amountPaid scalar. amountPaid stays the running sum of these rows.
    await tx.insert(invoicePaymentsTable).values({
      invoiceId: params.data.id,
      amount: -parsed.data.amount,
      method: parsed.data.method ?? "cash",
      note: parsed.data.note ?? null,
      createdByUserId: req.currentUser?.id ?? null,
    });

    await tx
      .update(invoicesTable)
      .set({
        amountPaid: newPaid,
        status,
        stockDeducted: nowCommitted,
        ...(fullyPaid ? {} : { paidAt: null }),
      })
      .where(eq(invoicesTable.id, params.data.id));

    await reconcileStock(tx, locked.stockDeducted, stored, nowCommitted, stored, {
      reason: "Invoice refunded",
      invoiceId: params.data.id,
      userId: req.currentUser?.id ?? null,
    });
  });

  if (routeError !== null) {
    const err = routeError as { httpStatus: number; message: string };
    res.status(err.httpStatus).json({ error: err.message });
    return;
  }

  // Reflect the refund (a negative payment) into QuickBooks Online.
  enqueueInvoiceSync(params.data.id);

  const [row] = await selectInvoices().where(eq(invoicesTable.id, params.data.id));
  res.json(UpdateInvoiceResponse.parse(await detailWithPhotos(row, stored, await fetchCatalog(req), req)));
});

export default router;
