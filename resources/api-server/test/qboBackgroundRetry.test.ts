import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, qboSyncLogTable, invoicesTable, invoiceLineItemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Background auto-retry sweep for failed QBO sync records.
 *
 * `runQboRetrySweep` re-attempts `failed` rows on a schedule so transient Intuit
 * failures heal without manual Retry clicks. Two guards bound it: per-row
 * exponential backoff and a hard attempt cap that promotes a permanently-bad
 * row to `failed_permanent` and stops auto-retrying it.
 *
 * The QBO client is mocked so the sweep can be made "ready" without real Intuit
 * credentials, and every outbound QBO call throws so each push deterministically
 * fails (driving the attempt/backoff/permanent bookkeeping) without network I/O.
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
    loadConnectionRow: async () =>
      ({ id: 1, accountMapping: { incomeAccount: "100" } }) as never,
    isConnected: () => ready.value,
    qboQuery: async () => {
      if (callThrows.value) throw new Error("simulated QBO outage");
      // Empty result -> push falls through to "create" via qboApiRequest.
      return [];
    },
    qboApiRequest: async () => {
      if (callThrows.value) throw new Error("simulated QBO outage");
      // Permissive shape satisfying every entity id the push paths read.
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

import { seedCustomerVehicle } from "./helpers";
import {
  runQboRetrySweep,
  MAX_AUTO_RETRY_ATTEMPTS,
} from "../src/lib/qboSync";

// Insert an invoice with one line item so a push attempt has real rows to load.
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

// Seed a failed sync-log row for an invoice with explicit attempts/age.
async function seedFailedLog(
  entityId: number,
  attempts: number,
  lastAttemptedAt: string,
): Promise<number> {
  const [row] = await db
    .insert(qboSyncLogTable)
    .values({
      entityType: "invoice",
      entityId,
      status: "failed",
      attempts,
      lastAttemptedAt,
      error: "boom",
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

const OLD = new Date(Date.now() - 24 * 60 * 60_000).toISOString(); // 24h ago

describe("QBO background retry sweep", () => {
  beforeEach(async () => {
    ready.value = true;
    callThrows.value = true;
    // The whole run shares one DB; the sweep scans ALL failed rows, so clear the
    // ledger before each test to keep the global candidate set deterministic.
    await db.delete(qboSyncLogTable);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-ops without touching rows when QBO is not ready", async () => {
    ready.value = false;
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    const logId = await seedFailedLog(invoiceId, 0, OLD);

    const result = await runQboRetrySweep();
    expect(result).toEqual({ retried: 0, recovered: 0, exhausted: 0 });

    const row = await readLog(logId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(0);
  });

  it("re-attempts an eligible failed row and increments its attempt counter", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    const logId = await seedFailedLog(invoiceId, 0, OLD);

    const result = await runQboRetrySweep();
    expect(result.retried).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.exhausted).toBe(0);

    const row = await readLog(logId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
  });

  it("skips a row whose backoff window has not elapsed", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    // Attempted moments ago with attempts=2 -> backoff is 20 min, so not due.
    const recent = new Date(Date.now() - 60_000).toISOString();
    const logId = await seedFailedLog(invoiceId, 2, recent);

    const result = await runQboRetrySweep();
    expect(result.retried).toBe(0);

    const row = await readLog(logId);
    expect(row.attempts).toBe(2); // untouched
  });

  it("promotes a row to failed_permanent once the attempt cap is reached", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    const logId = await seedFailedLog(invoiceId, MAX_AUTO_RETRY_ATTEMPTS - 1, OLD);

    const result = await runQboRetrySweep();
    expect(result.retried).toBe(1);
    expect(result.exhausted).toBe(1);

    const row = await readLog(logId);
    expect(row.status).toBe("failed_permanent");
    expect(row.attempts).toBe(MAX_AUTO_RETRY_ATTEMPTS);
  });

  it("ignores rows already at failed_permanent", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    const [row] = await db
      .insert(qboSyncLogTable)
      .values({
        entityType: "invoice",
        entityId: invoiceId,
        status: "failed_permanent",
        attempts: MAX_AUTO_RETRY_ATTEMPTS,
        lastAttemptedAt: OLD,
        error: "boom",
      })
      .returning();

    const result = await runQboRetrySweep();
    expect(result.retried).toBe(0);

    const after = await readLog(row.id);
    expect(after.status).toBe("failed_permanent");
    expect(after.attempts).toBe(MAX_AUTO_RETRY_ATTEMPTS);
  });

  it("clears the row and resets attempts when a retry finally succeeds", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    const logId = await seedFailedLog(invoiceId, 3, OLD);

    // Let outbound QBO calls succeed this sweep so the push resolves.
    callThrows.value = false;

    const result = await runQboRetrySweep();
    expect(result.retried).toBe(1);
    expect(result.recovered).toBe(1);

    const row = await readLog(logId);
    expect(row.status).toBe("synced");
    expect(row.attempts).toBe(0);
  });
});
