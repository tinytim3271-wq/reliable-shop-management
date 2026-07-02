import {
  db,
  partsTable,
  workOrderLineItemsTable,
  reorderDismissalsTable,
  invoicesTable,
  invoiceLineItemsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { round2 } from "./ledger";

// The two kinds of records that can own a low-stock reorder dismissal.
export type ReorderRecordType = "invoice" | "work_order";

// A database executor that is either the root `db` handle or a transaction
// handle, so dismissal cleanup can participate in a caller's transaction (PO
// receive / part adjustment) or run standalone.
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// When a part's stock is replenished back above its reorder level, drop any
// prior reorder-banner dismissals for that part across every record. Dismissals
// are meant to silence a *specific* low-stock episode; once the part is restocked
// the episode is over, so a fresh low-stock situation later (a new sale pulling
// it back down) must surface again instead of staying hidden by a stale
// dismissal. Reads the part's current quantity/reorder level from the given
// executor (so it sees the just-written stock change) and no-ops if the part is
// gone or still at/below its reorder level.
export const clearReorderDismissalsIfReplenished = async (
  partId: number,
  executor: DbExecutor = db,
): Promise<void> => {
  const [part] = await executor
    .select({
      quantityOnHand: partsTable.quantityOnHand,
      reorderLevel: partsTable.reorderLevel,
    })
    .from(partsTable)
    .where(eq(partsTable.id, partId));
  if (!part) return;
  if (part.quantityOnHand > part.reorderLevel) {
    await executor.delete(reorderDismissalsTable).where(eq(reorderDismissalsTable.partId, partId));
  }
};

// Load the set of catalog part ids a user has dismissed from the reorder banner
// for a given record, so the server can filter them back out of lowStockItems.
// Returns an empty set when nothing has been dismissed.
export const loadDismissedReorderPartIds = async (
  recordType: ReorderRecordType,
  recordId: number,
): Promise<Set<number>> => {
  const rows = await db
    .select({ partId: reorderDismissalsTable.partId })
    .from(reorderDismissalsTable)
    .where(
      and(
        eq(reorderDismissalsTable.recordType, recordType),
        eq(reorderDismissalsTable.recordId, recordId),
      ),
    );
  return new Set(rows.map((r) => r.partId));
};

// Record a reorder-banner dismissal for one part on one record. Idempotent: the
// unique (recordType, recordId, partId) index means re-dismissing the same part
// is a no-op rather than an error, so a double-click never 500s.
export const dismissReorderPart = async (args: {
  recordType: ReorderRecordType;
  recordId: number;
  partId: number;
  userId: number | null;
}): Promise<void> => {
  await db
    .insert(reorderDismissalsTable)
    .values({
      recordType: args.recordType,
      recordId: args.recordId,
      partId: args.partId,
      dismissedByUserId: args.userId,
    })
    .onConflictDoNothing({
      target: [
        reorderDismissalsTable.recordType,
        reorderDismissalsTable.recordId,
        reorderDismissalsTable.partId,
      ],
    });
};

// Remove a reorder-banner dismissal for one part on one record, so the part
// shows up again in lowStockItems. Idempotent: deleting a dismissal that does
// not exist is a no-op rather than an error.
export const undismissReorderPart = async (args: {
  recordType: ReorderRecordType;
  recordId: number;
  partId: number;
}): Promise<void> => {
  await db
    .delete(reorderDismissalsTable)
    .where(
      and(
        eq(reorderDismissalsTable.recordType, args.recordType),
        eq(reorderDismissalsTable.recordId, args.recordId),
        eq(reorderDismissalsTable.partId, args.partId),
      ),
    );
};

export const vehicleLabel = (v: {
  year: number | null;
  make: string | null;
  model: string | null;
}): string | null => {
  const parts = [v.year, v.make, v.model].filter((p) => p !== null && p !== undefined && p !== "");
  return parts.length ? parts.join(" ") : null;
};

export const estimateNumber = (id: number): string => `EST-${1000 + id}`;
export const invoiceNumber = (id: number): string => `INV-${2000 + id}`;

export type LineItemRow = {
  id: number;
  type: string;
  description: string;
  quantity: number;
  unitPrice: number;
};

export const shapeLineItem = (li: LineItemRow) => ({
  id: li.id,
  type: li.type,
  description: li.description,
  quantity: li.quantity,
  unitPrice: li.unitPrice,
  total: round2(li.quantity * li.unitPrice),
});

export const computeTotals = (
  items: { quantity: number; unitPrice: number }[],
  taxRate: number,
): { subtotal: number; taxAmount: number; total: number } => {
  const subtotal = round2(items.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0));
  const taxAmount = round2((subtotal * taxRate) / 100);
  const total = round2(subtotal + taxAmount);
  return { subtotal, taxAmount, total };
};

// Split a set of line items into labor / parts / fees subtotals, each rounded to
// cents. Lines with no type default to labor (mirroring normalizeLineItems).
// Shared by the work-order totals helper and by invoice shaping so the per-
// category breakdown is computed server-side the same way everywhere.
export const computeCategorySubtotals = (
  items: { type?: string | null; quantity: number; unitPrice: number }[],
): { laborSubtotal: number; partsSubtotal: number; feesSubtotal: number } => {
  const sumOf = (kind: string) =>
    round2(
      items
        .filter((li) => (li.type ?? "labor") === kind)
        .reduce((sum, li) => sum + li.quantity * li.unitPrice, 0),
    );
  return {
    laborSubtotal: sumOf("labor"),
    partsSubtotal: sumOf("part"),
    feesSubtotal: sumOf("fee"),
  };
};

// Split a set of line items into labor / parts / fees subtotals plus a grand
// total, all rounded to cents. Work orders carry no tax rate, so the grand
// total is just the sum of every line. Lines with no type default to labor
// (mirroring normalizeLineItems). Used to surface running totals on the work
// order detail page, computed server-side so it stays consistent with the
// estimate/invoice money model.
export const computeWorkOrderTotals = (
  items: { type?: string | null; quantity: number; unitPrice: number }[],
): { laborTotal: number; partsTotal: number; feesTotal: number; total: number } => {
  const { laborSubtotal, partsSubtotal, feesSubtotal } = computeCategorySubtotals(items);
  return {
    laborTotal: laborSubtotal,
    partsTotal: partsSubtotal,
    feesTotal: feesSubtotal,
    total: round2(laborSubtotal + partsSubtotal + feesSubtotal),
  };
};

export type LineItemInput = {
  type?: string;
  description: string;
  quantity?: number;
  unitPrice?: number;
  catalogPartId?: number | null;
};

// Load a work order's stored tasks & parts as line-item inputs (ordered by id)
// so an invoice generated from the work order can be seeded with the same
// labor/parts the shop already recorded. The persisted catalogPartId (set when
// the line item was created/updated) is included so the dedup comparison uses
// the stable id rather than re-matching descriptions at read time. Returns []
// when the work order has no line items.
export const loadWorkOrderLineItems = (workOrderId: number): Promise<LineItemInput[]> =>
  db
    .select({
      type: workOrderLineItemsTable.type,
      description: workOrderLineItemsTable.description,
      quantity: workOrderLineItemsTable.quantity,
      unitPrice: workOrderLineItemsTable.unitPrice,
      catalogPartId: workOrderLineItemsTable.catalogPartId,
    })
    .from(workOrderLineItemsTable)
    .where(eq(workOrderLineItemsTable.workOrderId, workOrderId))
    .orderBy(workOrderLineItemsTable.id);

export type InvoicedPart = {
  description: string;
  quantity: number;
  catalogPartId: number | null;
};

// Sum the part quantities already billed on a work order's prior (non-void)
// linked invoices, grouped by part description. Mirrors fetchInvoicedLaborHours
// (which covers tracked labor) but for parts, so the UI can warn before
// re-seeding the same components onto a follow-up invoice and the seeding flow
// can exclude them by default. Voided invoices are skipped since their charges
// no longer stand. Only part lines count; labor/fee lines are ignored.
// The persisted catalogPartId is returned so billedPartQuantities can key off
// the stable catalog id rather than re-resolving descriptions at read time.
export const loadInvoicedParts = async (
  workOrderId: number,
): Promise<InvoicedPart[]> => {
  const rows = await db
    .select({
      description: invoiceLineItemsTable.description,
      catalogPartId: invoiceLineItemsTable.catalogPartId,
      quantity: sql<number>`COALESCE(SUM(${invoiceLineItemsTable.quantity}), 0)`,
    })
    .from(invoiceLineItemsTable)
    .innerJoin(invoicesTable, eq(invoiceLineItemsTable.invoiceId, invoicesTable.id))
    .where(
      and(
        eq(invoicesTable.workOrderId, workOrderId),
        sql`${invoicesTable.status} <> 'void'`,
        eq(invoiceLineItemsTable.type, "part"),
      ),
    )
    .groupBy(invoiceLineItemsTable.description, invoiceLineItemsTable.catalogPartId);
  return rows.map((r) => ({
    description: r.description,
    catalogPartId: r.catalogPartId,
    quantity: Number(r.quantity),
  }));
};

// Compute a stable fingerprint for the current invoicedParts set. The
// fingerprint is a sorted, pipe-delimited "desc:qty" string so any change in
// the billed parts (new part, changed quantity) produces a different value.
// An empty set produces an empty string. Used to detect whether the
// "already billed parts" amber banner has already been dismissed for the
// current set of billed items.
export const computeInvoicedPartsFingerprint = (
  parts: InvoicedPart[],
): string =>
  [...parts]
    .sort((a, b) => a.description.localeCompare(b.description))
    .map((p) => `${p.description}:${p.quantity}`)
    .join("|");

// Build the dedup key for a part line. Prefer the persisted catalogPartId (set
// at write time when the description resolved to a catalog entry) so a renamed
// or fuzzy-matched part is still recognized as billed across invoices without
// depending on re-running the matcher against the current catalog state. Falls
// back to runtime catalog matching when no persisted id is available (legacy
// rows or free-text parts that resolved at read time), and ultimately to the
// normalized description string for genuine free-text / non-catalog parts.
const partDedupKey = (
  description: string,
  catalog: CatalogPart[],
  catalogPartId?: number | null,
): string => {
  if (catalogPartId != null) return `id:${catalogPartId}`;
  const match = matchCatalogPart(description, catalog);
  if (match) return `id:${match.id}`;
  return `desc:${description.trim().toLowerCase()}`;
};

// Build a stable-key -> already-billed-quantity map from the parts returned by
// loadInvoicedParts, so the seeding flow can match a work order's part lines
// against what was already billed. Catalog-backed parts are keyed by their
// persisted catalog id (rename/catalog-change-proof), with a runtime
// matchCatalogPart fallback for legacy rows that predate the column.
const billedPartQuantities = (
  parts: InvoicedPart[],
  catalog: CatalogPart[],
): Map<string, number> => {
  const map = new Map<string, number>();
  for (const p of parts) {
    const key = partDedupKey(p.description, catalog, p.catalogPartId);
    map.set(key, (map.get(key) ?? 0) + p.quantity);
  }
  return map;
};

// Resolve a catalog part id for each part line item at write time, so the
// stored catalogPartId column captures the stable part identity rather than
// relying solely on description matching at read time. Non-part lines get a
// null catalogPartId. Items that already carry a catalogPartId (e.g. when
// seeding an invoice from work-order line items that were resolved at WO write
// time) keep their existing id rather than re-resolving from the description,
// so the persisted identity is preserved across the seed operation.
export const resolveLineItemsWithCatalog = (
  items: ReturnType<typeof normalizeLineItems>,
  catalog: CatalogPart[],
): (ReturnType<typeof normalizeLineItems>[number] & { catalogPartId: number | null })[] =>
  items.map((li) => {
    if (li.catalogPartId != null) return li as typeof li & { catalogPartId: number | null };
    const partId = li.type === "part" ? (matchCatalogPart(li.description, catalog)?.id ?? null) : null;
    return { ...li, catalogPartId: partId };
  });

// Like loadWorkOrderLineItems, but when excludeBilledParts is true it subtracts
// the quantities already billed on this work order's prior invoices from the
// seeded part lines (dropping a line entirely once its whole quantity has been
// billed). This stops a follow-up invoice from silently re-charging parts that
// a prior invoice already billed. Matching is keyed off the persisted catalog
// part id where available (rename-proof and catalog-change-proof), falling back
// to runtime matchCatalogPart and then normalized description. Labor/fee lines
// always pass through unchanged.
export const loadWorkOrderLineItemsForInvoice = async (
  workOrderId: number,
  excludeBilledParts: boolean,
): Promise<LineItemInput[]> => {
  const items = await loadWorkOrderLineItems(workOrderId);
  if (!excludeBilledParts) return items;
  const catalog = await loadCatalog();
  const billed = billedPartQuantities(await loadInvoicedParts(workOrderId), catalog);
  if (billed.size === 0) return items;
  const result: LineItemInput[] = [];
  for (const li of items) {
    if ((li.type ?? "labor") !== "part") {
      result.push(li);
      continue;
    }
    const key = partDedupKey(li.description, catalog, li.catalogPartId);
    const already = billed.get(key) ?? 0;
    const qty = li.quantity ?? 1;
    if (already <= 0) {
      result.push(li);
      continue;
    }
    // Consume the billed pool against this line so duplicate parts are each
    // reduced rather than every line being zeroed by the same total.
    billed.set(key, Math.max(0, already - qty));
    const remaining = qty - already;
    if (remaining > 0) result.push({ ...li, quantity: remaining });
  }
  return result;
};

export type CatalogPart = {
  id: number;
  name: string;
  unitPrice: number;
  quantityOnHand: number;
  reorderLevel: number;
  sku?: string | null;
};

// Match a part description to a parts-catalog entry so callers can surface real
// shop stock/pricing where it exists. Prefer an exact (normalized) name match,
// then fall back to a reasonably specific substring match in either direction.
//
// When more than one catalog entry qualifies (duplicate names, or several parts
// whose names overlap the description under the fuzzy rule), the match must be
// deterministic: pick the lowest part id. Returning whichever row happened to be
// first in the input array makes stock deductions depend on catalog ordering,
// which is unstable across requests (Postgres heap order shifts after stock
// updates) and would let the same invoice deduct from different parts on
// different runs. Lowest-id (oldest part) is the stable, predictable choice.
export const matchCatalogPart = (
  description: string,
  catalog: CatalogPart[],
): CatalogPart | null => {
  const norm = description.trim().toLowerCase();
  if (!norm) return null;
  const lowestId = (a: CatalogPart, b: CatalogPart) => (a.id <= b.id ? a : b);
  const exact = catalog.filter((p) => p.name.trim().toLowerCase() === norm);
  if (exact.length) return exact.reduce(lowestId);
  const fuzzy = catalog.filter((p) => {
    const name = p.name.trim().toLowerCase();
    return name.length > 2 && (norm.includes(name) || name.includes(norm));
  });
  return fuzzy.length ? fuzzy.reduce(lowestId) : null;
};

// Invoice statuses where the part lines have been billed to the customer and so
// should be reflected as a deduction from catalog stock. Draft (not yet billed),
// void and cancelled invoices hold no stock.
const STOCK_COMMITTED_STATUSES = new Set(["sent", "partial", "paid"]);

export const isStockCommitted = (status: string): boolean =>
  STOCK_COMMITTED_STATUSES.has(status);

// Sum the on-hand quantity each catalog part should give up for a set of invoice
// line items. Only part lines that match a catalog entry (via the shared matcher)
// contribute; labor and unmatched lines are ignored. Quantities are rounded to
// whole units to match the integer stock column, mirroring how POs add stock.
export const computePartDeductions = (
  items: { type?: string | null; description: string; quantity?: number | null }[],
  catalog: CatalogPart[],
): Map<number, number> => {
  const deductions = new Map<number, number>();
  for (const li of items) {
    if ((li.type ?? "labor") !== "part") continue;
    const match = matchCatalogPart(li.description, catalog);
    if (!match) continue;
    const qty = Math.round(li.quantity ?? 1);
    if (qty <= 0) continue;
    deductions.set(match.id, (deductions.get(match.id) ?? 0) + qty);
  }
  return deductions;
};

// Build a single labor line item that bills tracked work-order time at a shop
// labor rate, so logged hours actually flow onto the invoice. Returns null when
// there is nothing billable (zero/negative hours) so the caller can simply skip
// appending it. Hours and rate are rounded to two decimals to match the
// numeric(…, 2) money/quantity model; the line total is still derived
// server-side from quantity * unitPrice like every other line.
// Description used for the labor line that bills a work order's tracked time.
// Shared so consumers (e.g. summing already-billed labor across a work order's
// invoices) can identify these lines without re-typing the literal.
export const TRACKED_LABOR_DESCRIPTION = "Tracked labor time";

// Sum tracked-labor hours already billed on a work order's OTHER (earlier,
// non-void) invoices, so a given invoice / its PDF / the customer portal can
// note that part of the work order's labor was billed elsewhere and reconcile
// without double-counting. Mirrors the fetchInvoicedLaborHours pattern (counts
// only "Tracked labor time" labor lines, excludes voided invoices) but groups by
// the prior invoice and restricts to invoices created before this one (lower id).
// Returns [] when there is no linked work order or no prior labor was billed.
// Shared by the invoice detail route, the estimate->invoice convert builder, and
// the public portal view (all populate the required `priorBilledLabor` field).
export const fetchPriorBilledLabor = async (
  invoiceId: number,
  workOrderId: number | null,
): Promise<{ invoiceId: number; number: string; hours: number }[]> => {
  if (workOrderId === null) return [];
  const rows = await db
    .select({
      invoiceId: invoiceLineItemsTable.invoiceId,
      hours: sql<number>`COALESCE(SUM(${invoiceLineItemsTable.quantity}), 0)`,
    })
    .from(invoiceLineItemsTable)
    .innerJoin(invoicesTable, eq(invoiceLineItemsTable.invoiceId, invoicesTable.id))
    .where(
      and(
        eq(invoicesTable.workOrderId, workOrderId),
        sql`${invoicesTable.id} < ${invoiceId}`,
        sql`${invoicesTable.status} <> 'void'`,
        eq(invoiceLineItemsTable.type, "labor"),
        eq(invoiceLineItemsTable.description, TRACKED_LABOR_DESCRIPTION),
      ),
    )
    .groupBy(invoiceLineItemsTable.invoiceId)
    .orderBy(invoiceLineItemsTable.invoiceId);
  return rows
    .map((r) => ({
      invoiceId: r.invoiceId,
      number: invoiceNumber(r.invoiceId),
      hours: Number(r.hours),
    }))
    .filter((r) => r.hours > 0);
};

export const buildTrackedLaborLine = (
  hours: number,
  rate: number,
): LineItemInput | null => {
  const qty = round2(hours);
  if (!(qty > 0)) return null;
  return {
    type: "labor",
    description: TRACKED_LABOR_DESCRIPTION,
    quantity: qty,
    unitPrice: round2(rate),
  };
};

export const normalizeLineItems = (items: LineItemInput[]) =>
  items.map((li) => ({
    type: li.type ?? "labor",
    description: li.description,
    quantity: li.quantity ?? 1,
    unitPrice: li.unitPrice ?? 0,
    catalogPartId: li.catalogPartId ?? null,
  }));

// Load the full parts catalog for stock/pricing matching. Ordered by id so the
// result is stable across requests: without an explicit order Postgres returns
// heap order, which shifts as parts are updated (e.g. stock deductions), and any
// matcher that breaks ties by array position would then deduct from different
// parts on different requests. matchCatalogPart breaks ties by lowest id, but
// ordering here keeps every other consumer that iterates the catalog stable too.
export const loadCatalog = (): Promise<CatalogPart[]> =>
  db
    .select({
      id: partsTable.id,
      name: partsTable.name,
      unitPrice: partsTable.unitPrice,
      quantityOnHand: partsTable.quantityOnHand,
      reorderLevel: partsTable.reorderLevel,
      sku: partsTable.sku,
    })
    .from(partsTable)
    .orderBy(partsTable.id);

export type EstimatePartLine = {
  type?: string | null;
  description: string;
  quantity?: number | null;
  partId?: number | null;
};

export type OverStockItem = {
  partId: number;
  description: string;
  requested: number;
  available: number;
};

// Inspect estimate line items and flag any part line whose requested quantity
// exceeds the matched catalog entry's on-hand stock. A line is matched either by
// an explicit partId (authoritative) or, failing that, by description against the
// catalog. Non-part lines and lines with no catalog match are ignored.
export const findOverStockItems = (
  items: EstimatePartLine[],
  catalog: CatalogPart[],
): OverStockItem[] => {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const offenders: OverStockItem[] = [];
  for (const li of items) {
    if ((li.type ?? "labor") !== "part") continue;
    const match =
      (li.partId != null ? byId.get(li.partId) : undefined) ??
      matchCatalogPart(li.description, catalog);
    if (!match) continue;
    const requested = li.quantity ?? 1;
    if (requested > match.quantityOnHand) {
      offenders.push({
        partId: match.id,
        description: li.description,
        requested,
        available: match.quantityOnHand,
      });
    }
  }
  return offenders;
};

export type LowStockItem = {
  partId: number;
  name: string;
  description: string;
  remaining: number;
  reorderLevel: number;
};

// Inspect a set of (already billed) line items against the current catalog and
// flag any matched part now sitting at or below its reorder level, so callers can
// nudge staff to reorder right after a sale deducts stock. Matching mirrors
// computePartDeductions (shared matchCatalogPart, part lines only). Results are
// deduped by catalog id; callers redact the numeric fields for non-inventory
// users. The caller should run this only for stock-committed invoices, since a
// draft sale has not deducted anything.
export const findLowStockItems = (
  items: { type?: string | null; description: string }[],
  catalog: CatalogPart[],
): LowStockItem[] => {
  const seen = new Set<number>();
  const result: LowStockItem[] = [];
  for (const li of items) {
    if ((li.type ?? "labor") !== "part") continue;
    const match = matchCatalogPart(li.description, catalog);
    if (!match || seen.has(match.id)) continue;
    if (match.quantityOnHand <= match.reorderLevel) {
      seen.add(match.id);
      result.push({
        partId: match.id,
        name: match.name,
        description: li.description,
        remaining: match.quantityOnHand,
        reorderLevel: match.reorderLevel,
      });
    }
  }
  return result;
};
