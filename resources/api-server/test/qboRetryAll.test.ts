import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  qboSyncLogTable,
  invoicesTable,
  invoiceLineItemsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * "Retry all permanently-failed" recovery path.
 *
 * Once the background sweep gives up on a record it is parked at
 * `failed_permanent` and never auto-retried. After the operator fixes the
 * underlying cause (typically a missing account mapping) they need a way to
 * re-queue everything in one go. Two paths do that:
 *   1. POST /integrations/qbo/log/retry-all — resets every failed_permanent row
 *      and re-pushes it once.
 *   2. Saving the account mapping (PUT /mapping) auto-resets failed_permanent
 *      rows so the background sweep picks them up again.
 *
 * The QBO client is mocked so the routes see a "connected" company without real
 * Intuit credentials, and outbound calls can be toggled to succeed or throw.
 */

const { ready, callThrows } = vi.hoisted(() => ({
  ready: { value: true },
  callThrows: { value: true },
}));

vi.mock("../src/lib/qboClient", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/qboClient")>();
  const fakeConfig = {
    clientId: "test-client",
    clientSecret: "test-secret",
    environment: "sandbox" as const,
    redirectUri: "https://example.test/cb",
    apiBase: "https://sandbox.test",
  };
  return {
    ...actual,
    getQboConfig: () => (ready.value ? fakeConfig : null),
    isQboConfigured: () => ready.value,
    loadConnectionRow: async () =>
      ({ id: 1, accountMapping: { incomeAccount: "100" } }) as never,
    isConnected: () => ready.value,
    saveAccountMapping: async (_id: number, mapping: unknown) => mapping,
    qboQuery: async () => {
      if (callThrows.value) throw new Error("simulated QBO outage");
      return [];
    },
    qboApiRequest: async () => {
      if (callThrows.value) throw new Error("simulated QBO outage");
      return {
        Customer: { Id: "q-cust" },
        Item: { Id: "q-item" },
        Invoice: { Id: "q-inv", SyncToken: "0" },
        Payment: { Id: "q-pay" },
        Purchase: { Id: "q-exp" },
      };
    },
  };
});

import { agent, seedAdmin, seedCustomerVehicle, type SeededAdmin } from "./helpers";
import { requeuePermanentlyFailed } from "../src/lib/qboSync";

async function seedInvoice(customerId: number, vehicleId: number): Promise<number> {
  const [invoice] = await db
    .insert(invoicesTable)
    .values({ customerId, vehicleId, status: "sent", taxRate: 0, amountPaid: 0 })
    .returning();
  await db.insert(invoiceLineItemsTable).values({
    invoiceId: invoice.id,
    type: "labor",
    description: "Diagnostic",
    quantity: 1,
    unitPrice: 100,
  });
  return invoice.id;
}

const OLD = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

async function seedPermanentLog(entityId: number): Promise<number> {
  const [row] = await db
    .insert(qboSyncLogTable)
    .values({
      entityType: "invoice",
      entityId,
      status: "failed_permanent",
      attempts: 6,
      lastAttemptedAt: OLD,
      error: "missing income account",
    })
    .returning();
  return row.id;
}

async function readLog(id: number) {
  const [row] = await db
    .select()
    .from(qboSyncLogTable)
    .where(eq(qboSyncLogTable.id, id))
    .limit(1);
  return row;
}

describe("QBO retry-all of permanently-failed records", () => {
  let admin: SeededAdmin;

  const authed = (method: "post" | "put", path: string) =>
    agent()
      [method](path)
      .set("X-Forwarded-Proto", "https")
      .set("Cookie", admin.cookie);

  beforeEach(async () => {
    ready.value = true;
    callThrows.value = true;
    admin = await seedAdmin();
    // The whole run shares one DB; clear the ledger so the global candidate set
    // is deterministic per test.
    await db.delete(qboSyncLogTable);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requeuePermanentlyFailed resets rows to eligible (failed, attempts 0, no last-attempt)", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    const logId = await seedPermanentLog(invoiceId);

    const requeued = await requeuePermanentlyFailed();
    expect(requeued.map((r) => r.id)).toContain(logId);

    const row = await readLog(logId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(0);
    expect(row.lastAttemptedAt).toBeNull();
  });

  it("re-attempts every permanently-failed record and reports recovered when pushes succeed", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    const logId = await seedPermanentLog(invoiceId);

    // Let outbound QBO calls succeed so the re-push resolves.
    callThrows.value = false;

    const res = await authed("post", "/api/integrations/qbo/log/retry-all");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requeued: 1, recovered: 1, stillFailing: 0 });

    const row = await readLog(logId);
    expect(row.status).toBe("synced");
    expect(row.attempts).toBe(0);
  });

  it("drops still-failing records back to failed (attempts cleared) so the sweep resumes", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    const logId = await seedPermanentLog(invoiceId);

    // Outbound calls still throw -> the re-push fails again.
    const res = await authed("post", "/api/integrations/qbo/log/retry-all");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requeued: 1, recovered: 0, stillFailing: 1 });

    const row = await readLog(logId);
    // Back to plain `failed` with a cleared counter -> eligible for auto-retry.
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(0);
  });

  it("rejects retry-all with 409 when QBO is not connected", async () => {
    ready.value = false;
    const res = await authed("post", "/api/integrations/qbo/log/retry-all");
    expect(res.status).toBe(409);
  });

  it("auto-requeues permanently-failed records when the account mapping is saved", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    const logId = await seedPermanentLog(invoiceId);

    const res = await authed("put", "/api/integrations/qbo/mapping").send({
      incomeAccount: "100",
      paymentAccounts: { cash: "10", card: "11", check: "12" },
      expenseAccounts: { "1": "200" },
    });
    expect(res.status).toBe(200);

    const row = await readLog(logId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(0);
    expect(row.lastAttemptedAt).toBeNull();
  });
});
