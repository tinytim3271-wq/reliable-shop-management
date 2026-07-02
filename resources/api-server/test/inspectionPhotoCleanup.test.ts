import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { agent, seedAdmin, seedCustomerVehicle, type SeededAdmin, type SeededShop } from "./helpers";
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
const authDelete = (path: string) => withAuth(agent().delete(path));

// Fake object paths. getObjectEntitySizeBytes returns null for objects it
// cannot read, so size validation passes, and an admin bypasses the upload
// ownership check — letting us attach paths without real uploads.
async function createInspectionWithPhotos(
  photoSets: string[][],
  vehicleId = shop.vehicleId,
): Promise<number> {
  const created = await authPost("/api/inspections").send({
    vehicleId,
    title: "Cleanup test inspection",
  });
  expect(created.status).toBe(201);
  const inspectionId = created.body.id as number;

  for (const [i, photoUrls] of photoSets.entries()) {
    const item = await authPost(`/api/inspections/${inspectionId}/items`).send({
      name: `Item ${i}`,
      condition: "fail",
      photoUrls,
    });
    expect(item.status).toBe(201);
  }
  return inspectionId;
}

describe("DELETE /inspections/:id – frees orphaned item photos server-side", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("frees every photo the deleted inspection's items exclusively owned", async () => {
    const p1 = "/objects/uploads/insp-del-1.jpg";
    const p2 = "/objects/uploads/insp-del-2.jpg";
    const id = await createInspectionWithPhotos([[p1], [p2]]);

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await authDelete(`/api/inspections/${id}`);
    expect(res.status).toBe(204);

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).toContain(p1);
    expect(freed).toContain(p2);
  });

  it("does not free a photo still referenced by a work order", async () => {
    const shared = "/objects/uploads/insp-del-shared.jpg";
    const onlyHere = "/objects/uploads/insp-del-only.jpg";

    // A work order also references `shared`, so it must survive the inspection delete.
    const wo = await authPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "Keeps shared photo",
      photoUrls: [shared],
    });
    expect(wo.status).toBe(201);

    const id = await createInspectionWithPhotos([[shared, onlyHere]]);

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await authDelete(`/api/inspections/${id}`);
    expect(res.status).toBe(204);

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).toContain(onlyHere);
    expect(freed).not.toContain(shared);
  });

  it("still deletes the inspection when a photo cleanup fails (best-effort)", async () => {
    const boom = "/objects/uploads/insp-del-boom.jpg";
    const id = await createInspectionWithPhotos([[boom]]);

    vi.spyOn(ObjectStorageService.prototype, "deleteObjectEntity").mockRejectedValue(
      new Error("storage unavailable"),
    );

    const res = await authDelete(`/api/inspections/${id}`);
    expect(res.status).toBe(204);

    const after = await withAuth(agent().get(`/api/inspections/${id}`));
    expect(after.status).toBe(404);
  });
});
