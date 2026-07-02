import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QBO <-> RSS customer matching is email-first, then a fall back to exact name,
 * on BOTH directions of the sync. The point is anti-duplication: a customer that
 * already exists under either key must be linked, never re-created. These tests
 * mock the QBO transport (qboQuery/qboApiRequest) and drive the real DB so the
 * fallback decision and the persisted link are exercised end to end.
 */

// Canned QBO query results, keyed by the kind of query the code issues. The mock
// routes on the SQL-ish text so a single fn serves the pull list, the email
// lookup, and the name lookup.
let pullList: Array<{
  Id: string;
  DisplayName?: string;
  PrimaryEmailAddr?: { Address?: string };
}> = [];
let emailMatches: Array<{ Id: string }> = [];
let nameMatches: Array<{ Id: string }> = [];
const created: Array<{ id: string; body: unknown }> = [];

vi.mock("../src/lib/qboClient", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/qboClient")>();
  return {
    ...actual,
    qboQuery: vi.fn(
      async (_cfg: unknown, _row: unknown, _entity: string, query: string) => {
        if (query.includes("PrimaryEmailAddr")) return emailMatches;
        if (query.includes("Active = true")) return pullList;
        if (query.includes("DisplayName")) return nameMatches;
        return [];
      },
    ),
    qboApiRequest: vi.fn(
      async (
        _cfg: unknown,
        _row: unknown,
        _method: string,
        _path: string,
        body: unknown,
      ) => {
        const id = `NEW${created.length + 1}`;
        created.push({ id, body });
        return { Customer: { Id: id } };
      },
    ),
  };
});

import { eq } from "drizzle-orm";
import { db, customersTable } from "@workspace/db";
import { ensureQboCustomer, pullCustomers } from "../src/lib/qboSync";

// SyncContext fields are passed straight through to the mocked transport, so a
// shallow cast is enough for these matching-focused tests.
const ctx = { cfg: {}, row: {}, mapping: {} } as never;

beforeEach(() => {
  pullList = [];
  emailMatches = [];
  nameMatches = [];
  created.length = 0;
  vi.clearAllMocks();
});

describe("pullCustomers matching (QBO -> RSS)", () => {
  it("links by name when the email differs (no duplicate import)", async () => {
    const [rss] = await db
      .insert(customersTable)
      .values({ name: "John Smith", email: "old@example.com" })
      .returning({ id: customersTable.id });

    pullList = [
      {
        Id: "Q1",
        DisplayName: "John Smith",
        PrimaryEmailAddr: { Address: "new@example.com" },
      },
    ];

    const imported = await pullCustomers(ctx);
    expect(imported).toBe(0);

    const [row] = await db
      .select({ qboCustomerId: customersTable.qboCustomerId })
      .from(customersTable)
      .where(eq(customersTable.id, rss.id));
    expect(row.qboCustomerId).toBe("Q1");
  });

  it("links by email even when the name has drifted", async () => {
    const [rss] = await db
      .insert(customersTable)
      .values({ name: "Jonathan Smith", email: "jon@example.com" })
      .returning({ id: customersTable.id });

    pullList = [
      {
        Id: "Q2",
        DisplayName: "John S.",
        PrimaryEmailAddr: { Address: "jon@example.com" },
      },
    ];

    const imported = await pullCustomers(ctx);
    expect(imported).toBe(0);

    const [row] = await db
      .select({ qboCustomerId: customersTable.qboCustomerId })
      .from(customersTable)
      .where(eq(customersTable.id, rss.id));
    expect(row.qboCustomerId).toBe("Q2");
  });

  it("imports a genuinely new customer when neither key matches", async () => {
    pullList = [
      {
        Id: "Q3",
        DisplayName: "Brand New",
        PrimaryEmailAddr: { Address: "brand@example.com" },
      },
    ];

    const imported = await pullCustomers(ctx);
    expect(imported).toBe(1);

    const [row] = await db
      .select({ qboCustomerId: customersTable.qboCustomerId })
      .from(customersTable)
      .where(eq(customersTable.email, "brand@example.com"));
    expect(row.qboCustomerId).toBe("Q3");
  });
});

describe("ensureQboCustomer matching (RSS -> QBO)", () => {
  it("returns the persisted link without any QBO lookup", async () => {
    const id = await ensureQboCustomer(ctx, {
      id: 1,
      name: "Linked",
      email: "linked@example.com",
      qboCustomerId: "ALREADY",
    });
    expect(id).toBe("ALREADY");
    expect(created.length).toBe(0);
  });

  it("resolves by email first, then persists the link (no create)", async () => {
    const [rss] = await db
      .insert(customersTable)
      .values({ name: "Drifted Name", email: "match@example.com" })
      .returning({ id: customersTable.id });

    emailMatches = [{ Id: "QE" }];
    nameMatches = [{ Id: "QN" }]; // present but must NOT win when email matches

    const id = await ensureQboCustomer(ctx, {
      id: rss.id,
      name: "Drifted Name",
      email: "match@example.com",
      qboCustomerId: null,
    });
    expect(id).toBe("QE");
    expect(created.length).toBe(0);

    const [row] = await db
      .select({ qboCustomerId: customersTable.qboCustomerId })
      .from(customersTable)
      .where(eq(customersTable.id, rss.id));
    expect(row.qboCustomerId).toBe("QE");
  });

  it("falls back to name when email has no QBO match", async () => {
    const [rss] = await db
      .insert(customersTable)
      .values({ name: "Name Only", email: "nomatch@example.com" })
      .returning({ id: customersTable.id });

    emailMatches = [];
    nameMatches = [{ Id: "QN2" }];

    const id = await ensureQboCustomer(ctx, {
      id: rss.id,
      name: "Name Only",
      email: "nomatch@example.com",
      qboCustomerId: null,
    });
    expect(id).toBe("QN2");
    expect(created.length).toBe(0);
  });

  it("creates a new QBO customer only when neither key matches", async () => {
    const [rss] = await db
      .insert(customersTable)
      .values({ name: "Totally New", email: "totallynew@example.com" })
      .returning({ id: customersTable.id });

    emailMatches = [];
    nameMatches = [];

    const id = await ensureQboCustomer(ctx, {
      id: rss.id,
      name: "Totally New",
      email: "totallynew@example.com",
      qboCustomerId: null,
    });
    expect(id).toBe("NEW1");
    expect(created.length).toBe(1);

    const [row] = await db
      .select({ qboCustomerId: customersTable.qboCustomerId })
      .from(customersTable)
      .where(eq(customersTable.id, rss.id));
    expect(row.qboCustomerId).toBe("NEW1");
  });
});
