/**
 * Regression test for the storage DELETE ownership check.
 *
 * Verifies that DELETE /storage/objects/* enforces object ownership before
 * deleting an unreferenced private file. A peer staff user who merely knows an
 * object path (e.g. from a shared work order) must receive 403 — they may not
 * destroy another user's draft or recently-detached upload.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent, seedAdmin, seedStaffUser } from "./helpers";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  registerConfirmedUpload,
} from "../src/lib/objectStorage";
import type { StorageObjectHandle } from "../src/lib/objectStorageBackend";

/** Returns a minimal StorageObjectHandle mock whose getAcl resolves to `ownerId`. */
function fakeHandle(ownerId: string): StorageObjectHandle {
  return {
    getMetadata: vi.fn().mockResolvedValue({ size: 1024, contentType: "image/jpeg" }),
    getAcl: vi.fn().mockResolvedValue({ owner: ownerId, visibility: "private" }),
    createReadStream: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    setAcl: vi.fn().mockResolvedValue(undefined),
  } as unknown as StorageObjectHandle;
}

describe("DELETE /storage/objects/* — ownership enforcement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 403 when a peer staff user tries to delete another user's orphaned file", async () => {
    const owner = await seedAdmin();
    const peer = await seedStaffUser(["workOrders"]);

    const objectPath = "/objects/uploads/ownership-regression-peer.jpg";

    // Stamp the in-memory confirmed-upload token under the owner's id.
    registerConfirmedUpload(objectPath, owner.id);

    // Peer has no confirmed token, so the handler probes storage then checks ACL.
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
      fakeHandle(String(owner.id)),
    );
    // ACL check returns false for the peer (not the owner).
    vi.spyOn(ObjectStorageService.prototype, "canAccessObjectEntity").mockImplementation(
      async ({ userId }) => userId === String(owner.id),
    );
    const deleteSpy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await agent()
      .delete("/api/storage/objects/uploads/ownership-regression-peer.jpg")
      .set("Cookie", peer.cookie)
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(403);
    // The file must NOT have been deleted.
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("allows the owner to delete their own unreferenced file via confirmed token (fast path)", async () => {
    const owner = await seedAdmin();

    const objectPath = "/objects/uploads/ownership-regression-owner.jpg";
    registerConfirmedUpload(objectPath, owner.id);

    // The fast path (confirmed token) means getObjectEntityFile is never called,
    // but we still need deleteObjectEntity to be mocked to avoid real storage I/O.
    const deleteSpy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await agent()
      .delete("/api/storage/objects/uploads/ownership-regression-owner.jpg")
      .set("Cookie", owner.cookie)
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(204);
    expect(deleteSpy).toHaveBeenCalledWith(objectPath);
  });

  it("returns 204 idempotently for an already-absent object without requiring ownership proof", async () => {
    // A peer who only has workOrders permission should get 204 (not 403) when
    // the object is already gone — there is nothing to protect.
    const peer = await seedStaffUser(["workOrders"]);

    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockRejectedValue(
      new ObjectNotFoundError("/objects/uploads/already-absent.jpg"),
    );

    const res = await agent()
      .delete("/api/storage/objects/uploads/already-absent.jpg")
      .set("Cookie", peer.cookie)
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(204);
  });

  it("returns 409 when the object is still referenced by a record (never deletes)", async () => {
    const { customersTable, vehiclesTable, workOrdersTable, db } = await import("@workspace/db");

    const admin = await seedAdmin();
    const [cust] = await db.insert(customersTable).values({ name: "WO Ref Customer" }).returning();
    const [veh] = await db
      .insert(vehiclesTable)
      .values({ customerId: cust.id, make: "Ford", model: "F-150", year: 2021 })
      .returning();
    const referenced = "/objects/uploads/ownership-regression-ref.jpg";
    await db.insert(workOrdersTable).values({
      customerId: cust.id,
      vehicleId: veh.id,
      title: "Ref WO",
      photoUrls: [referenced],
    });

    const deleteSpy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await agent()
      .delete("/api/storage/objects/uploads/ownership-regression-ref.jpg")
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(409);
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});
