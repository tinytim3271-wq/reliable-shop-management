import { eq } from "drizzle-orm";
import {
  db,
  workOrdersTable,
  vehiclesTable,
  inspectionsTable,
  inspectionItemsTable,
} from "@workspace/db";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  isObjectPathReferenced,
} from "./objectStorage";

// Minimal logger shape so this helper can accept either req.log or the
// singleton logger without coupling to pino's full type.
interface CleanupLogger {
  warn: (obj: object, msg: string) => void;
}

/**
 * Best-effort free a set of photo object paths after the rows that owned them
 * have already been deleted (e.g. via an ON DELETE CASCADE).
 *
 * Only objects no longer referenced by ANY remaining work order or inspection
 * item are removed, so a photo that is shared/reused by a record outside the
 * cascade is never deleted. Already-absent objects and transient storage
 * failures never throw — deletion of the owning record has already committed
 * and the background orphan sweep is the backstop.
 */
export async function freeOrphanedPhotos(
  objectPaths: Iterable<string>,
  svc: ObjectStorageService,
  log: CleanupLogger,
): Promise<void> {
  const seen = new Set<string>();
  for (const url of objectPaths) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    try {
      if (await isObjectPathReferenced(url)) continue;
      await svc.deleteObjectEntity(url);
    } catch (e) {
      if (e instanceof ObjectNotFoundError) continue; // already gone — fine
      log.warn({ err: e, objectPath: url }, "photo cleanup failed");
    }
  }
}

/**
 * Photo object paths on the items of a single inspection. Used by
 * DELETE /inspections/:id to free item photos in lockstep with the row
 * deletion. Must be called BEFORE the inspection is deleted, while its items
 * still exist; afterwards pass the result to `freeOrphanedPhotos` so the now
 * unreferenced blobs are removed.
 */
export async function collectInspectionPhotoUrls(
  inspectionId: number,
): Promise<string[]> {
  const rows = await db
    .select({ photoUrls: inspectionItemsTable.photoUrls })
    .from(inspectionItemsTable)
    .where(eq(inspectionItemsTable.inspectionId, inspectionId));
  return rows.flatMap((r) => r.photoUrls ?? []);
}

/**
 * Collect every photo object path owned by rows that will be cascade-deleted
 * when the given vehicle is removed: work orders linked to the vehicle and
 * inspection items belonging to inspections linked to the vehicle. Must be
 * called BEFORE the vehicle is deleted, while the cascaded rows still exist.
 */
export async function collectVehicleCascadePhotoPaths(
  vehicleId: number,
): Promise<string[]> {
  const paths: string[] = [];

  const woRows = await db
    .select({ photoUrls: workOrdersTable.photoUrls })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.vehicleId, vehicleId));
  for (const row of woRows) paths.push(...(row.photoUrls ?? []));

  const iiRows = await db
    .select({ photoUrls: inspectionItemsTable.photoUrls })
    .from(inspectionItemsTable)
    .innerJoin(inspectionsTable, eq(inspectionItemsTable.inspectionId, inspectionsTable.id))
    .where(eq(inspectionsTable.vehicleId, vehicleId));
  for (const row of iiRows) paths.push(...(row.photoUrls ?? []));

  return paths;
}

/**
 * Collect every photo object path owned by rows that will be cascade-deleted
 * when the given customer is removed. Deleting a customer cascades into work
 * orders linked directly to the customer, the customer's vehicles, and through
 * those vehicles into more work orders, inspections, and inspection items.
 * Both the direct (customerId) and via-vehicle (vehicleId) work-order links are
 * gathered so a stray work order whose customerId and vehicleId disagree is
 * still covered. Must be called BEFORE the customer is deleted.
 */
export async function collectCustomerCascadePhotoPaths(
  customerId: number,
): Promise<string[]> {
  const paths: string[] = [];

  // Work orders linked directly to the customer.
  const woDirect = await db
    .select({ photoUrls: workOrdersTable.photoUrls })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.customerId, customerId));
  for (const row of woDirect) paths.push(...(row.photoUrls ?? []));

  // Work orders linked to the customer's vehicles.
  const woViaVehicle = await db
    .select({ photoUrls: workOrdersTable.photoUrls })
    .from(workOrdersTable)
    .innerJoin(vehiclesTable, eq(workOrdersTable.vehicleId, vehiclesTable.id))
    .where(eq(vehiclesTable.customerId, customerId));
  for (const row of woViaVehicle) paths.push(...(row.photoUrls ?? []));

  // Inspection items belonging to inspections on the customer's vehicles.
  const iiRows = await db
    .select({ photoUrls: inspectionItemsTable.photoUrls })
    .from(inspectionItemsTable)
    .innerJoin(inspectionsTable, eq(inspectionItemsTable.inspectionId, inspectionsTable.id))
    .innerJoin(vehiclesTable, eq(inspectionsTable.vehicleId, vehiclesTable.id))
    .where(eq(vehiclesTable.customerId, customerId));
  for (const row of iiRows) paths.push(...(row.photoUrls ?? []));

  return paths;
}
