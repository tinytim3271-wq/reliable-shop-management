import { beforeEach } from "vitest";
import request from "supertest";
import {
  db,
  usersTable,
  customersTable,
  vehiclesTable,
  mechanicsTable,
  timeEntriesTable,
  partsTable,
  expensesTable,
  expenseCategoriesTable,
  invoicesTable,
  invoiceLineItemsTable,
  invoicePaymentsTable,
  laborSessionsTable,
} from "@workspace/db";
import app from "../src/app";
import {
  hashPassword,
  PERMISSION_KEYS,
  type PermissionKey,
} from "../src/lib/auth";
import { resetAgentLimiter } from "../src/routes/aiAgent";

// Each test run gets its own disposable database (see globalSetup.ts), so rows
// no longer need cleanup. The whole run still shares ONE database across files,
// though, so names that must stay distinct across files — usernames (UNIQUE
// constraint) and catalog part names (matched by name) — get a per-file token
// plus a counter. This is for uniqueness only, not cleanup.
const RUN_TOKEN = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let nameSeq = 0;
export function uniqueName(base: string): string {
  nameSeq += 1;
  return `${base}-${RUN_TOKEN}-${nameSeq}`;
}

export const agent = (): request.Agent => request(app);

// Logs in and returns the raw Cookie header value. The session cookie is
// Secure+SameSite=None, which a cookie jar would refuse to send back over plain
// HTTP, so we forward the Set-Cookie value manually on every request instead.
export async function loginCookie(username: string, password: string): Promise<string> {
  // The session cookie is Secure, so express-session only emits it when the
  // request looks like HTTPS. `trust proxy` is on, so the forwarded-proto header
  // is enough to satisfy that over supertest's plain HTTP transport.
  const res = await agent()
    .post("/api/auth/login")
    .set("X-Forwarded-Proto", "https")
    .send({ username, password });
  if (res.status !== 200) {
    throw new Error(`login failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const sid = cookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("rss.sid="));
  if (!sid) throw new Error("no session cookie returned from login");
  return sid;
}

export interface SeededAdmin {
  id: number;
  username: string;
  password: string;
  cookie: string;
}

// Creates a disposable admin user and returns a ready-to-use session cookie.
export async function seedAdmin(): Promise<SeededAdmin> {
  const username = uniqueName("admin");
  const password = "test-password-123";
  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(usersTable)
    .values({
      username,
      passwordHash,
      displayName: "API Test Admin",
      role: "admin",
      permissions: [...PERMISSION_KEYS],
      active: true,
    })
    .returning();
  const cookie = await loginCookie(username, password);
  return { id: user.id, username, password, cookie };
}

// Creates a disposable non-admin staff user with the given module permissions
// and returns a ready-to-use session cookie. Used to exercise permission
// boundaries (e.g. a workOrders-only caller that lacks `inventory`).
export async function seedStaffUser(
  permissions: PermissionKey[],
  suffix = "staff",
): Promise<SeededAdmin> {
  const username = uniqueName(suffix);
  const password = "test-password-123";
  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(usersTable)
    .values({
      username,
      passwordHash,
      displayName: "API Test Staff",
      role: "technician",
      permissions,
      active: true,
    })
    .returning();
  const cookie = await loginCookie(username, password);
  return { id: user.id, username, password, cookie };
}

export interface SeededPart {
  id: number;
  name: string;
}

// Inserts a parts-catalog row with explicit stock levels so inventory-aware
// endpoints can be tested deterministically. Catalog lookups match by name, so
// callers should pass a uniqueName(...) to avoid colliding with parts seeded by
// other test files in the shared run database.
export async function seedPart(opts: {
  name: string;
  quantityOnHand: number;
  reorderLevel: number;
  unitPrice?: number;
}): Promise<SeededPart> {
  const [part] = await db
    .insert(partsTable)
    .values({
      name: opts.name,
      quantityOnHand: opts.quantityOnHand,
      reorderLevel: opts.reorderLevel,
      unitPrice: opts.unitPrice ?? 0,
    })
    .returning();
  return { id: part.id, name: part.name };
}

export interface SeededShop {
  customerId: number;
  vehicleId: number;
}

// Creates a customer + vehicle so estimate/invoice create paths have valid FKs.
export async function seedCustomerVehicle(): Promise<SeededShop> {
  const [customer] = await db
    .insert(customersTable)
    .values({ name: "Test Customer" })
    .returning();
  const [vehicle] = await db
    .insert(vehiclesTable)
    .values({
      customerId: customer.id,
      year: 2018,
      make: "Toyota",
      model: "Corolla",
    })
    .returning();
  return { customerId: customer.id, vehicleId: vehicle.id };
}

export interface SeededMechanic {
  mechanicId: number;
}

// Creates a mechanic with a time entry on a specific date for payday tests.
export async function seedMechanicWithEntry(date: string): Promise<SeededMechanic> {
  const [mechanic] = await db
    .insert(mechanicsTable)
    .values({ name: "Test Mechanic", hourlyRate: 40, status: "active" })
    .returning();
  await db.insert(timeEntriesTable).values({
    mechanicId: mechanic.id,
    date,
    hours: 10,
    rate: 40,
    totalPay: 400,
  });
  return { mechanicId: mechanic.id };
}

// Creates a tax-deductible (or not) expense category for expense-report tests.
export async function seedExpenseCategory(taxDeductible: boolean): Promise<{ categoryId: number }> {
  const [cat] = await db
    .insert(expenseCategoriesTable)
    .values({ name: "Test Category", taxDeductible })
    .returning();
  return { categoryId: cat.id };
}

// Creates an expense on a specific date so profit/expense reports can be tested
// against their date filters.
export async function seedExpense(args: {
  date: string;
  amount: number;
  taxAmount?: number;
  categoryId?: number | null;
}): Promise<void> {
  await db.insert(expensesTable).values({
    date: args.date,
    description: "Test Expense",
    amount: args.amount,
    taxAmount: args.taxAmount ?? 0,
    categoryId: args.categoryId ?? null,
  });
}

// Inserts an issued (sale) invoice with a controllable createdAt so revenue/tax
// reports can be exercised over arbitrary historical windows. A single line
// item carries the whole subtotal.
export async function seedIssuedInvoice(args: {
  customerId: number;
  vehicleId: number;
  createdAt: string;
  subtotal: number;
  taxRate: number;
  amountPaid?: number;
}): Promise<{ invoiceId: number }> {
  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      customerId: args.customerId,
      vehicleId: args.vehicleId,
      status: "sent",
      taxRate: args.taxRate,
      amountPaid: args.amountPaid ?? 0,
      createdAt: args.createdAt,
    })
    .returning();
  await db.insert(invoiceLineItemsTable).values({
    invoiceId: invoice.id,
    type: "labor",
    description: "Test Service",
    quantity: 1,
    unitPrice: args.subtotal,
  });
  return { invoiceId: invoice.id };
}

// Adds a completed (or still-running) labor session to a work order with an
// explicit duration in minutes, so work-order labor totals can be verified.
export async function seedLaborSession(args: {
  workOrderId: number;
  minutes: number | null;
}): Promise<void> {
  const startedAt = new Date("2099-07-01T08:00:00.000Z");
  const endedAt =
    args.minutes === null
      ? null
      : new Date(startedAt.getTime() + args.minutes * 60_000).toISOString();
  await db.insert(laborSessionsTable).values({
    workOrderId: args.workOrderId,
    startedAt: startedAt.toISOString(),
    endedAt,
  });
}

// Inserts a single invoice_payments row with a controllable method and
// createdAt so the payments-by-method report can be exercised across method
// buckets and arbitrary date windows.
export async function seedInvoicePayment(args: {
  invoiceId: number;
  amount: number;
  method: string;
  createdAt: string;
}): Promise<void> {
  await db.insert(invoicePaymentsTable).values({
    invoiceId: args.invoiceId,
    amount: args.amount,
    method: args.method,
    createdAt: args.createdAt,
  });
}

// --- Agent rate-limiter test reset -----------------------------------------
//
// `/api/ai/agent/message` and `/api/ai/agent/confirm` share ONE in-memory
// express-rate-limit instance (30 requests / 5-min window, keyed per IP). Every
// supertest request in a file comes from the same IP, so the whole file shares
// a single limiter budget, and blocks that drive enough message/confirm turns
// can push later tests over the cap into 429s.
//
// Rather than fake the system clock to roll each test into a fresh window (the
// old `freshLimiterWindowPerTest` approach, which had to keep a shared
// monotonic clock and could silently mis-tune offsets), we clear the limiter's
// store directly. `resetAgentLimiter()` (exported from the route module) calls
// the MemoryStore's `resetAll()`, wiping every per-IP counter, so each test
// starts from a full budget. No `Date.now` mocking is involved, so asserted DB
// timestamps and `new Date(...)` reads are untouched.

// Call inside a describe block. Clears the shared agent rate-limiter before
// every test in the block so it always starts with a fresh budget and can never
// inherit another block's accumulated hits.
export function resetLimiterPerTest(): void {
  beforeEach(async () => {
    await resetAgentLimiter();
  });
}
