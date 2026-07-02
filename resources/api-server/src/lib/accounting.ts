import { db, invoicesTable, invoiceLineItemsTable } from "@workspace/db";
import { round2 } from "./ledger";

// Date helpers live in ./dates to avoid a circular import (ledger.ts needs them
// too). Re-exported here so existing `../lib/accounting` importers keep working.
export { dayOf, monthOf, inRange } from "./dates";

// Invoices that are not counted as sales (still being drafted or cancelled).
const NON_SALE_STATUSES = new Set(["draft", "void", "cancelled"]);

export type InvoiceFigure = {
  id: number;
  status: string;
  createdAt: string;
  taxRate: number;
  subtotal: number;
  taxAmount: number;
};

// Computes per-invoice subtotal and tax for all issued (sale) invoices. Used by
// the profit/loss and tax reports so revenue math stays in one place.
export const getIssuedInvoiceFigures = async (): Promise<InvoiceFigure[]> => {
  const invoices = await db.select().from(invoicesTable);
  const lineItems = await db.select().from(invoiceLineItemsTable);

  return invoices
    .filter((inv) => !NON_SALE_STATUSES.has(inv.status))
    .map((inv) => {
      const subtotal = round2(
        lineItems
          .filter((li) => li.invoiceId === inv.id)
          .reduce((sum, li) => sum + li.quantity * li.unitPrice, 0),
      );
      const taxAmount = round2((subtotal * inv.taxRate) / 100);
      return {
        id: inv.id,
        status: inv.status,
        createdAt: inv.createdAt,
        taxRate: inv.taxRate,
        subtotal,
        taxAmount,
      };
    });
};
