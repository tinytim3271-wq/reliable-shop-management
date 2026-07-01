import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  qboSyncLogTable,
  invoicesTable,
  invoiceLineItemsTable,
  shopSettingsTable,
} from "@workspace/db";

/**
 * Owner alert when a QBO sync record gives up for good (Task: email/text the
 * owner when an accounting sync fails permanently).
 *
 * When the background retry sweep promotes a `failed` row to the terminal
 * `failed_permanent` state, it must fire a one-time out-of-band notification to
 * the shop owner — but only on that transition, never on an ordinary failed
 * retry, and never when QBO is not ready. The notification reuses the outreach
 * module's owner-alert path, so it stays inert (simulated) unless a live email
 * provider is connected.
 *
 * The QBO client is mocked so the sweep is "ready" with no real Intuit creds and
 * every push deterministically fails; the outreach owner-alert is mocked so we
 * can assert exactly when (and with what) it is invoked without touching email.
 */

const { ready } = vi.hoisted(() => ({ ready: { value: true } }));

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
    // Every outbound QBO call throws so each push fails deterministically.
    qboQuery: async () => {
      throw new Error("simulated QBO outage");
    },
    qboApiRequest: async () => {
      throw new Error("simulated QBO outage");
    },
  };
});

const notifyOwner = vi.fn();
vi.mock("../src/lib/messaging", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/messaging")>();
  return {
    ...actual,
    notifyOwner: (...args: unknown[]) => notifyOwner(...args),
  };
});

import { seedCustomerVehicle } from "./helpers";
import { runQboRetrySweep, MAX_AUTO_RETRY_ATTEMPTS } from "../src/lib/qboSync";

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

const OLD = new Date(Date.now() - 24 * 60 * 60_000).toISOString(); // 24h ago

describe("QBO permanent-failure owner alert", () => {
  beforeEach(async () => {
    ready.value = true;
    notifyOwner.mockReset();
    notifyOwner.mockResolvedValue({
      delivered: false,
      note: "simulated",
      toAddress: null,
    });
    // The sweep scans ALL failed rows globally; clear the ledger for determinism.
    await db.delete(qboSyncLogTable);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("alerts the owner exactly once when a row is promoted to failed_permanent", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    await seedFailedLog(invoiceId, MAX_AUTO_RETRY_ATTEMPTS - 1, OLD);

    const result = await runQboRetrySweep();
    expect(result.exhausted).toBe(1);

    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const arg = notifyOwner.mock.calls[0][0] as { subject: string; body: string };
    expect(arg.subject).toMatch(/QuickBooks/i);
    expect(arg.body).toContain(`invoice #${invoiceId}`);
  });

  it("does not alert when a retry merely fails without crossing the cap", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    await seedFailedLog(invoiceId, 0, OLD);

    const result = await runQboRetrySweep();
    expect(result.retried).toBe(1);
    expect(result.exhausted).toBe(0);

    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("does not re-alert on a later sweep once the row is already permanent", async () => {
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    await seedFailedLog(invoiceId, MAX_AUTO_RETRY_ATTEMPTS - 1, OLD);

    // First sweep promotes + alerts.
    await runQboRetrySweep();
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    notifyOwner.mockClear();
    // The row is now failed_permanent; a second sweep must not touch or re-alert.
    const second = await runQboRetrySweep();
    expect(second.retried).toBe(0);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("stays inert (no alert) when QBO is not ready", async () => {
    ready.value = false;
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    await seedFailedLog(invoiceId, MAX_AUTO_RETRY_ATTEMPTS - 1, OLD);

    const result = await runQboRetrySweep();
    expect(result).toEqual({ retried: 0, recovered: 0, exhausted: 0 });
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("does not abort the sweep when the owner alert throws", async () => {
    notifyOwner.mockRejectedValue(new Error("alert boom"));
    const { customerId, vehicleId } = await seedCustomerVehicle();
    const invoiceId = await seedInvoice(customerId, vehicleId);
    const logId = await seedFailedLog(invoiceId, MAX_AUTO_RETRY_ATTEMPTS - 1, OLD);

    // Sweep must still complete and the row must still be marked permanent.
    const result = await runQboRetrySweep();
    expect(result.exhausted).toBe(1);
    const [row] = await db
      .select()
      .from(qboSyncLogTable)
      .where(eq(qboSyncLogTable.id, logId));
    expect(row.status).toBe("failed_permanent");
  });
});
