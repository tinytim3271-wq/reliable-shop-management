import { describe, it, expect, vi } from "vitest";

describe("test environment boot", () => {
  it("environment is Node (no browser globals)", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof process).toBe("object");
    expect(typeof process.env).toBe("object");
  });

  it("NODE_ENV is 'test'", () => {
    expect(process.env.NODE_ENV).toBe("test");
  });

  it("SESSION_SECRET is populated (app.ts can import without throwing)", () => {
    expect(typeof process.env.SESSION_SECRET).toBe("string");
    expect((process.env.SESSION_SECRET ?? "").length).toBeGreaterThan(0);
  });

  it("LICENSE_ENFORCEMENT is 'off' so license gate is bypassed", () => {
    expect(process.env.LICENSE_ENFORCEMENT).toBe("off");
  });

  it("LOG_LEVEL is 'silent' so test output stays readable", () => {
    expect(process.env.LOG_LEVEL).toBe("silent");
  });

  it("DATABASE_URL is set (worker database was provisioned by setup)", () => {
    expect(typeof process.env.DATABASE_URL).toBe("string");
    expect((process.env.DATABASE_URL ?? "").length).toBeGreaterThan(0);
  });
});

describe("database connectivity", () => {
  it("can execute a simple query against the worker database", async () => {
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    const result = await db.execute(sql`SELECT 1 AS one`);
    const rows = (result as unknown as { rows: { one: number }[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].one).toBe(1);
  });

  it("resetDatabase helper truncates all tables without throwing", async () => {
    const { resetDatabase } = await import("./dbReset");
    await expect(resetDatabase()).resolves.toBeUndefined();
  });

  it("resetDatabase helper is idempotent — second call also succeeds", async () => {
    const { resetDatabase } = await import("./dbReset");
    await expect(resetDatabase()).resolves.toBeUndefined();
  });
});

describe("object-storage ACL mock (installed by setup beforeEach)", () => {
  it("trySetObjectEntityAclPolicy is spied on the prototype (mock is installed)", async () => {
    const { ObjectStorageService } = await import("../src/lib/objectStorage");
    expect(vi.isMockFunction(ObjectStorageService.prototype.trySetObjectEntityAclPolicy)).toBe(true);
  });

  it("trySetObjectEntityAclPolicy returns the raw path without calling GCS (path starts with /)", async () => {
    const { ObjectStorageService } = await import("../src/lib/objectStorage");
    const svc = new ObjectStorageService();
    // A path that starts with "/" would proceed past the early-return guard and
    // attempt real GCS metadata calls without the mock. The spy replaces the
    // method entirely, so this resolves to the raw path instead of throwing.
    const rawPath = "/objects/uploads/test-boot-check.jpg";
    const result = await svc.trySetObjectEntityAclPolicy(rawPath, {
      owner: "user:1",
      visibility: "private",
      sourceModule: "inspections",
    });
    expect(result).toBe(rawPath);
  });
});
