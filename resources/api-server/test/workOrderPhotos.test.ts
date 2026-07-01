import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";
import { ObjectStorageService } from "../src/lib/objectStorage";

let admin: SeededAdmin;
let shop: SeededShop;

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

const withAuth = (t: ReturnType<ReturnType<typeof agent>["get"]>) =>
  t.set("Cookie", admin.cookie).set("X-Forwarded-Proto", "https");
const authPost = (path: string) => withAuth(agent().post(path));
const authPatch = (path: string) => withAuth(agent().patch(path));
const authDelete = (path: string) => withAuth(agent().delete(path));

// Fake object paths. getObjectEntitySizeBytes returns null for objects it
// cannot read, so size validation passes, and an admin bypasses the ownership
// check — letting us exercise the caption/reorder logic without real uploads.
const A = "/objects/uploads/photo-a.jpg";
const B = "/objects/uploads/photo-b.jpg";
const C = "/objects/uploads/photo-c.jpg";

async function createWorkOrder(body: Record<string, unknown>): Promise<{ id: number }> {
  const res = await authPost("/api/work-orders").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    title: "Photo test work order",
    ...body,
  });
  expect(res.status).toBe(201);
  return { id: res.body.id };
}

describe("work order photo captions persist", () => {
  it("stores captions supplied at creation and returns them keyed by path", async () => {
    const res = await authPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "With captions",
      photoUrls: [A, B],
      photoCaptions: { [A]: "front bumper scratch", [B]: "rear dent" },
    });
    expect(res.status).toBe(201);
    expect(res.body.photoCaptions).toEqual({
      [A]: "front bumper scratch",
      [B]: "rear dent",
    });
  });

  it("drops a caption whose photo is not in the photo list on create", async () => {
    const res = await authPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "Orphan caption",
      photoUrls: [A],
      photoCaptions: { [A]: "valid", [C]: "orphan - no matching photo" },
    });
    expect(res.status).toBe(201);
    expect(res.body.photoCaptions).toEqual({ [A]: "valid" });
  });

  it("ignores blank/whitespace-only captions", async () => {
    const res = await authPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "Blank caption",
      photoUrls: [A],
      photoCaptions: { [A]: "   " },
    });
    expect(res.status).toBe(201);
    expect(res.body.photoCaptions).toEqual({});
  });
});

describe("work order photo reordering and removal", () => {
  it("reordering photoUrls preserves the path-keyed captions", async () => {
    const { id } = await createWorkOrder({
      photoUrls: [A, B, C],
      photoCaptions: { [A]: "cap a", [B]: "cap b", [C]: "cap c" },
    });

    const res = await authPatch(`/api/work-orders/${id}`).send({ photoUrls: [C, A, B] });
    expect(res.status).toBe(200);
    expect(res.body.photoUrls).toEqual([C, A, B]);
    expect(res.body.photoCaptions).toEqual({ [A]: "cap a", [B]: "cap b", [C]: "cap c" });
  });

  it("removing a photo prunes its caption even when captions are not resent", async () => {
    const { id } = await createWorkOrder({
      photoUrls: [A, B],
      photoCaptions: { [A]: "cap a", [B]: "cap b" },
    });

    const res = await authPatch(`/api/work-orders/${id}`).send({ photoUrls: [A] });
    expect(res.status).toBe(200);
    expect(res.body.photoUrls).toEqual([A]);
    expect(res.body.photoCaptions).toEqual({ [A]: "cap a" });
  });

  it("updating only captions leaves the photo order untouched", async () => {
    const { id } = await createWorkOrder({
      photoUrls: [A, B],
      photoCaptions: { [A]: "old" },
    });

    const res = await authPatch(`/api/work-orders/${id}`).send({
      photoCaptions: { [A]: "new caption", [B]: "added caption" },
    });
    expect(res.status).toBe(200);
    expect(res.body.photoUrls).toEqual([A, B]);
    expect(res.body.photoCaptions).toEqual({ [A]: "new caption", [B]: "added caption" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /storage/objects/* — frees the underlying file once a photo is removed
// from its work order. The test objects do not exist in GCS, so an unreferenced
// delete resolves as "already gone" (204); the safety guard is exercised by a
// path that is still linked to a work order (409).
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /storage/objects – free removed photos", () => {
  it("returns 401 for unauthenticated requests", async () => {
    const res = await agent()
      .delete("/api/storage/objects/uploads/del-unauth.jpg")
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(401);
  });

  it("refuses (409) to delete an object still referenced by a work order", async () => {
    const keep = "/objects/uploads/del-still-linked.jpg";
    const { id } = await createWorkOrder({ photoUrls: [keep] });
    expect(id).toBeTruthy();

    const res = await authDelete(`/api/storage${keep}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still referenced/i);
  });

  it("deletes (204) an object no longer referenced, after it is removed from the work order", async () => {
    const stay = "/objects/uploads/del-stay.jpg";
    const drop = "/objects/uploads/del-drop.jpg";
    const { id } = await createWorkOrder({ photoUrls: [stay, drop] });

    // Remove `drop` from the work order's photo list first.
    const patch = await authPatch(`/api/work-orders/${id}`).send({ photoUrls: [stay] });
    expect(patch.status).toBe(200);
    expect(patch.body.photoUrls).toEqual([stay]);

    // Now `drop` is unreferenced — deletion is allowed. The object does not exist
    // in GCS in the test environment, so the handler treats it as already-gone
    // and still reports success (idempotent cleanup).
    const res = await authDelete(`/api/storage${drop}`);
    expect(res.status).toBe(204);
  });

  it("is idempotent: deleting an already-absent unreferenced object returns 204", async () => {
    const res = await authDelete("/api/storage/objects/uploads/never-existed.jpg");
    expect(res.status).toBe(204);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /work-orders/:id — frees every photo the work order exclusively owned.
// We spy on deleteObjectEntity to observe which paths the handler tries to free:
// unreferenced photos are deleted, photos still linked to another record are
// skipped, and the whole cleanup is best-effort (a storage failure does not
// fail the delete).
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /work-orders/:id – frees orphaned photos", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("frees each photo the deleted work order exclusively owned", async () => {
    const p1 = "/objects/uploads/wo-del-1.jpg";
    const p2 = "/objects/uploads/wo-del-2.jpg";
    const { id } = await createWorkOrder({ photoUrls: [p1, p2] });

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await authDelete(`/api/work-orders/${id}`);
    expect(res.status).toBe(204);

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).toContain(p1);
    expect(freed).toContain(p2);
  });

  it("does not free a photo still referenced by another work order", async () => {
    const shared = "/objects/uploads/wo-del-shared.jpg";
    const onlyHere = "/objects/uploads/wo-del-only.jpg";
    const keeper = await createWorkOrder({ photoUrls: [shared] });
    const { id } = await createWorkOrder({ photoUrls: [shared, onlyHere] });

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await authDelete(`/api/work-orders/${id}`);
    expect(res.status).toBe(204);

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).toContain(onlyHere);
    expect(freed).not.toContain(shared);

    // keeper still references `shared`; cleaning it up should remove the link.
    expect(keeper.id).toBeTruthy();
  });

  it("still deletes the work order when a photo cleanup fails (best-effort)", async () => {
    const boom = "/objects/uploads/wo-del-boom.jpg";
    const { id } = await createWorkOrder({ photoUrls: [boom] });

    vi.spyOn(ObjectStorageService.prototype, "deleteObjectEntity").mockRejectedValue(
      new Error("storage unavailable"),
    );

    const res = await authDelete(`/api/work-orders/${id}`);
    expect(res.status).toBe(204);

    // Confirm the row is actually gone despite the cleanup failure.
    const after = await withAuth(agent().get(`/api/work-orders/${id}`));
    expect(after.status).toBe(404);
  });
});
