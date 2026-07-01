import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import {
  db,
  portalTokensTable,
  estimatesTable,
  estimateLineItemsTable,
  invoicesTable,
  invoiceLineItemsTable,
  customersTable,
  vehiclesTable,
  workOrdersTable,
  type PortalToken,
} from "@workspace/db";
import {
  vehicleLabel,
  estimateNumber,
  invoiceNumber,
  shapeLineItem,
  computeTotals,
  computeCategorySubtotals,
} from "./billing";
import { round2 } from "./ledger";

// Customer portal token helpers. A token is a 256-bit opaque secret handed to a
// single customer; only its sha256 hex digest is persisted, so reading the DB
// never yields a working link. Every token is bound (by FK) to exactly one
// estimate OR one invoice and carries an expiry plus optional revocation.
//
// Photo access is scoped to a snapshot taken at mint time (snapshotPhotoUrls on
// the token row). Photos added to the work order after the link is issued are
// never exposed through an existing token.

const TOKEN_TTL_DAYS = 30;

export const hashToken = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

export const generateToken = (): string => randomBytes(32).toString("base64url");

type MintTarget =
  | { estimateId: number; invoiceId?: undefined }
  | { invoiceId: number; estimateId?: undefined };

export type MintedLink = { token: string; expiresAt: string };

// Fetch the current photo URLs for the work order linked to a mint target.
// Called once at mint time to produce the immutable snapshot stored on the token.
const fetchMintPhotoSnapshot = async (target: MintTarget): Promise<string[]> => {
  let workOrderId: number | null = null;
  if (target.estimateId !== undefined) {
    const [e] = await db
      .select({ workOrderId: estimatesTable.workOrderId })
      .from(estimatesTable)
      .where(eq(estimatesTable.id, target.estimateId));
    workOrderId = e?.workOrderId ?? null;
  } else if (target.invoiceId !== undefined) {
    const [i] = await db
      .select({ workOrderId: invoicesTable.workOrderId })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, target.invoiceId));
    workOrderId = i?.workOrderId ?? null;
  }
  if (workOrderId === null) return [];
  const [wo] = await db
    .select({ photoUrls: workOrdersTable.photoUrls })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.id, workOrderId));
  return wo?.photoUrls ?? [];
};

export const mintPortalToken = async (
  target: MintTarget & { createdByUserId: number | null },
): Promise<MintedLink> => {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(
    Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Capture the work-order photo list at mint time. This snapshot is the
  // exclusive set of photos accessible through this token for its lifetime.
  const snapshotPhotoUrls = await fetchMintPhotoSnapshot(target);

  await db.insert(portalTokensTable).values({
    tokenHash,
    estimateId: target.estimateId ?? null,
    invoiceId: target.invoiceId ?? null,
    expiresAt,
    createdByUserId: target.createdByUserId,
    snapshotPhotoUrls,
  });
  return { token, expiresAt };
};

// Revoke every still-active link for a record (idempotent).
export const revokePortalTokens = async (
  target: { estimateId: number } | { invoiceId: number },
): Promise<void> => {
  const [col, id] =
    "estimateId" in target
      ? ([portalTokensTable.estimateId, target.estimateId] as const)
      : ([portalTokensTable.invoiceId, target.invoiceId] as const);
  await db
    .update(portalTokensTable)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(col, id), isNull(portalTokensTable.revokedAt)));
};

// Resolve a raw token to its row, rejecting unknown/revoked/expired tokens.
// All failure modes collapse to null so callers return one uniform 404 and
// never reveal whether a token exists, is expired, or was revoked.
export const resolvePortalToken = async (
  raw: string | undefined,
): Promise<PortalToken | null> => {
  if (!raw) return null;
  const [row] = await db
    .select()
    .from(portalTokensTable)
    .where(eq(portalTokensTable.tokenHash, hashToken(raw)));
  if (!row) return null;
  if (row.revokedAt) return null;
  if (Date.parse(row.expiresAt) <= Date.now()) return null;
  await db
    .update(portalTokensTable)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(portalTokensTable.id, row.id));
  return row;
};

// An estimate can only be approved/declined by the customer while it is still
// pending; once it is approved or declined the decision is locked.
export const ESTIMATE_PENDING = new Set(["draft", "sent"]);

export type PortalView = {
  kind: "estimate" | "invoice";
  id: number;
  number: string;
  status: string;
  customerName: string | null;
  vehicleLabel: string | null;
  notes: string | null;
  taxRate: number;
  laborSubtotal: number;
  partsSubtotal: number;
  feesSubtotal: number;
  subtotal: number;
  taxAmount: number;
  total: number;
  lineItems: ReturnType<typeof shapeLineItem>[];
  createdAt: string;
  canRespond: boolean;
  approvedAt: string | null;
  amountPaid: number | null;
  amountDue: number | null;
  paidAt: string | null;
  photos: { path: string; caption: string }[];
  priorBilledLabor: { invoiceId: number; number: string; hours: number }[];
};

// Build the captioned photo list from a snapshot of object paths.
// Only paths present in the snapshot are returned; their captions are fetched
// from the work order at read time (caption text updates are harmless but the
// set of visible paths is immutably bound to the snapshot).
// Returns [] when there is no linked work order or the snapshot is empty.
const buildSnapshotPhotos = async (
  workOrderId: number | null,
  snapshotPhotoUrls: string[],
): Promise<{ path: string; caption: string }[]> => {
  if (workOrderId === null || snapshotPhotoUrls.length === 0) return [];
  const [wo] = await db
    .select({ photoCaptions: workOrdersTable.photoCaptions })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.id, workOrderId));
  const captions = wo?.photoCaptions ?? {};
  return snapshotPhotoUrls.map((path) => ({ path, caption: captions[path] ?? "" }));
};

// Authorize a public photo fetch with a three-layer check:
//   1. The requested path must appear in the token's snapshotPhotoUrls (the
//      immutable set captured at mint time) — prevents tokens from gaining
//      access to photos added after the link was issued.
//   2. The bound estimate or invoice must still exist, still be linked to the
//      same work order, and that work order must still carry the photo in its
//      current photoUrls — prevents tokens from serving photos that staff have
//      since removed, records that have been deleted, or records whose work
//      order link has been changed.
//   3. The linked work order must belong to the same customer and vehicle as
//      the bound estimate or invoice — prevents pre-existing inconsistent rows
//      (created before relational FK checks were enforced) from leaking
//      cross-customer photos through the direct photo-fetch endpoint.
export const isPortalPhotoPathLive = async (
  token: PortalToken,
  objectPath: string,
): Promise<boolean> => {
  // Fast reject: path not in the snapshot captured at mint time.
  if (!(token.snapshotPhotoUrls ?? []).includes(objectPath)) return false;

  // Verify the bound record still exists and still points to a work order.
  // Also capture the record's customerId/vehicleId for the ownership check.
  let workOrderId: number | null = null;
  let recordCustomerId: number | null = null;
  let recordVehicleId: number | null = null;
  if (token.estimateId !== null) {
    const [e] = await db
      .select({
        workOrderId: estimatesTable.workOrderId,
        customerId: estimatesTable.customerId,
        vehicleId: estimatesTable.vehicleId,
      })
      .from(estimatesTable)
      .where(eq(estimatesTable.id, token.estimateId));
    if (!e) return false;
    workOrderId = e.workOrderId;
    recordCustomerId = e.customerId;
    recordVehicleId = e.vehicleId;
  } else if (token.invoiceId !== null) {
    const [i] = await db
      .select({
        workOrderId: invoicesTable.workOrderId,
        customerId: invoicesTable.customerId,
        vehicleId: invoicesTable.vehicleId,
      })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, token.invoiceId));
    if (!i) return false;
    workOrderId = i.workOrderId;
    recordCustomerId = i.customerId;
    recordVehicleId = i.vehicleId;
  }

  if (workOrderId === null) return false;

  // Verify the photo is still present on the live work order record AND that
  // the work order belongs to the same customer and vehicle as the bound record.
  // The combined WHERE ensures both checks in a single query.
  const [wo] = await db
    .select({ photoUrls: workOrdersTable.photoUrls })
    .from(workOrdersTable)
    .where(
      and(
        eq(workOrdersTable.id, workOrderId),
        eq(workOrdersTable.customerId, recordCustomerId!),
        eq(workOrdersTable.vehicleId, recordVehicleId!),
      ),
    );
  if (!wo) return false;

  return (wo.photoUrls ?? []).includes(objectPath);
};

const buildEstimateView = async (
  estimateId: number,
  snapshotPhotoUrls: string[],
): Promise<PortalView | null> => {
  const [row] = await db
    .select({
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
    })
    .from(estimatesTable)
    .leftJoin(customersTable, eq(estimatesTable.customerId, customersTable.id))
    .leftJoin(vehiclesTable, eq(estimatesTable.vehicleId, vehiclesTable.id))
    .where(eq(estimatesTable.id, estimateId));
  if (!row) return null;
  const items = await db
    .select()
    .from(estimateLineItemsTable)
    .where(eq(estimateLineItemsTable.estimateId, row.id))
    .orderBy(estimateLineItemsTable.id);
  const { subtotal, taxAmount, total } = computeTotals(items, row.taxRate);
  const { laborSubtotal, partsSubtotal, feesSubtotal } = computeCategorySubtotals(items);

  // Defensive read-time check: only serve work-order photos when the linked
  // work order belongs to the same customer and vehicle as this estimate.
  // This guards against pre-existing bad rows that bypassed write-time checks.
  let safeWorkOrderId: number | null = row.workOrderId;
  if (safeWorkOrderId !== null) {
    const [wo] = await db
      .select({ id: workOrdersTable.id })
      .from(workOrdersTable)
      .where(
        and(
          eq(workOrdersTable.id, safeWorkOrderId),
          eq(workOrdersTable.customerId, row.customerId),
          eq(workOrdersTable.vehicleId, row.vehicleId),
        ),
      );
    if (!wo) safeWorkOrderId = null;
  }

  return {
    kind: "estimate",
    id: row.id,
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
    lineItems: items.map(shapeLineItem),
    createdAt: row.createdAt,
    canRespond: ESTIMATE_PENDING.has(row.status),
    approvedAt: row.approvedAt,
    amountPaid: null,
    amountDue: null,
    paidAt: null,
    photos: await buildSnapshotPhotos(safeWorkOrderId, snapshotPhotoUrls),
    priorBilledLabor: [],
  };
};

const buildInvoiceView = async (
  invoiceId: number,
  snapshotPhotoUrls: string[],
): Promise<PortalView | null> => {
  const [row] = await db
    .select({
      id: invoicesTable.id,
      customerId: invoicesTable.customerId,
      vehicleId: invoicesTable.vehicleId,
      workOrderId: invoicesTable.workOrderId,
      status: invoicesTable.status,
      notes: invoicesTable.notes,
      taxRate: invoicesTable.taxRate,
      amountPaid: invoicesTable.amountPaid,
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
    .where(eq(invoicesTable.id, invoiceId));
  if (!row) return null;
  const items = await db
    .select()
    .from(invoiceLineItemsTable)
    .where(eq(invoiceLineItemsTable.invoiceId, row.id))
    .orderBy(invoiceLineItemsTable.id);
  const { subtotal, taxAmount, total } = computeTotals(items, row.taxRate);
  const { laborSubtotal, partsSubtotal, feesSubtotal } = computeCategorySubtotals(items);

  // Defensive read-time check: only serve work-order photos when the linked
  // work order belongs to the same customer and vehicle as this invoice.
  // This guards against pre-existing bad rows that bypassed write-time checks.
  let safeWorkOrderId: number | null = row.workOrderId;
  if (safeWorkOrderId !== null) {
    const [wo] = await db
      .select({ id: workOrdersTable.id })
      .from(workOrdersTable)
      .where(
        and(
          eq(workOrdersTable.id, safeWorkOrderId),
          eq(workOrdersTable.customerId, row.customerId),
          eq(workOrdersTable.vehicleId, row.vehicleId),
        ),
      );
    if (!wo) safeWorkOrderId = null;
  }

  return {
    kind: "invoice",
    id: row.id,
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
    lineItems: items.map(shapeLineItem),
    createdAt: row.createdAt,
    canRespond: false,
    approvedAt: null,
    amountPaid: row.amountPaid,
    amountDue: round2(total - row.amountPaid),
    paidAt: row.paidAt,
    photos: await buildSnapshotPhotos(safeWorkOrderId, snapshotPhotoUrls),
    // Portal tokens are scoped to exactly one invoice. Exposing prior-billed
    // labor would leak other invoices' IDs, formatted numbers, and hours to a
    // recipient who never received those links — a token-scope violation.
    // Internal views (invoice detail route) still call fetchPriorBilledLabor
    // directly; the portal surface always returns an empty array.
    priorBilledLabor: [],
  };
};

export const buildPortalView = async (
  token: PortalToken,
): Promise<PortalView | null> => {
  const snapshot = token.snapshotPhotoUrls ?? [];
  if (token.estimateId !== null) return buildEstimateView(token.estimateId, snapshot);
  if (token.invoiceId !== null) return buildInvoiceView(token.invoiceId, snapshot);
  return null;
};

export type RespondResult =
  | { ok: true; view: PortalView }
  | { ok: false; status: 400 | 404 | 409; error: string };

// Approve/decline the estimate behind a token. Rejects (409) if the estimate is
// no longer pending so a customer cannot flip an already-final decision, and
// rejects (400) if the token belongs to an invoice rather than an estimate.
//
// Uses a compare-and-swap UPDATE (WHERE status IN pending statuses) so that
// concurrent requests with the same token cannot both succeed. The read and
// the write are collapsed into a single conditional UPDATE; if 0 rows are
// affected the status was already final (or the row is missing) and the second
// request receives a 409 instead of silently overwriting the first decision.
export const respondToEstimate = async (
  token: PortalToken,
  decision: "approved" | "declined",
): Promise<RespondResult> => {
  if (token.estimateId === null) {
    return { ok: false, status: 400, error: "This link is not for an estimate." };
  }
  const pendingStatuses = Array.from(ESTIMATE_PENDING) as string[];
  const updated = await db
    .update(estimatesTable)
    .set({
      status: decision,
      ...(decision === "approved" ? { approvedAt: new Date().toISOString() } : {}),
    })
    .where(
      and(
        eq(estimatesTable.id, token.estimateId),
        inArray(estimatesTable.status, pendingStatuses),
      ),
    )
    .returning({ id: estimatesTable.id });
  if (updated.length === 0) {
    // Either the estimate does not exist, or it was already decided (possibly
    // by a concurrent request). Fetch to distinguish 404 from 409.
    const [existing] = await db
      .select({ status: estimatesTable.status })
      .from(estimatesTable)
      .where(eq(estimatesTable.id, token.estimateId));
    if (!existing) return { ok: false, status: 404, error: "Estimate not found." };
    return {
      ok: false,
      status: 409,
      error: `This estimate has already been ${existing.status}.`,
    };
  }
  const view = await buildEstimateView(token.estimateId, token.snapshotPhotoUrls ?? []);
  if (!view) return { ok: false, status: 404, error: "Estimate not found." };
  return { ok: true, view };
};
