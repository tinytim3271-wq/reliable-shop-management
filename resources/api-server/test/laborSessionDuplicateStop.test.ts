import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// Stopping a labor session closes the one row whose endedAt IS NULL and returns
// 404 otherwise. A second stop on the same id (or a stop on a non-existent id)
// must NOT re-close the session: overwriting an already-set endedAt would
// silently corrupt the recorded billable hours.

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

describe("labor session duplicate-stop guard", () => {
  it("stops an open session once, then 404s a second stop on the same id", async () => {
    const workOrderId = await createWorkOrder();

    const start = await adminPost(`/api/work-orders/${workOrderId}/labor-sessions`).send({});
    expect(start.status).toBe(201);
    const sessionId = start.body.id;

    const firstStop = await adminPost(`/api/labor-sessions/${sessionId}/stop`).send({});
    expect(firstStop.status).toBe(200);
    expect(firstStop.body.endedAt).toBeTruthy();

    const secondStop = await adminPost(`/api/labor-sessions/${sessionId}/stop`).send({});
    expect(secondStop.status).toBe(404);
    expect(secondStop.body.error).toBeTruthy();
  });

  it("404s a stop on a non-existent session id", async () => {
    const stop = await adminPost(`/api/labor-sessions/999999999/stop`).send({});
    expect(stop.status).toBe(404);
    expect(stop.body.error).toBeTruthy();
  });
});
