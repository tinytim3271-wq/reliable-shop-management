import { beforeEach, describe, expect, it, vi } from "vitest";

// The `open_import_dialog` read tool returns a client `open_import` action that
// the frontend uses to navigate to the import hub (or a specific importer) and
// open the CSV importer. The tool is ungated at the loop level; instead it
// enforces a per-type permission check inside execute, because each importer
// needs a different module: customers -> customers; work-orders -> workOrders +
// customers; invoices -> invoices + customers; expenses -> accounting. Omitting
// the type opens the hub when the caller holds at least one importer module.
//
// Mock the OpenAI integration so agent turns never make a real network call and
// the tool/loop output is fully controlled. Mocking the module also sidesteps
// the import-time env checks in the real client.
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import { db, aiMessagesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  agent,
  seedStaffUser,
  resetLimiterPerTest,
  type SeededAdmin,
} from "./helpers";

const mockedCreate = vi.mocked(openai.chat.completions.create);

function finalCompletion(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] } as never;
}

function toolCallCompletion(name: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  } as never;
}

function post(path: string, cookie: string) {
  return agent().post(path).set("Cookie", cookie).set("X-Forwarded-Proto", "https");
}

// Pull the tool result string that was fed back to the model on the loop's
// second turn (after the tool ran).
function toolResultContent(): string {
  const secondCall = mockedCreate.mock.calls[1]?.[0] as {
    messages: { role: string; content?: unknown }[];
  };
  const toolResult = secondCall.messages.find(
    (m) => m.role === "tool" && typeof m.content === "string",
  );
  return String(toolResult?.content);
}

// Run one agent turn where the model invokes open_import_dialog with `args`,
// then replies. Returns the HTTP response body.
async function runImport(cookie: string, args: Record<string, unknown>) {
  mockedCreate.mockResolvedValueOnce(toolCallCompletion("open_import_dialog", args));
  mockedCreate.mockResolvedValueOnce(finalCompletion("Done."));
  const res = await post("/api/ai/agent/message", cookie).send({
    message: "Import some data.",
  });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("final");
  return res.body as {
    action?: { type: string; path: string };
    conversationId: number;
  };
}

let customersStaff: SeededAdmin;
let accountingStaff: SeededAdmin;
let woStaff: SeededAdmin;
let otherStaff: SeededAdmin;

beforeEach(async () => {
  mockedCreate.mockReset();
  customersStaff = await seedStaffUser(["customers"], "import-cust");
  accountingStaff = await seedStaffUser(["accounting"], "import-acct");
  woStaff = await seedStaffUser(["workOrders", "customers"], "import-wo");
  // A technician scoped to an unrelated module only: holds no importer module.
  otherStaff = await seedStaffUser(["appointments"], "import-other");
});

describe("open_import_dialog AI tool", () => {
  resetLimiterPerTest();

  it("opens the hub for a caller holding the customers module", async () => {
    const body = await runImport(customersStaff.cookie, {});
    expect(body.action).toEqual({ type: "open_import", path: "/import" });
    expect(toolResultContent()).toContain("open_import");
    expect(toolResultContent()).not.toContain("Permission denied");
  });

  it("opens the customers importer for a customers-only caller", async () => {
    const body = await runImport(customersStaff.cookie, { type: "customers" });
    expect(body.action).toEqual({
      type: "open_import",
      path: "/import?type=customers",
    });
  });

  it("opens the expenses importer for an accounting-only caller", async () => {
    const body = await runImport(accountingStaff.cookie, { type: "expenses" });
    expect(body.action).toEqual({
      type: "open_import",
      path: "/import?type=expenses",
    });
    expect(toolResultContent()).not.toContain("Permission denied");
  });

  it("opens the work-orders importer for a workOrders+customers caller", async () => {
    const body = await runImport(woStaff.cookie, { type: "work-orders" });
    expect(body.action).toEqual({
      type: "open_import",
      path: "/import?type=work-orders",
    });
  });

  it("denies the expenses importer for a caller without the accounting module", async () => {
    const body = await runImport(customersStaff.cookie, { type: "expenses" });
    expect(body.action).toBeUndefined();
    expect(toolResultContent()).toContain("Permission denied");
    expect(toolResultContent()).toContain("accounting");
    expect(toolResultContent()).not.toContain("open_import");
  });

  it("denies the customers importer for an accounting-only caller", async () => {
    const body = await runImport(accountingStaff.cookie, { type: "customers" });
    expect(body.action).toBeUndefined();
    expect(toolResultContent()).toContain("Permission denied");
    expect(toolResultContent()).toContain("customers");
  });

  it("denies work-orders for a caller missing the customers module", async () => {
    // workOrders without customers cannot import work orders (the route also
    // creates customer/vehicle records).
    const woOnly = await seedStaffUser(["workOrders"], "import-wo-only");
    const body = await runImport(woOnly.cookie, { type: "work-orders" });
    expect(body.action).toBeUndefined();
    expect(toolResultContent()).toContain("Permission denied");
    expect(toolResultContent()).toContain("customers");
  });

  it("denies the hub for a caller holding no importer module", async () => {
    const body = await runImport(otherStaff.cookie, {});
    expect(body.action).toBeUndefined();
    expect(toolResultContent()).toContain("Permission denied");
    expect(toolResultContent()).not.toContain("open_import");

    // The denial was persisted as a tool message.
    const toolMsgs = await db
      .select()
      .from(aiMessagesTable)
      .where(
        and(
          eq(aiMessagesTable.conversationId, body.conversationId),
          eq(aiMessagesTable.role, "tool"),
        ),
      );
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toContain("Permission denied");
  });
});
