import { db, expenseCategoriesTable } from "@workspace/db";
import { ilike } from "drizzle-orm";

// The category every uncategorized imported expense falls back to.
export const UNCATEGORIZED_CATEGORY = "Uncategorized";

// Resolve a free-text category name to an expense-category id, creating the
// category when no case-insensitive match exists. A blank/empty name resolves
// to the shared "Uncategorized" bucket. Returns the resolved id and whether a
// new category row was created (so import flows can report how many categories
// they minted). Shared by every import path so the resolve-or-create rule lives
// in exactly one place.
export const resolveExpenseCategoryId = async (
  name: string | null | undefined,
): Promise<{ id: number; created: boolean }> => {
  const clean = (name ?? "").trim() || UNCATEGORIZED_CATEGORY;

  // ilike with no wildcards is a case-insensitive exact match, so "Office",
  // "office", and "OFFICE" all resolve to the same existing category.
  const [existing] = await db
    .select({ id: expenseCategoriesTable.id })
    .from(expenseCategoriesTable)
    .where(ilike(expenseCategoriesTable.name, clean))
    .limit(1);
  if (existing) return { id: existing.id, created: false };

  const [created] = await db
    .insert(expenseCategoriesTable)
    .values({ name: clean })
    .returning({ id: expenseCategoriesTable.id });
  return { id: created.id, created: true };
};
