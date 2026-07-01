import { beforeAll, describe, expect, it } from "vitest";
import { db, stockMovementsTable } from "@workspace/db";
import {
  agent,
  seedAdmin,
  seedStaffUser,
  seedCustomerVehicle,
  seedPart,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// The shop-wide stock movement report is a single printable/exportable audit
// document spanning every part. These tests pin its inventory-permission gate,
// that each row carries the part name + acting staff attribution, and that the
// date-range filter scopes the ledger window. The run shares one database across
// files, so assertions filter to parts/dates this file owns rather than relying
// on the whole-shop count.

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (
  t: ReturnType<ReturnType<typeof agent>["get"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const report = (cookie: string, query = "") =>
  withAuth(agent().get(`/api/reports/stock-movements${query}`), cookie);

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("shop-wide stock movement report", () => {
  it("requires authentication", async () => {
    const res = await agent()
      .get("/api/reports/stock-movements")
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(401);
  });

  it("is denied to staff without the inventory permission", async () => {
    const staff = await seedStaffUser(["accounting"], "noinv");
    const res = await report(staff.cookie);
    expect(res.status).toBe(403);
  });

  it("is allowed for staff with the inventory permission", async () => {
    const staff = await seedStaffUser(["inventory"], "inv");
    const res = await report(staff.cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  it("surfaces a billed part with its name, delta, source, and acting staff", async () => {
    const part = await seedPart({
      name: uniqueName("Report Part"),
      quantityOnHand: 10,
      reorderLevel: 0,
    });
    const created = await withAuth(agent().post("/api/invoices"), admin.cookie).send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "sent",
      lineItems: [{ description: part.name, type: "part", quantity: 3, unitPrice: 20 }],
    });
    expect(created.status).toBe(201);

    const res = await report(admin.cookie);
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: any) => r.partId === part.id);
    expect(row).toBeDefined();
    expect(row.partName).toBe(part.name);
    expect(row.delta).toBe(-3);
    expect(row.reason).toBe("Billed on invoice");
    expect(row.sourceType).toBe("invoice");
    expect(row.sourceId).toBe(created.body.id);
    expect(row.createdByName).toBe("API Test Admin");
  });

  it("keeps legacy/system rows with a null acting staff name", async () => {
    const part = await seedPart({
      name: uniqueName("Legacy Report Part"),
      quantityOnHand: 5,
      reorderLevel: 0,
    });
    await db.insert(stockMovementsTable).values({
      partId: part.id,
      delta: -1,
      reason: "Manual adjustment",
      createdByUserId: null,
    });

    const res = await report(admin.cookie);
    const row = res.body.rows.find((r: any) => r.partId === part.id);
    expect(row).toBeDefined();
    expect(row.createdByUserId).toBeNull();
    expect(row.createdByName).toBeNull();
  });

  it("narrows the ledger to a single part via partId", async () => {
    const partA = await seedPart({ name: uniqueName("Filter Part A"), quantityOnHand: 0, reorderLevel: 0 });
    const partB = await seedPart({ name: uniqueName("Filter Part B"), quantityOnHand: 0, reorderLevel: 0 });
    await db.insert(stockMovementsTable).values([
      { partId: partA.id, delta: 3, reason: "Manual adjustment" },
      { partId: partB.id, delta: 5, reason: "Manual adjustment" },
    ]);

    const res = await report(admin.cookie, `?partId=${partA.id}`);
    expect(res.status).toBe(200);
    // Every returned row must belong to the requested part, and partB's movement
    // must be excluded entirely.
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(res.body.rows.every((r: any) => r.partId === partA.id)).toBe(true);
    expect(res.body.rows.some((r: any) => r.partId === partB.id)).toBe(false);
  });

  it("narrows the ledger to a single reason", async () => {
    const part = await seedPart({ name: uniqueName("Reason Filter Part"), quantityOnHand: 0, reorderLevel: 0 });
    await db.insert(stockMovementsTable).values([
      { partId: part.id, delta: 2, reason: "Manual adjustment" },
      { partId: part.id, delta: 7, reason: "Received purchase order" },
    ]);

    const res = await report(admin.cookie, `?partId=${part.id}&reason=Received%20purchase%20order`);
    expect(res.status).toBe(200);
    const mine = res.body.rows.filter((r: any) => r.partId === part.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].reason).toBe("Received purchase order");
    expect(mine[0].delta).toBe(7);
  });

  it("lists every distinct reason in availableReasons regardless of active filters", async () => {
    const part = await seedPart({ name: uniqueName("Available Reasons Part"), quantityOnHand: 0, reorderLevel: 0 });
    await db.insert(stockMovementsTable).values([
      { partId: part.id, delta: 1, reason: "Manual adjustment" },
      { partId: part.id, delta: 2, reason: "Received purchase order" },
    ]);

    const res = await report(admin.cookie, `?partId=${part.id}&reason=Manual%20adjustment`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.availableReasons)).toBe(true);
    // Even though the result rows are filtered to one reason, availableReasons
    // still offers the full set so the picker never collapses.
    expect(res.body.availableReasons).toContain("Manual adjustment");
    expect(res.body.availableReasons).toContain("Received purchase order");
    const mine = res.body.rows.filter((r: any) => r.partId === part.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].reason).toBe("Manual adjustment");
  });

  it("scopes the ledger to the requested date range", async () => {
    const part = await seedPart({
      name: uniqueName("Dated Report Part"),
      quantityOnHand: 0,
      reorderLevel: 0,
    });
    // Two movements on this part in distinct, far-future windows no other test
    // touches, so the date filter can be asserted in isolation.
    await db.insert(stockMovementsTable).values([
      {
        partId: part.id,
        delta: 4,
        reason: "Received purchase order",
        createdAt: "2031-03-10T12:00:00.000Z",
      },
      {
        partId: part.id,
        delta: -2,
        reason: "Billed on invoice",
        createdAt: "2032-06-20T12:00:00.000Z",
      },
    ]);

    const res = await report(
      admin.cookie,
      "?startDate=2031-01-01&endDate=2031-12-31",
    );
    expect(res.status).toBe(200);
    const mine = res.body.rows.filter((r: any) => r.partId === part.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].delta).toBe(4);
    expect(res.body.startDate).toBe("2031-01-01");
    expect(res.body.endDate).toBe("2031-12-31");
  });
});
