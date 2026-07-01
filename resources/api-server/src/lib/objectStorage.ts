import { Readable } from "stream";
import { db, workOrdersTable, inspectionItemsTable, expensesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
} from "./objectAcl";
import {
  ObjectNotFoundError,
  UploadTooLargeError,
  MAX_OBJECT_UPLOAD_SIZE_BYTES,
  getObjectStorageBackend,
  type ObjectStorageBackend,
  type StorageObjectHandle,
} from "./objectStorageBackend";
import { logger } from "./logger";

// Re-exported so existing importers (storage routes, photo cleanup, write
// routes) that import these from this module keep working after they moved to
// the backend layer.
export { ObjectNotFoundError, UploadTooLargeError, MAX_OBJECT_UPLOAD_SIZE_BYTES };

// Maximum accepted size for private object uploads. Shared by the storage
// route and the write routes that validate objects at save time.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
// Legacy signed-URL TTL. The upload flow no longer mints presigned PUT URLs
// (uploads now stream through the server), but the pending upload-token TTL
// below is still anchored to this value as a lower bound, so it is retained.
export const SIGNED_URL_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Safe image MIME types that may be served inline (rendered in <img> tags).
// Any object whose stored Content-Type is not on this list must be served as
// application/octet-stream with Content-Disposition: attachment to prevent
// script execution on the application origin. Shared by every route that
// streams private objects (authenticated storage route and public portal).
export const SAFE_INLINE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Upload token registry — in-memory, module-level singleton.
//
// When the server mints a presigned upload URL it records objectPath → userId.
// Callers that subsequently try to link that objectPath to a business record
// must prove they minted the URL (token valid) OR that the object's GCS ACL
// names them as owner (set when the upload is confirmed via /uploads/confirm).
// This prevents cross-user/cross-module injection attacks where a user inserts
// a foreign objectPath into a record they control to bypass read-path checks.
//
// Two TTLs are used:
//  - UPLOAD_PENDING_TTL_MS: lifetime of an unconfirmed (pending) token. Kept
//    short so unconfirmed orphans are swept from GCS quickly if /confirm is
//    never called. Must be a little longer than SIGNED_URL_TTL_MS.
//  - UPLOAD_REGISTRY_TTL_MS: lifetime of a confirmed token, used for the
//    pre-link preview window (caller can preview their photo before attaching
//    it to a work order / inspection item).
// ─────────────────────────────────────────────────────────────────────────────
const UPLOAD_PENDING_TTL_MS = 20 * 60 * 1000; // 20 min — slightly > signed URL TTL
const UPLOAD_REGISTRY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (confirmed tokens only)
// Two-state registry: "pending" (minted, not yet confirmed) → "confirmed"
// (passed size/type validation via /uploads/confirm and ACL stamped).
// Only confirmed entries satisfy link-time ownership verification so that
// confirm is effectively mandatory before an object can be attached to a record.
interface UploadRegistryEntry {
  userId: number;
  expiresAt: number;
  confirmed: boolean;
  // Optional original filename and MIME type captured at upload time for
  // document attachments. Used by the AI chat document-extraction flow to label
  // the file and (as a fallback) pick a parser; the authoritative content type
  // for extraction is the stored object metadata, not these client-declared
  // values. Absent for photo uploads.
  fileName?: string;
  mimeType?: string;
}
const uploadRegistry = new Map<string, UploadRegistryEntry>();

/** Record that userId minted a presigned URL for objectPath (pending state). */
export function registerUpload(objectPath: string, userId: number): void {
  uploadRegistry.set(objectPath, {
    userId,
    expiresAt: Date.now() + UPLOAD_PENDING_TTL_MS,
    confirmed: false,
  });
  // Prune expired entries to prevent unbounded growth.
  if (uploadRegistry.size > 1000) {
    const now = Date.now();
    for (const [path, entry] of uploadRegistry) {
      if (entry.expiresAt < now) uploadRegistry.delete(path);
    }
  }
}

/**
 * Returns true if this server issued an upload token for objectPath to userId
 * and that token is still within its TTL window (regardless of confirmed state).
 * Used by the confirm endpoint to verify the caller minted the URL before
 * allowing any GCS interaction or ACL write.
 */
export function isUploadTokenValid(objectPath: string, userId: number): boolean {
  const entry = uploadRegistry.get(objectPath);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    uploadRegistry.delete(objectPath);
    return false;
  }
  return entry.userId === userId;
}

/**
 * Advance a pending token to confirmed state after the confirm endpoint has
 * validated actual GCS size and content-type. Returns false if the token is
 * missing, expired, or belongs to a different user — indicating the caller
 * should not proceed with ACL writes or record links.
 */
export function markUploadConfirmed(objectPath: string, userId: number): boolean {
  const entry = uploadRegistry.get(objectPath);
  if (!entry || entry.userId !== userId || entry.expiresAt < Date.now()) return false;
  entry.confirmed = true;
  return true;
}

/**
 * Register a finalized (already validated and confirmed) upload path directly
 * in confirmed state. Used after server-side copy finalization where the new
 * destination path was never separately registered as pending.
 *
 * Also records the path in the provisional-orphan registry so that the periodic
 * sweep can delete it from GCS if it is never linked to a DB record within
 * PROVISIONAL_ORPHAN_TTL_MS.
 */
export function registerConfirmedUpload(
  objectPath: string,
  userId: number,
  meta?: { fileName?: string; mimeType?: string },
): void {
  uploadRegistry.set(objectPath, {
    userId,
    expiresAt: Date.now() + UPLOAD_REGISTRY_TTL_MS,
    confirmed: true,
    ...(meta?.fileName ? { fileName: meta.fileName } : {}),
    ...(meta?.mimeType ? { mimeType: meta.mimeType } : {}),
  });
  provisionalUploads.set(objectPath, Date.now());
}

/**
 * Return the original filename and MIME type recorded for a confirmed upload
 * owned by userId, or null if no live confirmed token exists for that path/user.
 * Used by the AI chat document-extraction flow to label an attached document.
 * In-memory only (resets on restart); callers must tolerate a null result.
 */
export function getConfirmedUploadMetadata(
  objectPath: string,
  userId: number,
): { fileName?: string; mimeType?: string } | null {
  const entry = uploadRegistry.get(objectPath);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    uploadRegistry.delete(objectPath);
    return null;
  }
  if (entry.userId !== userId || !entry.confirmed) return null;
  return { fileName: entry.fileName, mimeType: entry.mimeType };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provisional-orphan registry — tracks confirmed uploads that have not yet
// been linked to a business record (work order or inspection item).
//
// When a confirmed upload is written via the proxied endpoint or via the
// legacy confirm flow, its objectPath is added here. A background sweep
// periodically checks entries older than PROVISIONAL_ORPHAN_TTL_MS against
// the DB; if the object is still unlinked it is deleted from GCS.
//
// This closes the cost-exhaustion vector where a staff user uploads many
// valid (size ≤ cap) files but never attaches them to any record.
// ─────────────────────────────────────────────────────────────────────────────
const PROVISIONAL_ORPHAN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
// objectPath → timestamp when it was confirmed
const provisionalUploads = new Map<string, number>();

/**
 * Remove objectPath from both the provisional registry and the upload-token
 * registry once it has been linked to a business record. Called by write routes
 * (work orders, inspection items, expenses) when they persist an objectPath to
 * the DB.
 *
 * Revoking the confirmed token at link time is the critical step: the pre-link
 * preview shortcut in GET /storage/objects/* must no longer apply once the file
 * is attached to a record. From that point on, access is governed exclusively
 * by the owning record's module permissions, so a user whose module permission
 * is later revoked cannot retain read access through a stale confirmed token.
 */
export function markUploadLinked(objectPath: string): void {
  provisionalUploads.delete(objectPath);
  uploadRegistry.delete(objectPath);
}

/**
 * Remove an entry from the upload registry, invalidating any in-memory token
 * for that path. Called after the original temp upload is superseded by a
 * finalized copy so that the old path can no longer satisfy ownership checks.
 */
export function removeFromUploadRegistry(objectPath: string): void {
  uploadRegistry.delete(objectPath);
}

/**
 * Count the number of pending (unconfirmed) upload tokens currently held by
 * userId. Used by the mint endpoint to enforce a per-user concurrent pending
 * upload cap, bounding how many unconfirmed blobs can exist in object storage
 * at once regardless of the hourly mint rate limit.
 */
export function countPendingUploads(userId: number): number {
  const now = Date.now();
  let count = 0;
  for (const entry of uploadRegistry.values()) {
    if (!entry.confirmed && entry.userId === userId && entry.expiresAt >= now) {
      count++;
    }
  }
  return count;
}

/**
 * Returns true if this server issued a confirmed (validated) upload token for
 * objectPath to userId and the token is still within TTL. Used by the
 * GET /storage/objects/* handler to grant pre-link preview access to the
 * uploader without requiring the object to be linked to a DB record yet.
 */
export function hasConfirmedUploadToken(objectPath: string, userId: number): boolean {
  const entry = uploadRegistry.get(objectPath);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    uploadRegistry.delete(objectPath);
    return false;
  }
  return entry.userId === userId && entry.confirmed;
}

/**
 * Returns true if objectPath is still referenced by at least one work order or
 * inspection item. Used as a safety guard before deleting an object from GCS:
 * a file must never be removed while a business record still points at it.
 * Non-/objects/ paths are treated as unreferenced.
 */
export async function isObjectPathReferenced(objectPath: string): Promise<boolean> {
  if (!objectPath.startsWith("/objects/")) return false;
  const [woRef] = await db
    .select({ id: workOrdersTable.id })
    .from(workOrdersTable)
    .where(sql`${objectPath} = ANY(${workOrdersTable.photoUrls})`)
    .limit(1);
  if (woRef) return true;
  const [iiRef] = await db
    .select({ id: inspectionItemsTable.id })
    .from(inspectionItemsTable)
    .where(sql`${objectPath} = ANY(${inspectionItemsTable.photoUrls})`)
    .limit(1);
  if (iiRef) return true;
  const [expRef] = await db
    .select({ id: expensesTable.id })
    .from(expensesTable)
    .where(sql`${objectPath} = ANY(${expensesTable.receiptUrls})`)
    .limit(1);
  return !!expRef;
}

/**
 * Verify that userId is the legitimate owner of objectPath for linking
 * purposes. Requires EITHER a confirmed token (upload went through
 * /uploads/confirm) OR a GCS ACL WRITE grant (set at confirm time,
 * persists across server restarts). Using only isUploadTokenValid (pending
 * state) is intentionally insufficient — confirm must have run first.
 * Non-/objects/ paths pass unconditionally.
 */
export async function verifyObjectUploadOwnership(
  objectPath: string,
  userId: number,
  svc: ObjectStorageService,
): Promise<boolean> {
  if (!objectPath.startsWith("/objects/")) return true;
  // Confirmed in-memory token — fastest path, no network roundtrip.
  const entry = uploadRegistry.get(objectPath);
  if (entry && entry.userId === userId && entry.confirmed && entry.expiresAt >= Date.now()) {
    return true;
  }
  // ACL fallback: covers objects where /confirm ran but the server was restarted
  // (token lost) — the ACL owner field persists the claim in GCS metadata.
  try {
    const objectHandle = await svc.getObjectEntityFile(objectPath);
    return await svc.canAccessObjectEntity({
      userId: String(userId),
      objectHandle,
      requestedPermission: ObjectPermission.WRITE,
    });
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Background cleanup jobs — sweep expired/orphaned uploads from GCS.
//
// Two complementary sweeps run on the same interval:
//
// 1. sweepExpiredUploads — deletes uploads whose registry TTL expired before
//    they were confirmed (client aborted or never called /confirm). This
//    covers the legacy presigned-URL flow (now disabled) and any legacy
//    confirm-path uploads that were never finalized. Also proactively checks
//    actual GCS object sizes for pending uploads and immediately deletes any
//    that exceed MAX_OBJECT_UPLOAD_SIZE_BYTES (size-spoofing defense).
//
// 2. sweepProvisionalOrphans — deletes confirmed-but-unlinked uploads older
//    than PROVISIONAL_ORPHAN_TTL_MS by querying the DB for references. This
//    closes the cost-exhaustion vector where a staff user uploads many valid
//    files but never attaches them to any work order or inspection item.
//
// Limitation: registry state is in-memory and resets on server restart.
// A GCS Object Lifecycle Management rule on the uploads/ prefix (e.g.,
// delete after 1 day) is the recommended complement for cross-restart orphans.
// ─────────────────────────────────────────────────────────────────────────────
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // run every 5 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Backstop reconciliation — see reconcileOrphanedUploads / runOrphanReconciliation.
//
// The two registry-based sweeps above only ever look at in-memory entries, and
// the provisional registry stops tracking an object the moment it is linked to a
// record. No sweep ever revisits a once-linked object, so a confirmed photo that
// is orphaned by an interrupted record delete (tab closed / network drop before
// the client-driven storage delete ran) leaks storage cost forever. The
// reconciliation sweep lists the GCS uploads/ prefix and deletes anything the DB
// no longer references.
//
// Grace must comfortably exceed the confirmed-but-unlinked link window
// (UPLOAD_REGISTRY_TTL_MS / PROVISIONAL_ORPHAN_TTL_MS, both 2h) so a normal
// upload-then-attach flow is never raced. The interval is long because each pass
// lists the entire uploads/ prefix.
// ─────────────────────────────────────────────────────────────────────────────
const RECONCILE_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // run every 6 hours

async function sweepExpiredUploads(): Promise<void> {
  const now = Date.now();
  const toDeleteExpired: string[] = [];
  const toCheckSize: string[] = [];

  for (const [objectPath, entry] of uploadRegistry) {
    if (entry.confirmed) continue;
    if (entry.expiresAt < now) {
      toDeleteExpired.push(objectPath);
    } else {
      // Pending and not yet expired — check actual GCS size to catch oversized
      // uploads where the client declared a small size to bypass the mint-time
      // cap and then uploaded a much larger body.
      toCheckSize.push(objectPath);
    }
  }

  const svc = new ObjectStorageService();
  let deleted = 0;
  let oversizedDeleted = 0;

  for (const objectPath of toDeleteExpired) {
    try {
      await svc.deleteObjectEntity(objectPath);
      deleted++;
    } catch {
      // Object may already be absent — not an error.
    }
    uploadRegistry.delete(objectPath);
  }

  // Proactively delete pending uploads whose actual stored size already exceeds
  // the cap. This closes the size-spoofing attack: a client that declares
  // size=1 and uploads gigabytes would otherwise persist until the TTL expired
  // (up to 2 hours). Now the next sweep cycle (every 10 minutes) deletes it.
  for (const objectPath of toCheckSize) {
    try {
      const actualSize = await svc.getObjectEntitySizeBytes(objectPath);
      if (actualSize !== null && actualSize > MAX_OBJECT_UPLOAD_SIZE_BYTES) {
        try {
          await svc.deleteObjectEntity(objectPath);
          oversizedDeleted++;
        } catch {
          // Object may already be absent — not an error.
        }
        uploadRegistry.delete(objectPath);
      }
    } catch {
      // Transient GCS error or object not yet present — skip this cycle.
    }
  }

  if (deleted > 0 || oversizedDeleted > 0) {
    logger.info(
      { deleted, oversizedDeleted, skipped: toDeleteExpired.length - deleted },
      "upload-cleanup: swept expired and oversized unconfirmed uploads from GCS",
    );
  }
}

/**
 * Sweeps confirmed-but-unlinked uploads older than PROVISIONAL_ORPHAN_TTL_MS.
 * For each candidate, queries the DB to check whether the objectPath is
 * referenced by any work order or inspection item. Deletes from GCS if unlinked.
 */
async function sweepProvisionalOrphans(): Promise<void> {
  const now = Date.now();
  const candidates: string[] = [];

  for (const [objectPath, confirmedAt] of provisionalUploads) {
    if (now - confirmedAt >= PROVISIONAL_ORPHAN_TTL_MS) {
      candidates.push(objectPath);
    }
  }

  if (candidates.length === 0) return;

  const svc = new ObjectStorageService();
  let deleted = 0;

  for (const objectPath of candidates) {
    try {
      // Check DB linkage for this objectPath.
      const [woRef] = await db
        .select({ id: workOrdersTable.id })
        .from(workOrdersTable)
        .where(sql`${objectPath} = ANY(${workOrdersTable.photoUrls})`)
        .limit(1);

      const [iiRef] = !woRef
        ? await db
            .select({ id: inspectionItemsTable.id })
            .from(inspectionItemsTable)
            .where(sql`${objectPath} = ANY(${inspectionItemsTable.photoUrls})`)
            .limit(1)
        : [undefined];

      const [expRef] = !woRef && !iiRef
        ? await db
            .select({ id: expensesTable.id })
            .from(expensesTable)
            .where(sql`${objectPath} = ANY(${expensesTable.receiptUrls})`)
            .limit(1)
        : [undefined];

      if (woRef || iiRef || expRef) {
        // Linked to a record — remove from provisional registry but keep GCS object.
        provisionalUploads.delete(objectPath);
        continue;
      }

      // Not linked to any record — delete from GCS and remove from registry.
      try {
        await svc.deleteObjectEntity(objectPath);
        deleted++;
      } catch {
        // Object may already be absent — not an error.
      }
      provisionalUploads.delete(objectPath);
    } catch (err) {
      // Per-object DB or GCS error — log and skip; will retry next interval.
      logger.warn({ err, objectPath }, "upload-cleanup: error checking provisional orphan");
    }
  }

  if (deleted > 0 || candidates.length > 0) {
    logger.info(
      { deleted, checked: candidates.length },
      "upload-cleanup: swept confirmed-but-unlinked provisional uploads from GCS",
    );
  }
}

// Start the sweeps when this module is first imported.
// unref() prevents the interval from keeping the process alive on shutdown.
const _uploadCleanupInterval = setInterval(() => {
  sweepExpiredUploads().catch((err) => {
    logger.warn({ err }, "upload-cleanup: unconfirmed sweep error");
  });
  sweepProvisionalOrphans().catch((err) => {
    logger.warn({ err }, "upload-cleanup: provisional orphan sweep error");
  });
}, CLEANUP_INTERVAL_MS);
_uploadCleanupInterval.unref();

// Backstop reconciliation runs on a longer cadence because each pass lists the
// entire uploads/ prefix. It reclaims confirmed-and-formerly-linked blobs left
// behind by interrupted record deletes, which the registry-based sweeps above
// can never see. unref() keeps it from holding the process open on shutdown.
const _orphanReconcileInterval = setInterval(() => {
  void runOrphanReconciliation();
}, RECONCILE_INTERVAL_MS);
_orphanReconcileInterval.unref();

// Thrown when a write route attempts to re-register a storage object that is
// already bound to a different module. The ACL is immutable after first
// registration to prevent cross-module rebinding attacks (e.g. an inspections
// user stamping a workOrders photo with "inspections" to gain read access).
export class ObjectAclRebindingError extends Error {
  constructor(existingModule: string | undefined, requestedModule: string | undefined) {
    super(
      `Object is already registered to module "${existingModule ?? "(none)"}" ` +
      `and cannot be re-registered to "${requestedModule ?? "(none)"}"`,
    );
    this.name = "ObjectAclRebindingError";
    Object.setPrototypeOf(this, ObjectAclRebindingError.prototype);
  }
}

export class ObjectStorageService {
  // The active storage backend is selected once per process from
  // runtimeConfig.storageBackend (GCS in hosted mode, local filesystem in
  // desktop mode). All object operations delegate to it so this service keeps
  // the same public API and token-registry invariants across both backends.
  private backend: ObjectStorageBackend = getObjectStorageBackend();

  constructor() {}

  async searchPublicObject(filePath: string): Promise<StorageObjectHandle | null> {
    return this.backend.searchPublicObject(filePath);
  }

  async downloadObject(
    object: StorageObjectHandle,
    cacheTtlSec: number = 3600,
  ): Promise<Response> {
    const metadata = await object.getMetadata();
    const aclPolicy = await object.getAcl();
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = object.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": metadata.contentType || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  /**
   * Writes a Buffer directly to a new private object entity and returns the
   * canonical `/objects/…` path. Used by the server-proxied upload endpoint to
   * store file bytes that were streamed through the API server (where Express
   * body-size limits can enforce a hard cap). The active storage backend (GCS
   * in hosted mode, local filesystem in desktop mode) chooses the object id.
   */
  async writeObjectEntity(
    data: Buffer,
    contentType: string,
  ): Promise<{ objectPath: string }> {
    const objectPath = await this.backend.writeUpload(data, contentType);
    return { objectPath };
  }

  // Resolves a canonical `/objects/…` path to a backend handle, throwing
  // ObjectNotFoundError for an invalid path or a missing object (same contract
  // the GCS implementation provided before the backend abstraction).
  async getObjectEntityFile(objectPath: string): Promise<StorageObjectHandle> {
    return this.backend.getPrivateObject(objectPath);
  }

  /**
   * Reads the full bytes and content type of a private object entity. Used by
   * the outreach send path to load an attached report PDF so it can be relayed
   * to the email provider. Throws ObjectNotFoundError for an invalid/missing
   * path (same contract as getObjectEntityFile).
   */
  async readObjectBytes(
    objectPath: string,
  ): Promise<{ bytes: Buffer; contentType: string }> {
    const handle = await this.getObjectEntityFile(objectPath);
    const metadata = await handle.getMetadata();
    const resp = await this.downloadObject(handle);
    const bytes = Buffer.from(await resp.arrayBuffer());
    return {
      bytes,
      contentType: metadata.contentType || "application/octet-stream",
    };
  }

  /**
   * Returns the size in bytes of a private object entity, or null if the path
   * is not a valid private object path or the object does not exist.
   * Used to validate actual upload size after a presigned PUT completes.
   */
  async getObjectEntitySizeBytes(objectPath: string): Promise<number | null> {
    if (!objectPath.startsWith("/objects/")) {
      return null;
    }
    try {
      const objectFile = await this.getObjectEntityFile(objectPath);
      const metadata = await objectFile.getMetadata();
      const size = Number(metadata.size ?? 0);
      return Number.isFinite(size) ? size : null;
    } catch {
      return null;
    }
  }

  /**
   * Deletes a private object entity from GCS.
   * Throws ObjectNotFoundError if the path is invalid or the object is gone.
   */
  async deleteObjectEntity(objectPath: string): Promise<void> {
    const objectFile = await this.getObjectEntityFile(objectPath);
    await objectFile.delete();
  }

  /**
   * Finalizes a validated upload by server-side copying it to a new UUID path
   * and then deleting the original temp object.
   *
   * This is the core immutability guard: the signed PUT URL was minted for the
   * original temp path. Once we copy and delete the original, any subsequent
   * PUT to the old URL either fails (object gone) or re-creates a brand-new
   * unconfirmed orphan at that path — which the orphan sweep will remove.
   * The caller receives the new path, for which no signed PUT URL was ever
   * minted, making the validated content immutable from the client perspective.
   *
   * Returns the canonical `/objects/…` path of the new finalized object.
   * Throws if the copy fails (the caller should surface this as a 500).
   * The source deletion is best-effort: if it fails, the orphan sweep will
   * eventually remove the leftover temp object.
   */
  async finalizeUpload(sourcePath: string): Promise<{
    finalPath: string;
    metadata: { size: number; contentType: string };
  }> {
    // Server-side copy to a fresh UUID path. The backend re-reads the
    // destination metadata so the returned size/contentType reflect what was
    // actually persisted (closing the TOCTOU window on the source object) and
    // normalizes the content type for the confirm-route safety check.
    const { finalPath, metadata } = await this.backend.copyUpload(sourcePath);

    // Best-effort deletion of the original temp path. If this fails, the
    // orphan sweep will remove it later (ACL is only stamped on the finalized
    // copy, so the leftover temp object stays sweepable).
    try {
      const sourceFile = await this.getObjectEntityFile(sourcePath);
      await sourceFile.delete();
    } catch (err) {
      logger.warn({ err, sourcePath }, "upload-finalize: failed to delete original temp object after copy — orphan sweep will clean it up");
    }

    return {
      finalPath,
      metadata: { size: metadata.size, contentType: metadata.contentType },
    };
  }

  normalizeObjectEntityPath(rawPath: string): string {
    return this.backend.normalizeObjectPath(rawPath);
  }

  // Per-path in-process mutex for trySetObjectEntityAclPolicy.
  //
  // The read-check-write sequence in trySetObjectEntityAclPolicy is not
  // atomic at the storage layer. Without serialization, two concurrent
  // attachment requests for the same objectPath can both read a null ACL and
  // both write their chosen sourceModule — the second write silently overwrites
  // the first, breaking the single-module invariant. This map serializes all
  // concurrent calls on the same normalized path so only one read-check-write
  // cycle runs at a time.
  //
  // Keys are normalized object paths; values are the "gate" promise that the
  // next queued caller will await before starting its own cycle. The map entry
  // is deleted once the owning call settles and no further calls are queued.
  // Static so that all ObjectStorageService instances (one per route module)
  // share a single lock map. Instance-local locks would not serialize concurrent
  // attachment requests that arrive through different route files (workOrders,
  // inspections, expenses each construct their own instance).
  private static readonly _aclWriteLocks = new Map<string, Promise<void>>();

  private static _withAclLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const locks = ObjectStorageService._aclWriteLocks;
    const prev = locks.get(path) ?? Promise.resolve();

    let gateResolve!: () => void;
    const gate = new Promise<void>((res) => { gateResolve = res; });
    locks.set(path, gate);

    const run = async (): Promise<T> => {
      // Wait for the previous holder to finish, ignoring its error — we care
      // about ordering, not about propagating unrelated failures.
      try { await prev; } catch { /* intentional: only synchronizing order */ }
      try {
        return await fn();
      } finally {
        // Release the gate so the next queued caller can proceed.
        if (locks.get(path) === gate) {
          locks.delete(path);
        }
        gateResolve();
      }
    };

    return run();
  }

  // Registers an ACL policy on a private object entity using first-write-wins
  // semantics for sourceModule. Rules:
  //   - No existing ACL → write the full policy (includes sourceModule if provided).
  //   - Existing ACL, sourceModule not yet set, new policy provides one → merge
  //     sourceModule into the existing ACL (first module binding).
  //   - Existing ACL, sourceModule already set, same value → no-op (idempotent).
  //   - Existing ACL, sourceModule already set, different value → throws
  //     ObjectAclRebindingError — callers must surface this as a client error
  //     (400) to prevent cross-module access-escalation attacks.
  //
  // Note: owner/visibility fields from an existing ACL are always preserved;
  // only sourceModule is updated during a merge so that the upload-time owner
  // stamp is never overwritten by a later link operation.
  //
  // Thread safety: the entire read-check-write cycle is serialized per path via
  // _withAclLock so that two concurrent attachment requests for the same object
  // cannot both observe a null ACL and each succeed in writing a different
  // sourceModule value.
  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    return ObjectStorageService._withAclLock(normalizedPath, async () => {
      const objectFile = await this.getObjectEntityFile(normalizedPath);

      // Check for an existing ACL before writing.
      const existing = await objectFile.getAcl();
      if (existing !== null) {
        if (existing.sourceModule !== undefined) {
          // sourceModule already stamped — only allow idempotent re-registration.
          if (existing.sourceModule === aclPolicy.sourceModule) {
            return normalizedPath;
          }
          // Rebinding to a different module is explicitly forbidden.
          throw new ObjectAclRebindingError(existing.sourceModule, aclPolicy.sourceModule);
        }

        // Existing ACL has no sourceModule yet (uploaded before link-time stamping
        // was introduced, or the upload endpoint set owner/visibility only).
        // Merge in the sourceModule from the incoming policy — this is the first
        // module binding; owner and visibility are preserved from the existing ACL.
        if (aclPolicy.sourceModule !== undefined) {
          await objectFile.setAcl({ ...existing, sourceModule: aclPolicy.sourceModule });
        }
        // If no sourceModule is being set (e.g. caller only wants to refresh
        // owner/visibility), that is a no-op since ACL already exists.
        return normalizedPath;
      }

      await objectFile.setAcl(aclPolicy);
      return normalizedPath;
    });
  }

  async canAccessObjectEntity({
    userId,
    objectHandle,
    requestedPermission,
  }: {
    userId?: string;
    objectHandle: StorageObjectHandle;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    const aclPolicy = await objectHandle.getAcl();
    return canAccessObject({
      userId,
      aclPolicy,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }

  /**
   * Scans the GCS uploads/ prefix for objects older than ageMs that were
   * never confirmed (no ACL metadata). Deletes them. Used at startup to
   * remove orphaned uploads from before the last restart ("restart gap").
   *
   * `linkedPaths` — a set of canonical `/objects/…` paths currently
   * referenced by DB records. Objects in this set are never deleted,
   * regardless of ACL state. Pass it at startup to protect pre-patch
   * photos (uploaded before ACL-stamping was introduced) that live in
   * the uploads/ prefix but are already attached to work orders or
   * inspection items.
   *
   * Returns the count of deleted objects.
   */
  async sweepUnconfirmedUploads(
    ageMs: number,
    linkedPaths?: ReadonlySet<string>
  ): Promise<number> {
    const uploads = await this.backend.listUploads();
    const cutoffMs = Date.now() - ageMs;
    let deleted = 0;

    for (const upload of uploads) {
      try {
        const createdAt = upload.metadata.timeCreatedMs;
        if (createdAt === null) continue; // unknown age — keep (fail-safe)
        if (createdAt > cutoffMs) continue; // within TTL — keep

        // Never delete an object that is referenced by a DB record.
        // This protects pre-patch photos that were uploaded before ACL-stamping
        // was introduced (they have no ACL metadata but are legitimately linked).
        if (linkedPaths?.has(upload.objectPath)) continue;

        // Confirmed uploads have ACL metadata stamped at confirm time — keep them.
        if (upload.acl !== null) continue;

        const handle = await this.getObjectEntityFile(upload.objectPath);
        await handle.delete();
        deleted++;
      } catch {
        // Individual file error (already gone, permission, etc.) — skip.
      }
    }

    return deleted;
  }

  /**
   * Backstop reconciliation sweep. Lists every object under the uploads/ prefix
   * and deletes those older than graceMs that are no longer referenced by any
   * business record (work order, inspection item, or expense receipt).
   *
   * Unlike sweepUnconfirmedUploads — which only removes objects that were never
   * confirmed (no ACL metadata) — this reclaims CONFIRMED, formerly-LINKED blobs
   * orphaned by an interrupted record delete (tab closed or network dropped
   * before the client-driven storage delete ran). The provisional registry stops
   * tracking an object once it is linked, and no other sweep ever revisits a
   * once-linked object, so without this backstop such blobs leak forever.
   *
   * The grace period protects freshly uploaded objects that are confirmed but
   * not yet attached to a record (the legitimate pre-link preview window); it
   * must comfortably exceed that window so a normal upload-then-attach is never
   * raced. Objects of unknown/unparseable age are kept (fail-safe).
   *
   * Idempotent and safe to run repeatedly: it only deletes objects the DB no
   * longer references at scan time and tolerates objects that vanish between
   * listing and deletion. Returns the count of reclaimed objects.
   */
  async reconcileOrphanedUploads(graceMs: number): Promise<number> {
    const uploads = await this.backend.listUploads();
    const cutoffMs = Date.now() - graceMs;
    let deleted = 0;

    for (const upload of uploads) {
      try {
        const createdAt = upload.metadata.timeCreatedMs;
        // Keep anything within the grace window or with an unknown age.
        if (createdAt === null || !Number.isFinite(createdAt) || createdAt > cutoffMs) {
          continue;
        }

        // Never delete an object a live business record still points at.
        if (await isObjectPathReferenced(upload.objectPath)) continue;

        const handle = await this.getObjectEntityFile(upload.objectPath);
        await handle.delete();
        deleted++;
      } catch {
        // Individual file error (already gone, transient storage/DB) — skip; the
        // next run retries. Keeps the sweep non-aborting and idempotent.
      }
    }

    return deleted;
  }
}

/**
 * One-time startup cleanup: deletes GCS objects in the uploads/ prefix that
 * were never confirmed (no ACL) and are older than the upload registry TTL.
 * This covers the "restart gap" where the in-memory registry was cleared and
 * orphan blobs can no longer be tracked by the periodic sweep.
 *
 * Errors are logged and swallowed — startup must succeed even if GCS is
 * temporarily unreachable.
 */
export async function runStartupUploadCleanup(): Promise<void> {
  try {
    // Build the DB-linked set BEFORE touching GCS. Any object currently
    // referenced by a work order or inspection item must be preserved,
    // even if it has no ACL metadata (photos uploaded before this security
    // patch was deployed won't have ACL metadata yet but are legitimate).
    const linkedPaths = new Set<string>();

    const [woRows, itemRows, expenseRows] = await Promise.all([
      db.select({ photoUrls: workOrdersTable.photoUrls }).from(workOrdersTable),
      db.select({ photoUrls: inspectionItemsTable.photoUrls }).from(inspectionItemsTable),
      db.select({ receiptUrls: expensesTable.receiptUrls }).from(expensesTable),
    ]);

    for (const row of woRows) {
      for (const url of row.photoUrls ?? []) linkedPaths.add(url);
    }
    for (const row of itemRows) {
      for (const url of row.photoUrls ?? []) linkedPaths.add(url);
    }
    for (const row of expenseRows) {
      for (const url of row.receiptUrls ?? []) linkedPaths.add(url);
    }

    const svc = new ObjectStorageService();
    const deleted = await svc.sweepUnconfirmedUploads(UPLOAD_PENDING_TTL_MS, linkedPaths);
    if (deleted > 0) {
      logger.info(
        { deleted },
        "upload-cleanup: startup sweep deleted stale unconfirmed uploads from GCS",
      );
    }
  } catch (err) {
    logger.warn({ err }, "upload-cleanup: startup sweep failed — continuing without cleanup");
  }
}

/**
 * Runs the orphan-reconciliation backstop once and logs how many blobs were
 * reclaimed. Errors are logged and swallowed so a transient GCS/DB failure never
 * crashes the periodic timer or startup. Exported so the same sweep can also be
 * triggered on demand if an admin-facing path is ever added.
 */
export async function runOrphanReconciliation(): Promise<void> {
  try {
    const svc = new ObjectStorageService();
    const reclaimed = await svc.reconcileOrphanedUploads(RECONCILE_GRACE_MS);
    if (reclaimed > 0) {
      logger.info(
        { reclaimed },
        "upload-cleanup: reconciliation reclaimed orphaned uploads no longer referenced by any record",
      );
    }
  } catch (err) {
    logger.warn({ err }, "upload-cleanup: reconciliation sweep error");
  }
}

