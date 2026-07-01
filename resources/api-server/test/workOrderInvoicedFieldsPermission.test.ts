import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  seedStaffUser,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// A caller with only the "workOrders" permission must not see invoice-derived
// billing history (invoicedLaborHours / invoicedParts) on work order detail.
// Those fields expose what has been charged through invoices — a separate module
// the user is not authorized to access. The detail endpoint must return null for
// both fields when the caller lacks the "invoices" permission.

let admin: SeededAdmin;
let woStaff: SeededAdmin;
let shop: SeededShop;

const withAuth = (
  t: ReturnType<ReturnType<typeof agent>["get"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const adminPost = (path: string) => withAuth(agent().post(path), admin.cookie);
const adminPatch = (path: string) => withAuth(agent().patch(path), admin.cookie);
const staffGet = (path: string) => withAuth(agent().get(path), woStaff.cookie);
const adminGet = (path: string) => withAuth(agent().get(path), admin.cookie);

beforeAll(async () => {
  admin = await seedAdmin();
  // Staff with workOrders but no invoices permission
  woStaff = await seedStaffUser(["workOrders", "customers"], "wo-only");
  shop = await seedCustomerVehicle();
});

describe("work order invoiced fields — permission gating", () => {
  it("returns null for invoicedLaborHours and invoicedParts when caller lacks invoices permission", async () => {
    const woRes = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      lineItems: [{ type: "part", description: "Brake pad", quantity: 2, unitPrice: 30 }],
    });
    expect(woRes.status).toBe(201);
    const woId = woRes.body.id as number;

    // Create and bill an invoice so invoicedParts / invoicedLaborHours would be
    // non-trivial if the fields were populated.
    const invRes = await adminPost("/api/invoices").send({
      workOrderId: woId,
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "draft",
      lineItems: [],
    });
    expect(invRes.status).toBe(201);
    const invId = invRes.body.id as number;
    await adminPatch(`/api/invoices/${invId}`).send({ status: "sent" });

    // Admin (has invoices permission) sees real values.
    const adminDetail = await adminGet(`/api/work-orders/${woId}`);
    expect(adminDetail.status).toBe(200);
    expect(typeof adminDetail.body.invoicedLaborHours).toBe("number");
    expect(Array.isArray(adminDetail.body.invoicedParts)).toBe(true);

    // workOrders-only staff must receive null for both invoice-derived fields.
    const staffDetail = await staffGet(`/api/work-orders/${woId}`);
    expect(staffDetail.status).toBe(200);
    expect(staffDetail.body.invoicedLaborHours).toBeNull();
    expect(staffDetail.body.invoicedParts).toBeNull();
  });

  it("admin with invoices permission always sees real invoicedLaborHours and invoicedParts", async () => {
    const woRes = await adminPost("/api/work-orders").send({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      title: uniqueName("WO"),
      lineItems: [],
    });
    expect(woRes.status).toBe(201);
    const woId = woRes.body.id as number;

    const detail = await adminGet(`/api/work-orders/${woId}`);
    expect(detail.status).toBe(200);
    // Freshly created WO with no linked invoices — 0 hours, empty array.
    expect(detail.body.invoicedLaborHours).toBe(0);
    expect(detail.body.invoicedParts).toEqual([]);
  });
});
