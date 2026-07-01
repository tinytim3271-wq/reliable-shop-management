import express, { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  MAX_OBJECT_UPLOAD_SIZE_BYTES,
  isUploadTokenValid,
  registerConfirmedUpload,
  removeFromUploadRegistry,
  hasConfirmedUploadToken,
  isObjectPathReferenced,
  markUploadLinked,
  SAFE_INLINE_CONTENT_TYPES,
  verifyObjectUploadOwnership,
} from "../lib/objectStorage";
import { DOCUMENT_CONTENT_TYPES } from "../lib/documentExtract";
import { db, workOrdersTable, inspectionItemsTable, expensesTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// Content types accepted by the server-proxied upload endpoint: safe-inline
// images (rendered in <img>) plus the document types the AI chat can extract
// text from. Documents are accepted for upload but are still SERVED as
// application/octet-stream (they are not in SAFE_INLINE_CONTENT_TYPES), so they
// can never execute on the app origin.
const ACCEPTED_UPLOAD_CONTENT_TYPES = new Set<string>([
  ...SAFE_INLINE_CONTENT_TYPES,
  ...DOCUMENT_CONTENT_TYPES,
]);

// Bound the client-declared filename kept for document attachments: strip path
// separators and control characters so a stored label can never be used for
// traversal or to smuggle markup into a prompt, then cap the length.
function sanitizeUploadFileName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the raw value if it isn't valid percent-encoding.
  }
  const cleaned = decoded
    .replace(/[\r\n\t]+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[/\\]+/g, "_")
    .trim()
    .slice(0, 200);
  return cleaned || undefined;
}

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// ─────────────────────────────────────────────────────────────────────────────
// Per-user upload rate limiter for POST /storage/uploads.
//
// Limits authenticated users to 30 uploads and 500 MB total per hour.
// This applies to the actual bytes received by the server — not client-
// declared metadata — so it cannot be spoofed by under-declaring sizes.
// Memory-only; resets on server restart.
// ─────────────────────────────────────────────────────────────────────────────
const UPLOAD_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const UPLOAD_RATE_MAX_COUNT = 30;
const UPLOAD_RATE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB per window

interface UploadRateLimitEntry { count: number; bytes: number; windowStart: number }
const uploadRateLimiter = new Map<number, UploadRateLimitEntry>();

/**
 * Returns true if the user has capacity in their current window for an upload
 * of `byteCount` bytes. Increments both count and byte counters on success.
 */
function checkAndIncrementUploadRateLimit(userId: number, byteCount: number): boolean {
  const now = Date.now();
  const entry = uploadRateLimiter.get(userId);
  if (!entry || now - entry.windowStart >= UPLOAD_RATE_WINDOW_MS) {
    uploadRateLimiter.set(userId, { count: 1, bytes: byteCount, windowStart: now });
    return true;
  }
  if (entry.count >= UPLOAD_RATE_MAX_COUNT) return false;
  if (entry.bytes + byteCount > UPLOAD_RATE_MAX_BYTES) return false;
  entry.count++;
  entry.bytes += byteCount;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-process concurrency guard for POST /storage/uploads.
//
// express.raw buffers the entire body in memory before the handler runs.
// Without a concurrency cap, parallel large uploads can exhaust API memory.
// A low ceiling (3) is plenty for a small shop — users rarely upload
// multiple photos simultaneously.
//
// Per-user cap (MAX_CONCURRENT_UPLOADS_PER_USER = 1): each authenticated user
// may hold at most one upload slot at a time. This prevents a single insider
// from monopolising all global slots with slow-body connections and locking
// out every other user. The global ceiling remains as a memory backstop.
//
// UPLOAD_BODY_TIMEOUT_MS: after a slot is claimed the socket's inactivity
// timeout is set to this value. If no bytes arrive for 30 s, the socket is
// destroyed; the existing res.once("close", release) handler then frees both
// the global and per-user counters.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_CONCURRENT_UPLOADS = 3;
const MAX_CONCURRENT_UPLOADS_PER_USER = 1;
const UPLOAD_BODY_TIMEOUT_MS = 30_000; // 30 s inactivity limit per upload slot
let concurrentUploads = 0;
const concurrentUploadsByUser = new Map<number, number>();

/**
 * POST /storage/uploads
 *
 * Server-proxied file upload. The client sends the raw file bytes in the
 * request body with a Content-Type header matching the file's MIME type
 * and an optional X-File-Name header for the filename.
 *
 * The API server enforces a hard byte cap via express.raw({ limit }) — any
 * request body that exceeds MAX_OBJECT_UPLOAD_SIZE_BYTES is rejected by the
 * middleware with a 413 before the handler runs. Because the bytes flow
 * through the server, the size limit cannot be bypassed by under-declaring
 * metadata as is possible with a presigned PUT URL approach.
 *
 * On success the server writes the validated bytes directly to GCS and
 * returns a confirmed objectPath ready to be linked to a work order or
 * inspection item — no separate confirm step required.
 */
router.post(
  "/storage/uploads",
  // Concurrency guard: enforced BEFORE express.raw buffers the body in memory
  // so that concurrent oversized-body attacks cannot exhaust process heap.
  //
  // IMPORTANT: the slot is released via res.once('finish'/'close'), NOT in the
  // handler's finally block. express.raw can reject a request (e.g. 413 on an
  // oversized body) before the handler ever runs — in that case the handler's
  // finally would never execute and the counter would permanently leak.
  // Binding to res finish/close guarantees release on every code path:
  //   - normal success or handler error  → 'finish' fires when response is sent
  //   - parser error (413)               → 'finish' fires after error handler responds
  //   - client abort / connection drop   → 'close' fires
  // The 'released' flag prevents double-decrement when both events fire.
  (_req: Request, res: Response, next) => {
    const userId = _req.currentUser!.id;
    const userCount = concurrentUploadsByUser.get(userId) ?? 0;

    if (userCount >= MAX_CONCURRENT_UPLOADS_PER_USER) {
      res.status(429).json({ error: "You already have an upload in progress. Please wait for it to finish." });
      return;
    }
    if (concurrentUploads >= MAX_CONCURRENT_UPLOADS) {
      res.status(429).json({ error: "Too many simultaneous uploads. Please try again shortly." });
      return;
    }

    concurrentUploads++;
    concurrentUploadsByUser.set(userId, userCount + 1);

    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        concurrentUploads--;
        const remaining = (concurrentUploadsByUser.get(userId) ?? 1) - 1;
        if (remaining <= 0) {
          concurrentUploadsByUser.delete(userId);
        } else {
          concurrentUploadsByUser.set(userId, remaining);
        }
      }
    };
    res.once("finish", release);
    res.once("close", release);
    // Defend against slow-body slot-squatting: if the socket is idle (no bytes
    // received) for UPLOAD_BODY_TIMEOUT_MS, destroy it. The 'close' event on
    // the response then fires and both the global and per-user slots are freed.
    _req.setTimeout(UPLOAD_BODY_TIMEOUT_MS, () => { _req.socket?.destroy(); });
    next();
  },
  express.raw({ type: () => true, limit: MAX_OBJECT_UPLOAD_SIZE_BYTES }),
  async (req: Request, res: Response) => {
    const rawContentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();

    if (!ACCEPTED_UPLOAD_CONTENT_TYPES.has(rawContentType)) {
      res.status(400).json({ error: "Unsupported file type" });
      return;
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Request body is empty" });
      return;
    }

    // Belt-and-suspenders: verify actual byte count even though express.raw
    // already enforced the limit via the middleware above.
    if (body.length > MAX_OBJECT_UPLOAD_SIZE_BYTES) {
      res.status(413).json({
        error: `File exceeds the maximum allowed size of ${MAX_OBJECT_UPLOAD_SIZE_BYTES / (1024 * 1024)} MB`,
      });
      return;
    }

    // Rate limit: enforced on actual received bytes, not client-declared metadata.
    if (!checkAndIncrementUploadRateLimit(req.currentUser!.id, body.length)) {
      res.status(429).json({
        error: "Upload quota exceeded. You have reached the maximum uploads or total bytes for this hour.",
      });
      return;
    }

    try {
      const { objectPath } = await objectStorageService.writeObjectEntity(body, rawContentType);

      // Register as confirmed immediately — bytes were validated in this request.
      // Capture the client-declared filename (sanitized) so the AI chat can label
      // an attached document; the stored content type stays authoritative.
      const fileName = sanitizeUploadFileName(req.headers["x-file-name"]);
      registerConfirmedUpload(objectPath, req.currentUser!.id, {
        fileName,
        mimeType: rawContentType,
      });

      // Stamp a persistent ACL so ownership survives server restarts.
      try {
        await objectStorageService.trySetObjectEntityAclPolicy(objectPath, {
          owner: String(req.currentUser!.id),
          visibility: "private",
        });
      } catch {
        req.log.warn({ objectPath }, "Failed to set ACL on proxied upload — ownership relies on in-memory token until server restart");
      }

      res.status(201).json({ objectPath, confirmed: true });
    } catch (error) {
      req.log.error({ err: error }, "Error writing upload to object storage");
      res.status(500).json({ error: "Failed to store upload" });
    }
  },
);

/**
 * POST /storage/uploads/request-url — DISABLED
 *
 * This endpoint previously minted presigned GCS PUT URLs that bypassed the
 * API server's byte-enforcement layer, allowing arbitrarily large uploads
 * regardless of the declared size. It has been replaced by the server-proxied
 * POST /storage/uploads endpoint which enforces hard size limits in-process.
 */
router.post("/storage/uploads/request-url", (_req: Request, res: Response) => {
  res.status(410).json({
    error: "This endpoint has been removed. Use POST /api/storage/uploads to upload files.",
  });
});

/**
 * POST /storage/uploads/confirm
 *
 * Called by the client after the presigned PUT completes. Fetches the actual
 * GCS object metadata, validates real size and content-type, and auto-deletes
 * the object if it violates the caps — preventing oversized or wrong-type
 * blobs from persisting in private storage even when they are never linked to
 * a business record.
 */
router.post("/storage/uploads/confirm", async (req: Request, res: Response) => {
  const { objectPath } = req.body as { objectPath?: unknown };
  if (typeof objectPath !== "string" || !objectPath.startsWith("/objects/")) {
    res.status(400).json({ error: "Invalid objectPath" });
    return;
  }

  // Verify minting proof BEFORE any GCS interaction or ACL write.
  // Without this check, any staff user could call /confirm with a foreign
  // objectPath and overwrite its ACL owner — an ownership takeover attack.
  if (!isUploadTokenValid(objectPath, req.currentUser!.id)) {
    res.status(403).json({ error: "You can only confirm uploads you initiated" });
    return;
  }

  try {
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
    const metadata = await objectFile.getMetadata();
    const actualSize = Number(metadata.size ?? 0);
    const rawContentType = (metadata.contentType ?? "").split(";")[0].trim().toLowerCase();

    const sizeViolation = actualSize > MAX_OBJECT_UPLOAD_SIZE_BYTES;
    const typeViolation = rawContentType !== "" && !SAFE_INLINE_CONTENT_TYPES.has(rawContentType);

    if (sizeViolation || typeViolation) {
      // Auto-delete the non-compliant object so it cannot persist as an
      // orphaned blob incurring storage cost, and cannot be used even if
      // the client skips this confirmation step and tries to link it.
      try {
        await objectFile.delete();
      } catch {
        req.log.warn({ objectPath }, "Failed to auto-delete non-compliant object");
      }

      if (sizeViolation) {
        res.status(400).json({
          error: `Uploaded file exceeds the maximum allowed size of ${MAX_OBJECT_UPLOAD_SIZE_BYTES / (1024 * 1024)} MB`,
        });
      } else {
        res.status(400).json({ error: "Uploaded file has an unsupported content type" });
      }
      return;
    }

    // Finalize: server-side copy the validated object to a new UUID path, then
    // delete the original temp path. This is the immutability guard: the signed
    // PUT URL was minted for `objectPath` (the temp path). Once the original is
    // gone, any subsequent PUT to that URL either fails (object absent) or
    // creates a brand-new unconfirmed orphan that the sweep will remove.
    // The returned `finalPath` has no signed URL ever minted for it, so its
    // content can never be overwritten by the client.
    //
    // finalizeUpload also returns the destination's actual metadata so we can
    // re-validate after the copy. This closes the TOCTOU window: if the source
    // was overwritten between the pre-copy validation above and when GCS
    // executed the copy, the violation will show up in finalMeta.
    let finalPath: string;
    let finalMeta: { size: number; contentType: string };
    try {
      const finalized = await objectStorageService.finalizeUpload(objectPath);
      finalPath = finalized.finalPath;
      finalMeta = finalized.metadata;
    } catch (finalizeErr) {
      req.log.error({ err: finalizeErr }, "Error finalizing upload");
      res.status(500).json({ error: "Failed to finalize upload" });
      return;
    }

    // Re-validate the destination to catch any TOCTOU overwrite that slipped in
    // between the pre-copy check and the actual GCS copy execution. If the
    // destination violates the caps, delete it before returning an error so it
    // cannot linger as a confirmed-but-oversized object.
    const finalSizeViolation = finalMeta.size > MAX_OBJECT_UPLOAD_SIZE_BYTES;
    const finalTypeViolation = finalMeta.contentType !== "" && !SAFE_INLINE_CONTENT_TYPES.has(finalMeta.contentType);
    if (finalSizeViolation || finalTypeViolation) {
      try {
        await objectStorageService.deleteObjectEntity(finalPath);
      } catch {
        req.log.warn({ objectPath: finalPath }, "Failed to auto-delete non-compliant finalized object");
      }
      if (finalSizeViolation) {
        res.status(400).json({
          error: `Uploaded file exceeds the maximum allowed size of ${MAX_OBJECT_UPLOAD_SIZE_BYTES / (1024 * 1024)} MB`,
        });
      } else {
        res.status(400).json({ error: "Uploaded file has an unsupported content type" });
      }
      return;
    }

    // Register the finalized path as confirmed and invalidate the old temp path
    // so it can no longer satisfy ownership or preview checks.
    registerConfirmedUpload(finalPath, req.currentUser!.id);
    removeFromUploadRegistry(objectPath);

    // Stamp a persistent ACL on the finalized object so link-time ownership
    // verification can fall back to GCS metadata after a server restart
    // (when the in-memory registry has been cleared).
    try {
      await objectStorageService.trySetObjectEntityAclPolicy(finalPath, {
        owner: String(req.currentUser!.id),
        visibility: "private",
      });
    } catch {
      req.log.warn({ objectPath: finalPath }, "Failed to set ACL on finalized upload — ownership relies on in-memory confirmed token until server restart");
    }

    res.json({ objectPath: finalPath, confirmed: true });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error confirming upload");
    res.status(500).json({ error: "Failed to confirm upload" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve private object entities from PRIVATE_OBJECT_DIR.
 * Requires authentication and either the `workOrders` or `inspections` module
 * permission (enforced by authGate). If the object has an ACL policy attached,
 * that policy is enforced on top of the module-permission gate. Objects are
 * served inline only when their Content-Type is a known-safe image type; all
 * other types are forced to download as application/octet-stream to prevent
 * active-content execution.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    // Record-level ownership check: the object must either be (a) linked to a
    // business record the caller has module permission to access, OR (b) owned
    // by the caller via a confirmed upload token (pre-link preview — allows the
    // uploader to preview a freshly uploaded photo before attaching it to a
    // record). Admins are exempted (they short-circuit in authGate).
    if (req.currentUser?.role !== "admin") {
      const user = req.currentUser!;

      // Fast path: caller holds a confirmed upload token for this object.
      // This covers the "just uploaded, not yet linked" preview window without
      // a DB round-trip.
      const ownedByConfirmedToken = hasConfirmedUploadToken(objectPath, user.id);

      if (!ownedByConfirmedToken) {
        const [woRef] = await db
          .select({ id: workOrdersTable.id })
          .from(workOrdersTable)
          .where(sql`${objectPath} = ANY(${workOrdersTable.photoUrls})`)
          .limit(1);

        const [iiRef] = await db
          .select({ id: inspectionItemsTable.id })
          .from(inspectionItemsTable)
          .where(sql`${objectPath} = ANY(${inspectionItemsTable.photoUrls})`)
          .limit(1);

        const [expRef] = await db
          .select({ id: expensesTable.id })
          .from(expensesTable)
          .where(sql`${objectPath} = ANY(${expensesTable.receiptUrls})`)
          .limit(1);

        const accessibleViaWorkOrder =
          !!woRef && user.permissions.includes("workOrders");
        const accessibleViaInspection =
          !!iiRef && user.permissions.includes("inspections");
        const accessibleViaExpense =
          !!expRef && user.permissions.includes("accounting");

        if (
          !accessibleViaWorkOrder &&
          !accessibleViaInspection &&
          !accessibleViaExpense
        ) {
          res.status(403).json({ error: "Access denied" });
          return;
        }

        // Defense-in-depth: enforce the stored sourceModule stamp.
        //
        // Record-linkage alone is insufficient when a raced attachment request
        // managed to cross-link an object into a second module before the first
        // module's ACL write was visible. The sourceModule stamp is written
        // atomically (first-write-wins, serialized by the per-path mutex in
        // trySetObjectEntityAclPolicy) and is immutable once set. Enforcing it
        // here means an accounting receipt cross-linked into an inspection item
        // by a race is still gated on the `accounting` permission, not the
        // weaker `inspections` permission.
        //
        // The sourceModule→permission map mirrors the write-path assignments in
        // workOrders.ts, inspections.ts, and expenses.ts. If sourceModule is
        // unset (legacy upload or upload-endpoint-only ACL), the record-linkage
        // check above is the sole gate, preserving backward compatibility.
        const acl = await objectFile.getAcl();
        if (acl?.sourceModule) {
          const sourceModulePermission: Record<string, string> = {
            workOrders: "workOrders",
            inspections: "inspections",
            accounting: "accounting",
          };
          const required = sourceModulePermission[acl.sourceModule];
          if (required !== undefined && !user.permissions.includes(required)) {
            res.status(403).json({ error: "Access denied" });
            return;
          }
        }
      }
    }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    // Prevent browser MIME-type sniffing regardless of content type.
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Only allow safe image types to render inline. Any other content type
    // (including HTML, SVG, PDF, or unknown types) is forced to download as
    // an opaque binary to prevent stored-XSS / same-origin script execution.
    const storedContentType = (
      (response.headers.get("Content-Type") ?? "application/octet-stream")
        .split(";")[0]
        .trim()
        .toLowerCase()
    );
    if (!SAFE_INLINE_CONTENT_TYPES.has(storedContentType)) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", "attachment");
    }

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

/**
 * DELETE /storage/objects/*
 *
 * Frees a private object entity from GCS once it has been removed from the
 * record that linked it (e.g. a photo dropped from a work order's photoUrls).
 * Called by the client after the PATCH that shortened the photo list has
 * committed, so the underlying file does not linger as an orphaned blob.
 *
 * Safe by construction:
 *   - Refuses to delete an object that is still referenced by any work order or
 *     inspection item (returns 409) — a file is never removed out from under a
 *     record that still points at it.
 *   - Treats an already-absent object as success (idempotent), so a retried or
 *     duplicate cleanup request does not error.
 *
 * Authorization: the module gate (authGate requires workOrders, inspections,
 * or accounting permission) is the outer guard. Additionally, only the ACL
 * owner of the object may delete it — a peer staff user who merely saw the
 * path from a shared record is denied (403). Objects already absent from
 * storage are treated as idempotent 204 without an ownership proof.
 */
router.delete("/storage/objects/*path", async (req: Request, res: Response) => {
  const raw = req.params.path;
  const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
  const objectPath = `/objects/${wildcardPath}`;

  try {
    // Safety guard: never delete an object a record still references.
    if (await isObjectPathReferenced(objectPath)) {
      res.status(409).json({ error: "Object is still referenced by a record" });
      return;
    }

    // Ownership check: only the uploader (ACL owner) may delete an unreferenced
    // private object. This prevents a peer staff user who merely saw the path
    // from destroying another user's draft or recently-detached file.
    const userId = req.currentUser?.id;
    if (userId == null) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Fast path: confirmed in-memory token proves ownership without a storage
    // roundtrip. If no confirmed token exists for this user, probe storage to
    // distinguish "object is already gone" (idempotent 204) from "object exists
    // but caller does not own it" (403).
    if (!hasConfirmedUploadToken(objectPath, userId)) {
      try {
        await objectStorageService.getObjectEntityFile(objectPath);
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          // Object is already absent — nothing to protect, idempotent cleanup.
          removeFromUploadRegistry(objectPath);
          markUploadLinked(objectPath);
          res.status(204).end();
          return;
        }
        throw err;
      }
      // Object exists in storage; verify ACL ownership before allowing deletion.
      const isOwner = await verifyObjectUploadOwnership(objectPath, userId, objectStorageService);
      if (!isOwner) {
        res.status(403).json({ error: "Forbidden: you do not own this object" });
        return;
      }
    }

    try {
      await objectStorageService.deleteObjectEntity(objectPath);
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
      // Already gone — nothing to delete. Fall through to registry cleanup and
      // report success so the cleanup is idempotent.
    }

    // Invalidate any in-memory tokens so the path can no longer satisfy
    // ownership/preview checks, and drop it from the provisional-orphan sweep.
    removeFromUploadRegistry(objectPath);
    markUploadLinked(objectPath);

    res.status(204).end();
  } catch (error) {
    req.log.error({ err: error }, "Error deleting object");
    res.status(500).json({ error: "Failed to delete object" });
  }
});

export default router;
