import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  seedStaffUser,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// Verifies that authenticated staff paths cannot forge, bypass, or overwrite
// customer estimate-approval decisions. These tests exercise four guarantees:
//
//   1. Non-admin staff with the `estimates` permission are blocked from calling
//      /approve or /decline — those endpoints require admin because they record
//      a customer decision on the customer's behalf.
//   2. The general PATCH /estimates/:id route refuses any payload that tries to
//      set status to "approved" or "declined" directly, regardless of role.
//   3. Once a customer (or admin) has recorded a final decision, no further
//      /approve or /decline call can overwrite it — the compare-and-swap UPDATE
//      returns 409 instead of silently flipping the status.
//   4. The PATCH route also refuses to touch status on an already-finalized
//      estimate, even when the requested value is a pending state like "draft".

let admin: SeededAdmin;
let shop: SeededShop;

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

const withAdmin = (t: ReturnType<ReturnType<typeof agent>["post"]>) =>
  t.set("Cookie", admin.cookie).set("X-Forwarded-Proto", "https");

async function createDraftEstimate(): Promise<number> {
  const res = await withAdmin(agent().post("/api/estimates")).send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    lineItems: [{ description: "Diagnostic", quantity: 1, unitPrice: 75 }],
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

describe("estimate approval integrity — staff cannot forge approval decisions", () => {
  it("non-admin with estimates permission is blocked from /approve with 403", async () => {
    const staff = await seedStaffUser(["estimates"], "estonly-approve");
    const estimateId = await createDraftEstimate();

    const res = await agent()
      .post(`/api/estimates/${estimateId}/approve`)
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it("non-admin with estimates permission is blocked from /decline with 403", async () => {
    const staff = await seedStaffUser(["estimates"], "estonly-decline");
    const estimateId = await createDraftEstimate();

    const res = await agent()
      .post(`/api/estimates/${estimateId}/decline`)
      .set("Cookie", staff.cookie)
      .set("X-Forwarded-Proto", "https")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it("PATCH with status=approved is rejected with 403 for any staff user", async () => {
    const estimateId = await createDraftEstimate();

    const res = await withAdmin(agent().patch(`/api/estimates/${estimateId}`)).send({
      status: "approved",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/approve.*decline endpoints|dedicated/i);
  });

  it("PATCH with status=declined is rejected with 403 for any staff user", async () => {
    const estimateId = await createDraftEstimate();

    const res = await withAdmin(agent().patch(`/api/estimates/${estimateId}`)).send({
      status: "declined",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/approve.*decline endpoints|dedicated/i);
  });

  it("admin can approve a pending estimate and receives 200 with updated status", async () => {
    const estimateId = await createDraftEstimate();

    const res = await withAdmin(agent().post(`/api/estimates/${estimateId}/approve`)).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.approvedAt).toBeTypeOf("string");
  });

  it("admin can decline a pending estimate and receives 200 with updated status", async () => {
    const estimateId = await createDraftEstimate();

    const res = await withAdmin(agent().post(`/api/estimates/${estimateId}/decline`)).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
  });

  it("/approve returns 409 when the estimate is already approved (decision is locked)", async () => {
    const estimateId = await createDraftEstimate();

    const first = await withAdmin(agent().post(`/api/estimates/${estimateId}/approve`)).send({});
    expect(first.status).toBe(200);

    const second = await withAdmin(agent().post(`/api/estimates/${estimateId}/approve`)).send({});
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already been approved/i);
  });

  it("/approve returns 409 when the estimate has already been declined (no flip)", async () => {
    const estimateId = await createDraftEstimate();

    const decline = await withAdmin(agent().post(`/api/estimates/${estimateId}/decline`)).send({});
    expect(decline.status).toBe(200);

    const approve = await withAdmin(agent().post(`/api/estimates/${estimateId}/approve`)).send({});
    expect(approve.status).toBe(409);
    expect(approve.body.error).toMatch(/already been approved or declined/i);
  });

  it("/decline returns 409 when the estimate has already been approved (no flip)", async () => {
    const estimateId = await createDraftEstimate();

    const approve = await withAdmin(agent().post(`/api/estimates/${estimateId}/approve`)).send({});
    expect(approve.status).toBe(200);

    const decline = await withAdmin(agent().post(`/api/estimates/${estimateId}/decline`)).send({});
    expect(decline.status).toBe(409);
    expect(decline.body.error).toMatch(/already been approved or declined/i);
  });

  it("PATCH cannot reset an approved estimate's status back to a pending state", async () => {
    const estimateId = await createDraftEstimate();

    const approve = await withAdmin(agent().post(`/api/estimates/${estimateId}/approve`)).send({});
    expect(approve.status).toBe(200);

    const patch = await withAdmin(agent().patch(`/api/estimates/${estimateId}`)).send({
      status: "draft",
    });

    expect(patch.status).toBe(409);
    expect(patch.body.error).toMatch(/already been approved/i);
  });

  it("PATCH cannot reset a declined estimate's status back to a pending state", async () => {
    const estimateId = await createDraftEstimate();

    const decline = await withAdmin(agent().post(`/api/estimates/${estimateId}/decline`)).send({});
    expect(decline.status).toBe(200);

    const patch = await withAdmin(agent().patch(`/api/estimates/${estimateId}`)).send({
      status: "sent",
    });

    expect(patch.status).toBe(409);
    expect(patch.body.error).toMatch(/already been declined/i);
  });

  it("PATCH can freely change other fields on a pending estimate without touching status", async () => {
    const estimateId = await createDraftEstimate();

    const res = await withAdmin(agent().patch(`/api/estimates/${estimateId}`)).send({
      notes: "Updated note",
      status: "sent",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.notes).toBe("Updated note");
  });
});
