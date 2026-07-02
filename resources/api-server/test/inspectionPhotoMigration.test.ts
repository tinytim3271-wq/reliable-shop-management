import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, inspectionItemsTable, inspectionsTable } from "@workspace/db";
import { seedCustomerVehicle, type SeededShop } from "./helpers";
import {
  migrateItemNotes,
  migrateLegacyInspectionPhotos,
} from "../src/lib/migrateInspectionPhotos";

let shop: SeededShop;

beforeAll(async () => {
  shop = await seedCustomerVehicle();
});

async function seedInspectionItem(args: {
  notes: string | null;
  photoUrls?: string[];
}): Promise<number> {
  const [insp] = await db
    .insert(inspectionsTable)
    .values({ vehicleId: shop.vehicleId, title: "Migration test", status: "completed" })
    .returning();
  const [item] = await db
    .insert(inspectionItemsTable)
    .values({
      inspectionId: insp.id,
      name: "Brake Pads",
      condition: "fail",
      notes: args.notes,
      photoUrls: args.photoUrls ?? [],
    })
    .returning();
  return item.id;
}

describe("migrateItemNotes (pure)", () => {
  it("moves a legacy <img> path into photoUrls and strips the tag from notes", () => {
    const notes =
      'Worn down to the wear bar\n<img src="/api/storage/objects/uploads/abc.jpg" />';
    const result = migrateItemNotes(notes, []);
    expect(result).not.toBeNull();
    expect(result!.photoUrls).toEqual(["/objects/uploads/abc.jpg"]);
    expect(result!.notes).toBe("Worn down to the wear bar");
    expect(result!.movedCount).toBe(1);
  });

  it("returns null when there is nothing to migrate (idempotent)", () => {
    expect(migrateItemNotes("just text", [])).toBeNull();
    expect(migrateItemNotes(null, [])).toBeNull();
    expect(migrateItemNotes("", [])).toBeNull();
  });

  it("does not duplicate a path already present in photoUrls", () => {
    const notes = '<img src="/api/storage/objects/uploads/dup.jpg" />';
    const result = migrateItemNotes(notes, ["/objects/uploads/dup.jpg"]);
    expect(result).not.toBeNull();
    expect(result!.photoUrls).toEqual(["/objects/uploads/dup.jpg"]);
    expect(result!.notes).toBeNull();
  });

  it("migrates multiple tags and preserves surrounding text", () => {
    const notes =
      'top note\n<img src="/api/storage/objects/uploads/a.jpg" />\nmiddle\n<img src="/api/storage/objects/uploads/b.jpg" />\nbottom';
    const result = migrateItemNotes(notes, []);
    expect(result!.photoUrls).toEqual([
      "/objects/uploads/a.jpg",
      "/objects/uploads/b.jpg",
    ]);
    expect(result!.movedCount).toBe(2);
    expect(result!.notes).toBe("top note\nmiddle\nbottom");
  });

  it("leaves non-storage <img> sources untouched", () => {
    const notes = '<img src="https://example.com/photo.jpg" />';
    expect(migrateItemNotes(notes, [])).toBeNull();
  });

  it("returns null notes when only tags were present", () => {
    const notes = '<img src="/api/storage/objects/uploads/only.jpg" />';
    const result = migrateItemNotes(notes, []);
    expect(result!.notes).toBeNull();
  });
});

describe("migrateLegacyInspectionPhotos (db)", () => {
  it("migrates legacy rows and is safe to re-run", async () => {
    const legacyId = await seedInspectionItem({
      notes: 'Leaking\n<img src="/api/storage/objects/uploads/run.jpg" />',
    });
    const cleanId = await seedInspectionItem({
      notes: "no photos here",
      photoUrls: ["/objects/uploads/already.jpg"],
    });

    const first = await migrateLegacyInspectionPhotos();
    expect(first.itemsUpdated).toBeGreaterThanOrEqual(1);
    expect(first.photosMoved).toBeGreaterThanOrEqual(1);

    const [migrated] = await db
      .select()
      .from(inspectionItemsTable)
      .where(eq(inspectionItemsTable.id, legacyId));
    expect(migrated.photoUrls).toContain("/objects/uploads/run.jpg");
    expect(migrated.notes).toBe("Leaking");

    const [untouched] = await db
      .select()
      .from(inspectionItemsTable)
      .where(eq(inspectionItemsTable.id, cleanId));
    expect(untouched.notes).toBe("no photos here");
    expect(untouched.photoUrls).toEqual(["/objects/uploads/already.jpg"]);

    // Re-running must not touch the already-migrated row again.
    const second = await migrateLegacyInspectionPhotos();
    const [reMigrated] = await db
      .select()
      .from(inspectionItemsTable)
      .where(eq(inspectionItemsTable.id, legacyId));
    expect(reMigrated.photoUrls).toEqual(["/objects/uploads/run.jpg"]);
    expect(reMigrated.notes).toBe("Leaking");
    expect(second.itemsUpdated).toBe(0);
  });
});
