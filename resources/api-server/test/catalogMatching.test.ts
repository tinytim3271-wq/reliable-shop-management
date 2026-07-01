import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, partsTable } from "@workspace/db";
import {
  loadCatalog,
  matchCatalogPart,
  computePartDeductions,
  type CatalogPart,
} from "../src/lib/billing";
import { seedPart, uniqueName } from "./helpers";

// The parts catalog is matched by name (exact, then fuzzy substring) to decide
// which part an invoice/work-order line deducts from. Because the suite shares
// one database across files and Postgres returns rows in an unstable heap order,
// the matcher must resolve duplicate/overlapping names deterministically or the
// same repair bill could deduct from different parts on different runs.

const part = (id: number, name: string): CatalogPart => ({
  id,
  name,
  unitPrice: 0,
  quantityOnHand: 10,
  reorderLevel: 1,
});

describe("matchCatalogPart determinism", () => {
  it("returns the lowest-id exact match regardless of input order", () => {
    const a = part(7, "Brake Pad");
    const b = part(3, "Brake Pad");
    expect(matchCatalogPart("Brake Pad", [a, b])?.id).toBe(3);
    expect(matchCatalogPart("Brake Pad", [b, a])?.id).toBe(3);
  });

  it("returns the lowest-id fuzzy match regardless of input order", () => {
    const a = part(9, "Premium Oil Filter");
    const b = part(4, "Oil Filter Deluxe");
    expect(matchCatalogPart("oil filter", [a, b])?.id).toBe(4);
    expect(matchCatalogPart("oil filter", [b, a])?.id).toBe(4);
  });

  it("prefers an exact match over a lower-id fuzzy match", () => {
    const fuzzy = part(2, "Heavy Duty Air Filter");
    const exact = part(8, "Air Filter");
    expect(matchCatalogPart("Air Filter", [fuzzy, exact])?.id).toBe(8);
  });

  it("returns null when nothing matches", () => {
    expect(matchCatalogPart("Nonexistent", [part(1, "Spark Plug")])).toBeNull();
    expect(matchCatalogPart("   ", [part(1, "Spark Plug")])).toBeNull();
  });
});

describe("computePartDeductions with overlapping catalog names", () => {
  it("attributes a line to a single deterministic part when names overlap", () => {
    const catalog = [part(5, "Coolant Flush Kit"), part(2, "Coolant")];
    const deductions = computePartDeductions(
      [{ type: "part", description: "Coolant", quantity: 3 }],
      catalog,
    );
    expect(deductions.size).toBe(1);
    expect(deductions.get(2)).toBe(3);
  });
});

describe("loadCatalog ordering", () => {
  it("returns parts in ascending id order even after a stock update reshuffles the heap", async () => {
    const first = await seedPart({
      name: uniqueName("Det Catalog A"),
      quantityOnHand: 10,
      reorderLevel: 1,
    });
    const second = await seedPart({
      name: uniqueName("Det Catalog B"),
      quantityOnHand: 10,
      reorderLevel: 1,
    });
    const third = await seedPart({
      name: uniqueName("Det Catalog C"),
      quantityOnHand: 10,
      reorderLevel: 1,
    });

    // Update the earliest-inserted row so Postgres is free to move it within the
    // heap; an unordered scan could then return it out of insertion order.
    await db
      .update(partsTable)
      .set({ quantityOnHand: 1 })
      .where(eq(partsTable.id, first.id));

    const ids = (await loadCatalog()).map((p) => p.id);
    const seededOrder = [first.id, second.id, third.id];
    const positions = seededOrder.map((id) => ids.indexOf(id));
    // Each seeded part appears, and in strictly ascending position (id order).
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
  });
});
