import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import type { GlobalSetupContext } from "vitest/node";

const { Pool } = pg;

// Point a base Postgres connection string at a different database name.
function withDatabaseName(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

// Creates a disposable Postgres TEMPLATE database for this test run and pushes
// the Drizzle schema into it once. Each vitest worker then cheaply clones this
// template into its own per-worker database (see test/setup.ts) via
// `CREATE DATABASE ... TEMPLATE`, which is a fast filesystem copy and avoids
// re-running the (slow) drizzle push per worker. Giving every worker its own
// database lets files run in parallel without clobbering each other's rows.
//
// We hand the admin connection string, the template name, and a per-run prefix
// to the workers via `provide`. On teardown we drop the template and every
// per-worker database created from it (all share the run prefix). This keeps the
// suite isolated from the shared dev database.
export default async function setup({ provide }: GlobalSetupContext) {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "DATABASE_URL must be set to create an ephemeral test database",
    );
  }

  // Shared prefix for every database created by this run. Teardown drops all
  // databases that start with it, so a crashed worker can't leak a database.
  const runPrefix = `apitest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const templateDb = `${runPrefix}_tmpl`;

  const admin = new Pool({ connectionString: adminUrl });
  try {
    await admin.query(`CREATE DATABASE "${templateDb}"`);
  } finally {
    await admin.end();
  }

  const templateUrl = withDatabaseName(adminUrl, templateDb);

  // Push the schema into the fresh template database non-interactively.
  // `push-force` applies the Drizzle schema without prompting.
  const repoRoot = path.resolve(__dirname, "../../..");
  try {
    execFileSync("pnpm", ["--filter", "@workspace/db", "run", "push-force"], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: templateUrl },
      stdio: "pipe",
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    const out = e.stdout?.toString() ?? "";
    const errOut = e.stderr?.toString() ?? "";
    // Best-effort cleanup of the half-created template before re-throwing.
    const cleanup = new Pool({ connectionString: adminUrl });
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${templateDb}"`);
    } finally {
      await cleanup.end();
    }
    throw new Error(
      `failed to push schema into test database:\n${out}\n${errOut}`,
    );
  }

  provide("testAdminUrl", adminUrl);
  provide("testTemplateDb", templateDb);
  provide("testRunPrefix", runPrefix);

  return async () => {
    const cleanup = new Pool({ connectionString: adminUrl });
    try {
      // Find every database created by this run (template + per-worker clones).
      const result = await cleanup.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname LIKE $1`,
        [`${runPrefix}%`],
      );
      for (const { datname } of result.rows) {
        // Drop any lingering connections so DROP DATABASE is not blocked.
        await cleanup.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [datname],
        );
        await cleanup.query(`DROP DATABASE IF EXISTS "${datname}"`);
      }
    } finally {
      await cleanup.end();
    }
  };
}

declare module "vitest" {
  interface ProvidedContext {
    testAdminUrl: string;
    testTemplateDb: string;
    testRunPrefix: string;
  }
}
