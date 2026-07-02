import { Router, type IRouter, type Request } from "express";
import { eq, desc, and, type SQL } from "drizzle-orm";
import {
  db,
  inspectionsTable,
  inspectionItemsTable,
  inspectionTemplatesTable,
  inspectionTemplateItemsTable,
  customersTable,
  vehiclesTable,
  mechanicsTable,
} from "@workspace/db";
import {
  ListInspectionsQueryParams,
  ListInspectionsResponse,
  CreateInspectionBody,
  GetInspectionParams,
  GetInspectionResponse,
  UpdateInspectionParams,
  UpdateInspectionBody,
  UpdateInspectionResponse,
  DeleteInspectionParams,
  AddInspectionItemParams,
  AddInspectionItemBody,
  UpdateInspectionItemParams,
  UpdateInspectionItemBody,
  DeleteInspectionItemParams,
} from "@workspace/api-zod";
import { vehicleLabel } from "../lib/billing";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  ObjectAclRebindingError,
  MAX_OBJECT_UPLOAD_SIZE_BYTES,
  verifyObjectUploadOwnership,
  markUploadLinked,
} from "../lib/objectStorage";
import {
  collectInspectionPhotoUrls,
  freeOrphanedPhotos,
} from "../lib/photoCleanup";
import { hasPermission } from "../lib/auth";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * Validate that every /objects/* URL in the list does not exceed the upload
 * size cap. Called before persisting photoUrls so a client that lied about
 * the declared size at mint time cannot bypass the limit by linking the
 * oversized object to a record.
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
 * injection: a user cannot insert a foreign objectPath into a record they
 * control to bypass the read-path authorization check. Admins bypass this.
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
    // multi-module user from re-attaching an inspections photo to a work order
    // or expense record to widen who can read it.
    try {
      await objectStorageService.trySetObjectEntityAclPolicy(url, {
        owner: String(userId),
        visibility: "private",
        sourceModule: "inspections",
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
    // the DB write commits so that a failed write does not strand the object
    // outside the fast 2-hour orphan sweep.
    newlyLinked.push(url);
  }
  return { error: null, newlyLinked };
}

const inspColumns = {
  id: inspectionsTable.id,
  vehicleId: inspectionsTable.vehicleId,
  customerId: inspectionsTable.customerId,
  workOrderId: inspectionsTable.workOrderId,
  templateId: inspectionsTable.templateId,
  inspectorId: inspectionsTable.inspectorId,
  title: inspectionsTable.title,
  status: inspectionsTable.status,
  notes: inspectionsTable.notes,
  createdAt: inspectionsTable.createdAt,
  completedAt: inspectionsTable.completedAt,
  customerName: customersTable.name,
  vYear: vehiclesTable.year,
  vMake: vehiclesTable.make,
  vModel: vehiclesTable.model,
  inspectorName: mechanicsTable.name,
};

type InspRow = {
  id: number;
  vehicleId: number;
  customerId: number | null;
  workOrderId: number | null;
  templateId: number | null;
  inspectorId: number | null;
  title: string;
  status: string;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
  customerName: string | null;
  vYear: number | null;
  vMake: string | null;
  vModel: string | null;
  inspectorName: string | null;
};

const selectInspections = () =>
  db
    .select(inspColumns)
    .from(inspectionsTable)
    .leftJoin(customersTable, eq(inspectionsTable.customerId, customersTable.id))
    .leftJoin(vehiclesTable, eq(inspectionsTable.vehicleId, vehiclesTable.id))
    .leftJoin(mechanicsTable, eq(inspectionsTable.inspectorId, mechanicsTable.id));

const fetchItems = (inspectionId: number) =>
  db
    .select()
    .from(inspectionItemsTable)
    .where(eq(inspectionItemsTable.inspectionId, inspectionId))
    .orderBy(inspectionItemsTable.sortOrder, inspectionItemsTable.id);

type StoredItem = typeof inspectionItemsTable.$inferSelect;

const shapeItem = (it: StoredItem) => ({
  id: it.id,
  category: it.category,
  name: it.name,
  condition: it.condition,
  notes: it.notes,
  photoUrls: it.photoUrls,
  sortOrder: it.sortOrder,
});

const shapeInspection = (row: InspRow, items: StoredItem[]) => ({
  id: row.id,
  vehicleId: row.vehicleId,
  customerId: row.customerId,
  workOrderId: row.workOrderId,
  templateId: row.templateId,
  inspectorId: row.inspectorId,
  title: row.title,
  status: row.status,
  notes: row.notes,
  customerName: row.customerName,
  vehicleLabel: vehicleLabel({ year: row.vYear, make: row.vMake, model: row.vModel }),
  inspectorName: row.inspectorName,
  itemCount: items.length,
  passCount: items.filter((i) => i.condition === "pass").length,
  attentionCount: items.filter((i) => i.condition === "attention").length,
  failCount: items.filter((i) => i.condition === "fail").length,
  createdAt: row.createdAt,
  completedAt: row.completedAt,
});

const detail = (row: InspRow, items: StoredItem[]) => ({
  ...shapeInspection(row, items),
  items: items.map(shapeItem),
});

// Strip cross-module fields the caller is not permitted to read:
//   customerName / vehicleLabel → customers module
//   inspectorName               → payroll module (mechanics)
const redactInspection = <
  T extends {
    customerName: string | null;
    vehicleLabel: string | null;
    inspectorName: string | null;
  },
>(
  shaped: T,
  req: Request,
): T => ({
  ...shaped,
  customerName: hasPermission(req, "customers") ? shaped.customerName : null,
  vehicleLabel: hasPermission(req, "customers") ? shaped.vehicleLabel : null,
  inspectorName: hasPermission(req, "payroll") ? shaped.inspectorName : null,
});

router.get("/inspections", async (req, res): Promise<void> => {
  const query = ListInspectionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const filters: SQL[] = [];
  if (query.data.vehicleId) filters.push(eq(inspectionsTable.vehicleId, query.data.vehicleId));
  if (query.data.customerId) filters.push(eq(inspectionsTable.customerId, query.data.customerId));
  if (query.data.workOrderId)
    filters.push(eq(inspectionsTable.workOrderId, query.data.workOrderId));
  if (query.data.status) filters.push(eq(inspectionsTable.status, query.data.status));

  const base = selectInspections();
  const rows = filters.length
    ? await base.where(and(...filters)).orderBy(desc(inspectionsTable.id))
    : await base.orderBy(desc(inspectionsTable.id));

  const allItems = await db.select().from(inspectionItemsTable);
  const shaped = rows.map((row) =>
    redactInspection(
      shapeInspection(
        row,
        allItems.filter((it) => it.inspectionId === row.id),
      ),
      req,
    ),
  );

  res.json(ListInspectionsResponse.parse(shaped));
});

router.post("/inspections", async (req, res): Promise<void> => {
  const parsed = CreateInspectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Cross-module permission guards.
  if (parsed.data.vehicleId != null && !hasPermission(req, "customers")) {
    res.status(403).json({ error: "You do not have permission to link to a vehicle record" });
    return;
  }
  if (parsed.data.customerId != null && !hasPermission(req, "customers")) {
    res.status(403).json({ error: "You do not have permission to link to a customer record" });
    return;
  }
  if (parsed.data.inspectorId != null && !hasPermission(req, "payroll")) {
    res.status(403).json({ error: "You do not have permission to assign an inspector" });
    return;
  }

  let title = parsed.data.title ?? null;
  const templateId = parsed.data.templateId ?? null;
  let templateItems: { category: string | null; name: string; sortOrder: number }[] = [];

  if (templateId) {
    // Applying a template copies settings-module data (template name and items)
    // into the inspection. Require settings permission to do so.
    if (!hasPermission(req, "settings")) {
      res.status(403).json({ error: "You do not have permission to apply inspection templates" });
      return;
    }
    const [template] = await db
      .select()
      .from(inspectionTemplatesTable)
      .where(eq(inspectionTemplatesTable.id, templateId));
    if (!template) {
      res.status(400).json({ error: "Template not found" });
      return;
    }
    if (!title) title = template.name;
    templateItems = await db
      .select({
        category: inspectionTemplateItemsTable.category,
        name: inspectionTemplateItemsTable.name,
        sortOrder: inspectionTemplateItemsTable.sortOrder,
      })
      .from(inspectionTemplateItemsTable)
      .where(eq(inspectionTemplateItemsTable.templateId, templateId))
      .orderBy(inspectionTemplateItemsTable.sortOrder, inspectionTemplateItemsTable.id);
  }

  const [created] = await db
    .insert(inspectionsTable)
    .values({
      vehicleId: parsed.data.vehicleId,
      customerId: parsed.data.customerId ?? null,
      workOrderId: parsed.data.workOrderId ?? null,
      templateId,
      inspectorId: parsed.data.inspectorId ?? null,
      title: title ?? "Vehicle Inspection",
      notes: parsed.data.notes ?? null,
      status: "in_progress",
    })
    .returning();

  if (templateItems.length) {
    await db.insert(inspectionItemsTable).values(
      templateItems.map((ti) => ({
        inspectionId: created.id,
        category: ti.category,
        name: ti.name,
        condition: "pass",
        sortOrder: ti.sortOrder,
      })),
    );
  }

  const [row] = await selectInspections().where(eq(inspectionsTable.id, created.id));
  const items = await fetchItems(created.id);
  res.status(201).json(UpdateInspectionResponse.parse(redactInspection(detail(row, items), req)));
});

router.get("/inspections/:id", async (req, res): Promise<void> => {
  const params = GetInspectionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await selectInspections().where(eq(inspectionsTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Inspection not found" });
    return;
  }

  const items = await fetchItems(row.id);
  res.json(GetInspectionResponse.parse(redactInspection(detail(row, items), req)));
});

router.patch("/inspections/:id", async (req, res): Promise<void> => {
  const params = UpdateInspectionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateInspectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(inspectionsTable)
    .where(eq(inspectionsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Inspection not found" });
    return;
  }

  if (parsed.data.inspectorId != null && !hasPermission(req, "payroll")) {
    res.status(403).json({ error: "You do not have permission to assign an inspector" });
    return;
  }

  const updates: Partial<typeof inspectionsTable.$inferInsert> = {};
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;
  if (parsed.data.inspectorId !== undefined) updates.inspectorId = parsed.data.inspectorId;
  if (parsed.data.status !== undefined) {
    updates.status = parsed.data.status;
    if (parsed.data.status === "completed") {
      // Only stamp completedAt on the first in_progress -> completed transition;
      // re-completing an already-completed inspection preserves the original.
      if (existing.status !== "completed") {
        updates.completedAt = new Date().toISOString();
      }
    } else {
      updates.completedAt = null;
    }
  }

  if (Object.keys(updates).length) {
    await db.update(inspectionsTable).set(updates).where(eq(inspectionsTable.id, params.data.id));
  }

  const [row] = await selectInspections().where(eq(inspectionsTable.id, params.data.id));
  const items = await fetchItems(params.data.id);
  res.json(UpdateInspectionResponse.parse(redactInspection(detail(row, items), req)));
});

router.delete("/inspections/:id", async (req, res): Promise<void> => {
  const params = DeleteInspectionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Collect the item photo paths BEFORE the delete cascades the items away —
  // afterwards they cannot be queried, and only an already-deleted row makes
  // isObjectPathReferenced return false so the blobs become freeable.
  const photoUrls = await collectInspectionPhotoUrls(params.data.id);

  const [deleted] = await db
    .delete(inspectionsTable)
    .where(eq(inspectionsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Inspection not found" });
    return;
  }

  // Free the underlying photo objects server-side so deletes that bypass the
  // detail-page client cleanup (bulk/admin/script callers) don't orphan blobs.
  await freeOrphanedPhotos(photoUrls, objectStorageService, req.log);

  res.sendStatus(204);
});

router.post("/inspections/:id/items", async (req, res): Promise<void> => {
  const params = AddInspectionItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = AddInspectionItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [insp] = await db
    .select()
    .from(inspectionsTable)
    .where(eq(inspectionsTable.id, params.data.id));
  if (!insp) {
    res.status(404).json({ error: "Inspection not found" });
    return;
  }

  let postItemNewlyLinked: string[] = [];
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
    postItemNewlyLinked = ownerResult.newlyLinked;
  }

  await db.insert(inspectionItemsTable).values({
    inspectionId: params.data.id,
    category: parsed.data.category ?? null,
    name: parsed.data.name,
    condition: parsed.data.condition ?? "pass",
    notes: parsed.data.notes ?? null,
    photoUrls: parsed.data.photoUrls ?? [],
    sortOrder: parsed.data.sortOrder ?? 0,
  });

  // Revoke provisional-upload tracking only after the DB write committed.
  for (const url of postItemNewlyLinked) markUploadLinked(url);

  const [row] = await selectInspections().where(eq(inspectionsTable.id, params.data.id));
  const items = await fetchItems(params.data.id);
  res.status(201).json(UpdateInspectionResponse.parse(redactInspection(detail(row, items), req)));
});

router.patch("/inspections/:id/items/:itemId", async (req, res): Promise<void> => {
  const params = UpdateInspectionItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateInspectionItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [item] = await db
    .select()
    .from(inspectionItemsTable)
    .where(
      and(
        eq(inspectionItemsTable.id, params.data.itemId),
        eq(inspectionItemsTable.inspectionId, params.data.id),
      ),
    );
  if (!item) {
    res.status(404).json({ error: "Inspection item not found" });
    return;
  }

  let patchItemNewlyLinked: string[] = [];
  if (parsed.data.photoUrls?.length) {
    const sizeError = await validatePhotoUrlSizes(parsed.data.photoUrls);
    if (sizeError) {
      res.status(400).json({ error: sizeError });
      return;
    }
    // item.photoUrls holds the current URLs already linked to this item —
    // only new additions need upload-ownership verification.
    const ownerResult = await verifyPhotoUrlOwnership(
      parsed.data.photoUrls,
      item.photoUrls ?? [],
      req.currentUser!.id,
      req.currentUser!.role,
    );
    if (ownerResult.error) {
      res.status(403).json({ error: ownerResult.error });
      return;
    }
    patchItemNewlyLinked = ownerResult.newlyLinked;
  }

  const updates: Partial<typeof inspectionItemsTable.$inferInsert> = {};
  if (parsed.data.condition !== undefined) updates.condition = parsed.data.condition;
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;
  if (parsed.data.photoUrls !== undefined) updates.photoUrls = parsed.data.photoUrls;

  if (Object.keys(updates).length) {
    await db
      .update(inspectionItemsTable)
      .set(updates)
      .where(eq(inspectionItemsTable.id, params.data.itemId));
  }

  // Revoke provisional-upload tracking only after the DB write committed.
  for (const url of patchItemNewlyLinked) markUploadLinked(url);

  const [row] = await selectInspections().where(eq(inspectionsTable.id, params.data.id));
  const items = await fetchItems(params.data.id);
  res.json(UpdateInspectionResponse.parse(redactInspection(detail(row, items), req)));
});

router.delete("/inspections/:id/items/:itemId", async (req, res): Promise<void> => {
  const params = DeleteInspectionItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(inspectionItemsTable)
    .where(
      and(
        eq(inspectionItemsTable.id, params.data.itemId),
        eq(inspectionItemsTable.inspectionId, params.data.id),
      ),
    )
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Inspection item not found" });
    return;
  }

  // Free the deleted item's photo blobs server-side (best-effort) so removing a
  // single item reclaims storage immediately rather than waiting for the 24h
  // orphan sweep. Paths still referenced by any surviving record are kept.
  await freeOrphanedPhotos(deleted.photoUrls ?? [], objectStorageService, req.log);

  res.sendStatus(204);
});

export default router;
