import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import {
  db,
  timeEntriesTable,
  expensesTable,
  expenseCategoriesTable,
  invoicesTable,
  invoiceLineItemsTable,
  invoicePaymentsTable,
  customersTable,
  workOrdersTable,
  stockMovementsTable,
  partsTable,
  usersTable,
} from "@workspace/db";
import { computeAllBalances, round2 } from "./ledger";
import { getIssuedInvoiceFigures, inRange, monthOf, dayOf } from "./accounting";

// Single source of truth for every report's computation. Both the REST report
// routes and the AI assistant's report tools call these so the numbers Timothy
// speaks always match the on-screen report.

// Invoices that are not counted as sales (still being drafted or cancelled).
const NON_SALE_STATUSES = new Set(["draft", "void", "cancelled"]);

const UNCATEGORIZED = "Uncategorized";

type DateRange = { startDate?: string; endDate?: string };

export type IssuedInvoiceWithPayments = {
  id: number;
  status: string;
  customerId: number;
  createdAt: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
};

// Per-invoice figures including amountPaid, for sales/AR reporting. Mirrors the
// sale-status filter used elsewhere but also surfaces payment + customer data.
export async function getIssuedInvoicesWithPayments(): Promise<
  IssuedInvoiceWithPayments[]
> {
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
        customerId: inv.customerId,
        createdAt: inv.createdAt,
        subtotal,
        taxAmount,
        total: round2(subtotal + taxAmount),
        amountPaid: inv.amountPaid,
      };
    });
}

export async function computePaydayReport({ startDate, endDate }: DateRange) {
  const balances = await computeAllBalances({ startDate, endDate });
  const rows = balances.map((b) => ({
    mechanicId: b.mechanicId,
    mechanicName: b.mechanicName,
    hours: b.totalHours,
    grossPay: b.grossPay,
    advances: b.deductibleAdvances,
    borrowedDeduction: 0,
    netPay: b.netPay,
  }));

  return {
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    rows,
    totalHours: round2(rows.reduce((s, r) => s + r.hours, 0)),
    totalGross: round2(rows.reduce((s, r) => s + r.grossPay, 0)),
    totalAdvances: round2(rows.reduce((s, r) => s + r.advances, 0)),
    totalBorrowedDeduction: round2(
      rows.reduce((s, r) => s + r.borrowedDeduction, 0),
    ),
    totalNet: round2(rows.reduce((s, r) => s + r.netPay, 0)),
  };
}

export async function computeProfitLossReport({ startDate, endDate }: DateRange) {
  const invoices = (await getIssuedInvoiceFigures()).filter((inv) =>
    inRange(inv.createdAt, startDate, endDate),
  );
  const revenue = round2(invoices.reduce((s, inv) => s + inv.subtotal, 0));
  const taxCollected = round2(invoices.reduce((s, inv) => s + inv.taxAmount, 0));

  const timeEntries = await db.select().from(timeEntriesTable);
  const payroll = round2(
    timeEntries
      .filter((t) => inRange(t.date, startDate, endDate))
      .reduce((s, t) => s + t.totalPay, 0),
  );

  const expenses = await db.select().from(expensesTable);
  const categories = await db.select().from(expenseCategoriesTable);
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const byCategory = new Map<string, number>();
  let totalExpenses = 0;
  for (const e of expenses) {
    if (!inRange(e.date, startDate, endDate)) continue;
    const name =
      e.categoryId !== null
        ? (nameById.get(e.categoryId) ?? UNCATEGORIZED)
        : UNCATEGORIZED;
    byCategory.set(name, round2((byCategory.get(name) ?? 0) + e.amount));
    totalExpenses = round2(totalExpenses + e.amount);
  }

  const expenseRows = [...byCategory.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  return {
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    revenue,
    taxCollected,
    payroll,
    expenses: expenseRows,
    totalExpenses,
    netProfit: round2(revenue - totalExpenses - payroll),
  };
}

export async function computeExpenseReport({ startDate, endDate }: DateRange) {
  const expenses = await db.select().from(expensesTable);
  const categories = await db.select().from(expenseCategoriesTable);
  const catById = new Map(categories.map((c) => [c.id, c]));

  type Agg = {
    categoryId: number | null;
    category: string;
    amount: number;
    count: number;
    taxDeductible: boolean;
  };
  const groups = new Map<string, Agg>();
  let total = 0;
  let deductibleTotal = 0;
  let nonDeductibleTotal = 0;
  let taxPaid = 0;

  for (const e of expenses) {
    if (!inRange(e.date, startDate, endDate)) continue;
    const cat = e.categoryId !== null ? catById.get(e.categoryId) : undefined;
    const taxDeductible = cat ? cat.taxDeductible : true;
    const key = e.categoryId !== null ? `c${e.categoryId}` : "uncategorized";
    const existing = groups.get(key) ?? {
      categoryId: e.categoryId,
      category: cat?.name ?? UNCATEGORIZED,
      amount: 0,
      count: 0,
      taxDeductible,
    };
    existing.amount = round2(existing.amount + e.amount);
    existing.count += 1;
    groups.set(key, existing);

    total = round2(total + e.amount);
    taxPaid = round2(taxPaid + e.taxAmount);
    if (taxDeductible) deductibleTotal = round2(deductibleTotal + e.amount);
    else nonDeductibleTotal = round2(nonDeductibleTotal + e.amount);
  }

  return {
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    categories: [...groups.values()].sort((a, b) => b.amount - a.amount),
    total,
    deductibleTotal,
    nonDeductibleTotal,
    taxPaid,
  };
}

export async function computeTaxReport({
  startDate,
  endDate,
  rate,
}: DateRange & { rate?: number }) {
  const invoices = (await getIssuedInvoiceFigures()).filter((inv) =>
    inRange(inv.createdAt, startDate, endDate),
  );

  let taxableSales = 0;
  let nonTaxableSales = 0;
  let taxCollected = 0;
  const periodMap = new Map<
    string,
    { taxableSales: number; taxCollected: number }
  >();

  for (const inv of invoices) {
    const isTaxed = inv.taxRate > 0;
    if (isTaxed) taxableSales = round2(taxableSales + inv.subtotal);
    else nonTaxableSales = round2(nonTaxableSales + inv.subtotal);
    taxCollected = round2(taxCollected + inv.taxAmount);

    const key = monthOf(inv.createdAt);
    const p = periodMap.get(key) ?? { taxableSales: 0, taxCollected: 0 };
    if (isTaxed) p.taxableSales = round2(p.taxableSales + inv.subtotal);
    p.taxCollected = round2(p.taxCollected + inv.taxAmount);
    periodMap.set(key, p);
  }

  const expenses = await db.select().from(expensesTable);
  const taxPaidOnPurchases = round2(
    expenses
      .filter((e) => inRange(e.date, startDate, endDate))
      .reduce((s, e) => s + e.taxAmount, 0),
  );

  const appliedRate = rate ?? null;
  const estimatedTaxDue =
    appliedRate !== null
      ? round2((taxableSales * appliedRate) / 100)
      : taxCollected;

  return {
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    taxableSales,
    nonTaxableSales,
    grossSales: round2(taxableSales + nonTaxableSales),
    taxCollected,
    effectiveRate:
      taxableSales > 0 ? round2((taxCollected / taxableSales) * 100) : 0,
    appliedRate,
    estimatedTaxDue,
    taxPaidOnPurchases,
    periods: [...periodMap.entries()]
      .map(([period, v]) => ({
        period,
        taxableSales: v.taxableSales,
        taxCollected: v.taxCollected,
      }))
      .sort((a, b) => a.period.localeCompare(b.period)),
  };
}

export async function computeSalesSummaryReport({
  startDate,
  endDate,
}: DateRange) {
  const invoices = (await getIssuedInvoicesWithPayments()).filter((inv) =>
    inRange(inv.createdAt, startDate, endDate),
  );

  let grossSales = 0;
  let taxCollected = 0;
  let totalInvoiced = 0;
  let totalCollected = 0;
  let arOutstanding = 0;
  let paidCount = 0;
  let partialCount = 0;
  let unpaidCount = 0;
  const monthly = new Map<
    string,
    { grossSales: number; taxCollected: number; collected: number }
  >();

  for (const inv of invoices) {
    grossSales = round2(grossSales + inv.subtotal);
    taxCollected = round2(taxCollected + inv.taxAmount);
    totalInvoiced = round2(totalInvoiced + inv.total);
    totalCollected = round2(totalCollected + inv.amountPaid);
    arOutstanding = round2(
      arOutstanding + Math.max(0, round2(inv.total - inv.amountPaid)),
    );

    if (inv.amountPaid <= 0) unpaidCount += 1;
    else if (inv.amountPaid >= inv.total) paidCount += 1;
    else partialCount += 1;

    const key = monthOf(inv.createdAt);
    const m = monthly.get(key) ?? {
      grossSales: 0,
      taxCollected: 0,
      collected: 0,
    };
    m.grossSales = round2(m.grossSales + inv.subtotal);
    m.taxCollected = round2(m.taxCollected + inv.taxAmount);
    m.collected = round2(m.collected + inv.amountPaid);
    monthly.set(key, m);
  }

  const customers = await db.select().from(customersTable);
  const newCustomers = customers.filter((c) =>
    inRange(c.createdAt, startDate, endDate),
  ).length;

  const workOrders = await db.select().from(workOrdersTable);
  const completedWorkOrders = workOrders.filter(
    (w) =>
      inRange(w.createdAt, startDate, endDate) &&
      (w.status === "completed" ||
        w.status === "closed" ||
        w.status === "invoiced"),
  ).length;

  return {
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    grossSales,
    taxCollected,
    totalInvoiced,
    totalCollected,
    arOutstanding,
    invoiceCount: invoices.length,
    paidCount,
    partialCount,
    unpaidCount,
    averageTicket:
      invoices.length > 0 ? round2(totalInvoiced / invoices.length) : 0,
    newCustomers,
    completedWorkOrders,
    monthly: [...monthly.entries()]
      .map(([period, v]) => ({ period, ...v }))
      .sort((a, b) => a.period.localeCompare(b.period)),
  };
}

export async function computeAccountsReceivableReport({
  canSeeCustomers,
  canSeeInvoices,
}: {
  canSeeCustomers: boolean;
  canSeeInvoices: boolean;
}) {
  const invoices = await getIssuedInvoicesWithPayments();

  let nameById: Map<number, string> = new Map();
  if (canSeeCustomers) {
    const customers = await db.select().from(customersTable);
    nameById = new Map(customers.map((c) => [c.id, c.name]));
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const aging = { current: 0, days31to60: 0, days61to90: 0, days90plus: 0 };
  let totalOutstanding = 0;

  const rows = invoices
    .map((inv) => {
      const balance = round2(inv.total - inv.amountPaid);
      const created = dayOf(inv.createdAt);
      const ageDays = Math.max(
        0,
        Math.round(
          (Date.parse(`${today}T00:00:00Z`) -
            Date.parse(`${created}T00:00:00Z`)) /
            86_400_000,
        ),
      );
      return {
        invoiceId: inv.id,
        customerName: canSeeCustomers
          ? (nameById.get(inv.customerId) ?? "Unknown")
          : null,
        status: canSeeInvoices ? inv.status : null,
        invoiceTotal: canSeeInvoices ? inv.total : null,
        amountPaid: canSeeInvoices ? inv.amountPaid : null,
        balance: canSeeInvoices ? balance : null,
        createdAt: inv.createdAt,
        ageDays,
      };
    })
    .filter((r) => (r.balance ?? 0) > 0.005)
    .sort((a, b) => b.ageDays - a.ageDays);

  for (const r of rows) {
    const bal = r.balance ?? 0;
    totalOutstanding = round2(totalOutstanding + bal);
    if (r.ageDays <= 30) aging.current = round2(aging.current + bal);
    else if (r.ageDays <= 60) aging.days31to60 = round2(aging.days31to60 + bal);
    else if (r.ageDays <= 90) aging.days61to90 = round2(aging.days61to90 + bal);
    else aging.days90plus = round2(aging.days90plus + bal);
  }

  return { asOf: now.toISOString(), rows, totalOutstanding, aging };
}

export async function computeTopServicesReport({
  startDate,
  endDate,
  limit = 10,
}: DateRange & { limit?: number }) {
  const invoices = (await getIssuedInvoicesWithPayments()).filter((inv) =>
    inRange(inv.createdAt, startDate, endDate),
  );
  const invoiceIds = new Set(invoices.map((inv) => inv.id));

  const lineItems = await db.select().from(invoiceLineItemsTable);

  type Agg = {
    description: string;
    type: string;
    count: number;
    totalQuantity: number;
    totalRevenue: number;
  };
  const groups = new Map<string, Agg>();

  for (const li of lineItems) {
    if (!invoiceIds.has(li.invoiceId)) continue;
    const key = `${li.type}::${li.description.trim().toLowerCase()}`;
    const existing = groups.get(key) ?? {
      description: li.description,
      type: li.type,
      count: 0,
      totalQuantity: 0,
      totalRevenue: 0,
    };
    existing.count += 1;
    existing.totalQuantity = round2(existing.totalQuantity + li.quantity);
    existing.totalRevenue = round2(
      existing.totalRevenue + li.quantity * li.unitPrice,
    );
    groups.set(key, existing);
  }

  const rows = [...groups.values()]
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, limit);

  return { startDate: startDate ?? null, endDate: endDate ?? null, rows };
}

export async function computePaymentsByMethodReport({
  startDate,
  endDate,
}: DateRange) {
  // Read the durable per-payment trail so collections reconcile by the date the
  // money came in, grouped by how it was tendered (cash/card/check/other).
  // Refunds are stored as negative-amount rows carrying their own method/date,
  // so summing amounts nets them out of the matching bucket and grand total.
  const payments = await db.select().from(invoicePaymentsTable);

  type Agg = {
    method: string;
    collected: number;
    refunded: number;
    amount: number;
    count: number;
  };
  const groups = new Map<string, Agg>();
  let totalCollected = 0;
  let totalRefunded = 0;
  let total = 0;
  let paymentCount = 0;

  for (const p of payments) {
    if (!inRange(p.createdAt, startDate, endDate)) continue;
    const method = p.method;
    const existing = groups.get(method) ?? {
      method,
      collected: 0,
      refunded: 0,
      amount: 0,
      count: 0,
    };
    existing.amount = round2(existing.amount + p.amount);
    total = round2(total + p.amount);
    if (p.amount > 0) {
      existing.collected = round2(existing.collected + p.amount);
      existing.count += 1;
      paymentCount += 1;
      totalCollected = round2(totalCollected + p.amount);
    } else if (p.amount < 0) {
      existing.refunded = round2(existing.refunded - p.amount);
      totalRefunded = round2(totalRefunded - p.amount);
    }
    groups.set(method, existing);
  }

  return {
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    methods: [...groups.values()].sort((a, b) => b.amount - a.amount),
    totalCollected,
    totalRefunded,
    total,
    paymentCount,
  };
}

export async function computeStockMovementReport({
  startDate,
  endDate,
  partId,
  reason,
  createdByUserId,
  direction,
}: DateRange & {
  partId?: number;
  reason?: string;
  createdByUserId?: number;
  direction?: "in" | "out";
}) {
  const conditions = [];
  if (partId !== undefined)
    conditions.push(eq(stockMovementsTable.partId, partId));
  if (reason !== undefined)
    conditions.push(eq(stockMovementsTable.reason, reason));
  if (createdByUserId !== undefined)
    conditions.push(eq(stockMovementsTable.createdByUserId, createdByUserId));
  if (direction === "in") conditions.push(gt(stockMovementsTable.delta, 0));
  if (direction === "out") conditions.push(lt(stockMovementsTable.delta, 0));

  const movements = await db
    .select({
      id: stockMovementsTable.id,
      partId: stockMovementsTable.partId,
      partName: sql<string>`coalesce(${partsTable.name}, ${stockMovementsTable.partName}, '(deleted part)')`,
      partSku: sql<
        string | null
      >`coalesce(${partsTable.sku}, ${stockMovementsTable.partSku})`,
      delta: stockMovementsTable.delta,
      reason: stockMovementsTable.reason,
      sourceType: stockMovementsTable.sourceType,
      sourceId: stockMovementsTable.sourceId,
      createdByUserId: stockMovementsTable.createdByUserId,
      createdByName: usersTable.displayName,
      createdAt: stockMovementsTable.createdAt,
    })
    .from(stockMovementsTable)
    .leftJoin(partsTable, eq(stockMovementsTable.partId, partsTable.id))
    .leftJoin(usersTable, eq(stockMovementsTable.createdByUserId, usersTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(stockMovementsTable.id));

  const rows = movements.filter((m) => inRange(m.createdAt, startDate, endDate));

  const reasonRows = await db
    .selectDistinct({ reason: stockMovementsTable.reason })
    .from(stockMovementsTable)
    .orderBy(stockMovementsTable.reason);
  const availableReasons = reasonRows.map((r) => r.reason);

  const staffRows = await db
    .selectDistinct({
      id: stockMovementsTable.createdByUserId,
      name: usersTable.displayName,
    })
    .from(stockMovementsTable)
    .innerJoin(usersTable, eq(stockMovementsTable.createdByUserId, usersTable.id))
    .orderBy(usersTable.displayName);
  const availableStaff = staffRows
    .filter((s): s is { id: number; name: string } => s.id !== null)
    .map((s) => ({ id: s.id, name: s.name }));

  let totalAdded = 0;
  let totalRemoved = 0;
  for (const m of rows) {
    if (m.delta > 0) totalAdded += m.delta;
    else if (m.delta < 0) totalRemoved += -m.delta;
  }

  return {
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    rows,
    totalMovements: rows.length,
    totalAdded,
    totalRemoved,
    netChange: totalAdded - totalRemoved,
    availableReasons,
    availableStaff,
  };
}
