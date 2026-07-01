import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, timeEntriesTable, mechanicsTable } from "@workspace/db";
import {
  GetPaydayReportQueryParams,
  GetPaydayReportResponse,
  GetDashboardSummaryResponse,
  GetProfitLossReportQueryParams,
  GetProfitLossReportResponse,
  GetExpenseReportQueryParams,
  GetExpenseReportResponse,
  GetTaxReportQueryParams,
  GetTaxReportResponse,
  GetSalesSummaryReportQueryParams,
  GetSalesSummaryReportResponse,
  GetAccountsReceivableReportResponse,
  GetTopServicesReportQueryParams,
  GetTopServicesReportResponse,
  GetPaymentsByMethodReportQueryParams,
  GetPaymentsByMethodReportResponse,
  GetStockMovementReportQueryParams,
  GetStockMovementReportResponse,
} from "@workspace/api-zod";
import { computeAllBalances, round2 } from "../lib/ledger";
import { hasPermission } from "../lib/auth";
import { readJsonFile } from "../lib/jsonFileStore";
import {
  computePaydayReport,
  computeProfitLossReport,
  computeExpenseReport,
  computeTaxReport,
  computeSalesSummaryReport,
  computeAccountsReceivableReport,
  computeTopServicesReport,
  computePaymentsByMethodReport,
  computeStockMovementReport,
} from "../lib/reporting";

const router: IRouter = Router();

interface DashboardPayrollRun {
  id: string;
  payPeriodStart: string;
  payPeriodEnd: string;
  checkDate: string;
  employeesProcessed: number;
  totalGrossPay: number;
  totalNetPay: number;
  totalDeductions: number;
  createdAt: string;
}

interface DashboardStore {
  payrollRuns: DashboardPayrollRun[];
}

router.get("/reports/payday", async (req, res): Promise<void> => {
  const query = GetPaydayReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const report = await computePaydayReport({
    startDate: query.data.startDate,
    endDate: query.data.endDate,
  });

  res.json(GetPaydayReportResponse.parse(report));
});

router.get("/reports/dashboard", async (_req, res): Promise<void> => {
  const balances = await computeAllBalances();

  const recentRows = await db
    .select({
      id: timeEntriesTable.id,
      mechanicId: timeEntriesTable.mechanicId,
      mechanicName: mechanicsTable.name,
      date: timeEntriesTable.date,
      job: timeEntriesTable.job,
      startTime: timeEntriesTable.startTime,
      endTime: timeEntriesTable.endTime,
      hours: timeEntriesTable.hours,
      rate: timeEntriesTable.rate,
      totalPay: timeEntriesTable.totalPay,
      notes: timeEntriesTable.notes,
      createdAt: timeEntriesTable.createdAt,
    })
    .from(timeEntriesTable)
    .leftJoin(mechanicsTable, eq(timeEntriesTable.mechanicId, mechanicsTable.id))
    .orderBy(desc(timeEntriesTable.date), desc(timeEntriesTable.id))
    .limit(8);

  const topEarners = [...balances]
    .sort((a, b) => b.netPay - a.netPay)
    .slice(0, 5)
    .map((b) => ({
      mechanicId: b.mechanicId,
      mechanicName: b.mechanicName,
      hours: b.totalHours,
      grossPay: b.grossPay,
      advances: b.deductibleAdvances,
      borrowedDeduction: 0,
      netPay: b.netPay,
    }));

  const summary = {
    totalMechanics: balances.length,
    activeMechanics: balances.filter((b) => b.status === "active").length,
    totalHoursAllTime: round2(balances.reduce((s, b) => s + b.totalHours, 0)),
    totalGrossAllTime: round2(balances.reduce((s, b) => s + b.grossPay, 0)),
    totalOutstandingAdvances: round2(balances.reduce((s, b) => s + b.deductibleAdvances, 0)),
    totalOutstandingLoans: round2(balances.reduce((s, b) => s + b.outstandingLoanBalance, 0)),
    totalNetOwed: round2(balances.reduce((s, b) => s + b.netPay, 0)),
    recentTimeEntries: recentRows,
    topEarners,
  };

  res.json(GetDashboardSummaryResponse.parse(summary));
});

// Rich dashboard payload for advanced widgets: payroll run velocity, pending
// obligations, and AI posture for offline-readiness indicators.
router.get("/reports/dashboard/advanced", async (_req, res): Promise<void> => {
  const balances = await computeAllBalances();
  const recentRows = await db
    .select({
      id: timeEntriesTable.id,
      mechanicId: timeEntriesTable.mechanicId,
      mechanicName: mechanicsTable.name,
      date: timeEntriesTable.date,
      job: timeEntriesTable.job,
      hours: timeEntriesTable.hours,
      totalPay: timeEntriesTable.totalPay,
    })
    .from(timeEntriesTable)
    .leftJoin(mechanicsTable, eq(timeEntriesTable.mechanicId, mechanicsTable.id))
    .orderBy(desc(timeEntriesTable.date), desc(timeEntriesTable.id))
    .limit(50);

  const payrollStore = await readJsonFile<DashboardStore>(
    "employees-payroll.json",
    { payrollRuns: [] },
  );

  const lastPayrollRuns = (payrollStore.payrollRuns ?? []).slice(0, 6);
  const avgPayrollGross =
    lastPayrollRuns.length > 0
      ? round2(
          lastPayrollRuns.reduce((sum, r) => sum + (Number(r.totalGrossPay) || 0), 0) /
            lastPayrollRuns.length,
        )
      : 0;

  const payrollRiskCount = balances.filter(
    (b) => b.outstandingLoanBalance > 0 || b.deductibleAdvances > 0,
  ).length;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const recentEntryCount7d = recentRows.filter((r) => r.date >= sevenDaysAgo).length;

  res.json({
    generatedAt: new Date().toISOString(),
    workforce: {
      totalMechanics: balances.length,
      activeMechanics: balances.filter((b) => b.status === "active").length,
      totalHoursAllTime: round2(balances.reduce((s, b) => s + b.totalHours, 0)),
      totalNetOwed: round2(balances.reduce((s, b) => s + b.netPay, 0)),
    },
    payroll: {
      outstandingAdvances: round2(
        balances.reduce((s, b) => s + b.deductibleAdvances, 0),
      ),
      outstandingLoans: round2(
        balances.reduce((s, b) => s + b.outstandingLoanBalance, 0),
      ),
      mechanicsWithDeductions: payrollRiskCount,
      recentRuns: lastPayrollRuns,
      averageGrossPerRun: avgPayrollGross,
    },
    operations: {
      recentTimeEntryCount: recentRows.length,
      recentTimeEntryCount7d: recentEntryCount7d,
      latestEntries: recentRows.slice(0, 12),
    },
    ai: {
      offlineFallbackEnabled: true,
      providerLikelyConfigured: Boolean(process.env["OPENAI_API_KEY"]),
    },
  });
});

router.get("/reports/profit-loss", async (req, res): Promise<void> => {
  const query = GetProfitLossReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const report = await computeProfitLossReport(query.data);
  res.json(GetProfitLossReportResponse.parse(report));
});

router.get("/reports/expenses", async (req, res): Promise<void> => {
  const query = GetExpenseReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const report = await computeExpenseReport(query.data);
  res.json(GetExpenseReportResponse.parse(report));
});

router.get("/reports/tax", async (req, res): Promise<void> => {
  const query = GetTaxReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const report = await computeTaxReport(query.data);
  res.json(GetTaxReportResponse.parse(report));
});

router.get("/reports/sales-summary", async (req, res): Promise<void> => {
  const query = GetSalesSummaryReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const report = await computeSalesSummaryReport(query.data);
  res.json(GetSalesSummaryReportResponse.parse(report));
});

router.get("/reports/accounts-receivable", async (req, res): Promise<void> => {
  const report = await computeAccountsReceivableReport({
    canSeeCustomers: hasPermission(req, "customers"),
    canSeeInvoices: hasPermission(req, "invoices"),
  });
  res.json(GetAccountsReceivableReportResponse.parse(report));
});

router.get("/reports/top-services", async (req, res): Promise<void> => {
  const query = GetTopServicesReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const report = await computeTopServicesReport({
    startDate: query.data.startDate,
    endDate: query.data.endDate,
    limit: query.data.limit ?? 10,
  });
  res.json(GetTopServicesReportResponse.parse(report));
});

router.get("/reports/payments-by-method", async (req, res): Promise<void> => {
  const query = GetPaymentsByMethodReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const report = await computePaymentsByMethodReport(query.data);
  res.json(GetPaymentsByMethodReportResponse.parse(report));
});

router.get("/reports/stock-movements", async (req, res): Promise<void> => {
  const query = GetStockMovementReportQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const report = await computeStockMovementReport(query.data);
  res.json(GetStockMovementReportResponse.parse(report));
});

export default router;
