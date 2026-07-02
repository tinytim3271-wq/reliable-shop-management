import { afterEach, describe, expect, it, vi } from "vitest";
import {
  db,
  customersTable,
  vehiclesTable,
  workOrdersTable,
  inspectionsTable,
  inspectionItemsTable,
} from "@workspace/db";
import { agent, seedAdmin } from "./helpers";
import { ObjectStorageService } from "../src/lib/objectStorage";
import {
  collectCustomerCascadePhotoPaths,
  collectVehicleCascadePhotoPaths,
} from "../src/lib/photoCleanup";

async function makeCustomer(name = "Cascade Customer"): Promise<number> {
  const [c] = await db.insert(customersTable).values({ name }).returning();
  return c.id;
}

async function makeVehicle(customerId: number): Promise<number> {
  const [v] = await db
    .insert(vehiclesTable)
    .values({ customerId, make: "Honda", model: "Civic", year: 2020 })
    .returning();
  return v.id;
}

async function makeWorkOrder(args: {
  customerId: number;
  vehicleId: number;
  photoUrls: string[];
}): Promise<number> {
  const [wo] = await db
    .insert(workOrdersTable)
    .values({
      customerId: args.customerId,
      vehicleId: args.vehicleId,
      title: "Cascade WO",
      photoUrls: args.photoUrls,
    })
    .returning();
  return wo.id;
}

async function makeInspectionItem(args: {
  vehicleId: number;
  photoUrls: string[];
}): Promise<void> {
  const [insp] = await db
    .insert(inspectionsTable)
    .values({ vehicleId: args.vehicleId, title: "Cascade inspection" })
    .returning();
  await db.insert(inspectionItemsTable).values({
    inspectionId: insp.id,
    name: "Brakes",
    photoUrls: args.photoUrls,
  });
}

describe("collectVehicleCascadePhotoPaths", () => {
  it("gathers photos from work orders and inspection items on the vehicle", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const wo = "/objects/uploads/veh-wo.jpg";
    const ins = "/objects/uploads/veh-ins.jpg";
    await makeWorkOrder({ customerId, vehicleId, photoUrls: [wo] });
    await makeInspectionItem({ vehicleId, photoUrls: [ins] });

    const paths = await collectVehicleCascadePhotoPaths(vehicleId);
    expect(paths).toContain(wo);
    expect(paths).toContain(ins);
  });
});

describe("collectCustomerCascadePhotoPaths", () => {
  it("gathers photos from work orders (direct and via vehicles) and inspections", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    // Work order linked through the vehicle (mismatched customerId is still
    // gathered because the vehicle cascade removes it).
    const otherCustomer = await makeCustomer("Other");
    const viaVehicle = "/objects/uploads/cust-via-vehicle.jpg";
    await makeWorkOrder({
      customerId: otherCustomer,
      vehicleId,
      photoUrls: [viaVehicle],
    });
    const ins = "/objects/uploads/cust-ins.jpg";
    await makeInspectionItem({ vehicleId, photoUrls: [ins] });

    const paths = await collectCustomerCascadePhotoPaths(customerId);
    expect(paths).toContain(viaVehicle);
    expect(paths).toContain(ins);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /customers/:id — frees photos owned by rows the cascade removes.
// The delete guards normally block deleting a customer that still has work
// orders/inspections, but a work order whose customerId points elsewhere while
// its vehicleId belongs to this customer slips past the guard and is removed by
// the vehicle cascade. Its photo must still be freed.
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /customers/:id – frees cascade-orphaned photos", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("frees a photo from a work order removed by the vehicle cascade", async () => {
    const admin = await seedAdmin();
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const otherCustomer = await makeCustomer("Mismatch");
    const orphan = "/objects/uploads/cust-cascade-orphan.jpg";
    await makeWorkOrder({
      customerId: otherCustomer,
      vehicleId,
      photoUrls: [orphan],
    });

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await agent()
      .delete(`/api/customers/${customerId}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(204);

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).toContain(orphan);
  });

  it("does not free a photo still referenced by a surviving record", async () => {
    const admin = await seedAdmin();
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const otherCustomer = await makeCustomer("Mismatch2");
    const shared = "/objects/uploads/cust-cascade-shared.jpg";
    await makeWorkOrder({
      customerId: otherCustomer,
      vehicleId,
      photoUrls: [shared],
    });
    // A surviving work order (different customer + vehicle) still points at the
    // same object, so the cascade cleanup must keep it.
    const keeperCustomer = await makeCustomer("Keeper");
    const keeperVehicle = await makeVehicle(keeperCustomer);
    await makeWorkOrder({
      customerId: keeperCustomer,
      vehicleId: keeperVehicle,
      photoUrls: [shared],
    });

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await agent()
      .delete(`/api/customers/${customerId}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(204);

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).not.toContain(shared);
  });

  it("still deletes the customer when photo cleanup fails (best-effort)", async () => {
    const admin = await seedAdmin();
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const otherCustomer = await makeCustomer("Mismatch3");
    const boom = "/objects/uploads/cust-cascade-boom.jpg";
    await makeWorkOrder({
      customerId: otherCustomer,
      vehicleId,
      photoUrls: [boom],
    });

    vi.spyOn(ObjectStorageService.prototype, "deleteObjectEntity").mockRejectedValue(
      new Error("storage unavailable"),
    );

    const res = await agent()
      .delete(`/api/customers/${customerId}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(204);

    const after = await agent()
      .get(`/api/customers/${customerId}`)
      .set("Cookie", admin.cookie)
      .set("X-Forwarded-Proto", "https");
    expect(after.status).toBe(404);
  });
});

// Note: the vehicle delete guard blocks deletion whenever ANY work order,
// estimate, invoice, or inspection references the vehicle, so a vehicle delete
// can never cascade into a photo-owning row through the route. The cleanup wired
// into DELETE /vehicles/:id is therefore defense-in-depth; its gathering logic
// is exercised by collectVehicleCascadePhotoPaths above.
