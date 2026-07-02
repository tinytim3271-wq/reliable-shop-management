import { beforeAll, describe, expect, it } from "vitest";
import { db, partsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  seedPart,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// Generating an invoice from a work order seeds the bill from the work order's
// stored parts. When staff generate a SECOND invoice from the same work order,
// the parts already billed on prior (non-void) invoices must be reported on the
// work order detail (invoicedParts) and excluded from the re-seeded line items
// by default, so the same components aren't billed twice. Staff can opt back in
// with rebillParts. Voided invoices must not count toward already-billed parts.

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (
  t: ReturnType<ReturnType<typeof agent>["get"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const adminGet = (path: string) => withAuth(agent().get(path), admin.cookie);
const adminPost = (path: string) => withAuth(agent().post(path), admin.cookie);
const adminPatch = (path: string) => withAuth(agent().patch(path), admin.cookie);

async function createWorkOrderWithPart(
  partName: string,
  quantity: number,
): Promise<number> {
  const res = await adminPost("/api/work-orders").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    title: uniqueName("WO"),
    lineItems: [
      { type: "part", description: partName, quantity, unitPrice: 25 },
    ],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function generateInvoice(
  workOrderId: number,
  extra: Record<string, unknown> = {},
) {
  const res = await adminPost("/api/invoices").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    workOrderId,
    status: "draft",
    lineItems: [],
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body;
}

const partLines = (inv: { lineItems: { type: string; description: string; quantity: number }[] }) =>
  inv.lineItems.filter((li) => li.type === "part");

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("work order invoicedParts", () => {
  it("reports no already-billed parts before any invoice", async () => {
    const name = uniqueName("Brake Pad");
    await seedPart({ name, quantityOnHand: 100, reorderLevel: 1 });
    const workOrderId = await createWorkOrderWithPart(name, 2);

    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.status).toBe(200);
    expect(wo.body.invoicedParts).toEqual([]);
  });

  it("reports parts billed on a prior invoice grouped with summed quantity", async () => {
    const name = uniqueName("Oil Filter");
    await seedPart({ name, quantityOnHand: 100, reorderLevel: 1 });
    const workOrderId = await createWorkOrderWithPart(name, 3);

    await generateInvoice(workOrderId);

    const wo = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(wo.status).toBe(200);
    expect(wo.body.invoicedParts).toEqual([{ description: name, quantity: 3 }]);
  });

  it("excludes already-billed parts when re-seeding a follow-up invoice", async () => {
    const name = uniqueName("Spark Plug");
    await seedPart({ name, quantityOnHand: 100, reorderLevel: 1 });
    const workOrderId = await createWorkOrderWithPart(name, 4);

    const first = await generateInvoice(workOrderId);
    expect(partLines(first)).toHaveLength(1);

    const second = await generateInvoice(workOrderId);
    // The whole quantity was already billed, so the part is left off entirely.
    expect(partLines(second)).toHaveLength(0);
  });

  it("re-seeds already-billed parts when rebillParts is set", async () => {
    const name = uniqueName("Air Filter");
    await seedPart({ name, quantityOnHand: 100, reorderLevel: 1 });
    const workOrderId = await createWorkOrderWithPart(name, 2);

    await generateInvoice(workOrderId);

    const second = await generateInvoice(workOrderId, { rebillParts: true });
    const parts = partLines(second);
    expect(parts).toHaveLength(1);
    expect(parts[0].quantity).toBe(2);
  });

  it("still excludes a part renamed between invoices via its catalog match", async () => {
    // A catalog part exists; the work order's part line starts out matching it
    // exactly, gets billed, then is renamed to a different free-text string that
    // still resolves to the same catalog part (fuzzy substring match).
    const name = uniqueName("Brake Pad");
    await seedPart({ name, quantityOnHand: 100, reorderLevel: 1 });
    const workOrderId = await createWorkOrderWithPart(name, 2);

    const first = await generateInvoice(workOrderId);
    expect(partLines(first)).toHaveLength(1);

    // Rename the work order's part line (e.g. "Brake Pad" -> "Front Brake Pad").
    // The description text no longer matches the billed line, but both resolve
    // to the same catalog part, so dedup must still recognize it as billed.
    const renamed = `Front ${name}`;
    const patched = await adminPatch(`/api/work-orders/${workOrderId}`).send({
      lineItems: [
        { type: "part", description: renamed, quantity: 2, unitPrice: 25 },
      ],
    });
    expect(patched.status).toBe(200);

    const second = await generateInvoice(workOrderId);
    // The renamed part resolves to the same catalog entry that was already
    // billed, so it is left off the follow-up invoice entirely.
    expect(partLines(second)).toHaveLength(0);
  });

  it("excludes a specific part even when a generic same-prefix part has a lower catalog id", async () => {
    // This test guards the persisted catalogPartId path: a generic "Brake Pad" catalog
    // entry with a lower id exists alongside a more specific "Brake Pad - OEM" entry.
    // The work order and invoice line carry the specific part's id (set at write time
    // via exact catalog match). The dedup must key off that persisted id, not re-run
    // the fuzzy matcher which could pick the generic lower-id entry because "brake pad"
    // is a substring of "brake pad - oem" under the fuzzy rule.
    const genericName = uniqueName("Brake Pad");
    const specificName = `${genericName} - OEM`;

    // Seed the generic part first so it gets the lower catalog id.
    await seedPart({ name: genericName, quantityOnHand: 100, reorderLevel: 1 });
    await seedPart({ name: specificName, quantityOnHand: 100, reorderLevel: 1 });

    // Work order carries the specific part; at write time the description exactly
    // matches the specific catalog entry, so catalogPartId is set to the specific id.
    const workOrderId = await createWorkOrderWithPart(specificName, 2);

    const first = await generateInvoice(workOrderId);
    expect(partLines(first)).toHaveLength(1);
    expect(partLines(first)[0].description).toBe(specificName);

    // Second invoice: the specific part was already billed. The dedup must not be
    // confused by the generic same-prefix part with the lower id.
    const second = await generateInvoice(workOrderId);
    expect(partLines(second)).toHaveLength(0);
  });

  it("still excludes a part whose catalog entry was renamed after billing", async () => {
    // This uniquely validates the persisted catalogPartId approach. Without it,
    // the dedup re-runs matchCatalogPart on the invoice's OLD description at read
    // time — after a catalog rename the old description fuzzy-matches the GENERIC
    // lower-id entry instead of the now-renamed specific entry, so the dedup keys
    // diverge and the part is re-billed. With persisted ids both sides key off the
    // stored specific id and the part is correctly excluded.
    //
    // Setup: generic "Brake Pad" (G, lower id) + specific "Brake Pad - OEM" (S)
    // Step 1: WO with "Brake Pad - OEM" → exact-match → catalogPartId=S stored.
    // Step 2: Invoice 1 billed ("Brake Pad - OEM", catalogPartId=S stored).
    // Step 3: Rename catalog entry S to "OEM Brake Pad" so old description drifts.
    // Step 4: PATCH WO line to new name "OEM Brake Pad" → exact-match → catalogPartId=S.
    // Without persisted ids: invoice "Brake Pad - OEM" re-resolves → G (fuzzy wins);
    //   WO "OEM Brake Pad" → exact → S; G ≠ S → WRONG re-bill on second invoice.
    // With persisted ids: invoice catalogPartId=S; WO catalogPartId=S → excluded ✓.

    const genericName = uniqueName("Brake Pad");
    const specificName = `${genericName} - OEM`;
    const renamedName = `OEM ${genericName}`;

    const genericPart = await seedPart({ name: genericName, quantityOnHand: 100, reorderLevel: 1 });
    const specificPart = await seedPart({ name: specificName, quantityOnHand: 100, reorderLevel: 1 });

    const workOrderId = await createWorkOrderWithPart(specificName, 2);

    const first = await generateInvoice(workOrderId);
    expect(partLines(first)).toHaveLength(1);
    expect(partLines(first)[0].description).toBe(specificName);

    // Simulate catalog drift: rename the specific catalog entry so its old name
    // ("Brake Pad - OEM") no longer matches it exactly and now fuzzy-matches the
    // generic ("Brake Pad") instead.
    await db.update(partsTable)
      .set({ name: renamedName })
      .where(eq(partsTable.id, specificPart.id));

    // Update the WO line to the new catalog name. resolveLineItemsWithCatalog
    // finds the exact-match to the renamed entry → catalogPartId=S preserved.
    const patched = await adminPatch(`/api/work-orders/${workOrderId}`).send({
      lineItems: [
        { type: "part", description: renamedName, quantity: 2, unitPrice: 25 },
      ],
    });
    expect(patched.status).toBe(200);

    // The specific part (now called "OEM Brake Pad") was already billed.
    // Persisted catalogPartId on both invoice and WO lines = S, so dedup excludes it.
    const second = await generateInvoice(workOrderId);
    expect(partLines(second)).toHaveLength(0);

    // Confirm the generic part's id is indeed lower (pre-condition for the test).
    expect(genericPart.id).toBeLessThan(specificPart.id);
  });

  it("excludes voided invoices from the already-billed parts", async () => {
    const name = uniqueName("Wiper Blade");
    await seedPart({ name, quantityOnHand: 100, reorderLevel: 1 });
    const workOrderId = await createWorkOrderWithPart(name, 5);

    const first = await generateInvoice(workOrderId);

    const before = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(before.body.invoicedParts).toEqual([{ description: name, quantity: 5 }]);

    const voided = await adminPatch(`/api/invoices/${first.id}`).send({ status: "void" });
    expect(voided.status).toBe(200);

    const after = await adminGet(`/api/work-orders/${workOrderId}`);
    expect(after.status).toBe(200);
    expect(after.body.invoicedParts).toEqual([]);

    // With the prior bill voided, a fresh invoice re-seeds the part again.
    const second = await generateInvoice(workOrderId);
    const parts = partLines(second);
    expect(parts).toHaveLength(1);
    expect(parts[0].quantity).toBe(5);
  });
});
