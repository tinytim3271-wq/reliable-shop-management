import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  customersTable,
  vehiclesTable,
  workOrdersTable,
  workOrderLineItemsTable,
  invoicesTable,
  invoiceLineItemsTable,
  expensesTable,
  expenseCategoriesTable,
} from "@workspace/db";
import { agent, seedAdmin, seedStaffUser, uniqueName, type SeededAdmin } from "./helpers";

function post(path: string, cookie: string) {
  return agent().post(path).set("Cookie", cookie).set("X-Forwarded-Proto", "https");
}

let admin: SeededAdmin;

beforeEach(async () => {
  admin = await seedAdmin();
});

describe("POST /api/import/work-orders", () => {
  it("creates work orders with customers, vehicles, and seeded line items", async () => {
    const name = uniqueName("Jane WO");
    const csv = [
      "Customer,Phone,Year,Make,Model,VIN,Title,Status,Labor Description,Labor Hours,Labor Rate,Parts Description,Parts Total",
      `"${name}","555-0100","2018","Toyota","Camry","WOVIN0000000001","Front brakes","completed","Replace pads","2","100","Brake pads","150.00"`,
    ].join("\n");

    const res = await post("/api/import/work-orders", admin.cookie).send({ csv });
    expect(res.status).toBe(200);
    expect(res.body.workOrdersCreated).toBe(1);
    expect(res.body.customersCreated).toBe(1);
    expect(res.body.vehiclesCreated).toBe(1);
    expect(res.body.rowsFailed).toBe(0);

    const [customer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.name, name));
    expect(customer).toBeDefined();

    const wos = await db
      .select()
      .from(workOrdersTable)
      .where(eq(workOrdersTable.customerId, customer.id));
    expect(wos).toHaveLength(1);
    expect(wos[0].title).toBe("Front brakes");

    const items = await db
      .select()
      .from(workOrderLineItemsTable)
      .where(eq(workOrderLineItemsTable.workOrderId, wos[0].id));
    expect(items.map((i) => i.type).sort()).toEqual(["labor", "part"]);
  });

  it("reuses an existing customer instead of duplicating", async () => {
    const name = uniqueName("Repeat WO");
    const csv = [
      "Customer,Phone,Title",
      `"${name}","555-0111","Job A"`,
      `"${name}","555-0111","Job B"`,
    ].join("\n");

    const res = await post("/api/import/work-orders", admin.cookie).send({ csv });
    expect(res.status).toBe(200);
    expect(res.body.workOrdersCreated).toBe(2);
    expect(res.body.customersCreated).toBe(1);
    expect(res.body.customersMatched).toBe(1);
  });

  it("rejects a caller with workOrders but not customers permission", async () => {
    const staff = await seedStaffUser(["workOrders"], "wo-only");
    const res = await post("/api/import/work-orders", staff.cookie).send({
      csv: "Customer,Title\nFoo,Bar",
    });
    expect(res.status).toBe(403);
  });

  it("skips duplicate work orders when the same full CSV is re-run", async () => {
    const name = uniqueName("Rerun WO");
    const csv = [
      "Customer,Phone,Year,Make,Model,VIN,Title,RO Date,Labor Description,Labor Total",
      `"${name}","555-0123","2019","Ford","F150","WORERUN00000001","Brake job","03/01/2024","Pads","200.00"`,
      `"${name}","555-0123","2019","Ford","F150","WORERUN00000001","Oil change","03/05/2024","Oil","60.00"`,
    ].join("\n");

    const first = await post("/api/import/work-orders", admin.cookie).send({ csv });
    expect(first.status).toBe(200);
    expect(first.body.workOrdersCreated).toBe(2);
    expect(first.body.workOrdersSkipped).toBe(0);

    const second = await post("/api/import/work-orders", admin.cookie).send({ csv });
    expect(second.status).toBe(200);
    expect(second.body.workOrdersCreated).toBe(0);
    expect(second.body.workOrdersSkipped).toBe(2);
    expect(second.body.customersCreated).toBe(0);
    expect(second.body.vehiclesCreated).toBe(0);

    const [customer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.name, name));
    const wos = await db
      .select()
      .from(workOrdersTable)
      .where(eq(workOrdersTable.customerId, customer.id));
    expect(wos).toHaveLength(2);
  });
});

describe("POST /api/import/invoices", () => {
  it("creates closed invoices with the recorded paid amount", async () => {
    const name = uniqueName("Inv Cust");
    const csv = [
      "Date,Customer,Total,Paid,Memo",
      `"01/15/2024","${name}","420.00","420.00","Brake job"`,
      `"02/03/2024","${name}","68.00","0.00","Oil change"`,
    ].join("\n");

    const res = await post("/api/import/invoices", admin.cookie).send({ csv });
    expect(res.status).toBe(200);
    expect(res.body.invoicesCreated).toBe(2);
    expect(res.body.customersCreated).toBe(1);
    expect(res.body.rowsFailed).toBe(0);

    const [customer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.name, name));
    const invoices = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.customerId, customer.id));
    expect(invoices).toHaveLength(2);
    expect(invoices.every((i) => i.status === "closed")).toBe(true);
    const paidTotals = invoices.map((i) => i.amountPaid).sort((a, b) => a - b);
    expect(paidTotals).toEqual([0, 420]);

    const firstItems = await db
      .select()
      .from(invoiceLineItemsTable)
      .where(eq(invoiceLineItemsTable.invoiceId, invoices[0].id));
    expect(firstItems.length).toBeGreaterThan(0);
  });

  it("reports a row with no amount as failed and creates no orphaned customer", async () => {
    const name = uniqueName("Inv NoAmt");
    const csv = ["Customer,Total", `"${name}",""`].join("\n");
    const res = await post("/api/import/invoices", admin.cookie).send({ csv });
    expect(res.status).toBe(200);
    expect(res.body.invoicesCreated).toBe(0);
    expect(res.body.rowsFailed).toBe(1);
    expect(res.body.customersCreated).toBe(0);

    // A row that fails amount validation must not leave behind a customer row:
    // the importer validates importability before creating any customer.
    const orphan = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.name, name));
    expect(orphan).toHaveLength(0);
  });

  it("skips duplicate invoices when the same full CSV is re-run", async () => {
    const name = uniqueName("Rerun Inv");
    const csv = [
      "Date,Customer,Total,Paid,Memo",
      `"01/15/2024","${name}","420.00","420.00","Brake job"`,
      `"02/03/2024","${name}","68.00","0.00","Oil change"`,
    ].join("\n");

    const first = await post("/api/import/invoices", admin.cookie).send({ csv });
    expect(first.status).toBe(200);
    expect(first.body.invoicesCreated).toBe(2);
    expect(first.body.invoicesSkipped).toBe(0);

    const second = await post("/api/import/invoices", admin.cookie).send({ csv });
    expect(second.status).toBe(200);
    expect(second.body.invoicesCreated).toBe(0);
    expect(second.body.invoicesSkipped).toBe(2);
    expect(second.body.customersCreated).toBe(0);

    const [customer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.name, name));
    const invoices = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.customerId, customer.id));
    expect(invoices).toHaveLength(2);
  });
});

describe("POST /api/import/expenses", () => {
  it("creates expenses and resolves categories by name", async () => {
    const catName = uniqueName("Parts & Supplies");
    const csv = [
      "Date,Name,Account,Amount,Memo,Payment Method",
      `"01/05/2024","NAPA","${catName}","312.45","Stock","Credit Card"`,
      `"01/09/2024","NAPA","${catName}","100.00","More stock","Credit Card"`,
    ].join("\n");

    const res = await post("/api/import/expenses", admin.cookie).send({ csv });
    expect(res.status).toBe(200);
    expect(res.body.expensesCreated).toBe(2);
    // Both rows share one category, created once.
    expect(res.body.categoriesCreated).toBe(1);
    expect(res.body.rowsFailed).toBe(0);

    const [cat] = await db
      .select()
      .from(expenseCategoriesTable)
      .where(eq(expenseCategoriesTable.name, catName));
    expect(cat).toBeDefined();

    const expenses = await db
      .select()
      .from(expensesTable)
      .where(eq(expensesTable.categoryId, cat.id));
    expect(expenses).toHaveLength(2);
  });

  it("reports rows with a missing date or amount as failed", async () => {
    const csv = [
      "Date,Amount",
      '"","50.00"',
      '"01/05/2024",""',
    ].join("\n");
    const res = await post("/api/import/expenses", admin.cookie).send({ csv });
    expect(res.status).toBe(200);
    expect(res.body.expensesCreated).toBe(0);
    expect(res.body.rowsFailed).toBe(2);
  });

  it("rejects a caller without the accounting permission", async () => {
    const staff = await seedStaffUser(["customers"], "no-acct");
    const res = await post("/api/import/expenses", staff.cookie).send({
      csv: "Date,Amount\n01/05/2024,50",
    });
    expect(res.status).toBe(403);
  });

  it("skips duplicate expenses when the same full CSV is re-run", async () => {
    const catName = uniqueName("Rerun Cat");
    const vendor = uniqueName("Vendor");
    const csv = [
      "Date,Name,Account,Amount,Memo,Payment Method",
      `"01/05/2024","${vendor}","${catName}","312.45","Stock","Credit Card"`,
      `"01/09/2024","${vendor}","${catName}","100.00","More stock","Credit Card"`,
    ].join("\n");

    const first = await post("/api/import/expenses", admin.cookie).send({ csv });
    expect(first.status).toBe(200);
    expect(first.body.expensesCreated).toBe(2);
    expect(first.body.expensesSkipped).toBe(0);

    const second = await post("/api/import/expenses", admin.cookie).send({ csv });
    expect(second.status).toBe(200);
    expect(second.body.expensesCreated).toBe(0);
    expect(second.body.expensesSkipped).toBe(2);
    expect(second.body.categoriesCreated).toBe(0);

    const [cat] = await db
      .select()
      .from(expenseCategoriesTable)
      .where(eq(expenseCategoriesTable.name, catName));
    const expenses = await db
      .select()
      .from(expensesTable)
      .where(eq(expensesTable.categoryId, cat.id));
    expect(expenses).toHaveLength(2);
  });
});
