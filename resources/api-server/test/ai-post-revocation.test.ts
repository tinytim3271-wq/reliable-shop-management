import { beforeAll, describe, expect, it } from "vitest";

// Regression guard for the post-revocation side channel called out in the
// threat model: stored AI conversation transcripts and durable memories must
// not preserve access to module data after a staff member's permission is
// revoked. Both surfaces filter by the caller's CURRENT permissions:
//   - GET /ai/memories       -> getFilteredMemoriesForUser
//   - GET /ai/conversations/:id -> getFilteredConversationTranscript
// This suite seeds content whose provenance is a specific module (recorded via
// sourcePermissions on memories, and via a restricted tool result in the
// transcript), then proves it is hidden from a user who lacks that module while
// still being fully visible to a user who holds it (and to an admin). No real
// network calls are made — only direct DB seeding and HTTP reads.

import {
  db,
  aiConversationsTable,
  aiMessagesTable,
  aiMemoriesTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  agent,
  loginCookie,
  seedAdmin,
  seedStaffUser,
  type SeededAdmin,
} from "./helpers";

const REDACTION_MARKER = "redacted";
// A concrete inventory figure that only an inventory-holder should ever see in
// the transcript; its presence/absence is how we detect a leak.
const SENSITIVE_STOCK_REPLY = "You have 7 ProBrake ceramic pads in stock.";

// A user who HOLDS the inventory module: should see inventory-derived content.
let holder: SeededAdmin;
// A user whose access to inventory has been "revoked" (never granted here):
// inventory-derived content must be hidden from them.
let revoked: SeededAdmin;
// An admin: bypasses module filtering and must see everything.
let admin: SeededAdmin;

function get(path: string, cookie: string) {
  return agent().get(path).set("Cookie", cookie).set("X-Forwarded-Proto", "https");
}

// Seed a conversation owned by `userId` containing one turn whose final
// assistant reply summarizes the result of an inventory-gated tool
// (`find_parts`, requiredPermission "inventory"). The transcript filter taints
// the final reply because it follows a restricted tool result. Returns the
// conversation id.
async function seedInventoryConversation(userId: number): Promise<number> {
  const [conv] = await db
    .insert(aiConversationsTable)
    .values({ userId, title: "Stock check" })
    .returning();

  // Insert sequentially so message ids are strictly ascending (the filter
  // walks the thread in id order).
  await db.insert(aiMessagesTable).values({
    conversationId: conv.id,
    role: "user",
    content: "How many ProBrake ceramic pads do we have?",
  });
  await db.insert(aiMessagesTable).values({
    conversationId: conv.id,
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: "call_inv_1",
        type: "function",
        function: { name: "find_parts", arguments: '{"search":"ProBrake ceramic"}' },
      },
    ],
  });
  await db.insert(aiMessagesTable).values({
    conversationId: conv.id,
    role: "tool",
    toolCallId: "call_inv_1",
    name: "find_parts",
    content: '{"parts":[{"id":1,"name":"ProBrake ceramic pads","quantityOnHand":7}]}',
  });
  await db.insert(aiMessagesTable).values({
    conversationId: conv.id,
    role: "assistant",
    content: SENSITIVE_STOCK_REPLY,
  });

  return conv.id;
}

beforeAll(async () => {
  holder = await seedStaffUser(["inventory"], "inv-holder");
  revoked = await seedStaffUser(["appointments"], "inv-revoked");
  admin = await seedAdmin();
});

describe("AI memories honor revoked module access", () => {
  it("omits an inventory-derived memory from a user who lacks inventory", async () => {
    const [gated] = await db
      .insert(aiMemoriesTable)
      .values({
        userId: revoked.id,
        kind: "fact",
        content: "Shelf B3 holds the ProBrake ceramic overstock.",
        sourcePermissions: ["inventory"],
      })
      .returning();
    // A memory gated on a permission the user DOES hold must still come through,
    // proving the filter is permission-driven and not blanket-hiding everything.
    // (revoked was seeded with ["appointments"] — see beforeAll above.)
    const [ungated] = await db
      .insert(aiMemoriesTable)
      .values({
        userId: revoked.id,
        kind: "preference",
        content: "Prefers metric tools.",
        sourcePermissions: ["appointments"],
      })
      .returning();

    const res = await get("/api/ai/memories", revoked.cookie);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).not.toContain(gated.id);
    expect(ids).toContain(ungated.id);
  });

  it("shows an inventory-derived memory to a user who still holds inventory", async () => {
    const [gated] = await db
      .insert(aiMemoriesTable)
      .values({
        userId: holder.id,
        kind: "fact",
        content: "Shelf B3 holds the ProBrake ceramic overstock.",
        sourcePermissions: ["inventory"],
      })
      .returning();

    const res = await get("/api/ai/memories", holder.cookie);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).toContain(gated.id);
  });

  it("shows an inventory-derived memory to an admin", async () => {
    const [gated] = await db
      .insert(aiMemoriesTable)
      .values({
        userId: admin.id,
        kind: "fact",
        content: "Shelf B3 holds the ProBrake ceramic overstock.",
        sourcePermissions: ["inventory"],
      })
      .returning();

    const res = await get("/api/ai/memories", admin.cookie);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).toContain(gated.id);
  });
});

describe("AI conversation transcripts honor revoked module access", () => {
  it("redacts inventory-derived replies for a user who lacks inventory", async () => {
    const conversationId = await seedInventoryConversation(revoked.id);

    const res = await get(`/api/ai/conversations/${conversationId}`, revoked.cookie);
    expect(res.status).toBe(200);

    const messages = res.body.messages as Array<{ role: string; content: string }>;
    // The user's own question is preserved.
    expect(messages.some((m) => m.role === "user")).toBe(true);
    // The assistant's final reply is redacted, not the real stock figure.
    const assistantReplies = messages.filter((m) => m.role === "assistant");
    expect(assistantReplies.length).toBeGreaterThan(0);
    const joined = assistantReplies.map((m) => m.content).join(" ");
    expect(joined).toContain(REDACTION_MARKER);
    expect(joined).not.toContain(SENSITIVE_STOCK_REPLY);
    expect(joined).not.toContain("7");
  });

  it("shows the full inventory-derived reply to a user who still holds inventory", async () => {
    const conversationId = await seedInventoryConversation(holder.id);

    const res = await get(`/api/ai/conversations/${conversationId}`, holder.cookie);
    expect(res.status).toBe(200);

    const messages = res.body.messages as Array<{ role: string; content: string }>;
    const joined = messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join(" ");
    expect(joined).toContain(SENSITIVE_STOCK_REPLY);
    expect(joined).not.toContain(REDACTION_MARKER);
  });

  it("shows the full inventory-derived reply to an admin", async () => {
    const conversationId = await seedInventoryConversation(admin.id);

    const res = await get(`/api/ai/conversations/${conversationId}`, admin.cookie);
    expect(res.status).toBe(200);

    const messages = res.body.messages as Array<{ role: string; content: string }>;
    const joined = messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join(" ");
    expect(joined).toContain(SENSITIVE_STOCK_REPLY);
    expect(joined).not.toContain(REDACTION_MARKER);
  });
});

// Regression guard for non-admin users with zero module permissions.
// The remember tool now writes ["__any"] for these users so their memories
// remain readable to themselves (and other staff) without being mistaken for
// legacy admin-authored rows or gated on permissions they don't hold.
describe("Non-admin with no module permissions can read their own memories", () => {
  let zeroPerm: SeededAdmin;
  let zeroPermMemoryId: number;

  beforeAll(async () => {
    zeroPerm = await seedStaffUser([], "zeroperm");

    // Directly insert a memory with the ["__any"] sentinel — the same value
    // the remember tool now writes for non-admins with no module permissions.
    const [mem] = await db
      .insert(aiMemoriesTable)
      .values({
        userId: zeroPerm.id,
        kind: "preference",
        content: "Prefers OEM parts when cost allows.",
        sourcePermissions: ["__any"],
      })
      .returning();
    zeroPermMemoryId = mem.id;
  });

  it("returns the memory to the zero-permission user who owns it", async () => {
    const res = await get("/api/ai/memories", zeroPerm.cookie);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).toContain(zeroPermMemoryId);
  });
});

// Regression guard for LEGACY admin-authored memories stored with
// sourcePermissions = [] (the old code path stored [] for all admin writes).
// After the fix, canReadMemory treats user-scoped [] identically to ["admin"]:
// admin-only.  Shop-wide rows (userId IS NULL) with [] remain ungated.
describe("Legacy admin-authored memories (sourcePermissions=[]) hidden after downgrade", () => {
  let legacyAdmin: SeededAdmin;
  let legacyMemoryId: number;
  // A non-admin staff user sharing the same shop-wide (userId=null) memory.
  let staffUser: SeededAdmin;
  // A shop-wide memory seeded with [] must remain visible to staff.
  let shopWideMemoryId: number;

  beforeAll(async () => {
    legacyAdmin = await seedAdmin();
    staffUser = await seedStaffUser(["appointments"], "legacy-staff");

    // Simulate a pre-fix admin-authored memory: user-scoped, sourcePermissions=[].
    const [legMem] = await db
      .insert(aiMemoriesTable)
      .values({
        userId: legacyAdmin.id,
        kind: "fact",
        content: "Legacy secret: markup is 45% across the board.",
        sourcePermissions: [],
      })
      .returning();
    legacyMemoryId = legMem.id;

    // Shop-wide memory (userId IS NULL) with [] must remain visible to staff.
    const [shopMem] = await db
      .insert(aiMemoriesTable)
      .values({
        userId: null,
        kind: "preference",
        content: "Shop prefers OEM parts when available.",
        sourcePermissions: [],
      })
      .returning();
    shopWideMemoryId = shopMem.id;

    // Demote legacyAdmin to an ordinary technician.
    await db
      .update(usersTable)
      .set({ role: "technician", permissions: [] })
      .where(eq(usersTable.id, legacyAdmin.id));
  });

  it("hides a legacy user-scoped [] memory from the downgraded account", async () => {
    const downgradedCookie = await loginCookie(legacyAdmin.username, legacyAdmin.password);
    const res = await get("/api/ai/memories", downgradedCookie);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).not.toContain(legacyMemoryId);
  });

  it("shop-wide [] memory (userId IS NULL) remains visible to staff", async () => {
    const res = await get("/api/ai/memories", staffUser.cookie);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).toContain(shopWideMemoryId);
  });
});

// Regression guard for the admin-downgrade memory leak:
//   sourcePermissions = ["admin"] on user-scoped memory rows means "only
//   readable by current admins". A memory written while an account held admin
//   rights must become invisible after that account is downgraded to technician,
//   even though the session for the downgraded user is still valid (they log in
//   again after demotion). A current admin must still see the same row.
describe("Admin-authored AI memories hidden after role downgrade", () => {
  // An admin whose account we will demote mid-test.
  let demotable: SeededAdmin;
  // A current admin used to verify admin-authored memories remain readable
  // to accounts that still hold admin rights.
  let currentAdmin: SeededAdmin;
  // The memory row owned by demotable, written with admin provenance.
  let demotableMemoryId: number;
  // The memory row owned by currentAdmin, written with admin provenance.
  let currentAdminMemoryId: number;

  beforeAll(async () => {
    demotable = await seedAdmin();
    currentAdmin = await seedAdmin();

    // Seed a memory for each admin that carries admin provenance (["admin"]
    // sentinel, matching what aiTools.ts now writes for admin-authored rows).
    const [demMem] = await db
      .insert(aiMemoriesTable)
      .values({
        userId: demotable.id,
        kind: "fact",
        content: "Owner pays all mechanics $35/hr as a secret base rate.",
        sourcePermissions: ["admin"],
      })
      .returning();
    demotableMemoryId = demMem.id;

    const [curMem] = await db
      .insert(aiMemoriesTable)
      .values({
        userId: currentAdmin.id,
        kind: "fact",
        content: "Monthly parts budget cap is $8,000.",
        sourcePermissions: ["admin"],
      })
      .returning();
    currentAdminMemoryId = curMem.id;

    // Demote demotable's account to an ordinary technician with no modules.
    await db
      .update(usersTable)
      .set({ role: "technician", permissions: [] })
      .where(eq(usersTable.id, demotable.id));
  });

  it("hides the admin-authored memory from the now-downgraded account", async () => {
    // The demotable user must log in fresh so the session reflects the new role.
    const downgradedCookie = await loginCookie(demotable.username, demotable.password);
    const res = await get("/api/ai/memories", downgradedCookie);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).not.toContain(demotableMemoryId);
  });

  it("still shows an admin-authored memory to an account that remains admin", async () => {
    // currentAdmin reads their own admin-authored memory; it must still appear
    // because their role has not changed.
    const res = await get("/api/ai/memories", currentAdmin.cookie);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number }>).map((m) => m.id);
    expect(ids).toContain(currentAdminMemoryId);
  });
});
