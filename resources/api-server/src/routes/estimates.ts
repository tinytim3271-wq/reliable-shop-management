import { Router, type IRouter } from "express";
import { eq, desc, and, inArray, type SQL } from "drizzle-orm";
import { isAdmin } from "../lib/auth";
import {
  db,
  estimatesTable,
  estimateLineItemsTable,
  invoicesTable,
  invoiceLineItemsTable,
  customersTable,
  vehiclesTable,
  workOrdersTable,
  workOrderLineItemsTable,
  partsTable,
} from "@workspace/db";
import {
  ListEstimatesQueryParams,
  ListEstimatesResponse,
  CreateEstimateBody,
  GetEstimateParams,
  GetEstimateResponse,
  UpdateEstimateParams,
  UpdateEstimateBody,
  UpdateEstimateResponse,
  DeleteEstimateParams,
  ApproveEstimateParams,
  DeclineEstimateParams,
  ConvertEstimateToInvoiceParams,
  ConvertEstimateToWorkOrderParams,
  CreateEstimatePortalLinkParams,
  RevokeEstimatePortalLinkParams,
  UpdateInvoiceResponse,
  UpdateWorkOrderResponse,
} from "@workspace/api-zod";
import { mintPortalToken, revokePortalTokens, ESTIMATE_PENDING } from "../lib/portal";
import { convertEstimateToInvoice } from "../lib/estimateToInvoice";
import { convertEstimateToWorkOrder } from "../lib/estimateToWorkOrder";
import {
  vehicleLabel,
  estimateNumber,
  invoiceNumber,
  fetchPriorBilledLabor,
  shapeLineItem,
  computeTotals,
  computeCategorySubtotals,
  normalizeLineItems,
  matchCatalogPart,
  type CatalogPart,
  computeWorkOrderTotals,
  loadCatalog,
  findOverStockItems,
  findLowStockItems,
  isStockCommitted,
  loadInvoicedParts,
  type InvoicedPart,
  type EstimatePartLine,
} from "../lib/billing";
import { round2 } from "../lib/ledger";
import { missingRef } from "../lib/refs";
import { hasPermission } from "../lib/auth";
import type { Request, Response } from "express";

const router: IRouter = Router();

const estColumns = {
  id: estimatesTable.id,
  customerId: estimatesTable.customerId,
  vehicleId: estimatesTable.vehicleId,
  workOrderId: estimatesTable.workOrderId,
  status: estimatesTable.status,
  notes: estimatesTable.notes,
  taxRate: estimatesTable.taxRate,
  approvedAt: estimatesTable.approvedAt,
  createdAt: estimatesTable.createdAt,
  customerName: customersTable.name,
  vYear: vehiclesTable.year,
  vMake: vehiclesTable.make,
  vModel: vehiclesTable.model,
};

type EstRow = {
  id: number;
  customerId: number;
  vehicleId: number;
  workOrderId: number | null;
  status: string;
  notes: string | null;
  taxRate: number;
  approvedAt: string | null;
  createdAt: string;
  customerName: string | null;
  vYear: number | null;
  vMake: string | null;
  vModel: string | null;
};

const selectEstimates = () =>
  db
    .select(estColumns)
    .from(estimatesTable)
    .leftJoin(customersTable, eq(estimatesTable.customerId, customersTable.id))
    .leftJoin(vehiclesTable, eq(estimatesTable.vehicleId, vehiclesTable.id));

const fetchLineItems = (estimateId: number) =>
  db
    .select()
    .from(estimateLineItemsTable)
    .where(eq(estimateLineItemsTable.estimateId, estimateId))
    .orderBy(estimateLineItemsTable.id);

type StoredLineItem = typeof estimateLineItemsTable.$inferSelect;

const shapeEstimate = (row: EstRow, items: StoredLineItem[]) => {
  const { subtotal, taxAmount, total } = computeTotals(items, row.taxRate);
  const { laborSubtotal, partsSubtotal, feesSubtotal } = computeCategorySubtotals(items);
  return {
    id: row.id,
    customerId: row.customerId,
    vehicleId: row.vehicleId,
    workOrderId: row.workOrderId,
    number: estimateNumber(row.id),
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
    approvedAt: row.approvedAt,
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
// the estimate detail/edit page can warn when a quoted part qty exceeds on-hand.
const shapeLineItemWithStock = (li: StoredLineItem, catalog: CatalogPart[]) => {
  const base = shapeLineItem(li);
  const match = li.type === "part" ? matchCatalogPart(li.description, catalog) : null;
  return {
    ...base,
    partId: match ? match.id : null,
    quantityOnHand: match ? match.quantityOnHand : null,
    lowStock: match ? match.quantityOnHand <= match.reorderLevel : null,
  };
};

const detail = (row: EstRow, items: StoredLineItem[], catalog: CatalogPart[]) => ({
  ...shapeEstimate(row, items),
  lineItems: items.map((li) => shapeLineItemWithStock(li, catalog)),
});

// Captioned, ordered photos from the linked work order. Gated on the workOrders
// permission so the estimate detail never exposes work-order photo paths to a
// caller who could not read them via the storage route anyway — the same
// object-storage boundary the work order itself enforces. Mirrors the invoice
// detail behavior so estimates surface the same photos that justify the work.
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

// Parts already billed on the linked work order's prior (non-void) invoices,
// mirroring the work-order detail's invoicedParts. Gated on BOTH the workOrders
// AND invoices permissions to match the same boundary enforced by the work-order
// detail endpoint (workOrders.ts buildDetail). Disclosing invoice-derived billing
// history to callers who lack the invoices permission would bypass the intended
// module separation.
const fetchInvoicedParts = async (
  workOrderId: number | null,
  req: Request,
): Promise<InvoicedPart[]> => {
  if (
    workOrderId === null ||
    !hasPermission(req, "workOrders") ||
    !hasPermission(req, "invoices")
  )
    return [];
  return loadInvoicedParts(workOrderId);
};

const detailWithPhotos = async (
  row: EstRow,
  items: StoredLineItem[],
  catalog: CatalogPart[],
  req: Request,
) => ({
  ...redactEstimate(detail(row, items, catalog), req),
  workOrderPhotos: await fetchWorkOrderPhotos(row.workOrderId, req),
  invoicedParts: await fetchInvoicedParts(row.workOrderId, req),
});

// Strip cross-module fields the caller is not permitted to read.
// customerName / vehicleLabel come from the customers module.
const redactEstimate = <T extends { customerName: string | null; vehicleLabel: string | null }>(
  shaped: T,
  req: Request,
): T => ({
  ...shaped,
  customerName: hasPermission(req, "customers") ? shaped.customerName : null,
  vehicleLabel: hasPermission(req, "customers") ? shaped.vehicleLabel : null,
});

// Reject part line items that quote more units than the matched catalog entry
// has on hand, unless the caller explicitly opts in with allowOverStock. Returns
// true and writes a 409 response when blocked; returns false to continue. The
// numeric available count is only disclosed to callers with inventory access so
// this guard does not become a side channel into stock levels.
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
      "One or more parts exceed available stock. Order more, reduce the quantity, or quote anyway to override.",
    overStockItems: offenders.map((o) => ({
      description: o.description,
      requested: o.requested,
      available: canSeeStock ? o.available : null,
    })),
  });
  return true;
};

router.get("/estimates", async (req, res): Promise<void> => {
  const query = ListEstimatesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const filters: SQL[] = [];
  if (query.data.status) filters.push(eq(estimatesTable.status, query.data.status));
  if (query.data.customerId) filters.push(eq(estimatesTable.customerId, query.data.customerId));
  if (query.data.vehicleId) filters.push(eq(estimatesTable.vehicleId, query.data.vehicleId));

  const base = selectEstimates();
  const rows = filters.length
    ? await base.where(and(...filters)).orderBy(desc(estimatesTable.id))
    : await base.orderBy(desc(estimatesTable.id));

  const allItems = await db.select().from(estimateLineItemsTable);
  const shaped = rows.map((row) =>
    redactEstimate(
      shapeEstimate(
        row,
        allItems.filter((li) => li.estimateId === row.id),
      ),
      req,
    ),
  );

  res.json(ListEstimatesResponse.parse(shaped));
});

router.post("/estimates", async (req, res): Promise<void> => {
  const parsed = CreateEstimateBody.safeParse(req.body);
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

  const refError =
    (await missingRef(customersTable, parsed.data.customerId, "Customer")) ??
    (await missingRef(vehiclesTable, parsed.data.vehicleId, "Vehicle")) ??
    (await missingRef(workOrdersTable, parsed.data.workOrderId, "Work order"));
  if (refError) {
    res.status(400).json({ error: refError });
    return;
  }

  // Relational consistency: the vehicle must belong to the specified customer,
  // and the work order (if any) must belong to the same customer and vehicle.
  // Without these checks a staff user could manufacture cross-customer record
  // graphs that the public portal later renders as if they belong to one customer.
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
    const woConditions: ReturnType<typeof eq>[] = [eq(workOrdersTable.id, parsed.data.workOrderId)];
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

  if (
    await blockedForOverStock(
      req,
      res,
      parsed.data.lineItems,
      parsed.data.allowOverStock,
    )
  ) {
    return;
  }

  const [created] = await db
    .insert(estimatesTable)
    .values({
      customerId: parsed.data.customerId,
      vehicleId: parsed.data.vehicleId,
      workOrderId: parsed.data.workOrderId ?? null,
      notes: parsed.data.notes ?? null,
      taxRate: parsed.data.taxRate ?? 0,
      status: parsed.data.status ?? "draft",
    })
    .returning();

  const items = normalizeLineItems(parsed.data.lineItems);
  if (items.length) {
    await db
      .insert(estimateLineItemsTable)
      .values(items.map((li) => ({ ...li, estimateId: created.id })));
  }

  const [row] = await selectEstimates().where(eq(estimatesTable.id, created.id));
  const stored = await fetchLineItems(created.id);
  const catalog = await fetchCatalog(req);
  res.status(201).json(
    UpdateEstimateResponse.parse(await detailWithPhotos(row, stored, catalog, req)),
  );
});

router.get("/estimates/:id", async (req, res): Promise<void> => {
  const params = GetEstimateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await selectEstimates().where(eq(estimatesTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }

  const stored = await fetchLineItems(row.id);
  const catalog = await fetchCatalog(req);
  res.json(GetEstimateResponse.parse(await detailWithPhotos(row, stored, catalog, req)));
});

router.patch("/estimates/:id", async (req, res): Promise<void> => {
  const params = UpdateEstimateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateEstimateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(estimatesTable)
    .where(eq(estimatesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }

  // Once a customer has approved or declined, the decision is irrevocable.
  // Reject any PATCH that touches the status field when the existing status is
  // already final, even if the caller tries to move it back to a pending value.
  // Admins wishing to override a final decision must use the /approve or
  // /decline endpoints, which enforce the pending-state CAS guard.
  if (
    parsed.data.status !== undefined &&
    !ESTIMATE_PENDING.has(existing.status)
  ) {
    res.status(409).json({
      error: `Cannot change status: this estimate has already been ${existing.status}`,
    });
    return;
  }

  if (
    (parsed.data.customerId !== undefined || parsed.data.vehicleId !== undefined) &&
    !hasPermission(req, "customers")
  ) {
    res.status(403).json({ error: "You do not have permission to reassign estimate ownership" });
    return;
  }

  if (parsed.data.workOrderId !== undefined && !hasPermission(req, "workOrders")) {
    res.status(403).json({ error: "You do not have permission to link to a work order" });
    return;
  }

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

  // The `approved` and `declined` statuses represent a customer's irrevocable
  // decision. Only the dedicated /approve and /decline endpoints (which enforce
  // the pending-state invariant) or the customer portal may set them. Blocking
  // here prevents staff from forging approval or overwriting a final decision
  // via the general update route.
  if (parsed.data.status === "approved" || parsed.data.status === "declined") {
    res.status(403).json({
      error:
        "Estimate approval status can only be changed via the /approve or /decline endpoints",
    });
    return;
  }

  if (
    await blockedForOverStock(
      req,
      res,
      parsed.data.lineItems,
      parsed.data.allowOverStock,
    )
  ) {
    return;
  }

  const { lineItems, allowOverStock: _allowOverStock, ...fields } = parsed.data;
  const becomingApproved = fields.status === "approved" && existing.status !== "approved";

  // Revoke any outstanding portal tokens when the estimate's ownership or
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

  if (ownershipChanging) {
    await revokePortalTokens({ estimateId: params.data.id });
  }

  await db
    .update(estimatesTable)
    .set({
      ...fields,
      ...(becomingApproved ? { approvedAt: new Date().toISOString() } : {}),
    })
    .where(eq(estimatesTable.id, params.data.id));

  if (lineItems) {
    await db
      .delete(estimateLineItemsTable)
      .where(eq(estimateLineItemsTable.estimateId, params.data.id));
    const items = normalizeLineItems(lineItems);
    if (items.length) {
      await db
        .insert(estimateLineItemsTable)
        .values(items.map((li) => ({ ...li, estimateId: params.data.id })));
    }
  }

  const [row] = await selectEstimates().where(eq(estimatesTable.id, params.data.id));
  const stored = await fetchLineItems(params.data.id);
  const catalog = await fetchCatalog(req);
  res.json(
    UpdateEstimateResponse.parse(await detailWithPhotos(row, stored, catalog, req)),
  );
});

router.delete("/estimates/:id", async (req, res): Promise<void> => {
  const params = DeleteEstimateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Deleting an estimate causes the database to null out invoices.estimateId on
  // any invoice that references this estimate (ON DELETE SET NULL). That is an
  // implicit write to billing records that bypasses the invoices permission gate.
  // Block the delete if any such invoice exists so that billing provenance is
  // only broken by someone with the explicit right to manage invoices.
  const linkedInvoices = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.estimateId, params.data.id));
  if (linkedInvoices.length > 0) {
    res.status(409).json({
      error:
        "This estimate is linked to one or more invoices. Remove or reassign those invoices before deleting the estimate.",
    });
    return;
  }

  // Revoke any outstanding portal tokens before deleting the estimate so that
  // customers holding an existing link can no longer access the portal view or
  // any photos through that link after the record is gone.
  await revokePortalTokens({ estimateId: params.data.id });

  const [deleted] = await db
    .delete(estimatesTable)
    .where(eq(estimatesTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }

  res.sendStatus(204);
});

// Mint a customer portal link for this estimate. The raw token is returned
// exactly once; only its hash is stored. createdByUserId is recorded for
// attribution (set null if the actor cannot be resolved).
router.post("/estimates/:id/portal-link", async (req, res): Promise<void> => {
  const params = CreateEstimatePortalLinkParams.safeParse(req.params);
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
    .from(estimatesTable)
    .where(eq(estimatesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }

  const link = await mintPortalToken({
    estimateId: params.data.id,
    createdByUserId: req.currentUser?.id ?? null,
  });
  res.status(201).json(link);
});

router.delete("/estimates/:id/portal-link", async (req, res): Promise<void> => {
  const params = RevokeEstimatePortalLinkParams.safeParse(req.params);
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
    .from(estimatesTable)
    .where(eq(estimatesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }

  await revokePortalTokens({ estimateId: params.data.id });
  res.sendStatus(204);
});

const setStatus = async (
  id: number,
  status: "approved" | "declined",
  catalog: CatalogPart[],
  req: Request,
): Promise<null | "not_found" | "conflict" | Awaited<ReturnType<typeof detailWithPhotos>>> => {
  // Use a compare-and-swap UPDATE that only succeeds while the estimate is
  // still pending (draft or sent). This mirrors the portal invariant: once a
  // customer decision is recorded it is locked and cannot be overwritten by
  // staff actions.
  const pendingStatuses = Array.from(ESTIMATE_PENDING) as string[];
  const updated = await db
    .update(estimatesTable)
    .set({
      status,
      ...(status === "approved" ? { approvedAt: new Date().toISOString() } : {}),
    })
    .where(and(eq(estimatesTable.id, id), inArray(estimatesTable.status, pendingStatuses)))
    .returning({ id: estimatesTable.id });
  if (updated.length === 0) {
    // Distinguish 404 from 409.
    const [existing] = await db
      .select({ id: estimatesTable.id })
      .from(estimatesTable)
      .where(eq(estimatesTable.id, id));
    return existing ? "conflict" : "not_found";
  }
  const [row] = await selectEstimates().where(eq(estimatesTable.id, id));
  const stored = await fetchLineItems(id);
  return detailWithPhotos(row, stored, catalog, req);
};

router.post("/estimates/:id/approve", async (req, res): Promise<void> => {
  // Recording a customer's approval decision on their behalf is an elevated
  // action. Require admin so that low-privilege estimators cannot forge
  // customer consent. Customers use the portal token flow instead.
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Admin permission required to approve an estimate on behalf of a customer" });
    return;
  }
  const params = ApproveEstimateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await setStatus(params.data.id, "approved", await fetchCatalog(req), req);
  if (result === "not_found" || result === null) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }
  if (result === "conflict") {
    res.status(409).json({ error: "This estimate has already been approved or declined" });
    return;
  }
  res.json(UpdateEstimateResponse.parse(result));
});

router.post("/estimates/:id/decline", async (req, res): Promise<void> => {
  // Same as approve: only admins may record a customer's decline on their
  // behalf. Low-privilege estimators cannot override a customer decision.
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Admin permission required to decline an estimate on behalf of a customer" });
    return;
  }
  const params = DeclineEstimateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await setStatus(params.data.id, "declined", await fetchCatalog(req), req);
  if (result === "not_found" || result === null) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }
  if (result === "conflict") {
    res.status(409).json({ error: "This estimate has already been approved or declined" });
    return;
  }
  res.json(UpdateEstimateResponse.parse(result));
});

router.post("/estimates/:id/convert-to-invoice", async (req, res): Promise<void> => {
  if (!isAdmin(req) && !req.currentUser?.permissions.includes("invoices")) {
    res.status(403).json({
      error: "You do not have permission to create invoices",
    });
    return;
  }

  const params = ConvertEstimateToInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Cross-module permission guards: the converted invoice inherits the
  // estimate's FK linkages, so the caller must hold the same cross-module
  // permissions that POST /invoices would require when those FKs are set.
  const [estForPerm] = await db
    .select({
      customerId: estimatesTable.customerId,
      vehicleId: estimatesTable.vehicleId,
      workOrderId: estimatesTable.workOrderId,
    })
    .from(estimatesTable)
    .where(eq(estimatesTable.id, params.data.id));
  if (estForPerm) {
    if (estForPerm.customerId != null && !hasPermission(req, "customers")) {
      res.status(403).json({ error: "You do not have permission to link to a customer record" });
      return;
    }
    if (estForPerm.vehicleId != null && !hasPermission(req, "customers")) {
      res.status(403).json({ error: "You do not have permission to link to a vehicle record" });
      return;
    }
    if (estForPerm.workOrderId != null && !hasPermission(req, "workOrders")) {
      res.status(403).json({ error: "You do not have permission to link to a work order" });
      return;
    }
  }

  const conversion = await convertEstimateToInvoice(params.data.id);
  if (!conversion.ok) {
    res.status(conversion.status).json({ error: conversion.error });
    return;
  }

  const [invRow] = await db
    .select({
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
      paidAt: invoicesTable.paidAt,
      createdAt: invoicesTable.createdAt,
      customerName: customersTable.name,
      vYear: vehiclesTable.year,
      vMake: vehiclesTable.make,
      vModel: vehiclesTable.model,
    })
    .from(invoicesTable)
    .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
    .leftJoin(vehiclesTable, eq(invoicesTable.vehicleId, vehiclesTable.id))
    .where(eq(invoicesTable.id, conversion.invoiceId));

  const invItems = await db
    .select()
    .from(invoiceLineItemsTable)
    .where(eq(invoiceLineItemsTable.invoiceId, conversion.invoiceId))
    .orderBy(invoiceLineItemsTable.id);

  const { subtotal, taxAmount, total } = computeTotals(invItems, invRow.taxRate);
  const { laborSubtotal, partsSubtotal, feesSubtotal } = computeCategorySubtotals(invItems);

  // Mirror the invoice route's reorder nudge: a converted invoice is created in
  // a billed (stock-committed) status, so surface any matched part now at/below
  // its reorder level. Numeric counts are redacted for non-inventory callers.
  const canSeeStock = hasPermission(req, "inventory");
  const lowStockItems = isStockCommitted(invRow.status)
    ? findLowStockItems(invItems, await loadCatalog()).map((item) => ({
        partId: canSeeStock ? item.partId : null,
        description: item.description,
        remaining: canSeeStock ? item.remaining : null,
        reorderLevel: canSeeStock ? item.reorderLevel : null,
        // A just-converted invoice has no dismissals yet.
        dismissed: false,
      }))
    : [];

  res.status(201).json(
    UpdateInvoiceResponse.parse({
      id: invRow.id,
      customerId: invRow.customerId,
      vehicleId: invRow.vehicleId,
      workOrderId: invRow.workOrderId,
      estimateId: invRow.estimateId,
      number: invoiceNumber(invRow.id),
      status: invRow.status,
      customerName: hasPermission(req, "customers") ? invRow.customerName : null,
      vehicleLabel: hasPermission(req, "customers")
        ? vehicleLabel({ year: invRow.vYear, make: invRow.vMake, model: invRow.vModel })
        : null,
      notes: invRow.notes,
      taxRate: invRow.taxRate,
      laborSubtotal,
      partsSubtotal,
      feesSubtotal,
      subtotal,
      taxAmount,
      total,
      amountPaid: invRow.amountPaid,
      amountDue: round2(total - invRow.amountPaid),
      stripePaymentIntentId: invRow.stripePaymentIntentId,
      paidAt: invRow.paidAt,
      createdAt: invRow.createdAt,
      lineItems: invItems.map(shapeLineItem),
      payments: [],
      workOrderPhotos: [],
      lowStockItems,
      priorBilledLabor: await fetchPriorBilledLabor(invRow.id, invRow.workOrderId),
    }),
  );
});

router.post("/estimates/:id/convert-to-work-order", async (req, res): Promise<void> => {
  if (!isAdmin(req) && !req.currentUser?.permissions.includes("workOrders")) {
    res.status(403).json({
      error: "You do not have permission to create work orders",
    });
    return;
  }

  const params = ConvertEstimateToWorkOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Cross-module permission guards: the converted work order inherits the
  // estimate's customer/vehicle linkage, so the caller must hold the same
  // cross-module permissions that POST /work-orders would require.
  const [estForPerm] = await db
    .select({
      customerId: estimatesTable.customerId,
      vehicleId: estimatesTable.vehicleId,
    })
    .from(estimatesTable)
    .where(eq(estimatesTable.id, params.data.id));
  if (estForPerm) {
    if (estForPerm.customerId != null && !hasPermission(req, "customers")) {
      res.status(403).json({ error: "You do not have permission to link to a customer record" });
      return;
    }
    if (estForPerm.vehicleId != null && !hasPermission(req, "customers")) {
      res.status(403).json({ error: "You do not have permission to link to a vehicle record" });
      return;
    }
  }

  const conversion = await convertEstimateToWorkOrder(params.data.id);
  if (!conversion.ok) {
    res.status(conversion.status).json({ error: conversion.error });
    return;
  }

  const [woRow] = await db
    .select({
      id: workOrdersTable.id,
      customerId: workOrdersTable.customerId,
      vehicleId: workOrdersTable.vehicleId,
      title: workOrdersTable.title,
      description: workOrdersTable.description,
      status: workOrdersTable.status,
      complaint: workOrdersTable.complaint,
      notes: workOrdersTable.notes,
      photoUrls: workOrdersTable.photoUrls,
      openedAt: workOrdersTable.openedAt,
      completedAt: workOrdersTable.completedAt,
      createdAt: workOrdersTable.createdAt,
      customerName: customersTable.name,
      vYear: vehiclesTable.year,
      vMake: vehiclesTable.make,
      vModel: vehiclesTable.model,
    })
    .from(workOrdersTable)
    .leftJoin(customersTable, eq(workOrdersTable.customerId, customersTable.id))
    .leftJoin(vehiclesTable, eq(workOrdersTable.vehicleId, vehiclesTable.id))
    .where(eq(workOrdersTable.id, conversion.workOrderId));

  // The conversion copies the estimate's quoted items into the work order's
  // structured tasks & parts; surface them in the response with stock context
  // (inventory-gated) so the work order detail reflects them immediately.
  const woItems = await db
    .select()
    .from(workOrderLineItemsTable)
    .where(eq(workOrderLineItemsTable.workOrderId, conversion.workOrderId))
    .orderBy(workOrderLineItemsTable.id);
  const catalog = await fetchCatalog(req);

  res.status(201).json(
    UpdateWorkOrderResponse.parse({
      id: woRow.id,
      customerId: woRow.customerId,
      vehicleId: woRow.vehicleId,
      customerName: hasPermission(req, "customers") ? woRow.customerName : null,
      vehicleLabel: hasPermission(req, "customers")
        ? vehicleLabel({ year: woRow.vYear, make: woRow.vMake, model: woRow.vModel })
        : null,
      assignedMechanicId: null,
      assignedMechanicName: null,
      title: woRow.title,
      description: woRow.description,
      status: woRow.status,
      complaint: woRow.complaint,
      notes: woRow.notes,
      photoUrls: woRow.photoUrls ?? [],
      totalLaborMinutes: 0,
      // A freshly converted work order has no linked invoices yet, so no tracked
      // labor time has been billed.
      invoicedLaborHours: 0,
      hasActiveSession: false,
      openedAt: woRow.openedAt,
      completedAt: woRow.completedAt,
      createdAt: woRow.createdAt,
      laborSessions: [],
      lowStockItems: [],
      // A just-converted work order has no linked invoices yet, so no parts
      // have been billed.
      invoicedParts: [],
      totals: computeWorkOrderTotals(woItems),
      lineItems: woItems.map((li) => {
        const match = li.type === "part" ? matchCatalogPart(li.description, catalog) : null;
        return {
          ...shapeLineItem(li),
          partId: match ? match.id : null,
          quantityOnHand: match ? match.quantityOnHand : null,
          lowStock: match ? match.quantityOnHand <= match.reorderLevel : null,
        };
      }),
    }),
  );
});

export default router;
