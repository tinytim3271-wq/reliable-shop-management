import { inject, vi, beforeEach, beforeAll } from "vitest";
import pg from "pg";

const { Pool } = pg;

// Point a base Postgres connection string at a different database name.
function withDatabaseName(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-worker disposable database
//
// globalSetup.ts creates ONE template database with the schema already pushed.
// Each vitest worker clones that template into its own database the first time a
// test file runs in the worker process, so files in different workers run fully
// in parallel without clobbering each other's rows. Cloning a template is a fast
// filesystem copy, far cheaper than re-running the drizzle push per worker.
//
// This must happen before any import of @workspace/db, which reads DATABASE_URL
// once at module load to build its connection pool. setupFiles run to completion
// before a test file (and its imports) are evaluated, so the top-level await here
// is early enough. With file isolation on, the db module is re-imported for each
// file, so we re-apply DATABASE_URL every time but only create the database once
// per worker (guarded on globalThis, which persists across files in a worker).
// ─────────────────────────────────────────────────────────────────────────────
const adminUrl = inject("testAdminUrl");
const templateDb = inject("testTemplateDb");
const runPrefix = inject("testRunPrefix");

const WORKER_DB_KEY = "__apiServerWorkerDbUrl";
type WorkerGlobal = typeof globalThis & { [WORKER_DB_KEY]?: string };

async function ensureWorkerDatabase(): Promise<string | undefined> {
  if (!adminUrl || !templateDb || !runPrefix) return undefined;

  const g = globalThis as WorkerGlobal;
  if (g[WORKER_DB_KEY]) return g[WORKER_DB_KEY];

  // Vitest assigns each worker a stable pool id within the run; use it to name a
  // per-worker database. Falls back to "1" for the single-worker case.
  const workerId = process.env.VITEST_POOL_ID ?? "1";
  const workerDb = `${runPrefix}_w${workerId}`;

  const admin = new Pool({ connectionString: adminUrl });
  try {
    // Recreate from the template so a recycled worker id starts clean. Cloning
    // requires no other sessions on the template; concurrent workers can briefly
    // contend, so retry on the transient "being accessed by other users" error.
    await admin.query(`DROP DATABASE IF EXISTS "${workerDb}"`);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await admin.query(
          `CREATE DATABASE "${workerDb}" TEMPLATE "${templateDb}"`,
        );
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        const code = (err as { code?: string }).code;
        // 55006 = object_in_use (template busy); 23505 = duplicate (race).
        if (code !== "55006" && code !== "23505") throw err;
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      }
    }
    if (lastErr) throw lastErr;
  } finally {
    await admin.end();
  }

  const workerUrl = withDatabaseName(adminUrl, workerDb);
  g[WORKER_DB_KEY] = workerUrl;
  return workerUrl;
}

const workerDatabaseUrl = await ensureWorkerDatabase();
if (workerDatabaseUrl) {
  process.env.DATABASE_URL = workerDatabaseUrl;
}

// Test-environment defaults applied before the Express app (app.ts) is imported.
// app.ts throws at import time without SESSION_SECRET, so it must be set here.
process.env.NODE_ENV = "test";

// Make license enforcement a no-op for the in-process suite regardless of
// whether the shared dev database happens to have a provisioned license row.
process.env.LICENSE_ENFORCEMENT = "off";

if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = "integration-test-session-secret";
}

// Quiet the request logger so test output stays readable.
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = "silent";
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-file database isolation
//
// The whole run shares ONE disposable database (see globalSetup.ts). setupFiles
// re-run for every test file, so this beforeAll truncates all tables once before
// each file's tests start, wiping any rows seeded by files that ran earlier in
// the run. That gives real per-file isolation: a test that passes in isolation
// passes in the full run regardless of file execution order. It runs before any
// per-file beforeAll seeding hook because setup.ts hooks are registered first.
// ─────────────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  const { resetDatabase } = await import("./dbReset");
  await resetDatabase();
});

// ─────────────────────────────────────────────────────────────────────────────
// Global object-storage ACL mock
//
// trySetObjectEntityAclPolicy calls GCS metadata APIs that are unavailable in
// the test environment. Route handlers now fail-closed on any error from this
// method, so without a mock every test that attaches a photo/receipt to a
// record would receive a 403. This beforeEach installs a no-op success mock as
// the default for all tests. Security tests that need to exercise the failure
// paths (rebinding / GCS unavailable) override this spy with their own mock
// and call vi.restoreAllMocks() in their afterEach to return to the default.
// ─────────────────────────────────────────────────────────────────────────────
beforeEach(async () => {
  const { ObjectStorageService } = await import("../src/lib/objectStorage");
  vi.spyOn(ObjectStorageService.prototype, "trySetObjectEntityAclPolicy")
    .mockImplementation(async (rawPath: string) => rawPath);
});
