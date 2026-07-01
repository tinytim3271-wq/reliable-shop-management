import { describe, it, expect, beforeAll } from "vitest";
import { db, partsTable, customersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resetDatabase } from "./dbReset";
import { seedPart, seedAdmin } from "./helpers";

// Regression guard for cross-file test pollution.
//
// The whole in-process suite shares ONE database for the run (see
// globalSetup.ts). Historically the database was only reset once per run, so
// each file accumulated the rows seeded by every file that ran before it. A
// generic "Brake Pad" part seeded in one file silently changed a price asserted
// in another file's test, and the suite only stayed green by luck of file
// order. Upgrading vitest 3 -> 4 reshuffled the default file order and exposed
// it. setup.ts now truncates every table before each file's tests, giving real
// per-file isolation. These tests pin that behavior so a regression is caught.
describe("database isolation between test files", () => {
  // setup.ts's beforeAll truncates the whole database before this (or any) file
  // runs, regardless of which files ran earlier in the same run.
  it("starts every file with an empty database", async () => {
    const parts = await db.select().from(partsTable);
    const customers = await db.select().from(customersTable);
    const users = await db.select().from(usersTable);
    expect(parts).toHaveLength(0);
    expect(customers).toHaveLength(0);
    expect(users).toHaveLength(0);
  });

  // Reproduces the exact failure mode: a generic, non-unique "Brake Pad" part
  // (the kind that previously leaked into ai-estimate-suggestions) is fully
  // wiped by the reset the harness runs before every file, so it can never
  // change a price another file asserts on.
  it("resetDatabase wipes a generic poison part seeded by a prior file", async () => {
    await seedPart({
      name: "Brake Pad",
      quantityOnHand: 99,
      reorderLevel: 1,
      unitPrice: 999.99,
    });
    await seedAdmin();

    const before = await db
      .select()
      .from(partsTable)
      .where(eq(partsTable.name, "Brake Pad"));
    expect(before).toHaveLength(1);

    await resetDatabase();

    const afterParts = await db.select().from(partsTable);
    const afterUsers = await db.select().from(usersTable);
    expect(afterParts).toHaveLength(0);
    expect(afterUsers).toHaveLength(0);
  });

  // RESTART IDENTITY: after a reset, identity sequences start over so each file
  // gets deterministic, low ids instead of inheriting another file's sequence.
  it("restarts identity sequences after a reset", async () => {
    await resetDatabase();
    const [first] = await db
      .insert(partsTable)
      .values({ name: "Sequence Probe", quantityOnHand: 0, reorderLevel: 0 })
      .returning();
    expect(first.id).toBe(1);
    await resetDatabase();
    const [second] = await db
      .insert(partsTable)
      .values({ name: "Sequence Probe", quantityOnHand: 0, reorderLevel: 0 })
      .returning();
    expect(second.id).toBe(1);
  });
});
