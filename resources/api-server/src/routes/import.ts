import { Router, type IRouter } from "express";
import { and, eq, ilike, asc, sql, isNull } from "drizzle-orm";
import type { Response } from "express";
import {
  db,
  customersTable,
  vehiclesTable,
  workOrdersTable,
  workOrderLineItemsTable,
  invoicesTable,
  invoiceLineItemsTable,
  expensesTable,
} from "@workspace/db";
import {
  ImportCustomersVehiclesBody,
  ImportCustomersVehiclesResponse,
  ImportWorkOrdersBody,
  ImportWorkOrdersResponse,
  ImportInvoicesBody,
  ImportInvoicesResponse,
  ImportExpensesBody,
  ImportExpensesResponse,
} from "@workspace/api-zod";
import { hasPermission } from "../lib/auth";
import { normalizeLineItems, type LineItemInput } from "../lib/billing";
import { round2 } from "../lib/ledger";
import { resolveExpenseCategoryId } from "../lib/expenseCategories";

const MAX_IMPORT_ROWS = 2000;

const router: IRouter = Router();

// Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, and
// commas/newlines inside quotes.
const parseCsv = (input: string): string[][] => {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const text = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

const normalize = (header: string): string => header.trim().toLowerCase().replace(/[\s_/-]+/g, "");

type AliasMap = Record<string, string[]>;

// Customer / vehicle column aliases shared by every import that resolves an
// owner + vehicle (customers-vehicles, work orders, invoices). Covers the most
// common header spellings from Mitchell1, Tekmetric, Shopmonkey, AutoFluent and
// QuickBooks exports.
const CUSTOMER_ALIASES: AliasMap = {
  firstName: ["firstname", "fname", "first"],
  lastName: ["lastname", "lname", "last"],
  name: ["name", "customer", "customername", "client", "clientname", "fullname", "billingname"],
  phone: ["phone", "phonenumber", "cell", "cellphone", "mobile", "telephone", "homephone"],
  email: ["email", "emailaddress", "email1"],
  address: ["address", "street", "streetaddress", "address1", "addressline1", "billingaddress"],
};

const VEHICLE_ALIASES: AliasMap = {
  year: ["year", "modelyear", "vehicleyear", "yr"],
  make: ["make", "vehiclemake", "manufacturer"],
  model: ["model", "vehiclemodel"],
  vin: ["vin", "vinnumber", "vehicleidentificationnumber"],
  licensePlate: ["licenseplate", "plate", "license", "tag", "tagnumber", "platenumber"],
  color: ["color", "colour"],
  mileage: ["mileage", "odometer", "miles", "odo"],
};

// Original customers-vehicles import alias set (unchanged behavior).
const FIELD_ALIASES: AliasMap = { ...CUSTOMER_ALIASES, ...VEHICLE_ALIASES };

// Work-order import: customer + vehicle, plus the work-order fields and the
// labor/parts columns used to seed line items.
const WORK_ORDER_ALIASES: AliasMap = {
  ...CUSTOMER_ALIASES,
  ...VEHICLE_ALIASES,
  title: ["title", "service", "servicename", "jobname", "job", "summary", "workrequested", "ronumber", "ro"],
  description: ["description", "servicedescription", "jobdescription", "workperformed", "details", "recommendation"],
  complaint: ["complaint", "concern", "customerconcern", "reportedissue", "symptom", "customerstates", "cause"],
  notes: ["notes", "note", "comments", "comment", "internalnotes", "memo"],
  status: ["status", "rostatus", "workorderstatus", "state", "stage"],
  openedAt: ["openedat", "opened", "datecreated", "createddate", "rodate", "date", "orderdate", "dateopened"],
  completedAt: ["completedat", "completed", "datecompleted", "closeddate", "dateclosed", "completiondate", "datefinished"],
  laborDescription: ["labor", "labordescription", "labordetail", "laboritem", "laborname"],
  laborAmount: ["laboramount", "labortotal", "laborcost", "laborprice", "laborcharge"],
  laborHours: ["laborhours", "hours", "billedhours", "laborhrs"],
  laborRate: ["laborrate", "rate", "hourlyrate"],
  partsDescription: ["parts", "partsdescription", "partdescription", "partname", "part", "partitem"],
  partsAmount: ["partsamount", "partstotal", "partscost", "partsprice", "partcost"],
  partsQuantity: ["partsquantity", "partqty", "quantity", "qty", "partsqty"],
};

// Invoice import: customer + (optional) vehicle, plus the amount/paid/tax/desc
// columns. Recognizes QuickBooks "Customer Balance Summary" (Customer/Balance)
// and "Invoice List" (Date/Num/Customer/Amount) headers via the aliases below.
const INVOICE_ALIASES: AliasMap = {
  ...CUSTOMER_ALIASES,
  ...VEHICLE_ALIASES,
  invoiceDate: ["date", "invoicedate", "txndate", "transactiondate", "datecreated"],
  description: ["description", "memo", "item", "service", "lineitem", "details", "productservice", "product"],
  amount: ["total", "amount", "invoicetotal", "balance", "grandtotal", "totalamount", "invoiceamount", "amountpaid"],
  amountPaid: ["paid", "amountpaid", "payment", "paymentamount", "totalpaid", "paymentsreceived"],
  tax: ["tax", "taxamount", "salestax", "taxtotal"],
  laborAmount: ["laboramount", "labortotal", "laborcost"],
  partsAmount: ["partsamount", "partstotal", "partscost"],
};

// Expense import: QuickBooks Expense Detail (Date, Name, Account, Amount, Memo,
// Payment Method) plus generic shop-system aliases.
const EXPENSE_ALIASES: AliasMap = {
  date: ["date", "txndate", "transactiondate", "expensedate"],
  vendor: ["vendor", "name", "payee", "vendorname", "paidto", "supplier", "merchant"],
  category: ["account", "category", "expensecategory", "accountname", "type", "expensetype", "split"],
  amount: ["amount", "total", "debit", "expenseamount", "cost"],
  memo: ["memo", "description", "notes", "note", "details", "memodescription"],
  paymentMethod: ["paymentmethod", "method", "paymenttype", "paidby", "creditcard", "paymentaccount"],
  tax: ["tax", "taxamount", "salestax"],
};

const buildHeaderMap = (headers: string[], aliases: AliasMap): Record<string, number> => {
  const map: Record<string, number> = {};
  headers.forEach((raw, index) => {
    const norm = normalize(raw);
    for (const [field, list] of Object.entries(aliases)) {
      if (list.includes(norm) && !(field in map)) {
        map[field] = index;
      }
    }
  });
  return map;
};

const cell = (row: string[], idx: number | undefined): string | null => {
  if (idx === undefined) return null;
  const value = row[idx]?.trim();
  return value && value !== "" ? value : null;
};

// Parse a money-ish cell ("$1,234.56", "(45.00)" for negatives) to a number, or
// null when the cell is blank/unparseable.
const parseMoney = (raw: string | null): number | null => {
  if (raw === null) return null;
  const negative = /^\(.*\)$/.test(raw.trim());
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
};

const pad = (v: string | number): string => String(v).padStart(2, "0");

// Parse a date cell to an ISO "YYYY-MM-DD" string. Handles ISO, US MM/DD/YYYY,
// and 2-digit years, falling back to Date.parse. Returns null when unparseable.
const parseDate = (raw: string | null): string | null => {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${pad(m[1])}-${pad(m[2])}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const dt = new Date(t);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }
  return null;
};

// Turn a thrown error into a specific, staff-readable per-row reason. Recognizes
// the common PostgreSQL (and PGlite) SQLSTATE codes so a failed row can name the
// offending column/constraint instead of the generic "Failed to import row".
const describeRowError = (err: unknown): string => {
  const e = err as { code?: unknown; column?: unknown; constraint?: unknown };
  const code = typeof e?.code === "string" ? e.code : "";
  const column = typeof e?.column === "string" && e.column ? e.column : null;
  switch (code) {
    case "23502": // not_null_violation
      return column ? `Missing a required value for "${column}"` : "Missing a required value";
    case "22001": // string_data_right_truncation
      return column ? `Value too long for "${column}"` : "A value is too long for its column";
    case "22003": // numeric_value_out_of_range
      return "A numeric value is out of range";
    case "22007": // invalid_datetime_format
    case "22008": // datetime_field_overflow
      return "A date value could not be parsed";
    case "22P02": // invalid_text_representation
      return "A value has the wrong format (expected a number or date)";
    case "23505": // unique_violation
      return "This row duplicates an existing record";
    case "23503": // foreign_key_violation
      return "This row references a record that does not exist";
    default:
      return "Failed to import row";
  }
};

// Validate row count + header presence; returns the parsed grid or null after
// having already sent a 400 response.
const parseGridOrError = (csv: string, res: Response): string[][] | null => {
  const grid = parseCsv(csv).filter((r) => r.some((c) => c.trim() !== ""));
  if (grid.length < 2) {
    res.status(400).json({ error: "CSV must include a header row and at least one data row" });
    return null;
  }
  const dataRows = grid.length - 1;
  if (dataRows > MAX_IMPORT_ROWS) {
    res.status(400).json({
      error: `Import exceeds the maximum of ${MAX_IMPORT_ROWS} rows per request (received ${dataRows})`,
    });
    return null;
  }
  return grid;
};

type CustomerResult = { id: number; created: boolean; matched: boolean };

// Resolve (or create) the customer described by a row. Matches by name (+phone
// when present) so existing records are reused, and caches within a run so a
// repeated owner is only looked up once. Returns null when no name is present.
const resolveCustomerFromRow = async (
  row: string[],
  hm: Record<string, number>,
  seen: Map<string, number>,
): Promise<CustomerResult | null> => {
  const explicitName = cell(row, hm.name);
  const first = cell(row, hm.firstName);
  const last = cell(row, hm.lastName);
  const name = explicitName ?? [first, last].filter(Boolean).join(" ").trim();
  if (!name) return null;

  const phone = cell(row, hm.phone);
  const email = cell(row, hm.email);
  const address = cell(row, hm.address);

  const dedupeKey = `${name.toLowerCase()}|${phone ?? ""}`;
  const cached = seen.get(dedupeKey);
  if (cached !== undefined) return { id: cached, created: false, matched: true };

  const existing = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(
      phone
        ? and(ilike(customersTable.name, name), eq(customersTable.phone, phone))
        : ilike(customersTable.name, name),
    )
    .limit(1);

  if (existing.length) {
    seen.set(dedupeKey, existing[0].id);
    return { id: existing[0].id, created: false, matched: true };
  }

  const [created] = await db
    .insert(customersTable)
    .values({ name, phone, email, address })
    .returning({ id: customersTable.id });
  seen.set(dedupeKey, created.id);
  return { id: created.id, created: true, matched: false };
};

type VehicleResult = { id: number; created: boolean; matched: boolean };

// Resolve (or create) a vehicle from a row's vehicle columns, matching by VIN
// first and then by customer + year/make/model. Returns null when the row
// carries no vehicle-identifying data at all.
const resolveVehicleFromRow = async (
  row: string[],
  hm: Record<string, number>,
  customerId: number,
  seen: Map<string, number>,
): Promise<VehicleResult | null> => {
  const yearRaw = cell(row, hm.year);
  const year = yearRaw ? Number.parseInt(yearRaw, 10) : null;
  const make = cell(row, hm.make);
  const model = cell(row, hm.model);
  const vin = cell(row, hm.vin);
  const licensePlate = cell(row, hm.licensePlate);
  const color = cell(row, hm.color);
  const mileageRaw = cell(row, hm.mileage);
  const mileage = mileageRaw ? Number.parseInt(mileageRaw.replace(/[^0-9]/g, ""), 10) : null;

  const hasVehicle = Boolean(year || make || model || vin || licensePlate);
  if (!hasVehicle) return null;

  const key = vin
    ? `vin:${vin.toLowerCase()}`
    : `c${customerId}|${year ?? ""}|${(make ?? "").toLowerCase()}|${(model ?? "").toLowerCase()}`;
  const cached = seen.get(key);
  if (cached !== undefined) return { id: cached, created: false, matched: true };

  let match: { id: number } | undefined;
  if (vin) {
    [match] = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(ilike(vehiclesTable.vin, vin))
      .limit(1);
  } else {
    const conds = [eq(vehiclesTable.customerId, customerId)];
    if (year && Number.isFinite(year)) conds.push(eq(vehiclesTable.year, year));
    if (make) conds.push(ilike(vehiclesTable.make, make));
    if (model) conds.push(ilike(vehiclesTable.model, model));
    [match] = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(and(...conds))
      .limit(1);
  }

  if (match) {
    seen.set(key, match.id);
    return { id: match.id, created: false, matched: true };
  }

  const [created] = await db
    .insert(vehiclesTable)
    .values({
      customerId,
      year: Number.isFinite(year) ? year : null,
      make,
      model,
      vin,
      licensePlate,
      color,
      mileage: Number.isFinite(mileage) ? mileage : null,
    })
    .returning({ id: vehiclesTable.id });
  seen.set(key, created.id);
  return { id: created.id, created: true, matched: false };
};

// Both work orders and invoices require a NOT NULL vehicleId. When a row has no
// vehicle data, fall back to (and cache) an existing vehicle for the customer,
// or mint a minimal placeholder so historical records can still be attached.
const ensureVehicleForRecord = async (
  row: string[],
  hm: Record<string, number>,
  customerId: number,
  seen: Map<string, number>,
  placeholderCache: Map<number, number>,
): Promise<VehicleResult> => {
  const fromRow = await resolveVehicleFromRow(row, hm, customerId, seen);
  if (fromRow) return fromRow;

  const cached = placeholderCache.get(customerId);
  if (cached !== undefined) return { id: cached, created: false, matched: true };

  const [existing] = await db
    .select({ id: vehiclesTable.id })
    .from(vehiclesTable)
    .where(eq(vehiclesTable.customerId, customerId))
    .orderBy(asc(vehiclesTable.id))
    .limit(1);
  if (existing) {
    placeholderCache.set(customerId, existing.id);
    return { id: existing.id, created: false, matched: true };
  }

  const [created] = await db
    .insert(vehiclesTable)
    .values({ customerId })
    .returning({ id: vehiclesTable.id });
  placeholderCache.set(customerId, created.id);
  return { id: created.id, created: true, matched: false };
};

router.post("/import/customers-vehicles", async (req, res): Promise<void> => {
  const parsed = ImportCustomersVehiclesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const grid = parseGridOrError(parsed.data.csv, res);
  if (!grid) return;

  const headerMap = buildHeaderMap(grid[0], FIELD_ALIASES);
  const hasName = "name" in headerMap || "firstName" in headerMap || "lastName" in headerMap;
  if (!hasName) {
    res.status(400).json({
      error: "Could not find a customer name column (expected e.g. 'Name', 'Customer', or 'First Name'/'Last Name')",
    });
    return;
  }

  const errors: { row: number; message: string }[] = [];
  let customersCreated = 0;
  let customersMatched = 0;
  let vehiclesCreated = 0;
  let rowsProcessed = 0;

  const seenCustomers = new Map<string, number>();
  const seenVehicles = new Map<string, number>();

  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    rowsProcessed++;
    try {
      const customer = await resolveCustomerFromRow(row, headerMap, seenCustomers);
      if (!customer) {
        errors.push({ row: i + 1, message: "Missing customer name" });
        continue;
      }
      if (customer.created) customersCreated++;
      else if (customer.matched) customersMatched++;

      const vehicle = await resolveVehicleFromRow(row, headerMap, customer.id, seenVehicles);
      if (vehicle?.created) vehiclesCreated++;
    } catch (err) {
      req.log.error({ err, row: i + 1 }, "Import row failed");
      errors.push({ row: i + 1, message: describeRowError(err) });
    }
  }

  res.json(
    ImportCustomersVehiclesResponse.parse({
      rowsProcessed,
      customersCreated,
      customersMatched,
      vehiclesCreated,
      rowsFailed: errors.length,
      errors,
    }),
  );
});

router.post("/import/work-orders", async (req, res): Promise<void> => {
  const parsed = ImportWorkOrdersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Importing work orders also resolves/creates customers and vehicles, so the
  // caller must additionally hold the customers permission (the work-orders
  // permission gate alone is not enough to write into the customer module).
  if (!hasPermission(req, "customers")) {
    res.status(403).json({ error: "You do not have permission to create customer and vehicle records" });
    return;
  }

  const grid = parseGridOrError(parsed.data.csv, res);
  if (!grid) return;

  const headerMap = buildHeaderMap(grid[0], WORK_ORDER_ALIASES);
  const hasName = "name" in headerMap || "firstName" in headerMap || "lastName" in headerMap;
  if (!hasName) {
    res.status(400).json({
      error: "Could not find a customer name column (expected e.g. 'Name', 'Customer', or 'First Name'/'Last Name')",
    });
    return;
  }

  const errors: { row: number; message: string }[] = [];
  let customersCreated = 0;
  let customersMatched = 0;
  let vehiclesCreated = 0;
  let vehiclesMatched = 0;
  let workOrdersCreated = 0;
  let workOrdersSkipped = 0;
  let rowsProcessed = 0;

  const seenCustomers = new Map<string, number>();
  const seenVehicles = new Map<string, number>();
  const placeholderVehicles = new Map<number, number>();

  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    rowsProcessed++;
    try {
      const customer = await resolveCustomerFromRow(row, headerMap, seenCustomers);
      if (!customer) {
        errors.push({ row: i + 1, message: "Missing customer name" });
        continue;
      }
      if (customer.created) customersCreated++;
      else if (customer.matched) customersMatched++;

      const vehicle = await ensureVehicleForRecord(
        row,
        headerMap,
        customer.id,
        seenVehicles,
        placeholderVehicles,
      );
      if (vehicle.created) vehiclesCreated++;
      else if (vehicle.matched) vehiclesMatched++;

      const title = cell(row, headerMap.title) ?? "Imported work order";
      const openedAtDate = parseDate(cell(row, headerMap.openedAt));

      // Idempotency guard: skip a row whose work order already exists so an
      // accidental re-run of the same full CSV does not duplicate records. The
      // signature is customer + vehicle + title, plus the opened date when the
      // CSV supplies one (when it does not, opened_at defaults to the import
      // time, which would differ between runs and is therefore left out).
      const woDuplicate = await db
        .select({ id: workOrdersTable.id })
        .from(workOrdersTable)
        .where(
          and(
            eq(workOrdersTable.customerId, customer.id),
            eq(workOrdersTable.vehicleId, vehicle.id),
            eq(workOrdersTable.title, title),
            ...(openedAtDate
              ? [sql`date(${workOrdersTable.openedAt}) = ${openedAtDate}`]
              : []),
          ),
        )
        .limit(1);
      if (woDuplicate.length) {
        workOrdersSkipped++;
        continue;
      }

      const description = cell(row, headerMap.description);
      const complaint = cell(row, headerMap.complaint);
      const notes = cell(row, headerMap.notes);
      const status = (cell(row, headerMap.status) ?? "completed").toLowerCase();
      const openedAt = parseDate(cell(row, headerMap.openedAt));
      const completedAt = parseDate(cell(row, headerMap.completedAt));

      // Seed labor/parts line items from any present columns. Totals are derived
      // server-side from these items; no stock is deducted for imported history.
      const items: LineItemInput[] = [];
      const laborDesc = cell(row, headerMap.laborDescription);
      const laborAmount = parseMoney(cell(row, headerMap.laborAmount));
      const laborHours = parseMoney(cell(row, headerMap.laborHours));
      const laborRate = parseMoney(cell(row, headerMap.laborRate));
      if (laborDesc || laborAmount != null || (laborHours != null && laborHours > 0)) {
        let quantity = 1;
        let unitPrice = 0;
        if (laborHours != null && laborHours > 0) {
          quantity = laborHours;
          unitPrice =
            laborRate != null
              ? laborRate
              : laborAmount != null
                ? round2(laborAmount / laborHours)
                : 0;
        } else {
          unitPrice = laborAmount ?? 0;
        }
        items.push({ type: "labor", description: laborDesc ?? "Labor", quantity, unitPrice });
      }

      const partsDesc = cell(row, headerMap.partsDescription);
      const partsAmount = parseMoney(cell(row, headerMap.partsAmount));
      const partsQty = parseMoney(cell(row, headerMap.partsQuantity));
      if (partsDesc || partsAmount != null) {
        const quantity = partsQty != null && partsQty > 0 ? partsQty : 1;
        const unitPrice =
          partsAmount != null ? (quantity > 1 ? round2(partsAmount / quantity) : partsAmount) : 0;
        items.push({ type: "part", description: partsDesc ?? "Parts", quantity, unitPrice });
      }

      await db.transaction(async (tx) => {
        const [wo] = await tx
          .insert(workOrdersTable)
          .values({
            customerId: customer.id,
            vehicleId: vehicle.id,
            title,
            description,
            complaint,
            notes,
            status,
            ...(openedAt ? { openedAt } : {}),
            completedAt,
          })
          .returning({ id: workOrdersTable.id });

        const normalized = normalizeLineItems(items);
        if (normalized.length) {
          await tx
            .insert(workOrderLineItemsTable)
            .values(normalized.map((li) => ({ ...li, workOrderId: wo.id })));
        }
      });
      workOrdersCreated++;
    } catch (err) {
      req.log.error({ err, row: i + 1 }, "Work order import row failed");
      errors.push({ row: i + 1, message: describeRowError(err) });
    }
  }

  res.json(
    ImportWorkOrdersResponse.parse({
      rowsProcessed,
      customersCreated,
      customersMatched,
      vehiclesCreated,
      vehiclesMatched,
      workOrdersCreated,
      workOrdersSkipped,
      rowsFailed: errors.length,
      errors,
    }),
  );
});

router.post("/import/invoices", async (req, res): Promise<void> => {
  const parsed = ImportInvoicesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Invoice import also resolves/creates customers and vehicles, and sets
  // historical payment amounts — both require accounting permission.
  if (!hasPermission(req, "customers")) {
    res.status(403).json({ error: "You do not have permission to create customer and vehicle records" });
    return;
  }
  if (!hasPermission(req, "accounting")) {
    res.status(403).json({ error: "You do not have permission to import invoice payment data" });
    return;
  }

  const grid = parseGridOrError(parsed.data.csv, res);
  if (!grid) return;

  const headerMap = buildHeaderMap(grid[0], INVOICE_ALIASES);
  const hasName = "name" in headerMap || "firstName" in headerMap || "lastName" in headerMap;
  if (!hasName) {
    res.status(400).json({
      error: "Could not find a customer name column (expected e.g. 'Name', 'Customer', or 'First Name'/'Last Name')",
    });
    return;
  }

  const errors: { row: number; message: string }[] = [];
  let customersCreated = 0;
  let customersMatched = 0;
  let invoicesCreated = 0;
  let invoicesSkipped = 0;
  let rowsProcessed = 0;

  const seenCustomers = new Map<string, number>();
  const seenVehicles = new Map<string, number>();
  const placeholderVehicles = new Map<number, number>();

  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    rowsProcessed++;
    try {
      // Validate the invoice is importable BEFORE creating any customer or
      // vehicle records. Resolving the customer first can INSERT a new customer
      // row; if the amount validation below then fails the row, that customer
      // would be orphaned and the summary (which only counts customers on a
      // written invoice) would silently understate the real DB writes. Building
      // line items first keeps a failed row from mutating any data.
      //
      // Line items: prefer explicit labor/parts amounts, else fall back to a
      // single line from the invoice total. taxRate stays 0 so the invoice total
      // equals the imported amount.
      const items: LineItemInput[] = [];
      const description = cell(row, headerMap.description);
      const laborAmount = parseMoney(cell(row, headerMap.laborAmount));
      const partsAmount = parseMoney(cell(row, headerMap.partsAmount));
      const totalRaw = cell(row, headerMap.amount);
      const total = parseMoney(totalRaw);
      if (laborAmount != null) {
        items.push({ type: "labor", description: description ?? "Labor", quantity: 1, unitPrice: laborAmount });
      }
      if (partsAmount != null) {
        items.push({ type: "part", description: "Parts", quantity: 1, unitPrice: partsAmount });
      }
      if (items.length === 0) {
        if (total == null) {
          errors.push({
            row: i + 1,
            message: totalRaw
              ? `Unparseable invoice amount "${totalRaw}"`
              : "Missing invoice amount/total",
          });
          continue;
        }
        items.push({
          type: "labor",
          description: description ?? "Imported invoice charges",
          quantity: 1,
          unitPrice: total,
        });
      }

      const lineTotal = items.reduce((sum, li) => sum + (li.unitPrice ?? 0) * (li.quantity ?? 1), 0);
      const paidCol = parseMoney(cell(row, headerMap.amountPaid));
      const amountPaid = paidCol != null ? paidCol : total != null ? total : round2(lineTotal);
      const createdDate = parseDate(cell(row, headerMap.invoiceDate));

      // Row is importable; now resolve (and possibly create) the customer.
      const customer = await resolveCustomerFromRow(row, headerMap, seenCustomers);
      if (!customer) {
        errors.push({ row: i + 1, message: "Missing customer name" });
        continue;
      }

      const vehicle = await ensureVehicleForRecord(
        row,
        headerMap,
        customer.id,
        seenVehicles,
        placeholderVehicles,
      );

      // Idempotency guard: skip a row whose invoice already exists so an
      // accidental re-run of the same full CSV does not duplicate records. The
      // signature is customer + vehicle + paid amount, plus the invoice date
      // when the CSV supplies one (when it does not, created_at defaults to the
      // import time and is left out so re-runs still match).
      const invDuplicate = await db
        .select({ id: invoicesTable.id })
        .from(invoicesTable)
        .where(
          and(
            eq(invoicesTable.customerId, customer.id),
            eq(invoicesTable.vehicleId, vehicle.id),
            eq(invoicesTable.amountPaid, round2(amountPaid)),
            ...(createdDate
              ? [sql`date(${invoicesTable.createdAt}) = ${createdDate}`]
              : []),
          ),
        )
        .limit(1);
      if (invDuplicate.length) {
        invoicesSkipped++;
        continue;
      }

      // Count customer resolution only once we know the invoice will be written.
      if (customer.created) customersCreated++;
      else if (customer.matched) customersMatched++;

      await db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(invoicesTable)
          .values({
            customerId: customer.id,
            vehicleId: vehicle.id,
            status: "closed",
            taxRate: 0,
            amountPaid: round2(amountPaid),
            ...(createdDate ? { createdAt: createdDate, paidAt: createdDate } : {}),
          })
          .returning({ id: invoicesTable.id });

        const normalized = normalizeLineItems(items);
        if (normalized.length) {
          await tx
            .insert(invoiceLineItemsTable)
            .values(normalized.map((li) => ({ ...li, invoiceId: inv.id })));
        }
      });
      invoicesCreated++;
    } catch (err) {
      req.log.error({ err, row: i + 1 }, "Invoice import row failed");
      errors.push({ row: i + 1, message: describeRowError(err) });
    }
  }

  res.json(
    ImportInvoicesResponse.parse({
      rowsProcessed,
      customersCreated,
      customersMatched,
      invoicesCreated,
      invoicesSkipped,
      rowsFailed: errors.length,
      errors,
    }),
  );
});

router.post("/import/expenses", async (req, res): Promise<void> => {
  const parsed = ImportExpensesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const grid = parseGridOrError(parsed.data.csv, res);
  if (!grid) return;

  const headerMap = buildHeaderMap(grid[0], EXPENSE_ALIASES);
  if (!("amount" in headerMap)) {
    res.status(400).json({
      error: "Could not find an amount column (expected e.g. 'Amount', 'Total', or 'Debit')",
    });
    return;
  }
  if (!("date" in headerMap)) {
    res.status(400).json({
      error: "Could not find a date column (expected e.g. 'Date' or 'Transaction Date')",
    });
    return;
  }

  const errors: { row: number; message: string }[] = [];
  let expensesCreated = 0;
  let expensesSkipped = 0;
  let categoriesCreated = 0;
  let rowsProcessed = 0;

  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    rowsProcessed++;
    try {
      const dateRaw = cell(row, headerMap.date);
      const date = parseDate(dateRaw);
      if (!date) {
        errors.push({
          row: i + 1,
          message: dateRaw ? `Unparseable date "${dateRaw}"` : "Missing date",
        });
        continue;
      }
      const amountRaw = cell(row, headerMap.amount);
      const amount = parseMoney(amountRaw);
      if (amount == null) {
        errors.push({
          row: i + 1,
          message: amountRaw ? `Unparseable amount "${amountRaw}"` : "Missing amount",
        });
        continue;
      }

      const vendor = cell(row, headerMap.vendor);
      const memo = cell(row, headerMap.memo);
      const description = memo ?? vendor ?? "Imported expense";
      const paymentMethod = cell(row, headerMap.paymentMethod);
      const tax = parseMoney(cell(row, headerMap.tax)) ?? 0;

      // Idempotency guard: skip a row whose expense already exists so an
      // accidental re-run of the same full CSV does not duplicate records. The
      // signature is date + amount + description, plus the vendor when present.
      const expDuplicate = await db
        .select({ id: expensesTable.id })
        .from(expensesTable)
        .where(
          and(
            eq(expensesTable.date, date),
            eq(expensesTable.amount, round2(amount)),
            eq(expensesTable.description, description),
            vendor ? eq(expensesTable.vendor, vendor) : isNull(expensesTable.vendor),
          ),
        )
        .limit(1);
      if (expDuplicate.length) {
        expensesSkipped++;
        continue;
      }

      const categoryResult = await resolveExpenseCategoryId(cell(row, headerMap.category));

      await db.insert(expensesTable).values({
        date,
        categoryId: categoryResult.id,
        vendor,
        description,
        amount: round2(amount),
        taxAmount: round2(tax),
        paymentMethod,
      });
      if (categoryResult.created) categoriesCreated++;
      expensesCreated++;
    } catch (err) {
      req.log.error({ err, row: i + 1 }, "Expense import row failed");
      errors.push({ row: i + 1, message: describeRowError(err) });
    }
  }

  res.json(
    ImportExpensesResponse.parse({
      rowsProcessed,
      expensesCreated,
      expensesSkipped,
      categoriesCreated,
      rowsFailed: errors.length,
      errors,
    }),
  );
});

export default router;
