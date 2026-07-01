import { eq } from "drizzle-orm";
import {
  db,
  workOrdersTable,
  estimatesTable,
  invoicesTable,
  inspectionsTable,
  vehiclesTable,
} from "@workspace/db";

// Referential delete guards shared by the REST delete routes and the AI delete
// tools so both enforce the exact same rules and return the same messages.
// Each returns a human-readable reason the record cannot be deleted, or null
// when deletion is safe.

export async function customerDeleteBlocker(id: number): Promise<string | null> {
  const [wo] = await db
    .select({ id: workOrdersTable.id })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.customerId, id))
    .limit(1);
  if (wo) {
    return "Cannot delete customer: existing work orders are linked to this customer. Remove them first.";
  }

  const [est] = await db
    .select({ id: estimatesTable.id })
    .from(estimatesTable)
    .where(eq(estimatesTable.customerId, id))
    .limit(1);
  if (est) {
    return "Cannot delete customer: existing estimates are linked to this customer. Remove them first.";
  }

  const [inv] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.customerId, id))
    .limit(1);
  if (inv) {
    return "Cannot delete customer: existing invoices are linked to this customer. Remove them first.";
  }

  // Deleting a customer cascades into their vehicles, which in turn cascade
  // into inspections. Block the delete if any of those vehicles have linked
  // inspections so a customer-only user cannot destroy inspection records they
  // are not permitted to access.
  const [insp] = await db
    .select({ id: inspectionsTable.id })
    .from(inspectionsTable)
    .innerJoin(vehiclesTable, eq(inspectionsTable.vehicleId, vehiclesTable.id))
    .where(eq(vehiclesTable.customerId, id))
    .limit(1);
  if (insp) {
    return "Cannot delete customer: existing inspections are linked to this customer's vehicles. Remove them first.";
  }

  return null;
}

export async function vehicleDeleteBlocker(id: number): Promise<string | null> {
  const [wo] = await db
    .select({ id: workOrdersTable.id })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.vehicleId, id))
    .limit(1);
  if (wo) {
    return "Cannot delete vehicle: existing work orders are linked to this vehicle. Remove them first.";
  }

  const [est] = await db
    .select({ id: estimatesTable.id })
    .from(estimatesTable)
    .where(eq(estimatesTable.vehicleId, id))
    .limit(1);
  if (est) {
    return "Cannot delete vehicle: existing estimates are linked to this vehicle. Remove them first.";
  }

  const [inv] = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.vehicleId, id))
    .limit(1);
  if (inv) {
    return "Cannot delete vehicle: existing invoices are linked to this vehicle. Remove them first.";
  }

  // Inspections cascade-delete when their vehicle is deleted. Block the delete
  // if any inspections are linked to this vehicle so a customer-module user
  // cannot destroy inspection records they are not permitted to access.
  const [insp] = await db
    .select({ id: inspectionsTable.id })
    .from(inspectionsTable)
    .where(eq(inspectionsTable.vehicleId, id))
    .limit(1);
  if (insp) {
    return "Cannot delete vehicle: existing inspections are linked to this vehicle. Remove them first.";
  }

  return null;
}
