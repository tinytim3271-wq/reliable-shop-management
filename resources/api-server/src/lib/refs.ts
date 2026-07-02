import { eq } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "@workspace/db";

// Returns a human-readable "<label> not found" message when a referenced row is
// missing, or null when the id is absent (an optional/nullable FK) or the row
// exists. Lets create/update handlers fail closed with a clean 400 instead of
// letting a bad foreign key surface as a raw database error.
export async function missingRef(
  table: PgTable & { id: PgColumn },
  id: number | null | undefined,
  label: string,
): Promise<string | null> {
  if (id === null || id === undefined) return null;
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
  return row ? null : `${label} not found`;
}
