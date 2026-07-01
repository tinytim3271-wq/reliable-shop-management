import { z } from "zod";
import type { AiToolDef, AiToolContext } from "./aiTools";
import type { PermissionKey } from "./auth";
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
} from "./reporting";

// How many detail rows any report summary tool returns to the model, to bound
// the size of the spoken summary.
const ROW_LIMIT = 10;

// A report key the assistant can read, navigate to, or print. Each maps to the
// frontend location that renders it and the module permission that guards it, so
// navigate/print can gate per-report without being tied to a single permission.
type ReportKey =
  | "payday"
  | "profit-loss"
  | "expenses"
  | "tax"
  | "sales-summary"
  | "accounts-receivable"
  | "top-services"
  | "payments-by-method"
  | "stock-movements";

interface ReportDef {
  label: string;
  permission: PermissionKey;
  // Frontend base path. Payday is a standalone page; the rest are tabs on the
  // Reports page selected via the `tab` query param.
  basePath: string;
  tab?: string;
}

const REPORTS: Record<ReportKey, ReportDef> = {
  payday: { label: "Payday / Payroll", permission: "payroll", basePath: "/payday" },
  "profit-loss": {
    label: "Profit & Loss",
    permission: "accounting",
    basePath: "/reports",
    tab: "pl",
  },
  expenses: {
    label: "Expenses",
    permission: "accounting",
    basePath: "/reports",
    tab: "expenses",
  },
  tax: { label: "Tax", permission: "accounting", basePath: "/reports", tab: "tax" },
  "sales-summary": {
    label: "Sales Summary",
    permission: "accounting",
    basePath: "/reports",
    tab: "sales",
  },
  "accounts-receivable": {
    label: "Accounts Receivable (A/R Aging)",
    permission: "accounting",
    basePath: "/reports",
    tab: "ar",
  },
  "top-services": {
    label: "Top Services",
    permission: "accounting",
    basePath: "/reports",
    tab: "services",
  },
  "payments-by-method": {
    label: "Payments by Method",
    permission: "accounting",
    basePath: "/reports",
    tab: "payments",
  },
  "stock-movements": {
    label: "Stock Movements",
    permission: "inventory",
    basePath: "/reports",
    tab: "stock",
  },
};

const REPORT_KEYS = Object.keys(REPORTS) as ReportKey[];

function canSeeReport(key: ReportKey, ctx: AiToolContext): boolean {
  if (ctx.isAdmin) return true;
  return ctx.permissions.includes(REPORTS[key].permission);
}

// Build the frontend URL for a report, threading the optional date range and a
// print flag through as query params the target page reads on load.
function buildReportPath(
  key: ReportKey,
  opts: { from?: string; to?: string; print?: boolean; pdf?: boolean },
): string {
  const def = REPORTS[key];
  const params = new URLSearchParams();
  if (def.tab) params.set("tab", def.tab);
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  if (opts.print) params.set("print", "1");
  if (opts.pdf) params.set("pdf", "1");
  const qs = params.toString();
  return qs ? `${def.basePath}?${qs}` : def.basePath;
}

// Build the frontend URL that arms the "email this report as a PDF" flow. The
// target page renders the same PDF as the download path, but routes it into the
// outreach draft instead of saving a file. Recipient + cover-note details ride
// along as query params the page hands to POST /messages (which resolves the
// recipient server-side). The date range is threaded through exactly like the
// download path so the emailed PDF honors the same pre-filter.
function buildReportEmailPath(
  key: ReportKey,
  opts: {
    from?: string;
    to?: string;
    customerId?: number;
    vendorId?: number;
    toName?: string;
    toAddress?: string;
    subject?: string;
    body?: string;
  },
): string {
  const def = REPORTS[key];
  const params = new URLSearchParams();
  if (def.tab) params.set("tab", def.tab);
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  params.set("emailPdf", "1");
  if (opts.customerId != null) params.set("customerId", String(opts.customerId));
  if (opts.vendorId != null) params.set("vendorId", String(opts.vendorId));
  if (opts.toName) params.set("toName", opts.toName);
  if (opts.toAddress) params.set("toAddress", opts.toAddress);
  if (opts.subject) params.set("subject", opts.subject);
  if (opts.body) params.set("body", opts.body);
  return `${def.basePath}?${params.toString()}`;
}

// An ISO calendar date (YYYY-MM-DD). Matches the date-range query params the
// report routes accept; passed straight through to the compute helpers.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date, e.g. 2026-01-31");

const dateRangeShape = {
  from: isoDate.optional(),
  to: isoDate.optional(),
};

const dateRangeProps = {
  from: {
    type: "string",
    description: "Start of the date range (inclusive), ISO YYYY-MM-DD.",
  },
  to: {
    type: "string",
    description: "End of the date range (inclusive), ISO YYYY-MM-DD.",
  },
};

function periodLabel(from?: string, to?: string): string {
  if (from && to) return `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `through ${to}`;
  return "all time";
}

// Spoken report summaries default to the CURRENT calendar month when the model
// supplies no date range, mirroring the report pages' default view so Timothy's
// numbers match what the user sees on screen (the alternative -- passing
// undefined through to the compute helpers -- would silently summarize all of
// history). A missing bound is filled to the matching current-month edge so a
// one-sided range still resolves deterministically.
function isoLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function withMonthDefault(
  from?: string,
  to?: string,
): { from: string; to: string } {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    from: from ?? isoLocalDate(monthStart),
    to: to ?? isoLocalDate(monthEnd),
  };
}

// The nine report read tools. Each returns a compact summary the model speaks;
// large row arrays are trimmed to ROW_LIMIT so the tool result stays small.
const reportReadTools: AiToolDef[] = [
  {
    name: "get_payday_report",
    description:
      "Get the payroll/payday summary for an optional date range: total hours, gross pay, advances, and net pay per mechanic plus shop totals.",
    kind: "read",
    requiredPermission: "payroll",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { ...dateRangeProps },
    },
    argsSchema: z.object({ ...dateRangeShape }),
    async execute(args) {
      const { from, to } = args as { from?: string; to?: string };
      const range = withMonthDefault(from, to);
      const r = await computePaydayReport({ startDate: range.from, endDate: range.to });
      return {
        period: periodLabel(range.from, range.to),
        totalHours: r.totalHours,
        totalGross: r.totalGross,
        totalAdvances: r.totalAdvances,
        totalNet: r.totalNet,
        mechanicCount: r.rows.length,
        mechanics: r.rows.slice(0, ROW_LIMIT).map((m) => ({
          name: m.mechanicName,
          hours: m.hours,
          grossPay: m.grossPay,
          netPay: m.netPay,
        })),
      };
    },
  },
  {
    name: "get_profit_loss_report",
    description:
      "Get the profit & loss summary for an optional date range: revenue, tax collected, payroll, total expenses, and net profit.",
    kind: "read",
    requiredPermission: "accounting",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { ...dateRangeProps },
    },
    argsSchema: z.object({ ...dateRangeShape }),
    async execute(args) {
      const { from, to } = args as { from?: string; to?: string };
      const range = withMonthDefault(from, to);
      const r = await computeProfitLossReport({ startDate: range.from, endDate: range.to });
      return {
        period: periodLabel(range.from, range.to),
        revenue: r.revenue,
        taxCollected: r.taxCollected,
        payroll: r.payroll,
        totalExpenses: r.totalExpenses,
        netProfit: r.netProfit,
        topExpenseCategories: r.expenses.slice(0, ROW_LIMIT),
      };
    },
  },
  {
    name: "get_expense_report",
    description:
      "Get the expense summary for an optional date range: total spent, tax-deductible vs non-deductible totals, tax paid, and a breakdown by category.",
    kind: "read",
    requiredPermission: "accounting",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { ...dateRangeProps },
    },
    argsSchema: z.object({ ...dateRangeShape }),
    async execute(args) {
      const { from, to } = args as { from?: string; to?: string };
      const range = withMonthDefault(from, to);
      const r = await computeExpenseReport({ startDate: range.from, endDate: range.to });
      return {
        period: periodLabel(range.from, range.to),
        total: r.total,
        deductibleTotal: r.deductibleTotal,
        nonDeductibleTotal: r.nonDeductibleTotal,
        taxPaid: r.taxPaid,
        topCategories: r.categories.slice(0, ROW_LIMIT).map((c) => ({
          category: c.category,
          amount: c.amount,
          count: c.count,
        })),
      };
    },
  },
  {
    name: "get_tax_report",
    description:
      "Get the sales-tax summary for an optional date range: taxable vs non-taxable sales, tax collected, effective rate, estimated tax due, and tax paid on purchases. Optionally pass a rate to estimate tax due.",
    kind: "read",
    requiredPermission: "accounting",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...dateRangeProps,
        rate: {
          type: "number",
          description:
            "Optional tax rate percent to estimate tax due against taxable sales.",
        },
      },
    },
    argsSchema: z.object({ ...dateRangeShape, rate: z.number().min(0).max(100).optional() }),
    async execute(args) {
      const { from, to, rate } = args as {
        from?: string;
        to?: string;
        rate?: number;
      };
      const range = withMonthDefault(from, to);
      const r = await computeTaxReport({ startDate: range.from, endDate: range.to, rate });
      return {
        period: periodLabel(range.from, range.to),
        taxableSales: r.taxableSales,
        nonTaxableSales: r.nonTaxableSales,
        grossSales: r.grossSales,
        taxCollected: r.taxCollected,
        effectiveRate: r.effectiveRate,
        appliedRate: r.appliedRate,
        estimatedTaxDue: r.estimatedTaxDue,
        taxPaidOnPurchases: r.taxPaidOnPurchases,
      };
    },
  },
  {
    name: "get_sales_summary_report",
    description:
      "Get the sales summary for an optional date range: gross sales, total invoiced and collected, outstanding A/R, invoice counts by paid status, average ticket, new customers, and completed work orders.",
    kind: "read",
    requiredPermission: "accounting",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { ...dateRangeProps },
    },
    argsSchema: z.object({ ...dateRangeShape }),
    async execute(args) {
      const { from, to } = args as { from?: string; to?: string };
      const range = withMonthDefault(from, to);
      const r = await computeSalesSummaryReport({ startDate: range.from, endDate: range.to });
      return {
        period: periodLabel(range.from, range.to),
        grossSales: r.grossSales,
        totalInvoiced: r.totalInvoiced,
        totalCollected: r.totalCollected,
        arOutstanding: r.arOutstanding,
        invoiceCount: r.invoiceCount,
        paidCount: r.paidCount,
        partialCount: r.partialCount,
        unpaidCount: r.unpaidCount,
        averageTicket: r.averageTicket,
        newCustomers: r.newCustomers,
        completedWorkOrders: r.completedWorkOrders,
      };
    },
  },
  {
    name: "get_accounts_receivable_report",
    description:
      "Get the accounts-receivable aging summary as of now: total outstanding, aging buckets (current, 31-60, 61-90, 90+ days), and the most overdue invoices.",
    kind: "read",
    requiredPermission: "accounting",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    argsSchema: z.object({}),
    async execute(_args, ctx) {
      const r = await computeAccountsReceivableReport({
        canSeeCustomers: ctx.isAdmin || ctx.permissions.includes("customers"),
        canSeeInvoices: ctx.isAdmin || ctx.permissions.includes("invoices"),
      });
      return {
        asOf: r.asOf,
        totalOutstanding: r.totalOutstanding,
        aging: r.aging,
        openInvoiceCount: r.rows.length,
        mostOverdue: r.rows.slice(0, ROW_LIMIT).map((row) => ({
          invoiceId: row.invoiceId,
          customerName: row.customerName,
          balance: row.balance,
          ageDays: row.ageDays,
        })),
      };
    },
    isStoredResultRestricted(content, ctx) {
      // The stored result may contain per-customer and per-invoice detail that
      // required extra permissions (customers, invoices) at execution time.
      // customerName is non-null only when canSeeCustomers was true; balance is
      // non-null only when canSeeInvoices was true. Redact the whole result if
      // the user no longer holds whichever extra permission produced the data.
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const overdue = parsed.mostOverdue;
        if (!Array.isArray(overdue)) return false;
        const hasCustomerData = overdue.some(
          (entry: unknown) =>
            entry !== null &&
            typeof entry === "object" &&
            (entry as Record<string, unknown>).customerName !== null,
        );
        if (hasCustomerData && !ctx.isAdmin && !ctx.permissions.includes("customers")) {
          return true;
        }
        const hasInvoiceData = overdue.some(
          (entry: unknown) =>
            entry !== null &&
            typeof entry === "object" &&
            (entry as Record<string, unknown>).balance !== null,
        );
        if (hasInvoiceData && !ctx.isAdmin && !ctx.permissions.includes("invoices")) {
          return true;
        }
      } catch {
        return true;
      }
      return false;
    },
  },
  {
    name: "get_top_services_report",
    description:
      "Get the top services and parts by revenue for an optional date range. Optionally cap how many rows to return.",
    kind: "read",
    requiredPermission: "accounting",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...dateRangeProps,
        limit: {
          type: "integer",
          description: "Max rows to return (1-20). Defaults to 10.",
        },
      },
    },
    argsSchema: z.object({
      ...dateRangeShape,
      limit: z.number().int().min(1).max(20).optional(),
    }),
    async execute(args) {
      const { from, to, limit } = args as {
        from?: string;
        to?: string;
        limit?: number;
      };
      const range = withMonthDefault(from, to);
      const r = await computeTopServicesReport({
        startDate: range.from,
        endDate: range.to,
        limit: limit ?? ROW_LIMIT,
      });
      return {
        period: periodLabel(range.from, range.to),
        rows: r.rows.map((row) => ({
          description: row.description,
          type: row.type,
          count: row.count,
          totalQuantity: row.totalQuantity,
          totalRevenue: row.totalRevenue,
        })),
      };
    },
  },
  {
    name: "get_payments_by_method_report",
    description:
      "Get payments grouped by tender method (cash, card, check, other) for an optional date range: amount collected, refunded, and net per method plus shop totals.",
    kind: "read",
    requiredPermission: "accounting",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { ...dateRangeProps },
    },
    argsSchema: z.object({ ...dateRangeShape }),
    async execute(args) {
      const { from, to } = args as { from?: string; to?: string };
      const range = withMonthDefault(from, to);
      const r = await computePaymentsByMethodReport({ startDate: range.from, endDate: range.to });
      return {
        period: periodLabel(range.from, range.to),
        totalCollected: r.totalCollected,
        totalRefunded: r.totalRefunded,
        total: r.total,
        paymentCount: r.paymentCount,
        methods: r.methods.map((m) => ({
          method: m.method,
          collected: m.collected,
          refunded: m.refunded,
          net: m.amount,
          count: m.count,
        })),
      };
    },
  },
  {
    name: "get_stock_movements_report",
    description:
      "Get the inventory stock-movement summary for an optional date range: totals added, removed, and net change, plus the most recent movements. Optionally filter by direction (in or out).",
    kind: "read",
    requiredPermission: "inventory",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...dateRangeProps,
        direction: {
          type: "string",
          enum: ["in", "out"],
          description: "Filter to additions (in) or removals (out).",
        },
      },
    },
    argsSchema: z.object({
      ...dateRangeShape,
      direction: z.enum(["in", "out"]).optional(),
    }),
    async execute(args) {
      const { from, to, direction } = args as {
        from?: string;
        to?: string;
        direction?: "in" | "out";
      };
      const range = withMonthDefault(from, to);
      const r = await computeStockMovementReport({
        startDate: range.from,
        endDate: range.to,
        direction,
      });
      return {
        period: periodLabel(range.from, range.to),
        totalMovements: r.totalMovements,
        totalAdded: r.totalAdded,
        totalRemoved: r.totalRemoved,
        netChange: r.netChange,
        recentMovements: r.rows.slice(0, ROW_LIMIT).map((m) => ({
          partName: m.partName,
          delta: m.delta,
          reason: m.reason,
          createdAt: m.createdAt,
        })),
      };
    },
  },
];

const reportKeyProp = {
  report: {
    type: "string",
    enum: REPORT_KEYS,
    description:
      "Which report to open: payday, profit-loss, expenses, tax, sales-summary, accounts-receivable, top-services, payments-by-method, or stock-movements.",
  },
};

const reportKeySchema = z.enum(REPORT_KEYS as [ReportKey, ...ReportKey[]]);

// Navigate and print are meta tools (no single module gate); each enforces the
// target report's own permission inside execute so a user can only open or print
// reports their modules allow. They return a client `action` the agent threads
// back to the frontend, which performs the navigation/print.
const reportNavTools: AiToolDef[] = [
  {
    name: "navigate_to_report",
    description:
      "Open a report on screen for the user, optionally pre-filtered to a date range. Use this when the user asks to see, open, pull up, or go to a report.",
    kind: "read",
    requiredPermission: null,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["report"],
      properties: { ...reportKeyProp, ...dateRangeProps },
    },
    argsSchema: z.object({ report: reportKeySchema, ...dateRangeShape }),
    async execute(args, ctx) {
      const { report, from, to } = args as {
        report: ReportKey;
        from?: string;
        to?: string;
      };
      if (!canSeeReport(report, ctx)) {
        return {
          error: `Permission denied: opening the ${REPORTS[report].label} report requires the "${REPORTS[report].permission}" module.`,
        };
      }
      const path = buildReportPath(report, { from, to });
      return {
        action: { type: "navigate", path },
        navigated: true,
        report: REPORTS[report].label,
        message: `Opening the ${REPORTS[report].label} report.`,
      };
    },
  },
  {
    name: "print_report",
    description:
      "Open a report and trigger the print dialog for the user, optionally pre-filtered to a date range. Use this when the user asks to print a report.",
    kind: "read",
    requiredPermission: null,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["report"],
      properties: { ...reportKeyProp, ...dateRangeProps },
    },
    argsSchema: z.object({ report: reportKeySchema, ...dateRangeShape }),
    async execute(args, ctx) {
      const { report, from, to } = args as {
        report: ReportKey;
        from?: string;
        to?: string;
      };
      if (!canSeeReport(report, ctx)) {
        return {
          error: `Permission denied: printing the ${REPORTS[report].label} report requires the "${REPORTS[report].permission}" module.`,
        };
      }
      const path = buildReportPath(report, { from, to, print: true });
      return {
        action: { type: "print", path },
        printing: true,
        report: REPORTS[report].label,
        message: `Printing the ${REPORTS[report].label} report.`,
      };
    },
  },
  {
    name: "download_report_pdf",
    description:
      "Open a report and download it as a polished PDF file for the user, optionally pre-filtered to a date range. Use this when the user asks to save, download, export, file, or email a report as a PDF (as opposed to just printing it).",
    kind: "read",
    requiredPermission: null,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["report"],
      properties: { ...reportKeyProp, ...dateRangeProps },
    },
    argsSchema: z.object({ report: reportKeySchema, ...dateRangeShape }),
    async execute(args, ctx) {
      const { report, from, to } = args as {
        report: ReportKey;
        from?: string;
        to?: string;
      };
      if (!canSeeReport(report, ctx)) {
        return {
          error: `Permission denied: exporting the ${REPORTS[report].label} report requires the "${REPORTS[report].permission}" module.`,
        };
      }
      const path = buildReportPath(report, { from, to, pdf: true });
      return {
        action: { type: "pdf", path },
        downloading: true,
        report: REPORTS[report].label,
        message: `Downloading the ${REPORTS[report].label} report as a PDF.`,
      };
    },
  },
  {
    name: "email_report_pdf",
    description:
      "Render a report as a polished PDF and start an email draft with it attached, addressed to a customer, vendor, or a free-typed name/email (e.g. the shop's accountant). Optionally pre-filter to a date range. Use this when the user asks to email or send a report to someone. This only prepares a draft in Outreach for the user to review and send -- it never sends anything on its own.",
    kind: "read",
    requiredPermission: null,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["report"],
      properties: {
        ...reportKeyProp,
        ...dateRangeProps,
        customerId: {
          type: "integer",
          description:
            "Send to this customer (resolves their saved email). Use when the recipient is a known customer.",
        },
        vendorId: {
          type: "integer",
          description:
            "Send to this vendor (resolves their saved email). Use when the recipient is a known vendor.",
        },
        toName: {
          type: "string",
          description:
            "Recipient name when they are not a saved customer/vendor, e.g. the accountant's name.",
        },
        toAddress: {
          type: "string",
          description:
            "Recipient email address when they are not a saved customer/vendor.",
        },
        subject: {
          type: "string",
          description: "Optional email subject line. A sensible default is used if omitted.",
        },
        body: {
          type: "string",
          description:
            "Optional short cover note for the email body. A sensible default is used if omitted. Keep it brief.",
        },
      },
    },
    argsSchema: z.object({
      report: reportKeySchema,
      ...dateRangeShape,
      customerId: z.number().int().positive().optional(),
      vendorId: z.number().int().positive().optional(),
      toName: z.string().trim().min(1).max(200).optional(),
      toAddress: z.string().trim().min(1).max(320).optional(),
      subject: z.string().trim().min(1).max(300).optional(),
      body: z.string().trim().min(1).max(1500).optional(),
    }),
    async execute(args, ctx) {
      const { report, from, to, customerId, vendorId, toName, toAddress, subject, body } =
        args as {
          report: ReportKey;
          from?: string;
          to?: string;
          customerId?: number;
          vendorId?: number;
          toName?: string;
          toAddress?: string;
          subject?: string;
          body?: string;
        };
      // Two gates: the report's own module permission (same as the download
      // tool) AND the Outreach module, since this stages a message draft. Both
      // are also enforced server-side (report compute + POST /messages), but
      // checking here avoids minting an action the user can't complete.
      if (!canSeeReport(report, ctx)) {
        return {
          error: `Permission denied: emailing the ${REPORTS[report].label} report requires the "${REPORTS[report].permission}" module.`,
        };
      }
      if (!ctx.isAdmin && !ctx.permissions.includes("communications")) {
        return {
          error:
            'Permission denied: emailing a report requires the "communications" (Outreach & Messaging) module.',
        };
      }
      const path = buildReportEmailPath(report, {
        from,
        to,
        customerId,
        vendorId,
        toName,
        toAddress,
        subject,
        body,
      });
      return {
        action: { type: "email_report", path },
        drafting: true,
        report: REPORTS[report].label,
        message: `Preparing an email draft with the ${REPORTS[report].label} report attached. Review and send it from Outreach.`,
      };
    },
  },
];

export const reportTools: AiToolDef[] = [...reportReadTools, ...reportNavTools];
