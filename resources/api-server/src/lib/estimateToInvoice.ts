import { eq } from "drizzle-orm";
import {
  db,
  estimatesTable,
  estimateLineItemsTable,
  invoicesTable,
  invoiceLineItemsTable,
} from "@workspace/db";
import { loadCatalog, matchCatalogPart } from "./billing";

export type ConvertEstimateToInvoiceResult =
  | { ok: false; status: number; error: string }
  | { ok: true; invoiceId: number };

// Create a draft invoice from an estimate by copying its header fields (customer,
// vehicle, work order, notes, tax rate) and line items verbatim. Shared by the
// REST route and the AI agent tool so totals/tax stay consistent across both.
// Callers are responsible for permission checks before invoking this.
export async function convertEstimateToInvoice(
  estimateId: number,
): Promise<ConvertEstimateToInvoiceResult> {
  const [estimate] = await db
    .select()
    .from(estimatesTable)
    .where(eq(estimatesTable.id, estimateId));
  if (!estimate) {
    return { ok: false, status: 404, error: "Estimate not found" };
  }

  const [existingInvoice] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.estimateId, estimate.id))
    .limit(1);
  if (existingInvoice) {
    return {
      ok: false,
      status: 409,
      error: "This estimate has already been converted to an invoice",
    };
  }

  const estItems = await db
    .select()
    .from(estimateLineItemsTable)
    .where(eq(estimateLineItemsTable.estimateId, estimateId))
    .orderBy(estimateLineItemsTable.id);
  if (estItems.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Cannot convert an estimate with no line items to an invoice",
    };
  }

  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      customerId: estimate.customerId,
      vehicleId: estimate.vehicleId,
      workOrderId: estimate.workOrderId,
      estimateId: estimate.id,
      notes: estimate.notes,
      taxRate: estimate.taxRate,
      status: "draft",
    })
    .returning();

  const catalog = estItems.some((li) => li.type === "part") ? await loadCatalog() : [];
  await db.insert(invoiceLineItemsTable).values(
    estItems.map((li) => ({
      invoiceId: invoice.id,
      type: li.type,
      description: li.description,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      catalogPartId:
        li.type === "part" ? (matchCatalogPart(li.description, catalog)?.id ?? null) : null,
    })),
  );

  return { ok: true, invoiceId: invoice.id };
}
