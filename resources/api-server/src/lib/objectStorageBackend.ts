// ─────────────────────────────────────────────────────────────────────────────
// Object storage backend abstraction.
//
// The application stores private object entities (work-order / inspection
// photos, expense receipts) and reads them back through `/storage/**`. Two
// concrete backends implement the same interface:
//
//   - GcsObjectStorageBackend   — hosted mode (Replit object storage / GCS via
//                                 the sidecar credential source). Default.
//   - LocalObjectStorageBackend — desktop mode (Electron Windows hub). Stores
//                                 bytes on the local filesystem under
//                                 runtimeConfig.objectStorageDir so the product
//                                 works fully offline with no cloud dependency.
//
// The backend is selected once per process from runtimeConfig.storageBackend
// (which defaults to "local" in desktop mode, "gcs" in hosted mode, and can be
// overridden with STORAGE_BACKEND for tests). ObjectStorageService delegates to
// the selected backend and keeps all token-registry / ACL / cleanup invariants
// unchanged across both backends.
// ─────────────────────────────────────────────────────────────────────────────
import { Storage, type File } from "@google-cloud/storage";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { createReadStream } from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { runtimeConfig } from "@workspace/db";
import type { ObjectAclPolicy } from "./objectAcl";

// Custom GCS metadata key under which the ACL policy JSON is stored (hosted), and
// the sidecar key inside the local `.meta.json` companion file (desktop).
const ACL_POLICY_METADATA_KEY = "custom:aclPolicy";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

/**
 * Thrown when a requested private object does not exist. Defined here (the
 * lowest storage layer) and re-exported from objectStorage.ts so existing
 * importers (storage routes, photo cleanup) keep working unchanged.
 */
export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

// Maximum accepted upload size in bytes. Enforced at the API route boundary
// (express.raw limit + explicit length checks) AND defensively at the backend
// write seam below, so no internal caller can persist an oversized object even
// if it bypasses the route. Defined here (the lowest storage layer) and
// re-exported from objectStorage.ts so existing route importers keep working.
export const MAX_OBJECT_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Thrown by a backend `writeUpload` when the incoming byte count exceeds
 * MAX_OBJECT_UPLOAD_SIZE_BYTES. Re-exported from objectStorage.ts. In the normal
 * flow the route rejects oversized bodies first, so this is a defense-in-depth
 * backstop against future internal callers.
 */
export class UploadTooLargeError extends Error {
  constructor() {
    super("Upload exceeds the maximum allowed size");
    this.name = "UploadTooLargeError";
    Object.setPrototypeOf(this, UploadTooLargeError.prototype);
  }
}

/** Backend-neutral object metadata. */
export interface ObjectMetadata {
  /** Size in bytes (0 when unknown). */
  size: number;
  /** Raw stored content type ("" when unknown). */
  contentType: string;
  /** Creation time in epoch milliseconds, or null when the backend can't report it. */
  timeCreatedMs: number | null;
}

/**
 * A handle to a single stored object. All concrete backends return handles that
 * implement the same operations so ObjectStorageService never branches on the
 * backend type.
 */
export interface StorageObjectHandle {
  getMetadata(): Promise<ObjectMetadata>;
  createReadStream(): Readable;
  /** Returns the stored ACL policy, or null if none is set. */
  getAcl(): Promise<ObjectAclPolicy | null>;
  setAcl(policy: ObjectAclPolicy): Promise<void>;
  /** Deletes the object. Throws ObjectNotFoundError if it is already gone. */
  delete(): Promise<void>;
}

/** One entry returned by listUploads (used by the orphan-cleanup sweeps). */
export interface UploadListing {
  /** Canonical `/objects/uploads/<id>` path. */
  objectPath: string;
  metadata: ObjectMetadata;
  acl: ObjectAclPolicy | null;
}

export interface ObjectStorageBackend {
  /** Resolve a canonical `/objects/…` path to a handle. Throws ObjectNotFoundError if absent. */
  getPrivateObject(objectPath: string): Promise<StorageObjectHandle>;
  /** True if a canonical `/objects/…` path currently exists. Never throws. */
  privateObjectExists(objectPath: string): Promise<boolean>;
  /** Resolve a relative path against the configured public search paths. */
  searchPublicObject(relPath: string): Promise<StorageObjectHandle | null>;
  /** Write new upload bytes and return the canonical `/objects/uploads/<id>` path. */
  writeUpload(data: Buffer, contentType: string): Promise<string>;
  /**
   * Server-side copy an existing upload to a fresh UUID path (immutability
   * finalize). Returns the new canonical path and the destination metadata.
   * The returned metadata.contentType is normalized (lowercased, params
   * stripped) for the confirm-route safety check.
   */
  copyUpload(sourcePath: string): Promise<{ finalPath: string; metadata: ObjectMetadata }>;
  /** List every object under the uploads/ prefix (for orphan sweeps). */
  listUploads(): Promise<UploadListing[]>;
  /** Normalize a raw stored path to the canonical `/objects/…` form. */
  normalizeObjectPath(rawPath: string): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GCS / Replit sidecar backend (hosted mode — default, unchanged behavior).
// ─────────────────────────────────────────────────────────────────────────────
function parseObjectPath(p: string): { bucketName: string; objectName: string } {
  if (!p.startsWith("/")) {
    p = `/${p}`;
  }
  const pathParts = p.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }
  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");
  return { bucketName, objectName };
}

class GcsObjectStorageBackend implements ObjectStorageBackend {
  private storage = new Storage({
    credentials: {
      audience: "replit",
      subject_token_type: "access_token",
      token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
      type: "external_account",
      credential_source: {
        url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
        format: {
          type: "json",
          subject_token_field_name: "access_token",
        },
      },
      universe_domain: "googleapis.com",
    },
    projectId: "",
  });

  private getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths).",
      );
    }
    return paths;
  }

  private getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var.",
      );
    }
    return dir;
  }

  private privateDirWithSlash(): string {
    const dir = this.getPrivateObjectDir();
    return dir.endsWith("/") ? dir : `${dir}/`;
  }

  /** Build a File for a canonical `/objects/…` path (no existence check). */
  private fileForObjectPath(objectPath: string): File {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }
    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }
    const entityId = parts.slice(1).join("/");
    const objectEntityPath = `${this.privateDirWithSlash()}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    return this.storage.bucket(bucketName).file(objectName);
  }

  private handle(file: File): StorageObjectHandle {
    return {
      async getMetadata(): Promise<ObjectMetadata> {
        const [m] = await file.getMetadata();
        const size = Number(m.size ?? 0);
        const tc = m.timeCreated ? new Date(m.timeCreated as string).getTime() : NaN;
        return {
          size: Number.isFinite(size) ? size : 0,
          contentType: (m.contentType as string | undefined) ?? "",
          timeCreatedMs: Number.isFinite(tc) ? tc : null,
        };
      },
      createReadStream(): Readable {
        return file.createReadStream();
      },
      async getAcl(): Promise<ObjectAclPolicy | null> {
        const [m] = await file.getMetadata();
        const raw = (m?.metadata as Record<string, string> | undefined)?.[ACL_POLICY_METADATA_KEY];
        return raw ? (JSON.parse(raw) as ObjectAclPolicy) : null;
      },
      async setAcl(policy: ObjectAclPolicy): Promise<void> {
        await file.setMetadata({
          metadata: { [ACL_POLICY_METADATA_KEY]: JSON.stringify(policy) },
        });
      },
      async delete(): Promise<void> {
        await file.delete();
      },
    };
  }

  async getPrivateObject(objectPath: string): Promise<StorageObjectHandle> {
    const file = this.fileForObjectPath(objectPath);
    const [exists] = await file.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return this.handle(file);
  }

  async privateObjectExists(objectPath: string): Promise<boolean> {
    try {
      const file = this.fileForObjectPath(objectPath);
      const [exists] = await file.exists();
      return exists;
    } catch {
      return false;
    }
  }

  async searchPublicObject(relPath: string): Promise<StorageObjectHandle | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${relPath}`;
      const { bucketName, objectName } = parseObjectPath(fullPath);
      const file = this.storage.bucket(bucketName).file(objectName);
      const [exists] = await file.exists();
      if (exists) {
        return this.handle(file);
      }
    }
    return null;
  }

  async writeUpload(data: Buffer, contentType: string): Promise<string> {
    if (data.byteLength > MAX_OBJECT_UPLOAD_SIZE_BYTES) {
      throw new UploadTooLargeError();
    }
    const objectId = randomUUID();
    const fullPath = `${this.privateDirWithSlash()}uploads/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    await this.storage.bucket(bucketName).file(objectName).save(data, { contentType });
    return `/objects/uploads/${objectId}`;
  }

  async copyUpload(sourcePath: string): Promise<{ finalPath: string; metadata: ObjectMetadata }> {
    const sourceFile = this.fileForObjectPath(sourcePath);
    const [exists] = await sourceFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }

    const newObjectId = randomUUID();
    const destFullPath = `${this.privateDirWithSlash()}uploads/${newObjectId}`;
    const { bucketName, objectName } = parseObjectPath(destFullPath);
    const destFile = this.storage.bucket(bucketName).file(objectName);

    await sourceFile.copy(destFile);

    const [m] = await destFile.getMetadata();
    const size = Number(m.size ?? 0);
    const tc = m.timeCreated ? new Date(m.timeCreated as string).getTime() : NaN;
    const contentType = ((m.contentType as string | undefined) ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    return {
      finalPath: `/objects/uploads/${newObjectId}`,
      metadata: {
        size: Number.isFinite(size) ? size : 0,
        contentType,
        timeCreatedMs: Number.isFinite(tc) ? tc : null,
      },
    };
  }

  async listUploads(): Promise<UploadListing[]> {
    const { bucketName, objectName } = parseObjectPath(`${this.privateDirWithSlash()}uploads/`);
    const bucket = this.storage.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: objectName });
    const prefixDir = this.privateDirWithSlash();
    const out: UploadListing[] = [];
    for (const file of files) {
      // Derive the canonical /objects/<entityId> path from the full GCS path.
      const objectPath = this.normalizeObjectPath(`/${bucketName}/${file.name}`);
      if (!objectPath.startsWith("/objects/")) continue;
      const h = this.handle(file);
      try {
        const metadata = await h.getMetadata();
        const acl = await h.getAcl();
        out.push({ objectPath, metadata, acl });
      } catch {
        // Object vanished or transient error — skip this entry.
      }
    }
    // prefixDir referenced for clarity; normalizeObjectPath handles stripping.
    void prefixDir;
    return out;
  }

  normalizeObjectPath(rawPath: string): string {
    let rawObjectPath: string;
    if (rawPath.startsWith("https://storage.googleapis.com/")) {
      rawObjectPath = new URL(rawPath).pathname;
    } else if (rawPath.startsWith("/")) {
      rawObjectPath = rawPath;
    } else {
      return rawPath;
    }

    const objectEntityDir = this.privateDirWithSlash();
    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }
    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Local filesystem backend (desktop mode — Electron Windows hub).
//
// Layout under runtimeConfig.objectStorageDir:
//   <root>/private/uploads/<uuid>          object bytes
//   <root>/private/uploads/<uuid>.meta.json  { contentType, acl } sidecar
//   <root>/public/<rel>                     hand-placed public assets
//
// All canonical `/objects/<rest>` paths map to <root>/private/<rest>. Paths are
// sanitized so a malicious `..` segment can never escape the storage root.
// ─────────────────────────────────────────────────────────────────────────────
interface LocalMeta {
  contentType?: string;
  acl?: ObjectAclPolicy;
}

const EXT_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
};

function guessContentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return EXT_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export class LocalObjectStorageBackend implements ObjectStorageBackend {
  private root: string;
  private privateRoot: string;
  private publicRoot: string;

  // `root` defaults to the configured object-storage directory; tests pass an
  // explicit temp dir so they can exercise the local backend without flipping
  // the whole process into desktop mode.
  constructor(root: string = runtimeConfig.objectStorageDir) {
    this.root = path.resolve(root);
    this.privateRoot = path.join(this.root, "private");
    this.publicRoot = path.join(this.root, "public");
  }

  private resolveUnder(base: string, rel: string): string {
    const segments = rel.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) {
      throw new ObjectNotFoundError();
    }
    for (const s of segments) {
      if (s === "." || s === "..") {
        throw new ObjectNotFoundError();
      }
    }
    const resolved = path.resolve(base, ...segments);
    const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
    if (resolved !== base && !resolved.startsWith(baseWithSep)) {
      throw new ObjectNotFoundError();
    }
    return resolved;
  }

  private resolvePrivate(objectPath: string): string {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }
    const rest = objectPath.slice("/objects/".length);
    return this.resolveUnder(this.privateRoot, rest);
  }

  private metaPath(filePath: string): string {
    return `${filePath}.meta.json`;
  }

  private async readMeta(filePath: string): Promise<LocalMeta> {
    try {
      const raw = await fsp.readFile(this.metaPath(filePath), "utf8");
      return JSON.parse(raw) as LocalMeta;
    } catch {
      return {};
    }
  }

  private async writeMeta(filePath: string, meta: LocalMeta): Promise<void> {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(this.metaPath(filePath), JSON.stringify(meta), "utf8");
  }

  private async statMetadata(filePath: string, meta: LocalMeta): Promise<ObjectMetadata> {
    const st = await fsp.stat(filePath); // throws ENOENT if missing
    const created =
      Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    return {
      size: st.size,
      contentType: meta.contentType ?? guessContentType(filePath),
      timeCreatedMs: Number.isFinite(created) ? created : null,
    };
  }

  private localHandle(filePath: string, isPublic: boolean): StorageObjectHandle {
    const self = this;
    return {
      async getMetadata(): Promise<ObjectMetadata> {
        const meta = isPublic ? {} : await self.readMeta(filePath);
        return self.statMetadata(filePath, meta);
      },
      createReadStream(): Readable {
        return createReadStream(filePath);
      },
      async getAcl(): Promise<ObjectAclPolicy | null> {
        if (isPublic) return null;
        const meta = await self.readMeta(filePath);
        return meta.acl ?? null;
      },
      async setAcl(policy: ObjectAclPolicy): Promise<void> {
        const meta = await self.readMeta(filePath);
        meta.acl = policy;
        await self.writeMeta(filePath, meta);
      },
      async delete(): Promise<void> {
        try {
          await fsp.rm(filePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
            throw new ObjectNotFoundError();
          }
          throw err;
        }
        // Best-effort sidecar removal.
        try {
          await fsp.rm(self.metaPath(filePath));
        } catch {
          /* sidecar may not exist */
        }
      },
    };
  }

  async getPrivateObject(objectPath: string): Promise<StorageObjectHandle> {
    const filePath = this.resolvePrivate(objectPath);
    try {
      await fsp.access(filePath);
    } catch {
      throw new ObjectNotFoundError();
    }
    return this.localHandle(filePath, false);
  }

  async privateObjectExists(objectPath: string): Promise<boolean> {
    try {
      const filePath = this.resolvePrivate(objectPath);
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async searchPublicObject(relPath: string): Promise<StorageObjectHandle | null> {
    let filePath: string;
    try {
      filePath = this.resolveUnder(this.publicRoot, relPath);
    } catch {
      return null;
    }
    try {
      await fsp.access(filePath);
    } catch {
      return null;
    }
    return this.localHandle(filePath, true);
  }

  async writeUpload(data: Buffer, contentType: string): Promise<string> {
    if (data.byteLength > MAX_OBJECT_UPLOAD_SIZE_BYTES) {
      throw new UploadTooLargeError();
    }
    const objectId = randomUUID();
    const filePath = path.join(this.privateRoot, "uploads", objectId);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, data);
    await this.writeMeta(filePath, { contentType });
    return `/objects/uploads/${objectId}`;
  }

  async copyUpload(sourcePath: string): Promise<{ finalPath: string; metadata: ObjectMetadata }> {
    const sourceFile = this.resolvePrivate(sourcePath);
    try {
      await fsp.access(sourceFile);
    } catch {
      throw new ObjectNotFoundError();
    }

    const newObjectId = randomUUID();
    const destFile = path.join(this.privateRoot, "uploads", newObjectId);
    await fsp.mkdir(path.dirname(destFile), { recursive: true });
    await fsp.copyFile(sourceFile, destFile);

    const srcMeta = await this.readMeta(sourceFile);
    await this.writeMeta(destFile, { contentType: srcMeta.contentType });

    const meta = await this.statMetadata(destFile, { contentType: srcMeta.contentType });
    // Normalize content type for the confirm-route safety check (matches GCS).
    const contentType = (meta.contentType ?? "").split(";")[0].trim().toLowerCase();
    return {
      finalPath: `/objects/uploads/${newObjectId}`,
      metadata: { ...meta, contentType },
    };
  }

  async listUploads(): Promise<UploadListing[]> {
    const dir = path.join(this.privateRoot, "uploads");
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const out: UploadListing[] = [];
    for (const name of entries) {
      if (name.endsWith(".meta.json")) continue;
      const filePath = path.join(dir, name);
      const objectPath = `/objects/uploads/${name}`;
      try {
        const meta = await this.readMeta(filePath);
        const metadata = await this.statMetadata(filePath, meta);
        out.push({ objectPath, metadata, acl: meta.acl ?? null });
      } catch {
        // Entry vanished between readdir and stat — skip.
      }
    }
    return out;
  }

  normalizeObjectPath(rawPath: string): string {
    // Desktop never produces GCS https URLs; canonical paths pass through.
    return rawPath;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend singleton selection.
// ─────────────────────────────────────────────────────────────────────────────
let _backend: ObjectStorageBackend | null = null;

export function getObjectStorageBackend(): ObjectStorageBackend {
  if (_backend) return _backend;
  _backend =
    runtimeConfig.storageBackend === "local"
      ? new LocalObjectStorageBackend()
      : new GcsObjectStorageBackend();
  return _backend;
}
