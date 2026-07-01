import { eq } from "drizzle-orm";
import {
  db,
  estimatesTable,
  estimateLineItemsTable,
  workOrdersTable,
  workOrderLineItemsTable,
} from "@workspace/db";
import { estimateNumber, loadCatalog, matchCatalogPart } from "./billing";

export type ConvertEstimateToWorkOrderResult =
  | { ok: false; status: number; error: string }
  | { ok: true; workOrderId: number };

// Work orders now carry structured line items, so a converted estimate's quoted
// labor/parts are copied verbatim into the work order's tasks & parts (see
// below) rather than being folded into the notes as a text summary. The notes
// retain only a short provenance reference so staff can see where the work order
// came from. Exported so the provenance shape can be unit-asserted and so the
// detail page can detect a converted work order.
export function buildConvertedWorkOrderNotes(estimateId: number): string {
  return `Converted from ${estimateNumber(estimateId)}.`;
}

// Create an open work order from an estimate, copying the linked customer and
// vehicle and seeding the title/description from the estimate, then link the
// estimate back to the new work order. Shared by the REST route and the AI agent
// tool so the customer/vehicle association and details stay consistent across
// both. Callers are responsible for permission checks before invoking this.
export async function convertEstimateToWorkOrder(
  estimateId: number,
): Promise<ConvertEstimateToWorkOrderResult> {
  const [estimate] = await db
    .select()
    .from(estimatesTable)
    .where(eq(estimatesTable.id, estimateId));
  if (!estimate) {
    return { ok: false, status: 404, error: "Estimate not found" };
  }

  if (estimate.workOrderId != null) {
    return {
      ok: false,
      status: 409,
      error: "This estimate is already linked to a work order",
    };
  }

  const lineItems = await db
    .select()
    .from(estimateLineItemsTable)
    .where(eq(estimateLineItemsTable.estimateId, estimate.id))
    .orderBy(estimateLineItemsTable.id);

  const [created] = await db
    .insert(workOrdersTable)
    .values({
      customerId: estimate.customerId,
      vehicleId: estimate.vehicleId,
      title: `From ${estimateNumber(estimate.id)}`,
      description: estimate.notes,
      notes: buildConvertedWorkOrderNotes(estimate.id),
      status: "open",
    })
    .returning();

  // Copy the estimate's quoted labor/parts into the work order's structured
  // tasks & parts so staff can track and bill the actual work from the work
  // order, instead of re-keying a notes-based reference summary. Resolve the
  // catalog part id for each part line at write time so the dedup guard on
  // follow-up invoices can key off a stable id rather than re-matching
  // descriptions against the current catalog state.
  if (lineItems.length) {
    const catalog = lineItems.some((li) => li.type === "part") ? await loadCatalog() : [];
    await db.insert(workOrderLineItemsTable).values(
      lineItems.map((li) => ({
        workOrderId: created.id,
        type: li.type,
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        catalogPartId:
          li.type === "part" ? (matchCatalogPart(li.description, catalog)?.id ?? null) : null,
      })),
    );
  }

  await db
    .update(estimatesTable)
    .set({ workOrderId: created.id })
    .where(eq(estimatesTable.id, estimate.id));

  return { ok: true, workOrderId: created.id };
}
