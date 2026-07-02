import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { Readable } from "stream";
import {
  LocalObjectStorageBackend,
  ObjectNotFoundError,
  UploadTooLargeError,
  MAX_OBJECT_UPLOAD_SIZE_BYTES,
} from "../src/lib/objectStorageBackend";
import type { ObjectAclPolicy } from "../src/lib/objectAcl";

// Desktop-mode object storage: the Electron Windows hub stores photos and
// receipts on the local filesystem instead of GCS. These tests exercise the
// local backend directly (with a temp root) so the desktop upload/read/delete
// path is verified without flipping the whole process into desktop mode.

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

describe("LocalObjectStorageBackend (desktop mode)", () => {
  let root: string;
  let backend: LocalObjectStorageBackend;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rss-storage-test-"));
    backend = new LocalObjectStorageBackend(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes an upload and reads back identical bytes and metadata", async () => {
    const objectPath = await backend.writeUpload(PNG_BYTES, "image/png");
    expect(objectPath).toMatch(/^\/objects\/uploads\/[0-9a-f-]+$/);

    expect(await backend.privateObjectExists(objectPath)).toBe(true);

    const handle = await backend.getPrivateObject(objectPath);
    const meta = await handle.getMetadata();
    expect(meta.size).toBe(PNG_BYTES.length);
    expect(meta.contentType).toBe("image/png");
    expect(typeof meta.timeCreatedMs).toBe("number");

    const bytes = await drain(handle.createReadStream());
    expect(bytes.equals(PNG_BYTES)).toBe(true);
  });

  it("round-trips an ACL policy via the sidecar meta file", async () => {
    const objectPath = await backend.writeUpload(PNG_BYTES, "image/png");
    const handle = await backend.getPrivateObject(objectPath);

    expect(await handle.getAcl()).toBeNull();

    const policy: ObjectAclPolicy = {
      owner: "user-123",
      visibility: "private",
      sourceModule: "inspections",
    };
    await handle.setAcl(policy);

    const fresh = await backend.getPrivateObject(objectPath);
    expect(await fresh.getAcl()).toEqual(policy);
  });

  it("finalizes an upload via copyUpload to a fresh path with normalized content type", async () => {
    const sourcePath = await backend.writeUpload(PNG_BYTES, "image/PNG; charset=binary");
    const { finalPath, metadata } = await backend.copyUpload(sourcePath);

    expect(finalPath).toMatch(/^\/objects\/uploads\/[0-9a-f-]+$/);
    expect(finalPath).not.toBe(sourcePath);
    expect(metadata.size).toBe(PNG_BYTES.length);
    expect(metadata.contentType).toBe("image/png");

    const copyBytes = await drain(
      (await backend.getPrivateObject(finalPath)).createReadStream(),
    );
    expect(copyBytes.equals(PNG_BYTES)).toBe(true);
  });

  it("deletes an object and reports it gone afterwards", async () => {
    const objectPath = await backend.writeUpload(PNG_BYTES, "image/png");
    const handle = await backend.getPrivateObject(objectPath);

    await handle.delete();

    expect(await backend.privateObjectExists(objectPath)).toBe(false);
    await expect(backend.getPrivateObject(objectPath)).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it("throws ObjectNotFoundError when deleting a missing object", async () => {
    const handle = await backend.getPrivateObject(
      await backend.writeUpload(PNG_BYTES, "image/png"),
    );
    await handle.delete();
    await expect(handle.delete()).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("lists uploads with metadata and ACL, excluding sidecar files", async () => {
    const isolatedRoot = await mkdtemp(path.join(tmpdir(), "rss-storage-list-"));
    const isolated = new LocalObjectStorageBackend(isolatedRoot);
    try {
      const a = await isolated.writeUpload(PNG_BYTES, "image/png");
      const b = await isolated.writeUpload(PNG_BYTES, "image/png");
      await (await isolated.getPrivateObject(b)).setAcl({
        owner: "user-9",
        visibility: "private",
      });

      const listing = await isolated.listUploads();
      const paths = listing.map((u) => u.objectPath).sort();
      expect(paths).toEqual([a, b].sort());
      // No `.meta.json` sidecar entries should leak into the listing.
      expect(listing.every((u) => !u.objectPath.endsWith(".meta.json"))).toBe(true);

      const withAcl = listing.find((u) => u.objectPath === b);
      expect(withAcl?.acl?.owner).toBe("user-9");
      const withoutAcl = listing.find((u) => u.objectPath === a);
      expect(withoutAcl?.acl).toBeNull();
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("rejects an upload larger than the maximum allowed size without persisting it", async () => {
    const isolatedRoot = await mkdtemp(path.join(tmpdir(), "rss-storage-big-"));
    const isolated = new LocalObjectStorageBackend(isolatedRoot);
    try {
      const oversize = Buffer.alloc(MAX_OBJECT_UPLOAD_SIZE_BYTES + 1, 0);
      await expect(
        isolated.writeUpload(oversize, "image/png"),
      ).rejects.toBeInstanceOf(UploadTooLargeError);

      // The oversize write must not leave any object behind.
      expect(await isolated.listUploads()).toEqual([]);

      // A buffer exactly at the limit is still accepted.
      const atLimit = Buffer.alloc(MAX_OBJECT_UPLOAD_SIZE_BYTES, 0);
      const objectPath = await isolated.writeUpload(atLimit, "image/png");
      expect(await isolated.privateObjectExists(objectPath)).toBe(true);
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("rejects path-traversal attempts instead of escaping the storage root", async () => {
    await expect(
      backend.getPrivateObject("/objects/../../etc/passwd"),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
    expect(await backend.privateObjectExists("/objects/../secret")).toBe(false);
    // Paths outside the /objects/ namespace are not valid private objects.
    await expect(
      backend.getPrivateObject("/not-objects/foo"),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("serves hand-placed public assets and ignores traversal", async () => {
    const publicDir = path.join(root, "public", "logos");
    await mkdir(publicDir, { recursive: true });
    await writeFile(path.join(publicDir, "logo.png"), PNG_BYTES);

    const found = await backend.searchPublicObject("logos/logo.png");
    expect(found).not.toBeNull();
    const bytes = await drain(found!.createReadStream());
    expect(bytes.equals(PNG_BYTES)).toBe(true);

    expect(await backend.searchPublicObject("missing.png")).toBeNull();
    expect(await backend.searchPublicObject("../private/uploads")).toBeNull();
  });
});
