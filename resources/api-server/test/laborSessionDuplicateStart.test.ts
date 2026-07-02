import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// A work order may only have one open (endedAt IS NULL) labor session at a
// time. The Start Clock button disables itself client-side, but the backend
// must reject a second concurrent start so a second client, the AI tools, or a
// race cannot double-count labor time.

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (
  t: ReturnType<ReturnType<typeof agent>["get"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const adminPost = (path: string) => withAuth(agent().post(path), admin.cookie);

async function createWorkOrder(): Promise<number> {
  const res = await adminPost("/api/work-orders").send({
    customerId: shop.customerId,
    vehicleId: shop.vehicleId,
    title: uniqueName("WO"),
    lineItems: [],
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("labor session duplicate-start guard", () => {
  it("rejects a second start while a session is already open", async () => {
    const workOrderId = await createWorkOrder();

    const first = await adminPost(`/api/work-orders/${workOrderId}/labor-sessions`).send({});
    expect(first.status).toBe(201);

    const second = await adminPost(`/api/work-orders/${workOrderId}/labor-sessions`).send({});
    expect(second.status).toBe(409);
    expect(second.body.error).toBeTruthy();
  });

  it("allows starting a new session once the previous one has stopped", async () => {
    const workOrderId = await createWorkOrder();

    const first = await adminPost(`/api/work-orders/${workOrderId}/labor-sessions`).send({});
    expect(first.status).toBe(201);
    const sessionId = first.body.id;

    const stop = await adminPost(`/api/labor-sessions/${sessionId}/stop`).send({});
    expect(stop.status).toBe(200);

    const second = await adminPost(`/api/work-orders/${workOrderId}/labor-sessions`).send({});
    expect(second.status).toBe(201);
  });

  it("opens only one session when two starts race concurrently", async () => {
    const workOrderId = await createWorkOrder();

    // Fire both starts in parallel so they race past the pre-insert check; the
    // DB partial unique index must let exactly one win.
    const [a, b] = await Promise.all([
      adminPost(`/api/work-orders/${workOrderId}/labor-sessions`).send({}),
      adminPost(`/api/work-orders/${workOrderId}/labor-sessions`).send({}),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const detail = await withAuth(
      agent().get(`/api/work-orders/${workOrderId}`),
      admin.cookie,
    );
    expect(detail.status).toBe(200);
    const openSessions = (detail.body.laborSessions ?? []).filter(
      (s: { endedAt: string | null }) => s.endedAt === null,
    );
    expect(openSessions).toHaveLength(1);
  });
});
