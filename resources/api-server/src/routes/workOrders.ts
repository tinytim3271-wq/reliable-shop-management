import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, and, isNull, sql, type SQL } from "drizzle-orm";
import {
  db,
  workOrdersTable,
  workOrderLineItemsTable,
  laborSessionsTable,
  customersTable,
  vehiclesTable,
  mechanicsTable,
  invoicesTable,
  invoiceLineItemsTable,
  estimatesTable,
  partsTable,
  stockMovementsTable,
} from "@workspace/db";
import {
  loadCatalog,
  findLowStockItems,
  isStockCommitted,
  computePartDeductions,
  loadDismissedReorderPartIds,
  dismissReorderPart,
  undismissReorderPart,
  TRACKED_LABOR_DESCRIPTION,
  loadInvoicedParts,
  computeInvoicedPartsFingerprint,
  type EstimatePartLine,
} from "../lib/billing";
import {
  ListWorkOrdersQueryParams,
  ListWorkOrdersResponse,
  ListWorkOrdersResponseItem,
  CreateWorkOrderBody,
  GetWorkOrderParams,
  GetWorkOrderResponse,
  UpdateWorkOrderParams,
  UpdateWorkOrderBody,
  UpdateWorkOrderResponse,
  DeleteWorkOrderParams,
  StartLaborSessionParams,
  StartLaborSessionBody,
  StopLaborSessionParams,
  StopLaborSessionResponse,
  DismissWorkOrderReorderPartParams,
  DismissWorkOrderReorderPartBody,
  RestoreWorkOrderReorderPartParams,
  RestoreWorkOrderReorderPartBody,
} from "@workspace/api-zod";
import { missingRef } from "../lib/refs";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  ObjectAclRebindingError,
  MAX_OBJECT_UPLOAD_SIZE_BYTES,
  verifyObjectUploadOwnership,
  markUploadLinked,
} from "../lib/objectStorage";
import { freeOrphanedPhotos } from "../lib/photoCleanup";
import { hasPermission } from "../lib/auth";
import { isAdmin } from "../lib/auth";
import {
  shapeLineItem,
  matchCatalogPart,
  normalizeLineItems,
  resolveLineItemsWithCatalog,
  computeWorkOrderTotals,
  type CatalogPart,
  type LineItemInput,
} from "../lib/billing";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

type CanonicalWorkOrderStatus =
  | "open"
  | "in_progress"
  | "awaiting_parts"
  | "completed"
  | "invoiced";

const LEGACY_STATUS_MAP: Record<string, CanonicalWorkOrderStatus> = {
  paid: "invoiced",
  sent: "in_progress",
  closed: "completed",
};

const LEGACY_STATUS_PAIRS = Object.entries(LEGACY_STATUS_MAP) as Array<
  [string, CanonicalWorkOrderStatus]
>;

const CANONICAL_STATUSES: CanonicalWorkOrderStatus[] = [
  "open",
  "in_progress",
  "awaiting_parts",
  "completed",
  "invoiced",
];

const KNOWN_STATUSES = new Set<string>([
  ...CANONICAL_STATUSES,
  ...Object.keys(LEGACY_STATUS_MAP),
]);

function normalizeWorkOrderStatus(status: string | null | undefined): CanonicalWorkOrderStatus {
  if (!status) return "open";
  if (
    status === "open" ||
    status === "in_progress" ||
    status === "awaiting_parts" ||
    status === "completed" ||
    status === "invoiced"
  ) {
    return status;
  }
  return LEGACY_STATUS_MAP[status] ?? "open";
}

// One-time maintenance endpoint: permanently rewrite known legacy statuses to
// the canonical enum values used by the API schemas.
router.post("/work-orders/admin/normalize-statuses", async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const dryRun = req.query["dryRun"] === "true" || req.body?.dryRun === true;
  const changed: Array<{ from: string; to: CanonicalWorkOrderStatus; count: number }> = [];
  let total = 0;

  for (const [legacy, canonical] of LEGACY_STATUS_PAIRS) {
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workOrdersTable)
      .where(eq(workOrdersTable.status, legacy));
    const count = Number(countRow?.count ?? 0);
    if (count <= 0) continue;

    if (!dryRun) {
      await db
        .update(workOrdersTable)
        .set({ status: canonical })
        .where(eq(workOrdersTable.status, legacy));
    }

    changed.push({ from: legacy, to: canonical, count });
    total += count;
  }

  res.json({
    success: true,
    dryRun,
    normalized: changed,
    totalAffected: total,
    message:
      total === 0
        ? "No known legacy statuses found."
        : dryRun
          ? "Dry run complete. Re-run without dryRun to apply changes."
          : "Legacy statuses normalized successfully.",
  });
});

router.get("/work-orders/admin/unknown-statuses", async (req: Request, res: Response): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const rows = await db
    .select({ status: workOrdersTable.status, count: sql<number>`count(*)::int` })
    .from(workOrdersTable)
    .groupBy(workOrdersTable.status)
    .orderBy(workOrdersTable.status);

  const unknown = rows
    .map((row: { status: string | null; count: number }) => ({
      status: row.status ?? "",
      count: Number(row.count ?? 0),
    }))
    .filter((row: { status: string; count: number }) => row.status !== "" && !KNOWN_STATUSES.has(row.status));

  res.json({
    success: true,
    canonical: CANONICAL_STATUSES,
    legacyMap: LEGACY_STATUS_MAP,
    unknown,
    totalUnknown: unknown.reduce((sum: number, row: { status: string; count: number }) => sum + row.count, 0),
    message: unknown.length === 0 ? "No unknown statuses found." : "Unknown statuses detected. Review before remapping.",
  });
});

/**
 * Validate that every /objects/* URL in the list does not exceed the upload
 * size cap. Called before persisting photoUrls to the database so that a
 * client that lied about the declared size at mint time cannot bypass the
 * limit by later linking the oversized object to a record.
 * Returns an error message if any URL fails, null if all pass.
 */
async function validatePhotoUrlSizes(urls: string[]): Promise<string | null> {
  for (const url of urls) {
    const sizeBytes = await objectStorageService.getObjectEntitySizeBytes(url);
    if (sizeBytes !== null && sizeBytes > MAX_OBJECT_UPLOAD_SIZE_BYTES) {
      // Auto-delete the oversized object from GCS so it cannot linger as an
      // orphaned blob even if the confirm endpoint was skipped.
      try {
        await objectStorageService.deleteObjectEntity(url);
      } catch (e) {
        if (!(e instanceof ObjectNotFoundError)) throw e;
      }
      return `File exceeds the maximum allowed size of ${MAX_OBJECT_UPLOAD_SIZE_BYTES / (1024 * 1024)} MB`;
    }
  }
  return null;
}

/**
 * Verify that the caller is the legitimate owner of each URL that is new
 * (not already present in currentUrls). Prevents cross-user/cross-module
 * injection: a user with inspections permission cannot insert a foreign
 * work-order objectPath into an inspection item they control to bypass the
 * read-path authorization check. Admins bypass this check.
 *
 * Returns a tuple of [error, urlsToMark]. On success, error is null and
 * urlsToMark lists the URLs that need markUploadLinked() called after the
 * surrounding DB write commits. markUploadLinked() is intentionally NOT called
 * here — calling it before the DB write succeeds would remove the object from
 * the provisional-orphan registry prematurely, leaving it unreferenced in
 * storage but bypassing the 2-hour sweep until the 24-hour reconciliation.
 */
async function verifyPhotoUrlOwnership(
  newUrls: string[],
  currentUrls: string[],
  userId: number,
  role: string,
): Promise<{ error: string; newlyLinked: string[] } | { error: null; newlyLinked: string[] }> {
  const existingSet = new Set(currentUrls);
  const newlyLinked: string[] = [];
  for (const url of newUrls) {
    if (existingSet.has(url)) continue; // already linked to this record — OK
    if (role !== "admin") {
      const owned = await verifyObjectUploadOwnership(url, userId, objectStorageService);
      if (!owned) return { error: "You can only attach files you uploaded", newlyLinked: [] };
    }
    // Stamp the module binding — immutable after first write. Prevents a
    // multi-module user from re-attaching a workOrders photo to an expense
    // record to widen who can read it.
    try {
      await objectStorageService.trySetObjectEntityAclPolicy(url, {
        owner: String(userId),
        visibility: "private",
        sourceModule: "workOrders",
      });
    } catch (e) {
      if (e instanceof ObjectAclRebindingError) {
        return { error: "This file is already assigned to a different module and cannot be attached here", newlyLinked: [] };
      }
      // Any other error (e.g. GCS unavailable) is also treated as a blocking
      // failure so the module binding cannot be silently skipped on a transient
      // error. The caller should retry the operation.
      return { error: "Unable to verify file module assignment; please try again", newlyLinked: [] };
    }
    // Track that this URL needs its provisional-upload entry revoked once the
    // DB write succeeds. markUploadLinked is called by the route handler AFTER
    // the transaction commits so that a failed DB write does not strand the
    // object outside the fast 2-hour orphan sweep.
    newlyLinked.push(url);
  }
  return { error: null, newlyLinked };
}

/**
 * Drop any caption whose key is not in the given photo list. Captions are
 * keyed by object path, so reordering photoUrls leaves them untouched, but
 * removing a photo must not leave an orphaned caption behind.
 */
function pruneCaptions(
  captions: Record<string, string>,
  urls: string[],
): Record<string, string> {
  const allowed = new Set(urls);
  const out: Record<string, string> = {};
  for (const [path, caption] of Object.entries(captions)) {
    if (allowed.has(path) && caption.trim() !== "") out[path] = caption;
  }
  return out;
}

const vehicleLabel = (v: {
  year: number | null;
  make: string | null;
  model: string | null;
}): string | null => {
  const parts = [v.year, v.make, v.model].filter((p) => p !== null && p !== undefined && p !== "");
  return parts.length ? parts.join(" ") : null;
};

const minutesBetween = (start: string, end: string): number =>
  Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000));

type SessionRow = typeof laborSessionsTable.$inferSelect & { mechanicName: string | null };

const sessionColumns = {
  id: laborSessionsTable.id,
  workOrderId: laborSessionsTable.workOrderId,
  mechanicId: laborSessionsTable.mechanicId,
  mechanicName: mechanicsTable.name,
  task: laborSessionsTable.task,
  startedAt: laborSessionsTable.startedAt,
  endedAt: laborSessionsTable.endedAt,
  createdAt: laborSessionsTable.createdAt,
};

const shapeSession = (s: SessionRow) => ({
  id: s.id,
  workOrderId: s.workOrderId,
  mechanicId: s.mechanicId,
  mechanicName: s.mechanicName,
  task: s.task,
  startedAt: s.startedAt,
  endedAt: s.endedAt,
  durationMinutes: s.endedAt ? minutesBetween(s.startedAt, s.endedAt) : null,
});

const woColumns = {
  id: workOrdersTable.id,
  customerId: workOrdersTable.customerId,
  vehicleId: workOrdersTable.vehicleId,
  customerName: customersTable.name,
  vYear: vehiclesTable.year,
  vMake: vehiclesTable.make,
  vModel: vehiclesTable.model,
  assignedMechanicId: workOrdersTable.assignedMechanicId,
  assignedMechanicName: mechanicsTable.name,
  title: workOrdersTable.title,
  description: workOrdersTable.description,
  status: workOrdersTable.status,
  complaint: workOrdersTable.complaint,
  notes: workOrdersTable.notes,
  photoUrls: workOrdersTable.photoUrls,
  photoCaptions: workOrdersTable.photoCaptions,
  mileageIn: workOrdersTable.mileageIn,
  stockDeducted: workOrdersTable.stockDeducted,
  billedBannerDismissedHash: workOrdersTable.billedBannerDismissedHash,
  openedAt: workOrdersTable.openedAt,
  completedAt: workOrdersTable.completedAt,
  createdAt: workOrdersTable.createdAt,
};

type WoRow = {
  id: number;
  customerId: number;
  vehicleId: number;
  customerName: string | null;
  vYear: number | null;
  vMake: string | null;
  vModel: string | null;
  assignedMechanicId: number | null;
  assignedMechanicName: string | null;
  title: string;
  description: string | null;
  status: string;
  complaint: string | null;
  notes: string | null;
  photoUrls: string[];
  photoCaptions: Record<string, string>;
  mileageIn: number | null;
  stockDeducted: boolean;
  billedBannerDismissedHash: string | null;
  openedAt: string;
  completedAt: string | null;
  createdAt: string;
};

const selectWorkOrders = () =>
  db
    .select(woColumns)
    .from(workOrdersTable)
    .leftJoin(customersTable, eq(workOrdersTable.customerId, customersTable.id))
    .leftJoin(vehiclesTable, eq(workOrdersTable.vehicleId, vehiclesTable.id))
    .leftJoin(mechanicsTable, eq(workOrdersTable.assignedMechanicId, mechanicsTable.id));

const shapeWorkOrder = (row: WoRow, sessions: SessionRow[]) => {
  const completed = sessions.filter((s) => s.endedAt);
  const totalLaborMinutes = completed.reduce(
    (sum, s) => sum + minutesBetween(s.startedAt, s.endedAt as string),
    0,
  );
  return {
    id: row.id,
    customerId: row.customerId,
    vehicleId: row.vehicleId,
    customerName: row.customerName,
    vehicleLabel: vehicleLabel({ year: row.vYear, make: row.vMake, model: row.vModel }),
    assignedMechanicId: row.assignedMechanicId,
    assignedMechanicName: row.assignedMechanicName,
    title: row.title,
    description: row.description,
    status: normalizeWorkOrderStatus(row.status),
    complaint: row.complaint,
    notes: row.notes,
    photoUrls: row.photoUrls ?? [],
    photoCaptions: pruneCaptions(row.photoCaptions ?? {}, row.photoUrls ?? []),
    mileageIn: row.mileageIn,
    stockDeducted: row.stockDeducted,
    totalLaborMinutes,
    hasActiveSession: sessions.some((s) => !s.endedAt),
    openedAt: row.openedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
};

const fetchSessions = (workOrderId: number) =>
  db
    .select(sessionColumns)
    .from(laborSessionsTable)
    .leftJoin(mechanicsTable, eq(laborSessionsTable.mechanicId, mechanicsTable.id))
    .where(eq(laborSessionsTable.workOrderId, workOrderId))
    .orderBy(desc(laborSessionsTable.startedAt));

type StoredLineItem = typeof workOrderLineItemsTable.$inferSelect & {
  catalogPartName: string | null;
};

const fetchLineItems = (workOrderId: number) =>
  db
    .select({
      id: workOrderLineItemsTable.id,
      workOrderId: workOrderLineItemsTable.workOrderId,
      type: workOrderLineItemsTable.type,
      description: workOrderLineItemsTable.description,
      quantity: workOrderLineItemsTable.quantity,
      unitPrice: workOrderLineItemsTable.unitPrice,
      catalogPartId: workOrderLineItemsTable.catalogPartId,
      catalogPartName: partsTable.name,
    })
    .from(workOrderLineItemsTable)
    .leftJoin(partsTable, eq(workOrderLineItemsTable.catalogPartId, partsTable.id))
    .where(eq(workOrderLineItemsTable.workOrderId, workOrderId))
    .orderBy(workOrderLineItemsTable.id);

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
// the work order detail page can show on-hand counts and low-stock cues for
// parts. Mirrors the estimate detail enrichment. catalogPartName comes from the
// JOIN in fetchLineItems and is surfaced for all users (not inventory-gated)
// since it's the part identity recorded at write time, not a live stock level.
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

// Replace all of a work order's line items with a new set (delete-then-insert),
// mirroring the estimate edit flow. Called only when the request explicitly
// supplies lineItems so a PATCH that omits them leaves existing items untouched.
const replaceLineItems = async (workOrderId: number, lineItems: LineItemInput[]) => {
  await db
    .delete(workOrderLineItemsTable)
    .where(eq(workOrderLineItemsTable.workOrderId, workOrderId));
  const items = normalizeLineItems(lineItems);
  if (items.length) {
    await db
      .insert(workOrderLineItemsTable)
      .values(items.map((li) => ({ ...li, workOrderId })));
  }
};

// Reject part line items that would pull more units than the matched catalog
// entry has on hand, unless the caller opts in with allowOverStock. Returns true
// and writes a 409 when blocked; false to continue. The numeric available count
// is only disclosed to inventory callers so this guard never leaks live stock
// levels. Mirrors the invoice/estimate over-stock guard. Only meaningful when
// the caller is actually deducting (deductStock), so callers gate on that first.
//
// `priorItems` are the part lines this work order already deducted (when it was
// previously in a deducted state). reconcileStock reverses that prior pull before
// applying the new one, so those quantities are available capacity for this edit
// and must be credited back — otherwise a no-op edit (e.g. changing only the
// notes, or lowering a quantity) on an already-deducted work order would falsely
// 409 against the reduced on-hand. On create, no prior pull exists so the credit
// is empty and this collapses to a plain on-hand check.
const blockedForOverStock = async (
  req: Request,
  res: Response,
  lineItems: EstimatePartLine[] | undefined,
  allowOverStock: boolean | undefined,
  priorItems?: DeductionLine[],
): Promise<boolean> => {
  if (allowOverStock) return false;
  if (!lineItems?.some((li) => (li.type ?? "labor") === "part")) return false;

  const catalog = await loadCatalog();
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const credit = computePartDeductions(priorItems ?? [], catalog);

  // Aggregate the requested pull per matched catalog part (a part may appear on
  // more than one line), keeping a representative description for the message.
  const requested = new Map<number, { qty: number; description: string }>();
  for (const li of lineItems) {
    if ((li.type ?? "labor") !== "part") continue;
    const match =
      (li.partId != null ? byId.get(li.partId) : undefined) ??
      matchCatalogPart(li.description, catalog);
    if (!match) continue;
    const qty = Math.round(li.quantity ?? 1);
    if (qty <= 0) continue;
    const prev = requested.get(match.id);
    requested.set(match.id, {
      qty: (prev?.qty ?? 0) + qty,
      description: prev?.description ?? li.description,
    });
  }

  const canSeeStock = hasPermission(req, "inventory");
  const offenders: { description: string; requested: number; available: number | null }[] = [];
  for (const [partId, { qty, description }] of requested) {
    const part = byId.get(partId);
    if (!part) continue;
    const available = part.quantityOnHand + (credit.get(partId) ?? 0);
    if (qty > available) {
      offenders.push({ description, requested: qty, available: canSeeStock ? available : null });
    }
  }
  if (offenders.length === 0) return false;

  res.status(409).json({
    error:
      "One or more parts exceed available stock. Order more, reduce the quantity, or pull anyway to override.",
    overStockItems: offenders,
  });
  return true;
};

type DeductionLine = { type?: string | null; description: string; quantity?: number | null };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Describes why a stock reconciliation is happening so each net change can be
// recorded in the stock movement ledger and traced back to its work order.
type MovementSource = { reason: string; workOrderId: number | null; userId: number | null };

// Adjust catalog stock to reflect a work order's deducted state, atomically within
// the caller's transaction. Adds back the quantities previously deducted (oldItems,
// when wasDeducted) and subtracts the new deduction (newItems, when nowDeducted),
// so editing or deleting a work order whose parts were already pulled reverses the
// earlier deduction. Each non-zero net change is also written to the stock movement
// ledger in the same transaction, so the audit log can never drift from the count.
// Returns the resulting deducted flag, which the caller persists on the work order.
// Mirrors the invoice reconcileStock; the source type is "work_order".
const reconcileStock = async (
  tx: Tx,
  wasDeducted: boolean,
  oldItems: DeductionLine[],
  nowDeducted: boolean,
  newItems: DeductionLine[],
  source: MovementSource,
): Promise<boolean> => {
  if (!wasDeducted && !nowDeducted) return false;

  const catalog = await loadCatalog();
  const deltas = new Map<number, number>();
  if (wasDeducted) {
    for (const [partId, qty] of computePartDeductions(oldItems, catalog)) {
      deltas.set(partId, (deltas.get(partId) ?? 0) + qty);
    }
  }
  if (nowDeducted) {
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
      sourceType: "work_order",
      sourceId: source.workOrderId,
      createdByUserId: source.userId,
    });
  }
  return nowDeducted;
};

// Sum the tracked labor hours already billed on this work order's prior
// invoices, so the UI can warn before re-billing the same logged time. Only
// counts the "Tracked labor time" labor lines that the work-order invoice flow
// generates (matching buildTrackedLaborLine), and excludes voided invoices
// since their charges no longer stand. The quantity on those lines is the
// billed hours (priced at the labor rate), so summing quantity gives the hours.
const fetchInvoicedLaborHours = async (workOrderId: number): Promise<number> => {
  const [agg] = await db
    .select({
      hours: sql<number>`COALESCE(SUM(${invoiceLineItemsTable.quantity}), 0)`,
    })
    .from(invoiceLineItemsTable)
    .innerJoin(invoicesTable, eq(invoiceLineItemsTable.invoiceId, invoicesTable.id))
    .where(
      and(
        eq(invoicesTable.workOrderId, workOrderId),
        sql`${invoicesTable.status} <> 'void'`,
        eq(invoiceLineItemsTable.type, "labor"),
        eq(invoiceLineItemsTable.description, TRACKED_LABOR_DESCRIPTION),
      ),
    );
  return Number(agg?.hours ?? 0);
};

// Build the full work order detail payload (header + sessions + line items),
// applying cross-module redaction and inventory-gated stock enrichment.
const buildDetail = async (row: WoRow, req: Request) => {
  const sessions = await fetchSessions(row.id);
  const stored = await fetchLineItems(row.id);
  const catalog = await fetchCatalog(req);
  const hasInvoices = hasPermission(req, "invoices");

  // Compute invoiced-parts fingerprint and banner-dismissed state when the
  // caller has invoices permission. The stored hash on the work order row is
  // compared against the current fingerprint so the banner hides only when the
  // set of billed parts hasn't changed since the last dismissal.
  let invoicedParts: Awaited<ReturnType<typeof loadInvoicedParts>> | null = null;
  let billedPartsBannerDismissed: boolean | null = null;
  if (hasInvoices) {
    invoicedParts = await loadInvoicedParts(row.id);
    const currentHash = computeInvoicedPartsFingerprint(invoicedParts);
    billedPartsBannerDismissed =
      invoicedParts.length > 0 &&
      row.billedBannerDismissedHash != null &&
      row.billedBannerDismissedHash === currentHash;
  }

  return {
    ...redactWorkOrder(shapeWorkOrder(row, sessions), req),
    laborSessions: sessions.map((s) => redactSession(shapeSession(s), req)),
    lineItems: stored.map((li) => shapeLineItemWithStock(li, catalog)),
    totals: computeWorkOrderTotals(stored),
    lowStockItems: await fetchLowStockItems(row.id, req),
    invoicedLaborHours: hasInvoices ? await fetchInvoicedLaborHours(row.id) : null,
    invoicedParts,
    billedPartsBannerDismissed,
  };
};

// Strip cross-module fields from a shaped work order when the caller lacks
// the corresponding module permission:
//   customerName / vehicleLabel  → requires "customers" permission
//   assignedMechanicName         → requires "payroll" permission
const redactWorkOrder = (
  shaped: ReturnType<typeof shapeWorkOrder>,
  req: Request,
) => ({
  ...shaped,
  customerName: hasPermission(req, "customers") ? shaped.customerName : null,
  vehicleLabel: hasPermission(req, "customers") ? shaped.vehicleLabel : null,
  assignedMechanicName: hasPermission(req, "payroll") ? shaped.assignedMechanicName : null,
});

// mechanicName on a labor session is payroll data.
const redactSession = (
  shaped: ReturnType<typeof shapeSession>,
  req: Request,
) => ({
  ...shaped,
  mechanicName: hasPermission(req, "payroll") ? shaped.mechanicName : null,
});

// Matched catalog parts billed through this work order's linked invoice(s) that
// have now fallen to or below their reorder level, so staff working from the
// work-order screen get the same reorder nudge the invoice already surfaces.
// Work orders have no line-item model of their own; parts are billed via a
// linked invoice (invoice.workOrderId), and only stock-committed invoices have
// actually deducted stock — drafts/voids have taken nothing off the shelf.
// Reuses the shared findLowStockItems matcher (deduped by catalog id). The
// numeric remaining/reorderLevel are disclosed only to inventory callers,
// mirroring the invoice redaction so this never leaks live counts.
const fetchLowStockItems = async (
  workOrderId: number,
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
  const items = await db
    .select({
      type: invoiceLineItemsTable.type,
      description: invoiceLineItemsTable.description,
      invoiceStatus: invoicesTable.status,
    })
    .from(invoiceLineItemsTable)
    .innerJoin(invoicesTable, eq(invoiceLineItemsTable.invoiceId, invoicesTable.id))
    .where(eq(invoicesTable.workOrderId, workOrderId));

  const committed = items.filter((li) => isStockCommitted(li.invoiceStatus));
  if (committed.length === 0) return [];

  const catalog = await loadCatalog();
  const canSeeStock = hasPermission(req, "inventory");
  const dismissed = await loadDismissedReorderPartIds("work_order", workOrderId);
  return (
    findLowStockItems(committed, catalog)
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

router.get("/work-orders", async (req, res): Promise<void> => {
  const query = ListWorkOrdersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const filters: SQL[] = [];
  if (query.data.status) {
    if (query.data.status === "invoiced") {
      filters.push(
        sql`${workOrdersTable.status} IN ('invoiced', 'paid')`,
      );
    } else if (query.data.status === "in_progress") {
      filters.push(
        sql`${workOrdersTable.status} IN ('in_progress', 'sent')`,
      );
    } else if (query.data.status === "completed") {
      filters.push(
        sql`${workOrdersTable.status} IN ('completed', 'closed')`,
      );
    } else {
      filters.push(eq(workOrdersTable.status, query.data.status));
    }
  }
  if (query.data.vehicleId) filters.push(eq(workOrdersTable.vehicleId, query.data.vehicleId));
  if (query.data.customerId) filters.push(eq(workOrdersTable.customerId, query.data.customerId));
  if (query.data.assignedMechanicId) filters.push(eq(workOrdersTable.assignedMechanicId, query.data.assignedMechanicId));

  const base = selectWorkOrders();
  const rows = filters.length
    ? await base.where(and(...filters)).orderBy(desc(workOrdersTable.id))
    : await base.orderBy(desc(workOrdersTable.id));

  const allSessions = await db
    .select(sessionColumns)
    .from(laborSessionsTable)
    .leftJoin(mechanicsTable, eq(laborSessionsTable.mechanicId, mechanicsTable.id));

  const shaped = rows.map((row) =>
    redactWorkOrder(
      shapeWorkOrder(
        row,
        allSessions.filter((s) => s.workOrderId === row.id),
      ),
      req,
    ),
  );

  res.json(ListWorkOrdersResponse.parse(shaped));
});

router.post("/work-orders", async (req, res): Promise<void> => {
  const parsed = CreateWorkOrderBody.safeParse(req.body);
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
  if (parsed.data.assignedMechanicId !== undefined && !hasPermission(req, "payroll")) {
    res.status(403).json({ error: "You do not have permission to assign a mechanic" });
    return;
  }

  const refError =
    (await missingRef(customersTable, parsed.data.customerId, "Customer")) ??
    (await missingRef(vehiclesTable, parsed.data.vehicleId, "Vehicle")) ??
    (await missingRef(mechanicsTable, parsed.data.assignedMechanicId, "Mechanic"));
  if (refError) {
    res.status(400).json({ error: refError });
    return;
  }

  // Relational consistency: the vehicle must belong to the specified customer.
  // Without this, a staff user could manufacture a work order that mixes records
  // from different customers, allowing the portal to expose one customer's photos
  // to another customer.
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

  let postNewlyLinked: string[] = [];
  if (parsed.data.photoUrls?.length) {
    const sizeError = await validatePhotoUrlSizes(parsed.data.photoUrls);
    if (sizeError) {
      res.status(400).json({ error: sizeError });
      return;
    }
    // All URLs are new in a POST — verify caller uploaded each one.
    const ownerResult = await verifyPhotoUrlOwnership(
      parsed.data.photoUrls,
      [],
      req.currentUser!.id,
      req.currentUser!.role,
    );
    if (ownerResult.error) {
      res.status(403).json({ error: ownerResult.error });
      return;
    }
    postNewlyLinked = ownerResult.newlyLinked;
  }

  // Deduction is opt-in (deductStock). When requested, the caller must hold the
  // inventory permission — the same boundary enforced on /parts, /purchase-orders,
  // and stock-movement routes — before any stock is pulled or the over-stock guard
  // is evaluated.
  const deductStock = parsed.data.deductStock ?? false;
  if (deductStock && !hasPermission(req, "inventory")) {
    res.status(403).json({ error: "You do not have permission to deduct inventory stock from a work order" });
    return;
  }
  if (
    deductStock &&
    (await blockedForOverStock(req, res, parsed.data.lineItems, parsed.data.allowOverStock))
  ) {
    return;
  }

  const rawItems = normalizeLineItems(parsed.data.lineItems ?? []);
  const createCatalog = rawItems.some((li) => li.type === "part") ? await loadCatalog() : [];
  const newItems = resolveLineItemsWithCatalog(rawItems, createCatalog);

  const created = await db.transaction(async (tx) => {
    const [wo] = await tx
      .insert(workOrdersTable)
      .values({
        customerId: parsed.data.customerId,
        vehicleId: parsed.data.vehicleId,
        assignedMechanicId: parsed.data.assignedMechanicId ?? null,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        status: parsed.data.status ?? "open",
        complaint: parsed.data.complaint ?? null,
        notes: parsed.data.notes ?? null,
        photoUrls: parsed.data.photoUrls ?? [],
        photoCaptions: pruneCaptions(parsed.data.photoCaptions ?? {}, parsed.data.photoUrls ?? []),
        stockDeducted: deductStock,
      })
      .returning();

    if (newItems.length) {
      await tx
        .insert(workOrderLineItemsTable)
        .values(newItems.map((li) => ({ ...li, workOrderId: wo.id })));
    }

    await reconcileStock(tx, false, [], deductStock, newItems, {
      reason: "Parts pulled for work order",
      workOrderId: wo.id,
      userId: req.currentUser?.id ?? null,
    });
    return wo;
  });

  // Revoke provisional-upload tracking only after the DB write committed.
  // If the transaction had thrown, these files would still be tracked by the
  // 2-hour orphan sweep instead of falling back to the 24-hour reconciliation.
  for (const url of postNewlyLinked) markUploadLinked(url);

  const [row] = await selectWorkOrders().where(eq(workOrdersTable.id, created.id));
  res.status(201).json(ListWorkOrdersResponseItem.parse(redactWorkOrder(shapeWorkOrder(row, []), req)));
});

router.get("/work-orders/:id", async (req, res): Promise<void> => {
  const params = GetWorkOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await selectWorkOrders().where(eq(workOrdersTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Work order not found" });
    return;
  }

  res.json(GetWorkOrderResponse.parse(await buildDetail(row, req)));
});

router.patch("/work-orders/:id", async (req, res): Promise<void> => {
  const params = UpdateWorkOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateWorkOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.assignedMechanicId !== undefined && !hasPermission(req, "payroll")) {
    res.status(403).json({ error: "You do not have permission to assign a mechanic" });
    return;
  }

  const refError = await missingRef(
    mechanicsTable,
    parsed.data.assignedMechanicId,
    "Mechanic",
  );
  if (refError) {
    res.status(400).json({ error: refError });
    return;
  }

  // Pre-read current photoUrls/captions so the ownership check can diff against
  // them (skipping token/ACL verification for URLs already linked to this
  // record) and so captions can be pruned to the final photo set.
  let currentPhotoUrls: string[] = [];
  let currentPhotoCaptions: Record<string, string> = {};
  const touchesPhotos =
    parsed.data.photoUrls !== undefined || parsed.data.photoCaptions !== undefined;
  if (touchesPhotos) {
    const [current] = await db
      .select({
        photoUrls: workOrdersTable.photoUrls,
        photoCaptions: workOrdersTable.photoCaptions,
      })
      .from(workOrdersTable)
      .where(eq(workOrdersTable.id, params.data.id));
    currentPhotoUrls = current?.photoUrls ?? [];
    currentPhotoCaptions = current?.photoCaptions ?? {};
  }

  let patchNewlyLinked: string[] = [];
  if (parsed.data.photoUrls?.length) {
    const sizeError = await validatePhotoUrlSizes(parsed.data.photoUrls);
    if (sizeError) {
      res.status(400).json({ error: sizeError });
      return;
    }
    const ownerResult = await verifyPhotoUrlOwnership(
      parsed.data.photoUrls,
      currentPhotoUrls,
      req.currentUser!.id,
      req.currentUser!.role,
    );
    if (ownerResult.error) {
      res.status(403).json({ error: ownerResult.error });
      return;
    }
    patchNewlyLinked = ownerResult.newlyLinked;
  }

  // Build the update set, pruning captions to the final photo list so a removed
  // photo never leaves a dangling caption (keyed by object path, captions are
  // unaffected by pure reordering). lineItems are stored in a separate table, and
  // deductStock/allowOverStock are control flags (not columns), so all three are
  // split out of the header update.
  const { lineItems, deductStock, allowOverStock: _allowOverStock, ...fields } = parsed.data;
  const updateData: Record<string, unknown> = { ...fields };
  if (touchesPhotos) {
    const finalUrls = parsed.data.photoUrls ?? currentPhotoUrls;
    const finalCaptions = parsed.data.photoCaptions ?? currentPhotoCaptions;
    updateData.photoCaptions = pruneCaptions(finalCaptions, finalUrls);
  }

  // Load the current deduction state and part lines so a prior deduction can be
  // reversed before the new state is applied. Fail closed with a 404.
  const [existing] = await db
    .select({ id: workOrdersTable.id, stockDeducted: workOrdersTable.stockDeducted })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Work order not found" });
    return;
  }

  const oldItems = await fetchLineItems(params.data.id);
  // deductStock omitted ⇒ keep the current state; supplied ⇒ toggle to it.
  const nowDeducted = deductStock ?? existing.stockDeducted;
  const rawPatchItems = lineItems ? normalizeLineItems(lineItems) : oldItems;
  const patchCatalog =
    lineItems && rawPatchItems.some((li) => li.type === "part") ? await loadCatalog() : [];
  const newItems = lineItems ? resolveLineItemsWithCatalog(rawPatchItems, patchCatalog) : rawPatchItems;

  // Any of these three cases produces a canonical inventory mutation:
  //   • deductStock toggled to true  — parts are newly pulled from stock
  //   • deductStock toggled to false — previously-pulled parts are returned
  //   • nowDeducted is still true AND line items are being changed — the set of
  //     parts pulled changes (reconcile reverses old, applies new)
  // All three require the inventory permission, which is the same boundary used
  // by /parts, /purchase-orders, and the stock-movement reporting routes.
  const inventoryMutates =
    (deductStock === true && !existing.stockDeducted) ||
    (deductStock === false && existing.stockDeducted) ||
    (nowDeducted && lineItems !== undefined);
  if (inventoryMutates && !hasPermission(req, "inventory")) {
    res.status(403).json({ error: "You do not have permission to modify inventory stock" });
    return;
  }

  // Guard the parts being committed (the effective new line set) against on-hand
  // stock when this edit results in a deduction, unless allowOverStock is set.
  // Credit back the quantities already deducted by this work order (reconcile
  // reverses them first) so a no-op or quantity-lowering edit isn't falsely
  // blocked against the already-reduced on-hand.
  const priorPull = existing.stockDeducted ? oldItems : undefined;
  // Check stock against the raw request (which carries partId for authoritative
  // catalog matching); normalizeLineItems strips partId, so newItems would fall
  // back to description matching. When lineItems is omitted, reuse oldItems.
  const stockCheckItems = lineItems ?? oldItems;
  if (
    nowDeducted &&
    (await blockedForOverStock(req, res, stockCheckItems, parsed.data.allowOverStock, priorPull))
  ) {
    return;
  }

  updateData.stockDeducted = nowDeducted;

  await db.transaction(async (tx) => {
    await tx
      .update(workOrdersTable)
      .set(updateData)
      .where(eq(workOrdersTable.id, params.data.id));

    if (lineItems) {
      await tx
        .delete(workOrderLineItemsTable)
        .where(eq(workOrderLineItemsTable.workOrderId, params.data.id));
      if (newItems.length) {
        await tx
          .insert(workOrderLineItemsTable)
          .values(newItems.map((li) => ({ ...li, workOrderId: params.data.id })));
      }
    }

    await reconcileStock(tx, existing.stockDeducted, oldItems, nowDeducted, newItems, {
      reason: "Work order parts updated",
      workOrderId: params.data.id,
      userId: req.currentUser?.id ?? null,
    });
  });

  // Revoke provisional-upload tracking only after the DB write committed.
  for (const url of patchNewlyLinked) markUploadLinked(url);

  const [row] = await selectWorkOrders().where(eq(workOrdersTable.id, params.data.id));
  res.json(UpdateWorkOrderResponse.parse(await buildDetail(row, req)));
});

router.delete("/work-orders/:id", async (req, res): Promise<void> => {
  const params = DeleteWorkOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Deleting a work order triggers ON DELETE SET NULL on both estimates.workOrderId
  // and invoices.workOrderId — implicitly rewriting billing and estimate records
  // without requiring the caller to hold estimates or invoices permission. Block
  // the delete if any estimates or invoices reference this work order so that
  // those cross-module side effects never bypass the billing permission boundary.
  const [linkedEstimate] = await db
    .select({ id: estimatesTable.id })
    .from(estimatesTable)
    .where(eq(estimatesTable.workOrderId, params.data.id));
  if (linkedEstimate) {
    res.status(409).json({
      error:
        "This work order is linked to one or more estimates. Remove or reassign those estimates before deleting the work order.",
    });
    return;
  }

  const [linkedInvoice] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.workOrderId, params.data.id));
  if (linkedInvoice) {
    res.status(409).json({
      error:
        "This work order is linked to one or more invoices. Remove or reassign those invoices before deleting the work order.",
    });
    return;
  }

  // Deleting a work order that already deducted stock returns those parts to
  // inventory. That is a canonical inventory mutation — enforce the same
  // boundary used by /parts, /purchase-orders, and the other stock-affecting
  // work-order paths. Read stockDeducted outside the transaction so we can
  // reject before acquiring any locks.
  const [preDelete] = await db
    .select({ stockDeducted: workOrdersTable.stockDeducted })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.id, params.data.id));
  if (preDelete?.stockDeducted && !hasPermission(req, "inventory")) {
    res.status(403).json({ error: "You do not have permission to delete a work order that has deducted inventory stock" });
    return;
  }

  const deleted = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(workOrdersTable)
      .where(eq(workOrdersTable.id, params.data.id));
    if (!existing) return null;

    // Restore any stock this work order had deducted before its line items
    // cascade away, recording the reversal in the movement ledger.
    if (existing.stockDeducted) {
      const oldItems = await tx
        .select()
        .from(workOrderLineItemsTable)
        .where(eq(workOrderLineItemsTable.workOrderId, params.data.id));
      await reconcileStock(tx, true, oldItems, false, [], {
        reason: "Work order deleted",
        workOrderId: params.data.id,
        userId: req.currentUser?.id ?? null,
      });
    }

    await tx.delete(workOrdersTable).where(eq(workOrdersTable.id, params.data.id));
    return existing;
  });

  if (!deleted) {
    res.status(404).json({ error: "Work order not found" });
    return;
  }

  // Best-effort: free each photo this work order owned, but only objects no
  // longer referenced by any other record. The row is already gone, so a path
  // is kept only if another work order or inspection item still points at it
  // (shared/reused photo). Failures are swallowed — deletion already succeeded
  // and the background orphan sweep is the backstop.
  await freeOrphanedPhotos(deleted.photoUrls ?? [], objectStorageService, req.log);

  res.sendStatus(204);
});

// drizzle-orm wraps driver errors in a DrizzleQueryError, so the underlying
// Postgres error (and its SQLSTATE `code`) lives on the `cause` chain rather
// than the top-level error. Walk the chain to detect a unique-violation (23505)
// regardless of how deeply the driver error is nested.
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if ((current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

router.post("/work-orders/:id/labor-sessions", async (req, res): Promise<void> => {
  const params = StartLaborSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = StartLaborSessionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [workOrder] = await db
    .select()
    .from(workOrdersTable)
    .where(eq(workOrdersTable.id, params.data.id));
  if (!workOrder) {
    res.status(404).json({ error: "Work order not found" });
    return;
  }

  // Enforce one open labor session per work order. The UI disables Start Clock
  // while a session runs, but a second client, the AI tools, or a race could
  // otherwise open concurrent sessions and double-count labor time.
  const [openSession] = await db
    .select({ id: laborSessionsTable.id })
    .from(laborSessionsTable)
    .where(
      and(
        eq(laborSessionsTable.workOrderId, params.data.id),
        isNull(laborSessionsTable.endedAt),
      ),
    );
  if (openSession) {
    res.status(409).json({ error: "This work order already has an active labor session" });
    return;
  }

  // Ownership check: only payroll users may start a session for another
  // mechanic or start an anonymous (no-mechanic) session. Non-payroll users
  // (including timeTracking) may only clock in for their own linked mechanic
  // — matching the timeEntries boundary. Omitting mechanicId is not an escape
  // hatch: a non-payroll user who has no linked mechanic, or who tries to
  // create an unowned session, is rejected outright.
  if (!hasPermission(req, "payroll")) {
    const ownMechanicId = req.currentUser?.mechanicId;
    if (
      parsed.data.mechanicId == null ||
      !ownMechanicId ||
      parsed.data.mechanicId !== ownMechanicId
    ) {
      res.status(403).json({
        error: "You do not have permission to start a labor session for another mechanic.",
      });
      return;
    }
  }

  let created: typeof laborSessionsTable.$inferSelect;
  try {
    [created] = await db
      .insert(laborSessionsTable)
      .values({
        workOrderId: params.data.id,
        mechanicId: parsed.data.mechanicId ?? null,
        task: parsed.data.task ?? null,
      })
      .returning();
  } catch (err) {
    // Two truly concurrent starts can both clear the pre-insert check above and
    // race to insert. The partial unique index (one open session per work order)
    // makes the second insert fail with a Postgres unique-violation (23505); map
    // it to the same 409 so the loser gets a clear, stable error. The code lives
    // on the DrizzleQueryError cause chain, so unwrap it via isUniqueViolation.
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "This work order already has an active labor session" });
      return;
    }
    throw err;
  }

  if (workOrder.status === "open") {
    await db
      .update(workOrdersTable)
      .set({ status: "in_progress" })
      .where(eq(workOrdersTable.id, params.data.id));
  }

  const [session] = await db
    .select(sessionColumns)
    .from(laborSessionsTable)
    .leftJoin(mechanicsTable, eq(laborSessionsTable.mechanicId, mechanicsTable.id))
    .where(eq(laborSessionsTable.id, created.id));

  res.status(201).json(StopLaborSessionResponse.parse(redactSession(shapeSession(session), req)));
});

// Persist a dismissal of the "already billed parts" amber banner on this work
// order. The server fingerprints the current invoicedParts set and stores the
// hash so subsequent reads suppress the banner until the fingerprint changes
// (i.e. a new invoice bills additional parts). Requires the invoices permission
// (same gate as invoicedParts). Idempotent.
router.post("/work-orders/:id/billed-parts-dismissal", async (req, res): Promise<void> => {
  const params = GetWorkOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!hasPermission(req, "invoices")) {
    res.status(403).json({ error: "You do not have permission to manage invoices" });
    return;
  }

  const [workOrder] = await db
    .select({ id: workOrdersTable.id })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.id, params.data.id));
  if (!workOrder) {
    res.status(404).json({ error: "Work order not found" });
    return;
  }

  const invoicedParts = await loadInvoicedParts(params.data.id);
  const hash = computeInvoicedPartsFingerprint(invoicedParts);

  await db
    .update(workOrdersTable)
    .set({ billedBannerDismissedHash: hash })
    .where(eq(workOrdersTable.id, params.data.id));

  res.sendStatus(204);
});

// Persist a dismissal of a low-stock part from this work order's reorder banner
// so it stays dismissed across refreshes. Requires the inventory permission (the
// reorder nudge is inventory-scoped; non-inventory callers never see partIds to
// dismiss). The dismissal is filtered back out of lowStockItems on read.
router.post("/work-orders/:id/reorder-dismissals", async (req, res): Promise<void> => {
  const params = DismissWorkOrderReorderPartParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = DismissWorkOrderReorderPartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!hasPermission(req, "inventory")) {
    res.status(403).json({ error: "You do not have permission to manage inventory" });
    return;
  }

  const [workOrder] = await db
    .select({ id: workOrdersTable.id })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.id, params.data.id));
  if (!workOrder) {
    res.status(404).json({ error: "Work order not found" });
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
    recordType: "work_order",
    recordId: params.data.id,
    partId: parsed.data.partId,
    userId: req.currentUser?.id ?? null,
  });
  res.sendStatus(204);
});

// Restore a previously-dismissed low-stock part to this work order's reorder
// banner, so staff who dismissed a part by mistake can bring the reminder back.
// Requires the inventory permission (same boundary as dismissing). The dismissal
// row is removed so the part reappears in lowStockItems on read. Idempotent.
router.delete("/work-orders/:id/reorder-dismissals", async (req, res): Promise<void> => {
  const params = RestoreWorkOrderReorderPartParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = RestoreWorkOrderReorderPartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!hasPermission(req, "inventory")) {
    res.status(403).json({ error: "You do not have permission to manage inventory" });
    return;
  }

  const [workOrder] = await db
    .select({ id: workOrdersTable.id })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.id, params.data.id));
  if (!workOrder) {
    res.status(404).json({ error: "Work order not found" });
    return;
  }

  await undismissReorderPart({
    recordType: "work_order",
    recordId: params.data.id,
    partId: parsed.data.partId,
  });
  res.sendStatus(204);
});

router.post("/labor-sessions/:id/stop", async (req, res): Promise<void> => {
  const params = StopLaborSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(laborSessionsTable)
    .where(and(eq(laborSessionsTable.id, params.data.id), isNull(laborSessionsTable.endedAt)));

  if (!existing) {
    res.status(404).json({ error: "Active labor session not found" });
    return;
  }

  // Ownership check: only payroll users may stop another mechanic's session or
  // stop an anonymous (no-mechanic) session. Non-payroll users may only stop
  // their own linked mechanic's session — matching the timeEntries boundary.
  // A null mechanicId is not a free pass: anonymous sessions are payroll-only.
  if (!hasPermission(req, "payroll")) {
    const ownMechanicId = req.currentUser?.mechanicId;
    if (
      existing.mechanicId == null ||
      !ownMechanicId ||
      existing.mechanicId !== ownMechanicId
    ) {
      res.status(403).json({
        error: "You do not have permission to stop a labor session for another mechanic.",
      });
      return;
    }
  }

  await db
    .update(laborSessionsTable)
    .set({ endedAt: new Date().toISOString() })
    .where(eq(laborSessionsTable.id, params.data.id));

  const [session] = await db
    .select(sessionColumns)
    .from(laborSessionsTable)
    .leftJoin(mechanicsTable, eq(laborSessionsTable.mechanicId, mechanicsTable.id))
    .where(eq(laborSessionsTable.id, params.data.id));

  res.json(StopLaborSessionResponse.parse(redactSession(shapeSession(session), req)));
});

export default router;
