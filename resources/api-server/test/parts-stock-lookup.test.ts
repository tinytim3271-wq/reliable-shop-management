import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedStaffUser,
  seedPart,
  uniqueName,
  type SeededAdmin,
} from "./helpers";

// Catalog stock lookup powers the inline "X in stock" hint estimate/intake forms
// show as part quantities are typed. The numeric count is inventory-scoped, so
// these tests pin both the matching behaviour and the permission redaction.

let admin: SeededAdmin;
let noInventoryStaff: SeededAdmin;

const IN_STOCK_NAME = uniqueName("Brake Pads");
const LOW_STOCK_NAME = uniqueName("Oil Filter");
const NONEXISTENT_NAME = uniqueName("Nonexistent Widget");

function lookup(cookie: string, descriptions: string[]) {
  return agent()
    .post("/api/parts/stock-lookup")
    .set("Cookie", cookie)
    .set("X-Forwarded-Proto", "https")
    .send({ descriptions });
}

beforeAll(async () => {
  admin = await seedAdmin();
  noInventoryStaff = await seedStaffUser(["estimates"], "noinv");
  await seedPart({ name: IN_STOCK_NAME, quantityOnHand: 8, reorderLevel: 2 });
  await seedPart({ name: LOW_STOCK_NAME, quantityOnHand: 1, reorderLevel: 3 });
});

describe("POST /parts/stock-lookup", () => {
  it("returns on-hand stock for a matched part to an inventory-permitted caller", async () => {
    const res = await lookup(admin.cookie, [IN_STOCK_NAME]);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [result] = res.body;
    expect(result.description).toBe(IN_STOCK_NAME);
    expect(result.partId).toEqual(expect.any(Number));
    expect(result.quantityOnHand).toBe(8);
    expect(result.lowStock).toBe(false);
  });

  it("flags a part at or below its reorder level as low stock", async () => {
    const res = await lookup(admin.cookie, [LOW_STOCK_NAME]);
    expect(res.status).toBe(200);
    const [result] = res.body;
    expect(result.quantityOnHand).toBe(1);
    expect(result.lowStock).toBe(true);
  });

  it("returns null stock fields when no catalog entry matches", async () => {
    const res = await lookup(admin.cookie, [NONEXISTENT_NAME]);
    expect(res.status).toBe(200);
    const [result] = res.body;
    expect(result.partId).toBeNull();
    expect(result.quantityOnHand).toBeNull();
    expect(result.lowStock).toBeNull();
  });

  it("preserves input order across multiple descriptions", async () => {
    const res = await lookup(admin.cookie, [LOW_STOCK_NAME, IN_STOCK_NAME]);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { description: string }) => r.description)).toEqual([
      LOW_STOCK_NAME,
      IN_STOCK_NAME,
    ]);
    expect(res.body[0].quantityOnHand).toBe(1);
    expect(res.body[1].quantityOnHand).toBe(8);
  });

  it("rejects a caller without inventory permission (fail-closed)", async () => {
    // The route lives under the `/parts` -> `inventory` permission gate, so stock
    // counts can never leak to a non-inventory user. The frontend hook gates the
    // call on the same permission, so it never reaches this 403 in practice.
    const res = await lookup(noInventoryStaff.cookie, [IN_STOCK_NAME]);
    expect(res.status).toBe(403);
  });

  it("requires authentication", async () => {
    const res = await agent()
      .post("/api/parts/stock-lookup")
      .set("X-Forwarded-Proto", "https")
      .send({ descriptions: [IN_STOCK_NAME] });
    expect(res.status).toBe(401);
  });
});
