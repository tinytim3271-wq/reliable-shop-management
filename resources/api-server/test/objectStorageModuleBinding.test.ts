import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";
import { ObjectStorageService, ObjectAclRebindingError } from "../src/lib/objectStorage";

let admin: SeededAdmin;
let shop: SeededShop;

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const withAdmin = (t: ReturnType<ReturnType<typeof agent>["get"]>) =>
  t.set("Cookie", admin.cookie).set("X-Forwarded-Proto", "https");

// ─────────────────────────────────────────────────────────────────────────────
// Cross-module binding rejection — ObjectAclRebindingError
//
// These tests verify that the route handlers surface ObjectAclRebindingError
// (thrown by trySetObjectEntityAclPolicy when an object is already bound to a
// different sourceModule) as a 403 and do not persist the record. The spy
// overrides the global success mock installed by setup.ts.
// ─────────────────────────────────────────────────────────────────────────────
describe("cross-module ACL rebinding rejection", () => {
  it("POST /work-orders rejects photoUrls bound to a different module", async () => {
    vi.spyOn(ObjectStorageService.prototype, "trySetObjectEntityAclPolicy")
      .mockRejectedValue(new ObjectAclRebindingError("accounting", "workOrders"));

    const res = await withAdmin(agent().post("/api/work-orders")).send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "Rebind test",
      photoUrls: ["/objects/uploads/rebind-wo.jpg"],
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/already assigned to a different module/i);
  });

  it("PATCH /work-orders/:id rejects photoUrls bound to a different module", async () => {
    const create = await withAdmin(agent().post("/api/work-orders")).send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "Rebind patch base",
    });
    expect(create.status).toBe(201);

    vi.spyOn(ObjectStorageService.prototype, "trySetObjectEntityAclPolicy")
      .mockRejectedValue(new ObjectAclRebindingError("inspections", "workOrders"));

    const res = await withAdmin(agent().patch(`/api/work-orders/${create.body.id}`)).send({
      photoUrls: ["/objects/uploads/rebind-wo-patch.jpg"],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/already assigned to a different module/i);
  });

  it("POST /inspections/:id/items rejects photoUrls bound to a different module", async () => {
    const insp = await withAdmin(agent().post("/api/inspections")).send({
      vehicleId: shop.vehicleId,
      title: "Rebind insp",
    });
    expect(insp.status).toBe(201);

    vi.spyOn(ObjectStorageService.prototype, "trySetObjectEntityAclPolicy")
      .mockRejectedValue(new ObjectAclRebindingError("workOrders", "inspections"));

    const res = await withAdmin(
      agent().post(`/api/inspections/${insp.body.id}/items`),
    ).send({
      name: "Brake pads",
      photoUrls: ["/objects/uploads/rebind-insp.jpg"],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/already assigned to a different module/i);
  });

  it("PATCH /inspections/:id/items/:itemId rejects photoUrls bound to a different module", async () => {
    const insp = await withAdmin(agent().post("/api/inspections")).send({
      vehicleId: shop.vehicleId,
      title: "Rebind insp patch",
    });
    expect(insp.status).toBe(201);
    const item = await withAdmin(
      agent().post(`/api/inspections/${insp.body.id}/items`),
    ).send({ name: "Tire" });
    expect(item.status).toBe(201);
    const itemId = item.body.items[0]?.id;
    expect(itemId).toBeTruthy();

    vi.spyOn(ObjectStorageService.prototype, "trySetObjectEntityAclPolicy")
      .mockRejectedValue(new ObjectAclRebindingError("accounting", "inspections"));

    const res = await withAdmin(
      agent().patch(`/api/inspections/${insp.body.id}/items/${itemId}`),
    ).send({
      photoUrls: ["/objects/uploads/rebind-insp-patch.jpg"],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/already assigned to a different module/i);
  });

  it("POST /expenses rejects receiptUrls bound to a different module", async () => {
    vi.spyOn(ObjectStorageService.prototype, "trySetObjectEntityAclPolicy")
      .mockRejectedValue(new ObjectAclRebindingError("workOrders", "accounting"));

    const res = await withAdmin(agent().post("/api/expenses")).send({
      date: "2025-06-01",
      description: "Oil supplier",
      amount: 45.0,
      receiptUrls: ["/objects/uploads/rebind-exp.jpg"],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/already assigned to a different module/i);
  });

  it("PATCH /expenses/:id rejects receiptUrls bound to a different module", async () => {
    const create = await withAdmin(agent().post("/api/expenses")).send({
      date: "2025-06-01",
      description: "Parts order",
      amount: 120.0,
    });
    expect(create.status).toBe(201);

    vi.spyOn(ObjectStorageService.prototype, "trySetObjectEntityAclPolicy")
      .mockRejectedValue(new ObjectAclRebindingError("inspections", "accounting"));

    const res = await withAdmin(agent().patch(`/api/expenses/${create.body.id}`)).send({
      receiptUrls: ["/objects/uploads/rebind-exp-patch.jpg"],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/already assigned to a different module/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed on GCS metadata errors
//
// These tests verify that a generic storage error (GCS unavailable) also blocks
// the record attach — module binding cannot be silently skipped on transient
// infrastructure failures.
// ─────────────────────────────────────────────────────────────────────────────
describe("fail-closed on ACL stamping errors", () => {
  it("POST /work-orders blocks photoUrls when ACL stamping throws a generic error", async () => {
    vi.spyOn(ObjectStorageService.prototype, "trySetObjectEntityAclPolicy")
      .mockRejectedValue(new Error("GCS metadata service unavailable"));

    const res = await withAdmin(agent().post("/api/work-orders")).send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: "GCS fail test",
      photoUrls: ["/objects/uploads/gcs-fail-wo.jpg"],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/unable to verify file module assignment/i);
  });

  it("POST /expenses blocks receiptUrls when ACL stamping throws a generic error", async () => {
    vi.spyOn(ObjectStorageService.prototype, "trySetObjectEntityAclPolicy")
      .mockRejectedValue(new Error("GCS metadata service unavailable"));

    const res = await withAdmin(agent().post("/api/expenses")).send({
      date: "2025-06-01",
      description: "Supply run",
      amount: 30.0,
      receiptUrls: ["/objects/uploads/gcs-fail-exp.jpg"],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/unable to verify file module assignment/i);
  });

  it("POST /inspections/:id/items blocks photoUrls when ACL stamping throws a generic error", async () => {
    const insp = await withAdmin(agent().post("/api/inspections")).send({
      vehicleId: shop.vehicleId,
      title: "GCS fail insp",
    });
    expect(insp.status).toBe(201);

    vi.spyOn(ObjectStorageService.prototype, "trySetObjectEntityAclPolicy")
      .mockRejectedValue(new Error("GCS metadata service unavailable"));

    const res = await withAdmin(
      agent().post(`/api/inspections/${insp.body.id}/items`),
    ).send({
      name: "Coolant hose",
      photoUrls: ["/objects/uploads/gcs-fail-insp.jpg"],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/unable to verify file module assignment/i);
  });
});
