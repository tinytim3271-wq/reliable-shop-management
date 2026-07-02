import { beforeAll, describe, expect, it } from "vitest";
import {
  agent,
  seedAdmin,
  seedCustomerVehicle,
  uniqueName,
  type SeededAdmin,
  type SeededShop,
} from "./helpers";

// The Start/Stop clock lifecycle leans on a partial unique index (one open
// session per work order) plus a stop handler that only closes the row whose
// endedAt IS NULL. This suite drives the full lifecycle harder than the
// single-shot duplicate-start / duplicate-stop guards: it runs several
// stop/start cycles on one work order and asserts the closed sessions keep
// their endedAt and the work order's billable labor stays consistent, and it
// confirms the global stop endpoint only ever touches the targeted session even
// when another work order has its own open session.

let admin: SeededAdmin;
let shop: SeededShop;

const withAuth = (
  t: ReturnType<ReturnType<typeof agent>["get"]>,
  cookie: string,
) => t.set("Cookie", cookie).set("X-Forwarded-Proto", "https");

const adminPost = (path: string) => withAuth(agent().post(path), admin.cookie);
const adminGet = (path: string) => withAuth(agent().get(path), admin.cookie);

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

interface SessionShape {
  id: number;
  endedAt: string | null;
}

async function fetchSessions(workOrderId: number): Promise<SessionShape[]> {
  const detail = await adminGet(`/api/work-orders/${workOrderId}`);
  expect(detail.status).toBe(200);
  return (detail.body.laborSessions ?? []) as SessionShape[];
}

async function fetchWorkOrder(workOrderId: number): Promise<{
  totalLaborMinutes: number;
  hasActiveSession: boolean;
  laborSessions: SessionShape[];
}> {
  const detail = await adminGet(`/api/work-orders/${workOrderId}`);
  expect(detail.status).toBe(200);
  return detail.body;
}

beforeAll(async () => {
  admin = await seedAdmin();
  shop = await seedCustomerVehicle();
});

describe("labor session stop/start lifecycle", () => {
  it("runs several stop/start cycles and keeps closed sessions consistent", async () => {
    const workOrderId = await createWorkOrder();

    const CYCLES = 4;
    const closedIds: number[] = [];
    for (let i = 0; i < CYCLES; i += 1) {
      const start = await adminPost(`/api/work-orders/${workOrderId}/labor-sessions`).send({});
      expect(start.status).toBe(201);
      const sessionId = start.body.id;

      const stop = await adminPost(`/api/labor-sessions/${sessionId}/stop`).send({});
      expect(stop.status).toBe(200);
      expect(stop.body.endedAt).toBeTruthy();
      closedIds.push(sessionId);
    }

    // After CYCLES complete cycles every session is closed, none is active, and
    // the billable labor reflects all the completed sessions.
    const afterCycles = await fetchWorkOrder(workOrderId);
    expect(afterCycles.hasActiveSession).toBe(false);
    expect(afterCycles.laborSessions).toHaveLength(CYCLES);
    expect(afterCycles.laborSessions.every((s) => s.endedAt !== null)).toBe(true);
    const billableAfterCycles = afterCycles.totalLaborMinutes;

    // Snapshot every closed session's endedAt so we can prove a stray re-stop
    // never overwrites an already-recorded end time.
    const endedAtById = new Map(
      afterCycles.laborSessions.map((s) => [s.id, s.endedAt]),
    );

    // A second stop on each already-closed session must 404 and must NOT
    // re-close the row (which would silently move endedAt and corrupt hours).
    for (const sessionId of closedIds) {
      const restop = await adminPost(`/api/labor-sessions/${sessionId}/stop`).send({});
      expect(restop.status).toBe(404);
      expect(restop.body.error).toBeTruthy();
    }

    const afterRestop = await fetchWorkOrder(workOrderId);
    expect(afterRestop.hasActiveSession).toBe(false);
    expect(afterRestop.totalLaborMinutes).toBe(billableAfterCycles);
    for (const s of afterRestop.laborSessions) {
      expect(s.endedAt).toBe(endedAtById.get(s.id));
    }

    // A fresh start is still allowed after all the cycles (the partial unique
    // index only blocks while a session is open).
    const restart = await adminPost(`/api/work-orders/${workOrderId}/labor-sessions`).send({});
    expect(restart.status).toBe(201);
    const reopened = await fetchWorkOrder(workOrderId);
    expect(reopened.hasActiveSession).toBe(true);
    expect(reopened.laborSessions).toHaveLength(CYCLES + 1);

    // Closing it again leaves no active session and bumps the completed count.
    const finalStop = await adminPost(`/api/labor-sessions/${restart.body.id}/stop`).send({});
    expect(finalStop.status).toBe(200);
    const finalState = await fetchWorkOrder(workOrderId);
    expect(finalState.hasActiveSession).toBe(false);
    expect(finalState.laborSessions.every((s) => s.endedAt !== null)).toBe(true);
  });

  it("stops only the targeted session even when another work order is running", async () => {
    const workOrderA = await createWorkOrder();
    const workOrderB = await createWorkOrder();

    const startA = await adminPost(`/api/work-orders/${workOrderA}/labor-sessions`).send({});
    expect(startA.status).toBe(201);
    const sessionA = startA.body.id;

    const startB = await adminPost(`/api/work-orders/${workOrderB}/labor-sessions`).send({});
    expect(startB.status).toBe(201);
    const sessionB = startB.body.id;

    // The stop endpoint is global (/labor-sessions/:id/stop), not work-order
    // scoped. Stopping B must close only B and leave A's open session alone.
    const stopB = await adminPost(`/api/labor-sessions/${sessionB}/stop`).send({});
    expect(stopB.status).toBe(200);
    expect(stopB.body.endedAt).toBeTruthy();

    const sessionsA = await fetchSessions(workOrderA);
    const openA = sessionsA.find((s) => s.id === sessionA);
    expect(openA).toBeDefined();
    expect(openA?.endedAt).toBeNull();

    const sessionsB = await fetchSessions(workOrderB);
    const closedB = sessionsB.find((s) => s.id === sessionB);
    expect(closedB?.endedAt).not.toBeNull();

    // A still has its one open session, so a second start on A is still 409.
    const secondA = await adminPost(`/api/work-orders/${workOrderA}/labor-sessions`).send({});
    expect(secondA.status).toBe(409);

    // B's session is closed, so B can start a fresh one.
    const secondB = await adminPost(`/api/work-orders/${workOrderB}/labor-sessions`).send({});
    expect(secondB.status).toBe(201);

    // Now finally stop A; it must still close cleanly and independently.
    const stopA = await adminPost(`/api/labor-sessions/${sessionA}/stop`).send({});
    expect(stopA.status).toBe(200);
    expect(stopA.body.endedAt).toBeTruthy();
  });
});
