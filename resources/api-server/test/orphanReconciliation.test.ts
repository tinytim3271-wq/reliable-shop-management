import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { db, customersTable, vehiclesTable, workOrdersTable } from "@workspace/db";
import { ObjectStorageService } from "../src/lib/objectStorage";
import {
  getObjectStorageBackend,
  type StorageObjectHandle,
  type UploadListing,
} from "../src/lib/objectStorageBackend";

// Mirrors the production grace window (objectStorage.ts RECONCILE_GRACE_MS).
const GRACE_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// The reconcile sweep is backend-agnostic: it lists uploads via the active
// backend, drops aged + unreferenced objects, and deletes them through a
// StorageObjectHandle. These tests stub those two seams (listUploads + the
// per-object handle) so the service logic is exercised without a real GCS or
// local-filesystem backend, while isObjectPathReferenced still hits the DB.

interface FakeUpload {
  listing: UploadListing;
  objectPath: string;
  delete: ReturnType<typeof vi.fn>;
}

// Builds a fake upload whose age is `ageMs` in the past. `objectPath` is the
// canonical /objects/uploads/<id> path used by DB records and reference checks.
function fakeUpload(ageMs: number, deleteImpl?: () => Promise<void>): FakeUpload {
  const objectPath = `/objects/uploads/${randomUUID()}`;
  const del = vi.fn(deleteImpl ?? (async () => {}));
  return {
    objectPath,
    delete: del,
    listing: {
      objectPath,
      metadata: {
        size: 1024,
        contentType: "image/png",
        timeCreatedMs: Date.now() - ageMs,
      },
      acl: null,
    },
  };
}

// Points the active backend's listUploads at a fixed set for the next sweep, and
// routes getObjectEntityFile to each upload's fake delete handle by path.
function mockSweep(uploads: FakeUpload[]): void {
  vi.spyOn(getObjectStorageBackend(), "listUploads").mockResolvedValue(
    uploads.map((u) => u.listing),
  );
  const byPath = new Map(uploads.map((u) => [u.objectPath, u]));
  vi.spyOn(
    ObjectStorageService.prototype,
    "getObjectEntityFile",
  ).mockImplementation(async (objectPath: string) => {
    const u = byPath.get(objectPath);
    if (!u) throw new Error(`unexpected getObjectEntityFile(${objectPath})`);
    return { delete: u.delete } as unknown as StorageObjectHandle;
  });
}

// Inserts a work order that references `objectPath` so isObjectPathReferenced
// reports it as still-linked.
async function linkPhotoToWorkOrder(objectPath: string): Promise<void> {
  const [c] = await db
    .insert(customersTable)
    .values({ name: "Recon Customer" })
    .returning();
  const [v] = await db
    .insert(vehiclesTable)
    .values({ customerId: c.id, make: "Honda", model: "Civic", year: 2021 })
    .returning();
  await db.insert(workOrdersTable).values({
    customerId: c.id,
    vehicleId: v.id,
    title: "Recon WO",
    photoUrls: [objectPath],
  });
}

describe("ObjectStorageService.reconcileOrphanedUploads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reclaims aged orphans but keeps referenced and fresh objects", async () => {
    // Aged + unreferenced — the interrupted-delete orphan this backstop targets.
    const orphan = fakeUpload(48 * HOUR_MS);
    // Aged but still linked to a live work order — must never be deleted.
    const referenced = fakeUpload(48 * HOUR_MS);
    await linkPhotoToWorkOrder(referenced.objectPath);
    // Recently uploaded, not yet linked — protected by the grace window.
    const fresh = fakeUpload(1 * HOUR_MS);

    mockSweep([orphan, referenced, fresh]);

    const reclaimed = await new ObjectStorageService().reconcileOrphanedUploads(
      GRACE_MS,
    );

    expect(reclaimed).toBe(1);
    expect(orphan.delete).toHaveBeenCalledTimes(1);
    expect(referenced.delete).not.toHaveBeenCalled();
    expect(fresh.delete).not.toHaveBeenCalled();
  });

  it("is best-effort: a failing delete does not abort the sweep or inflate the count", async () => {
    const boom = fakeUpload(48 * HOUR_MS, async () => {
      throw new Error("storage unavailable");
    });
    const ok = fakeUpload(48 * HOUR_MS);

    mockSweep([boom, ok]);

    const reclaimed = await new ObjectStorageService().reconcileOrphanedUploads(
      GRACE_MS,
    );

    // The failing object was attempted but not counted; the next orphan is still
    // processed (the sweep does not abort on a per-object error).
    expect(boom.delete).toHaveBeenCalledTimes(1);
    expect(ok.delete).toHaveBeenCalledTimes(1);
    expect(reclaimed).toBe(1);
  });

  it("is idempotent: a re-run after the orphan is gone reclaims nothing", async () => {
    const referenced = fakeUpload(48 * HOUR_MS);
    await linkPhotoToWorkOrder(referenced.objectPath);
    const fresh = fakeUpload(1 * HOUR_MS);

    // Second pass: the orphan was already deleted by the first run, so the list
    // only contains the still-referenced and the fresh object.
    mockSweep([referenced, fresh]);

    const reclaimed = await new ObjectStorageService().reconcileOrphanedUploads(
      GRACE_MS,
    );

    expect(reclaimed).toBe(0);
    expect(referenced.delete).not.toHaveBeenCalled();
    expect(fresh.delete).not.toHaveBeenCalled();
  });
});
