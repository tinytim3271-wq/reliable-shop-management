import { sql } from "drizzle-orm";
import { db, inspectionItemsTable } from "@workspace/db";
import { logger } from "./logger";

// Matches a single legacy embedded photo tag, e.g.
//   <img src="/api/storage/objects/uploads/abc.jpg" />
// `src` is captured so we can recover the path it pointed at.
const IMG_TAG_RE = /<img\b[^>]*?\bsrc="([^"]*)"[^>]*?>/gi;

// Legacy tags embedded the full client URL (`/api/storage` + canonical path).
// photoUrls store the canonical `/objects/...` path, so we strip the prefix.
const STORAGE_URL_PREFIX = "/api/storage";

/**
 * Convert a legacy `<img src="...">` source into the canonical object path
 * stored in photoUrls (e.g. `/objects/uploads/abc.jpg`), or null if the src
 * does not point at a trackable storage object.
 */
function toCanonicalPath(src: string): string | null {
  let path = src;
  if (path.startsWith(STORAGE_URL_PREFIX)) {
    path = path.slice(STORAGE_URL_PREFIX.length);
  }
  // Only object-storage paths are reference-tracked / cleanable. Anything else
  // (external URLs, data URIs, malformed src) is left untouched in notes.
  return path.startsWith("/objects/") ? path : null;
}

export type MigrationResult = {
  /** Number of inspection item rows that were updated. */
  itemsUpdated: number;
  /** Number of legacy photo paths moved into photoUrls arrays. */
  photosMoved: number;
};

/**
 * Parse the legacy `<img src="/api/storage{path}">` tags embedded in an
 * inspection item's notes and fold the referenced object paths into
 * photoUrls, returning the cleaned notes and the merged photo list.
 *
 * Returns null when there is nothing to migrate (notes have no trackable
 * legacy tag), which keeps the migration idempotent — re-running it on
 * already-migrated rows is a no-op.
 */
export function migrateItemNotes(
  notes: string | null,
  photoUrls: string[],
): { notes: string | null; photoUrls: string[]; movedCount: number } | null {
  if (!notes || !notes.includes("<img")) return null;

  const existing = new Set(photoUrls);
  const merged = [...photoUrls];
  let movedCount = 0;

  // Process line-by-line so a tag that occupied its own line is removed
  // cleanly instead of leaving a stray blank line behind.
  const keptLines: string[] = [];
  for (const line of notes.split("\n")) {
    const hadContent = line.trim() !== "";
    const cleanedLine = line.replace(IMG_TAG_RE, (fullTag, src: string) => {
      const path = toCanonicalPath(src);
      if (path === null) {
        // Not a trackable storage object — leave the tag in place.
        return fullTag;
      }
      if (!existing.has(path)) {
        existing.add(path);
        merged.push(path);
      }
      movedCount += 1;
      // Drop the tag from notes; it now lives in photoUrls.
      return "";
    });
    // Drop a line that held only migrated tag(s) and is now empty; preserve
    // genuine text lines and any blank lines the user authored themselves.
    if (hadContent && cleanedLine.trim() === "") continue;
    keptLines.push(cleanedLine.trimEnd());
  }

  if (movedCount === 0) return null;

  const normalizedNotes = keptLines.join("\n").trim();

  return {
    notes: normalizedNotes === "" ? null : normalizedNotes,
    photoUrls: merged,
    movedCount,
  };
}

/**
 * One-time migration: historically the inspection page embedded photos as
 * `<img src="/api/storage{path}">` tags inside an item's notes instead of the
 * photoUrls array. Those photos are invisible to the storage reference check,
 * have no remove button, and can never be freed. This moves the referenced
 * paths into photoUrls and strips the tags from notes so the photos behave
 * like any other tracked inspection photo.
 *
 * Idempotent and safe to re-run: once a row's notes contain no trackable
 * legacy tag, it is skipped. Errors are logged and swallowed so startup
 * always succeeds.
 */
export async function migrateLegacyInspectionPhotos(): Promise<MigrationResult> {
  const result: MigrationResult = { itemsUpdated: 0, photosMoved: 0 };
  try {
    // Only rows whose notes still embed an <img> tag can have anything to
    // migrate — this keeps repeat runs cheap and the operation idempotent.
    const rows = await db
      .select({
        id: inspectionItemsTable.id,
        notes: inspectionItemsTable.notes,
        photoUrls: inspectionItemsTable.photoUrls,
      })
      .from(inspectionItemsTable)
      .where(sql`${inspectionItemsTable.notes} LIKE '%<img%'`);

    for (const row of rows) {
      const migrated = migrateItemNotes(row.notes, row.photoUrls ?? []);
      if (!migrated) continue;

      await db
        .update(inspectionItemsTable)
        .set({ notes: migrated.notes, photoUrls: migrated.photoUrls })
        .where(sql`${inspectionItemsTable.id} = ${row.id}`);

      result.itemsUpdated += 1;
      result.photosMoved += migrated.movedCount;
    }

    if (result.itemsUpdated > 0) {
      logger.info(
        result,
        "inspection-photos: migrated legacy embedded photos into photoUrls",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "inspection-photos: legacy photo migration failed — continuing",
    );
  }
  return result;
}
