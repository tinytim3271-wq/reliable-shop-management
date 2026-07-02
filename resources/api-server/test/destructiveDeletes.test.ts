import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  customersTable,
  vehiclesTable,
  workOrdersTable,
  workOrderLineItemsTable,
  laborSessionsTable,
  estimatesTable,
  estimateLineItemsTable,
  invoicesTable,
  invoiceLineItemsTable,
  invoicePaymentsTable,
  expensesTable,
  inspectionsTable,
  inspectionItemsTable,
  partsTable,
  stockMovementsTable,
  mechanicsTable,
  timeEntriesTable,
  advancesTable,
  loansTable,
} from "@workspace/db";
import {
  agent,
  seedAdmin,
  seedStaffUser,
  uniqueName,
  type SeededAdmin,
} from "./helpers";
import { ObjectStorageService } from "../src/lib/objectStorage";
import {
  collectVehicleCascadePhotoPaths,
  freeOrphanedPhotos,
} from "../src/lib/photoCleanup";

// Exercises the destructive delete paths now that the suite runs against an
// isolated, disposable database (see globalSetup.ts). Covers three concerns:
//   1. ON DELETE CASCADE actually removes dependent rows.
//   2. Referential delete guards block deletes that would orphan / destroy
//      records the caller shouldn't be able to reach (409).
//   3. Deletes are permission-gated and fail closed (403) for callers without
//      the owning module permission.

let admin: SeededAdmin;

beforeAll(async () => {
  admin = await seedAdmin();
});

const auth = (
  t: ReturnType<ReturnType<typeof agent>["delete"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const adminDelete = (path: string) => auth(agent().delete(path), admin.cookie);

// ── small db seed helpers (no FK guards in the way) ──────────────────────────

async function makeCustomer(name = "Delete Test Customer"): Promise<number> {
  const [c] = await db.insert(customersTable).values({ name }).returning();
  return c.id;
}

async function makeVehicle(customerId: number): Promise<number> {
  const [v] = await db
    .insert(vehiclesTable)
    .values({ customerId, make: "Toyota", model: "Corolla", year: 2018 })
    .returning();
  return v.id;
}

async function makeMechanic(): Promise<number> {
  const [m] = await db
    .insert(mechanicsTable)
    .values({ name: "Delete Test Mechanic", hourlyRate: 40, status: "active" })
    .returning();
  return m.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cascade: deleting a customer removes its vehicles (ON DELETE CASCADE).
// The customer delete guard blocks customers with work orders / estimates /
// invoices / inspections, so a customer with only plain vehicles is the path
// that actually reaches the cascade.
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /customers/:id cascades into vehicles", () => {
  it("removes the customer's vehicles when the customer is deleted", async () => {
    const customerId = await makeCustomer();
    const vehicleA = await makeVehicle(customerId);
    const vehicleB = await makeVehicle(customerId);

    const res = await adminDelete(`/api/customers/${customerId}`);
    expect(res.status).toBe(204);

    const survivors = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.customerId, customerId));
    expect(survivors).toHaveLength(0);

    const stillThere = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable);
    const ids = stillThere.map((r) => r.id);
    expect(ids).not.toContain(vehicleA);
    expect(ids).not.toContain(vehicleB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cascade: deleting an estimate removes its line items.
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /estimates/:id cascades into estimate line items", () => {
  it("removes the estimate's line items when the estimate is deleted", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const [est] = await db
      .insert(estimatesTable)
      .values({ customerId, vehicleId, status: "draft" })
      .returning();
    await db.insert(estimateLineItemsTable).values([
      { estimateId: est.id, type: "labor", description: "Diagnostic", quantity: 1, unitPrice: 90 },
      { estimateId: est.id, type: "part", description: "Filter", quantity: 2, unitPrice: 12 },
    ]);

    const res = await adminDelete(`/api/estimates/${est.id}`);
    expect(res.status).toBe(204);

    const remaining = await db
      .select({ id: estimateLineItemsTable.id })
      .from(estimateLineItemsTable)
      .where(eq(estimateLineItemsTable.estimateId, est.id));
    expect(remaining).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cascade: deleting an invoice removes its line items AND its payments.
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /invoices/:id cascades into line items and payments", () => {
  it("removes the invoice's line items and payments when the invoice is deleted", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const [inv] = await db
      .insert(invoicesTable)
      .values({ customerId, vehicleId, status: "draft", taxRate: 0, amountPaid: 50 })
      .returning();
    await db.insert(invoiceLineItemsTable).values([
      { invoiceId: inv.id, type: "labor", description: "Service", quantity: 1, unitPrice: 100 },
    ]);
    await db.insert(invoicePaymentsTable).values([
      { invoiceId: inv.id, amount: 50, method: "cash" },
    ]);

    const res = await adminDelete(`/api/invoices/${inv.id}`);
    expect(res.status).toBe(204);

    const lineItems = await db
      .select({ id: invoiceLineItemsTable.id })
      .from(invoiceLineItemsTable)
      .where(eq(invoiceLineItemsTable.invoiceId, inv.id));
    expect(lineItems).toHaveLength(0);

    const payments = await db
      .select({ id: invoicePaymentsTable.id })
      .from(invoicePaymentsTable)
      .where(eq(invoicePaymentsTable.invoiceId, inv.id));
    expect(payments).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cascade: deleting a mechanic removes their time entries, advances, and loans.
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /mechanics/:id cascades into payroll records", () => {
  it("removes the mechanic's time entries, advances, and loans", async () => {
    const mechanicId = await makeMechanic();
    await db.insert(timeEntriesTable).values({
      mechanicId,
      date: "2099-01-02",
      hours: 8,
      rate: 40,
      totalPay: 320,
    });
    await db.insert(advancesTable).values({
      mechanicId,
      date: "2099-01-03",
      amount: 100,
    });
    await db.insert(loansTable).values({
      mechanicId,
      date: "2099-01-04",
      amountBorrowed: 500,
      amountRepaid: 0,
    });

    const res = await adminDelete(`/api/mechanics/${mechanicId}`);
    expect(res.status).toBe(204);

    const entries = await db
      .select({ id: timeEntriesTable.id })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.mechanicId, mechanicId));
    expect(entries).toHaveLength(0);

    const advances = await db
      .select({ id: advancesTable.id })
      .from(advancesTable)
      .where(eq(advancesTable.mechanicId, mechanicId));
    expect(advances).toHaveLength(0);

    const loans = await db
      .select({ id: loansTable.id })
      .from(loansTable)
      .where(eq(loansTable.mechanicId, mechanicId));
    expect(loans).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cascade + stock reversal: deleting a work order removes its line items and
// labor sessions (ON DELETE CASCADE), and reverses any stock it had deducted,
// writing the reversal to the stock-movement ledger.
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /work-orders/:id cascades and reverses deducted stock", () => {
  it("removes the work order's line items and labor sessions", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const mechanicId = await makeMechanic();
    const [wo] = await db
      .insert(workOrdersTable)
      .values({ customerId, vehicleId, title: "Cascade WO" })
      .returning();
    await db.insert(workOrderLineItemsTable).values([
      { workOrderId: wo.id, type: "labor", description: "Diagnose", quantity: 1, unitPrice: 90 },
      { workOrderId: wo.id, type: "part", description: "Belt", quantity: 1, unitPrice: 20 },
    ]);
    await db.insert(laborSessionsTable).values([
      { workOrderId: wo.id, mechanicId },
    ]);

    const res = await adminDelete(`/api/work-orders/${wo.id}`);
    expect(res.status).toBe(204);

    const lineItems = await db
      .select({ id: workOrderLineItemsTable.id })
      .from(workOrderLineItemsTable)
      .where(eq(workOrderLineItemsTable.workOrderId, wo.id));
    expect(lineItems).toHaveLength(0);

    const sessions = await db
      .select({ id: laborSessionsTable.id })
      .from(laborSessionsTable)
      .where(eq(laborSessionsTable.workOrderId, wo.id));
    expect(sessions).toHaveLength(0);
  });

  it("restores on-hand stock the work order had deducted", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    // Catalog parts are matched by description, so use a unique name to avoid
    // colliding with parts seeded elsewhere in the shared run database.
    const partName = uniqueName("WO Delete Brake Pad");
    const [part] = await db
      .insert(partsTable)
      .values({ name: partName, quantityOnHand: 10, reorderLevel: 1, unitPrice: 25 })
      .returning();
    const [wo] = await db
      .insert(workOrdersTable)
      .values({ customerId, vehicleId, title: "Stock WO", stockDeducted: true })
      .returning();
    // Mirror a committed deduction: the WO carries the part line and on-hand has
    // already been reduced by the deducted quantity.
    await db.insert(workOrderLineItemsTable).values([
      { workOrderId: wo.id, type: "part", description: partName, quantity: 3, unitPrice: 25 },
    ]);
    await db
      .update(partsTable)
      .set({ quantityOnHand: 7 })
      .where(eq(partsTable.id, part.id));

    const res = await adminDelete(`/api/work-orders/${wo.id}`);
    expect(res.status).toBe(204);

    const [after] = await db
      .select({ quantityOnHand: partsTable.quantityOnHand })
      .from(partsTable)
      .where(eq(partsTable.id, part.id));
    // The 3 units the WO held are credited back to on-hand.
    expect(after.quantityOnHand).toBe(10);

    // The reversal must also be recorded in the append-only stock-movement
    // ledger so the audit log never drifts from the count.
    const moves = await db
      .select({
        delta: stockMovementsTable.delta,
        sourceType: stockMovementsTable.sourceType,
        sourceId: stockMovementsTable.sourceId,
      })
      .from(stockMovementsTable)
      .where(eq(stockMovementsTable.partId, part.id));
    const reversal = moves.find((m) => m.sourceId === wo.id);
    expect(reversal).toBeTruthy();
    expect(reversal!.delta).toBe(3);
    expect(reversal!.sourceType).toBe("work_order");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cascade: deleting an inspection removes its inspection items.
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /inspections/:id cascades into inspection items", () => {
  it("removes the inspection's items when the inspection is deleted", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const [insp] = await db
      .insert(inspectionsTable)
      .values({ vehicleId, title: "Multi-point inspection" })
      .returning();
    await db.insert(inspectionItemsTable).values([
      { inspectionId: insp.id, name: "Brakes", condition: "pass" },
      { inspectionId: insp.id, name: "Tires", condition: "attention" },
    ]);

    const res = await adminDelete(`/api/inspections/${insp.id}`);
    expect(res.status).toBe(204);

    const remaining = await db
      .select({ id: inspectionItemsTable.id })
      .from(inspectionItemsTable)
      .where(eq(inspectionItemsTable.inspectionId, insp.id));
    expect(remaining).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete guards: a customer / vehicle with linked business records cannot be
// deleted (409). This protects records (work orders, inspections) the customer
// cascade would otherwise destroy.
// ─────────────────────────────────────────────────────────────────────────────
describe("delete guards block deletes that would destroy linked records", () => {
  it("blocks deleting a customer that still has a work order (409)", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    await db
      .insert(workOrdersTable)
      .values({ customerId, vehicleId, title: "Open WO" });

    const res = await adminDelete(`/api/customers/${customerId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/work orders/i);

    // The customer (and its vehicle) must survive a blocked delete.
    const [survivor] = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(eq(customersTable.id, customerId));
    expect(survivor).toBeTruthy();
  });

  it("blocks deleting a vehicle that still has an inspection (409)", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    await db
      .insert(inspectionsTable)
      .values({ vehicleId, title: "Pre-purchase inspection" });

    const res = await adminDelete(`/api/vehicles/${vehicleId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/inspections/i);

    const [survivor] = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, vehicleId));
    expect(survivor).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Permission gating: destructive deletes must fail closed (403) for callers
// who lack the owning module permission, and the target row must survive.
// ─────────────────────────────────────────────────────────────────────────────
describe("destructive deletes fail closed for unauthorized callers", () => {
  it("rejects DELETE /customers/:id without the customers permission (403)", async () => {
    const staff = await seedStaffUser(["invoices"], "no-customers");
    const customerId = await makeCustomer();

    const res = await auth(
      agent().delete(`/api/customers/${customerId}`),
      staff.cookie,
    );
    expect(res.status).toBe(403);

    const [survivor] = await db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(eq(customersTable.id, customerId));
    expect(survivor).toBeTruthy();
  });

  it("rejects DELETE /vehicles/:id without the customers permission (403)", async () => {
    const staff = await seedStaffUser(["workOrders"], "no-vehicles");
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);

    const res = await auth(
      agent().delete(`/api/vehicles/${vehicleId}`),
      staff.cookie,
    );
    expect(res.status).toBe(403);

    const [survivor] = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, vehicleId));
    expect(survivor).toBeTruthy();
  });

  it("rejects DELETE /estimates/:id without the estimates permission (403)", async () => {
    const staff = await seedStaffUser(["customers"], "no-estimates");
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const [est] = await db
      .insert(estimatesTable)
      .values({ customerId, vehicleId, status: "draft" })
      .returning();

    const res = await auth(
      agent().delete(`/api/estimates/${est.id}`),
      staff.cookie,
    );
    expect(res.status).toBe(403);

    const [survivor] = await db
      .select({ id: estimatesTable.id })
      .from(estimatesTable)
      .where(eq(estimatesTable.id, est.id));
    expect(survivor).toBeTruthy();
  });

  it("rejects DELETE /invoices/:id without the invoices permission (403)", async () => {
    const staff = await seedStaffUser(["customers"], "no-invoices");
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const [inv] = await db
      .insert(invoicesTable)
      .values({ customerId, vehicleId, status: "draft", taxRate: 0 })
      .returning();

    const res = await auth(
      agent().delete(`/api/invoices/${inv.id}`),
      staff.cookie,
    );
    expect(res.status).toBe(403);

    const [survivor] = await db
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, inv.id));
    expect(survivor).toBeTruthy();
  });

  it("rejects DELETE /work-orders/:id without the workOrders permission (403)", async () => {
    const staff = await seedStaffUser(["customers"], "no-workorders");
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const [wo] = await db
      .insert(workOrdersTable)
      .values({ customerId, vehicleId, title: "Protected WO" })
      .returning();

    const res = await auth(
      agent().delete(`/api/work-orders/${wo.id}`),
      staff.cookie,
    );
    expect(res.status).toBe(403);

    const [survivor] = await db
      .select({ id: workOrdersTable.id })
      .from(workOrdersTable)
      .where(eq(workOrdersTable.id, wo.id));
    expect(survivor).toBeTruthy();
  });

  it("rejects DELETE /inspections/:id without the inspections permission (403)", async () => {
    const staff = await seedStaffUser(["customers"], "no-inspections");
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const [insp] = await db
      .insert(inspectionsTable)
      .values({ vehicleId, title: "Protected inspection" })
      .returning();

    const res = await auth(
      agent().delete(`/api/inspections/${insp.id}`),
      staff.cookie,
    );
    expect(res.status).toBe(403);

    const [survivor] = await db
      .select({ id: inspectionsTable.id })
      .from(inspectionsTable)
      .where(eq(inspectionsTable.id, insp.id));
    expect(survivor).toBeTruthy();
  });

  it("rejects DELETE /mechanics/:id without the payroll permission (403)", async () => {
    const staff = await seedStaffUser(["timeTracking"], "no-payroll-mech");
    const mechanicId = await makeMechanic();

    const res = await auth(
      agent().delete(`/api/mechanics/${mechanicId}`),
      staff.cookie,
    );
    expect(res.status).toBe(403);

    const [survivor] = await db
      .select({ id: mechanicsTable.id })
      .from(mechanicsTable)
      .where(eq(mechanicsTable.id, mechanicId));
    expect(survivor).toBeTruthy();
  });

  // time-entry deletes change payroll totals, so they require the payroll
  // permission even though the route lives under the timeTracking module.
  it("rejects DELETE /time-entries/:id for a timeTracking-only caller (403)", async () => {
    const staff = await seedStaffUser(["timeTracking"], "no-payroll-te");
    const mechanicId = await makeMechanic();
    const [entry] = await db
      .insert(timeEntriesTable)
      .values({ mechanicId, date: "2099-02-01", hours: 5, rate: 40, totalPay: 200 })
      .returning();

    const res = await auth(
      agent().delete(`/api/time-entries/${entry.id}`),
      staff.cookie,
    );
    expect(res.status).toBe(403);

    const [survivor] = await db
      .select({ id: timeEntriesTable.id })
      .from(timeEntriesTable)
      .where(eq(timeEntriesTable.id, entry.id));
    expect(survivor).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Photo reclamation: alongside cascading child rows (and reversing stock), both
// the work-order and inspection DELETE handlers run a best-effort
// freeOrphanedPhotos step after the row is gone. It must free the object-storage
// blobs the deleted record owned, but never free a path another surviving record
// still references. deleteObjectEntity is spied so we can observe which blobs the
// handler tried to free without touching real GCS. Paths use uniqueName so they
// can't collide with records seeded by other files in the shared run database
// (isObjectPathReferenced would otherwise see a stray cross-file reference).
// ─────────────────────────────────────────────────────────────────────────────
describe("destructive deletes reclaim orphaned object-storage photos", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("frees a deleted work order's exclusive photo but keeps one shared with another record", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const shared = `/objects/uploads/${uniqueName("wo-photo-shared")}.jpg`;
    const exclusive = `/objects/uploads/${uniqueName("wo-photo-exclusive")}.jpg`;

    // A surviving work order keeps `shared` referenced after the delete, so the
    // shared blob must NOT be freed when the other work order is removed.
    await db
      .insert(workOrdersTable)
      .values({ customerId, vehicleId, title: "Keeper WO", photoUrls: [shared] });

    const [wo] = await db
      .insert(workOrdersTable)
      .values({ customerId, vehicleId, title: "Photo WO", photoUrls: [shared, exclusive] })
      .returning();

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await adminDelete(`/api/work-orders/${wo.id}`);
    expect(res.status).toBe(204);

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).toContain(exclusive);
    expect(freed).not.toContain(shared);
  });

  it("frees a deleted inspection's item photos but keeps one shared with a work order", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const shared = `/objects/uploads/${uniqueName("insp-photo-shared")}.jpg`;
    const exclusive = `/objects/uploads/${uniqueName("insp-photo-exclusive")}.jpg`;

    // A work order keeps `shared` referenced after the inspection (and its items)
    // cascade away, so the shared blob must survive the inspection delete.
    await db
      .insert(workOrdersTable)
      .values({ customerId, vehicleId, title: "Keeper WO", photoUrls: [shared] });

    const [insp] = await db
      .insert(inspectionsTable)
      .values({ vehicleId, title: "Photo inspection" })
      .returning();
    await db.insert(inspectionItemsTable).values([
      { inspectionId: insp.id, name: "Brakes", condition: "fail", photoUrls: [shared] },
      { inspectionId: insp.id, name: "Tires", condition: "fail", photoUrls: [exclusive] },
    ]);

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await adminDelete(`/api/inspections/${insp.id}`);
    expect(res.status).toBe(204);

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).toContain(exclusive);
    expect(freed).not.toContain(shared);
  });

  it("frees a single deleted inspection item's exclusive photo but keeps one shared with a surviving item", async () => {
    const customerId = await makeCustomer();
    const vehicleId = await makeVehicle(customerId);
    const shared = `/objects/uploads/${uniqueName("insp-item-shared")}.jpg`;
    const exclusive = `/objects/uploads/${uniqueName("insp-item-exclusive")}.jpg`;

    const [insp] = await db
      .insert(inspectionsTable)
      .values({ vehicleId, title: "Single-item photo inspection" })
      .returning();
    // A sibling item keeps `shared` referenced after the target item is removed,
    // so the shared blob must survive the single-item delete.
    await db.insert(inspectionItemsTable).values({
      inspectionId: insp.id,
      name: "Keeper item",
      condition: "pass",
      photoUrls: [shared],
    });
    const [item] = await db
      .insert(inspectionItemsTable)
      .values({
        inspectionId: insp.id,
        name: "Photo item",
        condition: "fail",
        photoUrls: [shared, exclusive],
      })
      .returning();

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await adminDelete(`/api/inspections/${insp.id}/items/${item.id}`);
    expect(res.status).toBe(204);

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).toContain(exclusive);
    expect(freed).not.toContain(shared);
  });

  it("frees a deleted expense's exclusive receipt but keeps one shared with another expense", async () => {
    const shared = `/objects/uploads/${uniqueName("exp-receipt-shared")}.jpg`;
    const exclusive = `/objects/uploads/${uniqueName("exp-receipt-exclusive")}.jpg`;

    // A surviving expense keeps `shared` referenced after the delete, so the
    // shared blob must NOT be freed when the other expense is removed.
    await db.insert(expensesTable).values({
      date: "2099-03-01",
      description: "Keeper expense",
      amount: 10,
      receiptUrls: [shared],
    });

    const [exp] = await db
      .insert(expensesTable)
      .values({
        date: "2099-03-02",
        description: "Receipt expense",
        amount: 25,
        receiptUrls: [shared, exclusive],
      })
      .returning();

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await adminDelete(`/api/expenses/${exp.id}`);
    expect(res.status).toBe(204);

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).toContain(exclusive);
    expect(freed).not.toContain(shared);
  });

  // The customer delete guard blocks any customer with a directly-linked work
  // order / estimate / invoice, or inspections on its vehicles. The one
  // cascaded-photo path it still permits is a "stray" work order whose own
  // customerId points elsewhere but whose vehicleId belongs to the deleted
  // customer: deleting the customer cascades its vehicle, which cascades that
  // work order, so its photos must be freed via the helper's via-vehicle link.
  // A regression that forgot that link would leak these blobs silently.
  it("frees a stray (via-vehicle) work order's exclusive photo when its customer is deleted", async () => {
    const ownerId = await makeCustomer("Cascade owner customer");
    const ownerVehicleId = await makeVehicle(ownerId);
    // A different customer "owns" the work orders by customerId, but parks them
    // against the deleted customer's vehicle.
    const otherId = await makeCustomer("Stray WO customer");
    const otherVehicleId = await makeVehicle(otherId);

    const shared = `/objects/uploads/${uniqueName("cust-photo-shared")}.jpg`;
    const exclusive = `/objects/uploads/${uniqueName("cust-photo-exclusive")}.jpg`;

    // Surviving WO on the OTHER customer's own vehicle keeps `shared` referenced
    // after the delete, so the shared blob must NOT be freed.
    await db.insert(workOrdersTable).values({
      customerId: otherId,
      vehicleId: otherVehicleId,
      title: "Keeper WO",
      photoUrls: [shared],
    });

    // Stray WO: customerId is the other customer (so the guard permits deleting
    // the owner), but vehicleId belongs to the owner's vehicle, so it cascades
    // away when the owner is deleted.
    await db.insert(workOrdersTable).values({
      customerId: otherId,
      vehicleId: ownerVehicleId,
      title: "Stray WO",
      photoUrls: [shared, exclusive],
    });

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    const res = await adminDelete(`/api/customers/${ownerId}`);
    expect(res.status).toBe(204);

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).toContain(exclusive);
    expect(freed).not.toContain(shared);
  });

  // The vehicle delete guard blocks any vehicle with linked work orders /
  // estimates / invoices / inspections, so no REST DELETE /vehicles call ever
  // reaches a non-empty cascade. We therefore exercise the same code the route
  // runs (collectVehicleCascadePhotoPaths + freeOrphanedPhotos) directly,
  // simulating the ON DELETE CASCADE by removing the vehicle row, to prove both
  // the via-vehicle work-order and via-vehicle inspection-item links are freed
  // while a path still referenced by a surviving record is kept.
  it("frees a vehicle's cascaded work-order and inspection-item photos but keeps a shared one", async () => {
    const customerId = await makeCustomer("Vehicle cascade customer");
    const vehicleId = await makeVehicle(customerId);
    const survivorVehicleId = await makeVehicle(customerId);

    const shared = `/objects/uploads/${uniqueName("veh-photo-shared")}.jpg`;
    const woExclusive = `/objects/uploads/${uniqueName("veh-wo-exclusive")}.jpg`;
    const inspExclusive = `/objects/uploads/${uniqueName("veh-insp-exclusive")}.jpg`;

    // Surviving WO on a different vehicle keeps `shared` referenced after the
    // target vehicle cascades away.
    await db.insert(workOrdersTable).values({
      customerId,
      vehicleId: survivorVehicleId,
      title: "Keeper WO",
      photoUrls: [shared],
    });

    // Work order on the target vehicle: shares one blob, owns one exclusively.
    await db.insert(workOrdersTable).values({
      customerId,
      vehicleId,
      title: "Cascade WO",
      photoUrls: [shared, woExclusive],
    });

    // Inspection (and item) on the target vehicle owning an exclusive blob.
    const [insp] = await db
      .insert(inspectionsTable)
      .values({ vehicleId, title: "Cascade inspection" })
      .returning();
    await db.insert(inspectionItemsTable).values({
      inspectionId: insp.id,
      name: "Brakes",
      condition: "fail",
      photoUrls: [inspExclusive],
    });

    // Gather the cascade photo paths BEFORE the rows are gone, exactly as the
    // route does.
    const cascadePhotoPaths = await collectVehicleCascadePhotoPaths(vehicleId);
    expect(cascadePhotoPaths).toContain(shared);
    expect(cascadePhotoPaths).toContain(woExclusive);
    expect(cascadePhotoPaths).toContain(inspExclusive);

    // Simulate the route's ON DELETE CASCADE: deleting the vehicle removes its
    // work orders, inspections, and inspection items.
    await db.delete(vehiclesTable).where(eq(vehiclesTable.id, vehicleId));

    const spy = vi
      .spyOn(ObjectStorageService.prototype, "deleteObjectEntity")
      .mockResolvedValue();

    await freeOrphanedPhotos(cascadePhotoPaths, new ObjectStorageService(), {
      warn: () => {},
    });

    const freed = spy.mock.calls.map((c) => c[0]);
    expect(freed).toContain(woExclusive);
    expect(freed).toContain(inspExclusive);
    expect(freed).not.toContain(shared);
  });
});
