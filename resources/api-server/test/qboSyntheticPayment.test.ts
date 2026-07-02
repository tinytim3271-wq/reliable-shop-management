import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A paid invoice with no explicit payment rows (for example one flipped straight
 * to `paid` by a status edit, or imported without a payment history) must still
 * show as paid in QBO. `pushSyntheticInvoicePayment` posts a single QBO Payment
 * for the paid amount, linked to the already-pushed Invoice, and is idempotent:
 * re-pushing sparse-updates the same Payment instead of minting a duplicate.
 *
 * resolveContext (in qboSync) reads its config/connection through the qboClient
 * exports, so mocking those cross-module bindings makes the module behave as if
 * connected without a live Intuit app. POST writes are captured; GET reads answer
 * with a SyncToken so the idempotent sparse-update path works.
 */

const writes: Array<{ id: string; entity: string; body: unknown }> = [];
let nextId = 1;

vi.mock("../src/lib/qboClient", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/qboClient")>();
  return {
    ...actual,
    getQboConfig: vi.fn(() => ({
      clientId: "test-id",
      clientSecret: "test-secret",
      environment: "sandbox" as const,
      redirectUri: "https://example.test/callback",
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
    })),
    loadConnectionRow: vi.fn(async () => ({
      id: 1,
      realmId: "REALM1",
      accessToken: "tok",
      refreshToken: "refresh",
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      companyName: "Test Co",
      connectedAt: new Date().toISOString(),
      lastSyncAt: null,
      accountMapping: {
        incomeAccount: "ACC-INCOME",
        paymentAccounts: { cash: "ACC-CASH" },
      },
      createdAt: new Date().toISOString(),
    })),
    isConnected: vi.fn(() => true),
    qboQuery: vi.fn(async () => []),
    qboApiRequest: vi.fn(
      async (
        _cfg: unknown,
        _row: unknown,
        method: string,
        path: string,
        body: unknown,
      ) => {
        // GET reads (SyncToken lookups) must not count as writes.
        if (method === "GET") {
          const entity = path.split("/")[0];
          const key = entity.charAt(0).toUpperCase() + entity.slice(1);
          return { [key]: { Id: path.split("/")[1], SyncToken: "1" } };
        }
        const id = `Q${nextId++}`;
        writes.push({ id, entity: path, body });
        if (path === "invoice") return { Invoice: { Id: id } };
        if (path === "payment") return { Payment: { Id: id } };
        if (path === "customer") return { Customer: { Id: id } };
        if (path === "item") return { Item: { Id: id } };
        return {};
      },
    ),
  };
});

import { eq, and } from "drizzle-orm";
import { db, invoicesTable, qboSyncLogTable } from "@workspace/db";
import { pushSyntheticInvoicePayment } from "../src/lib/qboSync";
import { seedCustomerVehicle, type SeededShop } from "./helpers";

let shop: SeededShop;

async function seedPaidInvoice(amountPaid: number) {
  const [inv] = await db
    .insert(invoicesTable)
    .values({
      customerId: shop.customerId,
      vehicleId: shop.vehicleId,
      status: "paid",
      amountPaid,
      taxRate: 0,
    })
    .returning({ id: invoicesTable.id });
  return inv.id;
}

const paymentWrites = () => writes.filter((w) => w.entity === "payment");

beforeEach(() => {
  writes.length = 0;
  nextId = 1;
  vi.clearAllMocks();
});

describe("pushSyntheticInvoicePayment", () => {
  it("posts a Payment linked to the invoice for the paid amount", async () => {
    shop = await seedCustomerVehicle();
    const invoiceId = await seedPaidInvoice(150);

    const ok = await pushSyntheticInvoicePayment(invoiceId);
    expect(ok).toBe(true);

    const [payment] = paymentWrites();
    expect(payment).toBeDefined();
    const body = payment.body as {
      TotalAmt: number;
      Line: Array<{ Amount: number; LinkedTxn: Array<{ TxnType: string }> }>;
      DepositToAccountRef?: { value: string };
    };
    expect(body.TotalAmt).toBe(150);
    expect(body.Line[0].Amount).toBe(150);
    expect(body.Line[0].LinkedTxn[0].TxnType).toBe("Invoice");
    // Falls back to the mapped cash deposit account when no method is known.
    expect(body.DepositToAccountRef?.value).toBe("ACC-CASH");

    const [log] = await db
      .select()
      .from(qboSyncLogTable)
      .where(
        and(
          eq(qboSyncLogTable.entityType, "payment"),
          eq(qboSyncLogTable.entityId, -invoiceId),
        ),
      );
    expect(log.status).toBe("synced");
    expect(log.qboId).toBeTruthy();
  });

  it("is idempotent: a second push sparse-updates the same Payment", async () => {
    shop = await seedCustomerVehicle();
    const invoiceId = await seedPaidInvoice(75);

    await pushSyntheticInvoicePayment(invoiceId);
    const firstPaymentId = paymentWrites()[0].id;

    writes.length = 0;
    await pushSyntheticInvoicePayment(invoiceId);

    const [second] = paymentWrites();
    expect(second).toBeDefined();
    const body = second.body as { Id?: string; sparse?: boolean };
    // Re-push carries the prior QBO id + sparse flag rather than creating anew.
    expect(body.Id).toBe(firstPaymentId);
    expect(body.sparse).toBe(true);

    // Only ever one synthetic-payment log row for this invoice.
    const logs = await db
      .select()
      .from(qboSyncLogTable)
      .where(
        and(
          eq(qboSyncLogTable.entityType, "payment"),
          eq(qboSyncLogTable.entityId, -invoiceId),
        ),
      );
    expect(logs.length).toBe(1);
  });

  it("no-ops on a zero-dollar invoice without posting a Payment", async () => {
    shop = await seedCustomerVehicle();
    const invoiceId = await seedPaidInvoice(0);

    const ok = await pushSyntheticInvoicePayment(invoiceId);
    expect(ok).toBe(true);
    expect(paymentWrites().length).toBe(0);
  });
});
