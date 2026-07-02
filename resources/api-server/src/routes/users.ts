import { Router, type IRouter } from "express";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, usersTable, authTokensTable } from "@workspace/db";
import {
  ListUsersResponse,
  CreateUserBody,
  GetUserParams,
  GetUserResponse,
  UpdateUserParams,
  UpdateUserBody,
  UpdateUserResponse,
  DeleteUserParams,
} from "@workspace/api-zod";
import {
  PERMISSION_KEYS,
  TECHNICIAN_PERMISSIONS,
  hashPassword,
  isAdmin,
  toPublicUser,
} from "../lib/auth";

const resolvePermissions = (
  role: string | undefined,
  permissions: string[] | undefined,
): string[] => {
  if (role === "admin") return [...PERMISSION_KEYS];
  if (permissions) return permissions;
  if (role === "technician") return [...TECHNICIAN_PERMISSIONS];
  return [];
};

const router: IRouter = Router();

router.get("/users", async (req, res): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const rows = await db.select().from(usersTable).orderBy(usersTable.username);
  res.json(ListUsersResponse.parse(rows.map(toPublicUser)));
});

router.post("/users", async (req, res): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, parsed.data.username));
  if (existing) {
    res.status(409).json({ error: "Username is already taken" });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const [user] = await db
    .insert(usersTable)
    .values({
      username: parsed.data.username,
      passwordHash,
      displayName: parsed.data.displayName,
      role: parsed.data.role ?? "technician",
      permissions: resolvePermissions(parsed.data.role, parsed.data.permissions),
      mechanicId: parsed.data.mechanicId ?? null,
      active: parsed.data.active ?? true,
    })
    .returning();

  res.status(201).json(GetUserResponse.parse(toPublicUser(user)));
});

router.get("/users/:id", async (req, res): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, params.data.id));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(GetUserResponse.parse(toPublicUser(user)));
});

router.patch("/users/:id", async (req, res): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const params = UpdateUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Hash the password outside the transaction (bcrypt is slow; holding a tx
  // open during hashing would increase lock contention unnecessarily).
  const newPasswordHash =
    parsed.data.password !== undefined
      ? await hashPassword(parsed.data.password)
      : undefined;

  let user: typeof usersTable.$inferSelect | undefined;
  let passwordChanged = false;

  const txResult = await db.transaction(async (tx) => {
    // Lock all active admin rows for the duration of this transaction.
    // This serializes any concurrent admin-management operations so the
    // "last admin" check and the subsequent write are atomic — no TOCTOU race.
    await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), eq(usersTable.active, true)))
      .for("update");

    const [target] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, params.data.id));
    if (!target) return "not_found" as const;

    // Guard against removing the last active admin (lockout protection).
    const losesAdmin =
      target.role === "admin" &&
      ((parsed.data.role !== undefined && parsed.data.role !== "admin") ||
        parsed.data.active === false);
    if (losesAdmin) {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.role, "admin"),
            eq(usersTable.active, true),
            ne(usersTable.id, target.id),
          ),
        );
      if ((row?.count ?? 0) === 0) return "last_admin" as const;
    }

    const updates: Partial<typeof usersTable.$inferInsert> = {};
    if (parsed.data.displayName !== undefined)
      updates.displayName = parsed.data.displayName;
    if (parsed.data.role !== undefined) updates.role = parsed.data.role;
    if (parsed.data.permissions !== undefined || parsed.data.role !== undefined)
      updates.permissions = resolvePermissions(
        parsed.data.role ?? target.role,
        parsed.data.permissions,
      );
    if (parsed.data.mechanicId !== undefined)
      updates.mechanicId = parsed.data.mechanicId;
    if (parsed.data.active !== undefined) updates.active = parsed.data.active;
    if (newPasswordHash !== undefined) updates.passwordHash = newPasswordHash;

    const [updated] = await tx
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, params.data.id))
      .returning();

    user = updated;
    passwordChanged = newPasswordHash !== undefined;
    return "ok" as const;
  });

  if (txResult === "not_found") {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (txResult === "last_admin") {
    res.status(400).json({ error: "Cannot remove or deactivate the last admin" });
    return;
  }

  // When a password is changed, invalidate all existing credentials for that
  // user: bearer tokens (auth_tokens rows) and server-side browser sessions.
  // This ensures a password reset actually contains a compromised account —
  // stolen tokens and hijacked sessions stop working immediately.
  if (passwordChanged) {
    await db
      .delete(authTokensTable)
      .where(eq(authTokensTable.userId, params.data.id));
    // Sessions are stored as JSON; delete any row whose sess.userId matches.
    // Raw SQL is used because the session table is managed by connect-pg-simple
    // and is not meant to be queried via the Drizzle table reference.
    await db.execute(
      sql`DELETE FROM session WHERE (sess->>'userId')::int = ${params.data.id}`,
    );
  }

  res.json(UpdateUserResponse.parse(toPublicUser(user!)));
});

router.delete("/users/:id", async (req, res): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const params = DeleteUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  if (req.currentUser?.id === params.data.id) {
    res.status(400).json({ error: "You cannot delete your own account" });
    return;
  }

  const deleteResult = await db.transaction(async (tx) => {
    // Lock all active admin rows for the duration of this transaction.
    // This serializes any concurrent admin-management operations so the
    // "last admin" check and the subsequent delete are atomic — no TOCTOU race.
    await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), eq(usersTable.active, true)))
      .for("update");

    const [target] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, params.data.id));
    if (!target) return "not_found" as const;

    if (target.role === "admin" && target.active) {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.role, "admin"),
            eq(usersTable.active, true),
            ne(usersTable.id, target.id),
          ),
        );
      if ((row?.count ?? 0) === 0) return "last_admin" as const;
    }

    await tx.delete(usersTable).where(eq(usersTable.id, params.data.id));
    return "ok" as const;
  });

  if (deleteResult === "not_found") {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (deleteResult === "last_admin") {
    res.status(400).json({ error: "Cannot delete the last admin" });
    return;
  }

  res.sendStatus(204);
});

export default router;
