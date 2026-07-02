import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, expensesTable, expenseCategoriesTable } from "@workspace/db";
import {
  ListExpenseCategoriesResponse,
  CreateExpenseCategoryBody,
  UpdateExpenseCategoryParams,
  UpdateExpenseCategoryBody,
  UpdateExpenseCategoryResponse,
  DeleteExpenseCategoryParams,
  ListExpensesQueryParams,
  ListExpensesResponse,
  CreateExpenseBody,
  UpdateExpenseParams,
  UpdateExpenseBody,
  UpdateExpenseResponse,
  DeleteExpenseParams,
} from "@workspace/api-zod";
import { inRange } from "../lib/accounting";
import { missingRef } from "../lib/refs";
import { enqueueExpenseSync } from "../lib/qboSync";
import { ObjectStorageService, ObjectAclRebindingError, verifyObjectUploadOwnership, markUploadLinked } from "../lib/objectStorage";
import { freeOrphanedPhotos } from "../lib/photoCleanup";

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

/**
 * Returns a tuple of [error, urlsToMark]. On success, error is null and
 * urlsToMark lists the URLs that need markUploadLinked() called after the
 * surrounding DB write commits. markUploadLinked() is intentionally NOT called
 * here — calling it before the DB write succeeds would remove the object from
 * the provisional-orphan registry prematurely, leaving it unreferenced in
 * storage but bypassing the 2-hour sweep until the 24-hour reconciliation.
 */
async function verifyReceiptUrlOwnership(
  newUrls: string[],
  currentUrls: string[],
  userId: number,
  role: string,
): Promise<{ error: string; newlyLinked: string[] } | { error: null; newlyLinked: string[] }> {
  const existingSet = new Set(currentUrls);
  const newlyLinked: string[] = [];
  for (const url of newUrls) {
    if (existingSet.has(url)) continue;
    if (role !== "admin") {
      const owned = await verifyObjectUploadOwnership(url, userId, objectStorageService);
      if (!owned) return { error: "You can only attach files you uploaded", newlyLinked: [] };
    }
    // Stamp the module binding — immutable after first write. Prevents a
    // multi-module user from re-attaching an accounting receipt to a work order
    // or inspection record to widen who can read it.
    try {
      await objectStorageService.trySetObjectEntityAclPolicy(url, {
        owner: String(userId),
        visibility: "private",
        sourceModule: "accounting",
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

type ExpenseRow = typeof expensesTable.$inferSelect;

const shapeExpense = (e: ExpenseRow, categoryName: string | null) => ({
  id: e.id,
  date: e.date,
  categoryId: e.categoryId,
  categoryName,
  vendor: e.vendor,
  description: e.description,
  amount: e.amount,
  taxAmount: e.taxAmount,
  paymentMethod: e.paymentMethod,
  notes: e.notes,
  receiptUrls: e.receiptUrls,
  createdAt: e.createdAt,
});

const categoryNameFor = async (categoryId: number | null): Promise<string | null> => {
  if (categoryId === null || categoryId === undefined) return null;
  const [cat] = await db
    .select()
    .from(expenseCategoriesTable)
    .where(eq(expenseCategoriesTable.id, categoryId));
  return cat?.name ?? null;
};

// ----- Expense categories -----

router.get("/expense-categories", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(expenseCategoriesTable)
    .orderBy(expenseCategoriesTable.name);
  res.json(ListExpenseCategoriesResponse.parse(rows));
});

router.post("/expense-categories", async (req, res): Promise<void> => {
  const parsed = CreateExpenseCategoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [created] = await db
    .insert(expenseCategoriesTable)
    .values({ name: parsed.data.name, taxDeductible: parsed.data.taxDeductible ?? true })
    .returning();

  res.status(201).json(UpdateExpenseCategoryResponse.parse(created));
});

router.patch("/expense-categories/:id", async (req, res): Promise<void> => {
  const params = UpdateExpenseCategoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateExpenseCategoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(expenseCategoriesTable)
    .set(parsed.data)
    .where(eq(expenseCategoriesTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  res.json(UpdateExpenseCategoryResponse.parse(updated));
});

router.delete("/expense-categories/:id", async (req, res): Promise<void> => {
  const params = DeleteExpenseCategoryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(expenseCategoriesTable)
    .where(eq(expenseCategoriesTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  res.sendStatus(204);
});

// ----- Expenses -----

router.get("/expenses", async (req, res): Promise<void> => {
  const query = ListExpensesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { startDate, endDate, categoryId } = query.data;
  const rows = await db.select().from(expensesTable).orderBy(desc(expensesTable.date), desc(expensesTable.id));
  const categories = await db.select().from(expenseCategoriesTable);
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const filtered = rows.filter((e) => {
    if (!inRange(e.date, startDate, endDate)) return false;
    if (categoryId !== undefined && e.categoryId !== categoryId) return false;
    return true;
  });

  res.json(ListExpensesResponse.parse(filtered.map((e) => shapeExpense(e, nameById.get(e.categoryId ?? -1) ?? null))));
});

router.post("/expenses", async (req, res): Promise<void> => {
  const parsed = CreateExpenseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const refError = await missingRef(
    expenseCategoriesTable,
    parsed.data.categoryId,
    "Expense category",
  );
  if (refError) {
    res.status(400).json({ error: refError });
    return;
  }

  const user = req.currentUser!;
  const postReceiptOwnerResult = await verifyReceiptUrlOwnership(
    parsed.data.receiptUrls ?? [],
    [],
    user.id,
    user.role,
  );
  if (postReceiptOwnerResult.error) {
    res.status(403).json({ error: postReceiptOwnerResult.error });
    return;
  }

  const [created] = await db
    .insert(expensesTable)
    .values({
      date: parsed.data.date,
      categoryId: parsed.data.categoryId ?? null,
      vendor: parsed.data.vendor ?? null,
      description: parsed.data.description,
      amount: parsed.data.amount,
      taxAmount: parsed.data.taxAmount ?? 0,
      paymentMethod: parsed.data.paymentMethod ?? null,
      notes: parsed.data.notes ?? null,
      receiptUrls: parsed.data.receiptUrls ?? [],
    })
    .returning();

  // Revoke provisional-upload tracking only after the DB write committed.
  for (const url of postReceiptOwnerResult.newlyLinked) markUploadLinked(url);

  // Mirror the expense into QuickBooks Online (no-op unless QBO is connected).
  enqueueExpenseSync(created.id);

  const name = await categoryNameFor(created.categoryId);
  res.status(201).json(UpdateExpenseResponse.parse(shapeExpense(created, name)));
});

router.patch("/expenses/:id", async (req, res): Promise<void> => {
  const params = UpdateExpenseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateExpenseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const refError = await missingRef(
    expenseCategoriesTable,
    parsed.data.categoryId,
    "Expense category",
  );
  if (refError) {
    res.status(400).json({ error: refError });
    return;
  }

  const [existing] = await db
    .select({ receiptUrls: expensesTable.receiptUrls })
    .from(expensesTable)
    .where(eq(expensesTable.id, params.data.id))
    .limit(1);

  if (!existing) {
    res.status(404).json({ error: "Expense not found" });
    return;
  }

  const patchUser = req.currentUser!;
  const patchReceiptOwnerResult = await verifyReceiptUrlOwnership(
    parsed.data.receiptUrls ?? existing.receiptUrls ?? [],
    existing.receiptUrls ?? [],
    patchUser.id,
    patchUser.role,
  );
  if (patchReceiptOwnerResult.error) {
    res.status(403).json({ error: patchReceiptOwnerResult.error });
    return;
  }

  const [updated] = await db
    .update(expensesTable)
    .set(parsed.data)
    .where(eq(expensesTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Expense not found" });
    return;
  }

  // Revoke provisional-upload tracking only after the DB write committed.
  for (const url of patchReceiptOwnerResult.newlyLinked) markUploadLinked(url);

  // Mirror the edited expense into QuickBooks Online (updates the existing
  // Purchase via its retained QBO id; no-op unless QBO is connected).
  enqueueExpenseSync(updated.id);

  const name = await categoryNameFor(updated.categoryId);
  res.json(UpdateExpenseResponse.parse(shapeExpense(updated, name)));
});

router.delete("/expenses/:id", async (req, res): Promise<void> => {
  const params = DeleteExpenseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(expensesTable)
    .where(eq(expensesTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Expense not found" });
    return;
  }

  // Best-effort: free each receipt photo this expense owned, but only objects no
  // longer referenced by any other record (a path another surviving record still
  // points at is kept). The row is already gone, so storage failures are
  // swallowed — the background orphan sweep is the backstop.
  await freeOrphanedPhotos(deleted.receiptUrls ?? [], objectStorageService, req.log);

  res.sendStatus(204);
});

export default router;
