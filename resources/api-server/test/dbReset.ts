import { sql } from "drizzle-orm";

// Cached list of user tables to truncate, discovered once from the live schema
// so this stays correct as tables are added/removed without hand-maintaining a
// list.
let cachedTables: string[] | null = null;

async function discoverTables(): Promise<string[]> {
  if (cachedTables) return cachedTables;
  const { db } = await import("@workspace/db");
  const result = await db.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const rows = (result as unknown as { rows: { tablename: string }[] }).rows;
  cachedTables = rows
    .map((r) => r.tablename)
    .filter((name) => !name.startsWith("__drizzle"));
  return cachedTables;
}

// Wipes every row from every user table in the test database and restarts the
// identity sequences, giving the caller a pristine, empty schema.
//
// The whole in-process suite shares ONE database for the run (see
// globalSetup.ts). Without this, each file accumulates the rows seeded by every
// file that ran before it, so a generic "Brake Pad" part seeded in one file
// could silently change a price another file asserts on. Running this before
// each file (see setup.ts) gives real per-file isolation, so a test that passes
// alone passes in the full run regardless of file execution order.
export async function resetDatabase(): Promise<void> {
  const tables = await discoverTables();
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t}"`).join(", ");
  const { db } = await import("@workspace/db");
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`),
  );
}
