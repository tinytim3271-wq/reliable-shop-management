import { Router, type IRouter, type Request } from "express";
import { and, eq, gte, lte } from "drizzle-orm";
import { db, mechanicsTable, timeEntriesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { hasPermission } from "../lib/auth";
import { readJsonFile, writeJsonFile } from "../lib/jsonFileStore";

type EmploymentType = "W2" | "1099";
type EmploymentStatus = "active" | "inactive" | "terminated";

interface EmployeeRecord {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  employmentType: EmploymentType;
  employmentStatus: EmploymentStatus;
  departmentRole: string | null;
  hourlyRate: number;
  annualSalary: number | null;
  hireDate: string | null;
  ssnLast4: string | null;
  taxIdLast4: string | null;
  address: string | null;
  emergencyContact: string | null;
  emergencyContactPhone: string | null;
  notes: string | null;
  mechanicId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface PayrollStub {
  id: string;
  payrollRunId: string;
  employeeId: number;
  employeeName: string;
  checkDate: string;
  payPeriodStart: string;
  payPeriodEnd: string;
  regularHours: number;
  regularRate: number;
  grossPay: number;
  deductions: {
    federalIncomeTax: number;
    socialSecurityTax: number;
    medicareTax: number;
    stateIncomeTax: number;
    other: number;
    total: number;
  };
  netPay: number;
  createdAt: string;
}

interface PayrollRun {
  id: string;
  payPeriodStart: string;
  payPeriodEnd: string;
  checkDate: string;
  createdByUserId: number;
  employeesProcessed: number;
  totalGrossPay: number;
  totalNetPay: number;
  totalDeductions: number;
  createdAt: string;
}

interface PayrollStore {
  employees: EmployeeRecord[];
  payrollRuns: PayrollRun[];
  payStubs: PayrollStub[];
}

const STORE_FILE = "employees-payroll.json";
const EMPTY_STORE: PayrollStore = {
  employees: [],
  payrollRuns: [],
  payStubs: [],
};

const router: IRouter = Router();

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const nowIso = (): string => new Date().toISOString();

const nextId = (items: Array<{ id: number }>): number => {
  let max = 0;
  for (const item of items) {
    if (item.id > max) max = item.id;
  }
  return max + 1;
};

const safeLast4 = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return digits.slice(-4);
};

const fullName = (e: EmployeeRecord): string => `${e.firstName} ${e.lastName}`.trim();

const isIsoDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function requireAdminAccess(req: Request, res: Parameters<IRouter["get"]>[1], next: () => void): void {
  if (!req.currentUser) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (req.currentUser.role === "admin" || hasPermission(req, "payroll") || hasPermission(req, "users")) {
    next();
    return;
  }
  res.status(403).json({ error: "Admin or payroll permission required" });
}

async function loadStore(): Promise<PayrollStore> {
  return readJsonFile<PayrollStore>(STORE_FILE, EMPTY_STORE);
}

async function saveStore(store: PayrollStore): Promise<void> {
  await writeJsonFile(STORE_FILE, store);
}

router.post("/employees", requireAdminAccess, async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      employmentType,
      hireDate,
      departmentRole,
      hourlyRate,
      annualSalary,
      employmentStatus,
      ssn,
      taxId,
      address,
      emergencyContact,
      emergencyContactPhone,
      notes,
      mechanicId,
    } = req.body ?? {};

    if (!firstName || !lastName || !email || !employmentType) {
      res.status(400).json({
        error: "Missing required fields",
        required: ["firstName", "lastName", "email", "employmentType"],
      });
      return;
    }

    if (employmentType !== "W2" && employmentType !== "1099") {
      res.status(400).json({ error: "employmentType must be W2 or 1099" });
      return;
    }

    const store = await loadStore();
    const ts = nowIso();
    const employee: EmployeeRecord = {
      id: nextId(store.employees),
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      email: String(email).trim().toLowerCase(),
      phone: typeof phone === "string" ? phone.trim() : null,
      employmentType,
      employmentStatus:
        employmentStatus === "inactive" || employmentStatus === "terminated"
          ? employmentStatus
          : "active",
      departmentRole: typeof departmentRole === "string" ? departmentRole.trim() : null,
      hourlyRate: Number.isFinite(Number(hourlyRate)) ? round2(Number(hourlyRate)) : 0,
      annualSalary: Number.isFinite(Number(annualSalary)) ? round2(Number(annualSalary)) : null,
      hireDate: isIsoDate(hireDate) ? hireDate : null,
      ssnLast4: safeLast4(ssn),
      taxIdLast4: safeLast4(taxId),
      address: typeof address === "string" ? address.trim() : null,
      emergencyContact:
        typeof emergencyContact === "string" ? emergencyContact.trim() : null,
      emergencyContactPhone:
        typeof emergencyContactPhone === "string" ? emergencyContactPhone.trim() : null,
      notes: typeof notes === "string" ? notes : null,
      mechanicId: Number.isInteger(Number(mechanicId)) ? Number(mechanicId) : null,
      createdAt: ts,
      updatedAt: ts,
    };

    store.employees.push(employee);
    await saveStore(store);

    logger.info({ userId: req.currentUser?.id, employeeId: employee.id }, "Employee created");

    res.status(201).json({ success: true, employeeId: employee.id, employee });
  } catch (err) {
    logger.error({ err }, "Failed to create employee");
    res.status(500).json({ error: "Failed to create employee" });
  }
});

router.get("/employees", requireAdminAccess, async (req, res) => {
  try {
    const statusQ = typeof req.query.status === "string" ? req.query.status : null;
    const typeQ = typeof req.query.employmentType === "string" ? req.query.employmentType : null;
    const searchQ = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";

    const store = await loadStore();
    const filtered = store.employees.filter((e) => {
      if (statusQ && e.employmentStatus !== statusQ) return false;
      if (typeQ && e.employmentType !== typeQ) return false;
      if (!searchQ) return true;
      const blob = [e.firstName, e.lastName, e.email, e.phone ?? "", e.departmentRole ?? ""]
        .join(" ")
        .toLowerCase();
      return blob.includes(searchQ);
    });

    res.json({
      success: true,
      count: filtered.length,
      employees: filtered.map((e) => ({
        ...e,
        ssn: e.ssnLast4 ? `***-**-${e.ssnLast4}` : null,
        taxId: e.taxIdLast4 ? `***-**-${e.taxIdLast4}` : null,
      })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to list employees");
    res.status(500).json({ error: "Failed to list employees" });
  }
});

router.get("/employees/:id", requireAdminAccess, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid employee id" });
      return;
    }
    const store = await loadStore();
    const employee = store.employees.find((e) => e.id === id);
    if (!employee) {
      res.status(404).json({ error: "Employee not found" });
      return;
    }
    res.json({ success: true, employee });
  } catch (err) {
    logger.error({ err }, "Failed to get employee");
    res.status(500).json({ error: "Failed to get employee" });
  }
});

router.patch("/employees/:id", requireAdminAccess, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid employee id" });
      return;
    }

    const store = await loadStore();
    const employee = store.employees.find((e) => e.id === id);
    if (!employee) {
      res.status(404).json({ error: "Employee not found" });
      return;
    }

    const updates = req.body ?? {};
    if (typeof updates.firstName === "string") employee.firstName = updates.firstName.trim();
    if (typeof updates.lastName === "string") employee.lastName = updates.lastName.trim();
    if (typeof updates.email === "string") employee.email = updates.email.trim().toLowerCase();
    if (typeof updates.phone === "string") employee.phone = updates.phone.trim();
    if (updates.employmentType === "W2" || updates.employmentType === "1099") {
      employee.employmentType = updates.employmentType;
    }
    if (
      updates.employmentStatus === "active" ||
      updates.employmentStatus === "inactive" ||
      updates.employmentStatus === "terminated"
    ) {
      employee.employmentStatus = updates.employmentStatus;
    }
    if (typeof updates.departmentRole === "string") employee.departmentRole = updates.departmentRole.trim();
    if (Number.isFinite(Number(updates.hourlyRate))) employee.hourlyRate = round2(Number(updates.hourlyRate));
    if (Number.isFinite(Number(updates.annualSalary))) employee.annualSalary = round2(Number(updates.annualSalary));
    if (isIsoDate(updates.hireDate)) employee.hireDate = updates.hireDate;
    if (updates.ssn) employee.ssnLast4 = safeLast4(updates.ssn);
    if (updates.taxId) employee.taxIdLast4 = safeLast4(updates.taxId);
    if (typeof updates.address === "string") employee.address = updates.address;
    if (typeof updates.emergencyContact === "string") employee.emergencyContact = updates.emergencyContact;
    if (typeof updates.emergencyContactPhone === "string") {
      employee.emergencyContactPhone = updates.emergencyContactPhone;
    }
    if (typeof updates.notes === "string") employee.notes = updates.notes;
    if (Number.isInteger(Number(updates.mechanicId))) {
      employee.mechanicId = Number(updates.mechanicId);
    }

    employee.updatedAt = nowIso();
    await saveStore(store);

    logger.info({ userId: req.currentUser?.id, employeeId: id }, "Employee updated");

    res.json({ success: true, employee });
  } catch (err) {
    logger.error({ err }, "Failed to update employee");
    res.status(500).json({ error: "Failed to update employee" });
  }
});

router.get("/employees/:id/payroll-history", requireAdminAccess, async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      res.status(400).json({ error: "Invalid employee id" });
      return;
    }

    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : null;
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : null;

    const store = await loadStore();
    const employee = store.employees.find((e) => e.id === employeeId);
    if (!employee) {
      res.status(404).json({ error: "Employee not found" });
      return;
    }

    const rows = store.payStubs
      .filter((s) => s.employeeId === employeeId)
      .filter((s) => (!startDate || s.checkDate >= startDate) && (!endDate || s.checkDate <= endDate))
      .sort((a, b) => b.checkDate.localeCompare(a.checkDate));

    res.json({ success: true, employeeId, payrollHistory: rows });
  } catch (err) {
    logger.error({ err }, "Failed to get payroll history");
    res.status(500).json({ error: "Failed to get payroll history" });
  }
});

router.get("/employees/:id/pay-stub/:payStubId", requireAdminAccess, async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const payStubId = req.params.payStubId;
    const store = await loadStore();
    const stub = store.payStubs.find((s) => s.employeeId === employeeId && s.id === payStubId);

    if (!stub) {
      res.status(404).json({ error: "Pay stub not found" });
      return;
    }

    if (req.query.format === "pdf") {
      res.status(501).json({ error: "PDF export is not yet enabled for pay stubs" });
      return;
    }

    res.json({ success: true, payStub: stub });
  } catch (err) {
    logger.error({ err }, "Failed to get pay stub");
    res.status(500).json({ error: "Failed to get pay stub" });
  }
});

router.post("/payroll/generate", requireAdminAccess, async (req, res) => {
  try {
    const { payPeriodStart, payPeriodEnd, checkDate } = req.body ?? {};
    if (!isIsoDate(payPeriodStart) || !isIsoDate(payPeriodEnd) || !isIsoDate(checkDate)) {
      res.status(400).json({
        error: "Invalid required fields",
        required: ["payPeriodStart", "payPeriodEnd", "checkDate"],
      });
      return;
    }
    if (payPeriodEnd < payPeriodStart) {
      res.status(400).json({ error: "payPeriodEnd must be on or after payPeriodStart" });
      return;
    }

    const store = await loadStore();
    const activeEmployees = store.employees.filter((e) => e.employmentStatus === "active");
    if (activeEmployees.length === 0) {
      res.status(400).json({ error: "No active employees found" });
      return;
    }

    const rows = await db
      .select({
        mechanicId: timeEntriesTable.mechanicId,
        mechanicName: mechanicsTable.name,
        date: timeEntriesTable.date,
        hours: timeEntriesTable.hours,
        rate: timeEntriesTable.rate,
        totalPay: timeEntriesTable.totalPay,
      })
      .from(timeEntriesTable)
      .leftJoin(mechanicsTable, eq(timeEntriesTable.mechanicId, mechanicsTable.id))
      .where(
        and(
          gte(timeEntriesTable.date, payPeriodStart),
          lte(timeEntriesTable.date, payPeriodEnd),
        ),
      );

    const byMechanic = new Map<number, { hours: number; gross: number }>();
    for (const row of rows) {
      const mechanicId = row.mechanicId ?? -1;
      const prev = byMechanic.get(mechanicId) ?? { hours: 0, gross: 0 };
      prev.hours += Number(row.hours) || 0;
      prev.gross += Number(row.totalPay) || (Number(row.hours) || 0) * (Number(row.rate) || 0);
      byMechanic.set(mechanicId, prev);
    }

    const runId = `PR-${Date.now()}`;
    const stubs: PayrollStub[] = [];

    for (const employee of activeEmployees) {
      let regularHours = 0;
      let grossPay = 0;
      if (employee.mechanicId !== null && byMechanic.has(employee.mechanicId)) {
        const agg = byMechanic.get(employee.mechanicId)!;
        regularHours = round2(agg.hours);
        grossPay = round2(agg.gross);
      } else {
        const rate = employee.hourlyRate > 0 ? employee.hourlyRate : 0;
        regularHours = 0;
        grossPay = round2(regularHours * rate);
      }

      const federalIncomeTax = employee.employmentType === "W2" ? round2(grossPay * 0.12) : 0;
      const socialSecurityTax = employee.employmentType === "W2" ? round2(grossPay * 0.062) : 0;
      const medicareTax = employee.employmentType === "W2" ? round2(grossPay * 0.0145) : 0;
      const stateIncomeTax = employee.employmentType === "W2" ? round2(grossPay * 0.03) : 0;
      const other = 0;
      const totalDeductions = round2(
        federalIncomeTax + socialSecurityTax + medicareTax + stateIncomeTax + other,
      );
      const netPay = round2(Math.max(0, grossPay - totalDeductions));

      stubs.push({
        id: `PS-${Date.now()}-${employee.id}`,
        payrollRunId: runId,
        employeeId: employee.id,
        employeeName: fullName(employee),
        checkDate,
        payPeriodStart,
        payPeriodEnd,
        regularHours,
        regularRate: employee.hourlyRate,
        grossPay,
        deductions: {
          federalIncomeTax,
          socialSecurityTax,
          medicareTax,
          stateIncomeTax,
          other,
          total: totalDeductions,
        },
        netPay,
        createdAt: nowIso(),
      });
    }

    const run: PayrollRun = {
      id: runId,
      payPeriodStart,
      payPeriodEnd,
      checkDate,
      createdByUserId: req.currentUser!.id,
      employeesProcessed: stubs.length,
      totalGrossPay: round2(stubs.reduce((s, st) => s + st.grossPay, 0)),
      totalNetPay: round2(stubs.reduce((s, st) => s + st.netPay, 0)),
      totalDeductions: round2(stubs.reduce((s, st) => s + st.deductions.total, 0)),
      createdAt: nowIso(),
    };

    store.payrollRuns.unshift(run);
    store.payStubs.unshift(...stubs);
    await saveStore(store);

    logger.info({ userId: req.currentUser?.id, runId }, "Payroll generated");

    res.json({
      success: true,
      message: "Payroll generated successfully",
      payrollRun: run,
    });
  } catch (err) {
    logger.error({ err }, "Failed to generate payroll");
    res.status(500).json({ error: "Failed to generate payroll" });
  }
});

router.get("/payroll/year-end-report/:year", requireAdminAccess, async (req, res) => {
  try {
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: "Invalid year" });
      return;
    }

    const store = await loadStore();
    const yearStubs = store.payStubs.filter((s) => s.checkDate.startsWith(`${year}-`));
    const byEmployee = new Map<number, { gross: number; net: number; tax: number }>();

    for (const stub of yearStubs) {
      const prev = byEmployee.get(stub.employeeId) ?? { gross: 0, net: 0, tax: 0 };
      prev.gross += stub.grossPay;
      prev.net += stub.netPay;
      prev.tax += stub.deductions.total;
      byEmployee.set(stub.employeeId, prev);
    }

    const employees = store.employees
      .filter((e) => byEmployee.has(e.id))
      .map((e) => {
        const totals = byEmployee.get(e.id)!;
        return {
          id: e.id,
          name: fullName(e),
          employmentType: e.employmentType,
          totalGrossPay: round2(totals.gross),
          totalTaxWithheld: round2(totals.tax),
          totalNetPay: round2(totals.net),
          documentType: e.employmentType === "W2" ? "W2" : "1099",
        };
      });

    res.json({
      success: true,
      report: {
        year,
        generatedDate: nowIso(),
        employees,
        summary: {
          totalEmployees: employees.length,
          w2Employees: employees.filter((e) => e.employmentType === "W2").length,
          contractorEmployees: employees.filter((e) => e.employmentType === "1099").length,
          totalPayroll: round2(employees.reduce((s, e) => s + e.totalGrossPay, 0)),
          totalTaxesPaid: round2(employees.reduce((s, e) => s + e.totalTaxWithheld, 0)),
        },
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to generate year-end report");
    res.status(500).json({ error: "Failed to generate year-end report" });
  }
});

router.get("/employees/:id/w2/:year", requireAdminAccess, async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const year = Number(req.params.year);
    const store = await loadStore();
    const employee = store.employees.find((e) => e.id === employeeId && e.employmentType === "W2");
    if (!employee) {
      res.status(404).json({ error: "W2 employee not found" });
      return;
    }

    const stubs = store.payStubs.filter(
      (s) => s.employeeId === employeeId && s.checkDate.startsWith(`${year}-`),
    );

    const gross = round2(stubs.reduce((s, x) => s + x.grossPay, 0));
    const federal = round2(stubs.reduce((s, x) => s + x.deductions.federalIncomeTax, 0));
    const social = round2(stubs.reduce((s, x) => s + x.deductions.socialSecurityTax, 0));
    const medicare = round2(stubs.reduce((s, x) => s + x.deductions.medicareTax, 0));

    res.json({
      success: true,
      w2: {
        year,
        employeeId,
        employee: {
          name: fullName(employee),
          ssn: employee.ssnLast4 ? `***-**-${employee.ssnLast4}` : null,
          address: employee.address,
        },
        w2Data: {
          boxes: {
            1: { description: "Wages, tips, other compensation", value: gross },
            2: { description: "Federal income tax withheld", value: federal },
            3: { description: "Social security wages", value: gross },
            4: { description: "Social security tax withheld", value: social },
            5: { description: "Medicare wages and tips", value: gross },
            6: { description: "Medicare tax withheld", value: medicare },
          },
        },
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to generate W2");
    res.status(500).json({ error: "Failed to generate W2" });
  }
});

router.get("/employees/:id/1099/:year", requireAdminAccess, async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const year = Number(req.params.year);
    const store = await loadStore();
    const employee = store.employees.find((e) => e.id === employeeId && e.employmentType === "1099");
    if (!employee) {
      res.status(404).json({ error: "1099 contractor not found" });
      return;
    }

    const stubs = store.payStubs.filter(
      (s) => s.employeeId === employeeId && s.checkDate.startsWith(`${year}-`),
    );

    const gross = round2(stubs.reduce((s, x) => s + x.grossPay, 0));

    res.json({
      success: true,
      form1099: {
        year,
        contractorId: employeeId,
        contractor: {
          name: fullName(employee),
          taxId: employee.taxIdLast4 ? `***-**-${employee.taxIdLast4}` : null,
          address: employee.address,
        },
        income: { nonemployeeCompensation: gross },
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to generate 1099");
    res.status(500).json({ error: "Failed to generate 1099" });
  }
});

// Helper endpoint for dashboard/payroll UI.
router.get("/payroll/runs", requireAdminAccess, async (_req, res) => {
  const store = await loadStore();
  res.json({ success: true, payrollRuns: store.payrollRuns.slice(0, 100) });
});

export default router;
