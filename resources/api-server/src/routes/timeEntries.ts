import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, timeEntriesTable, mechanicsTable } from "@workspace/db";
import {
  ListTimeEntriesQueryParams,
  ListTimeEntriesResponse,
  CreateTimeEntryBody,
  UpdateTimeEntryParams,
  UpdateTimeEntryBody,
  UpdateTimeEntryResponse,
  DeleteTimeEntryParams,
} from "@workspace/api-zod";
import { round2 } from "../lib/ledger";
import { hasPermission } from "../lib/auth";

const router: IRouter = Router();

router.get("/time-entries", async (req, res): Promise<void> => {
  const query = ListTimeEntriesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const canReadPayroll = hasPermission(req, "payroll");

  // Non-payroll users may only list their own entries.
  // They must be linked to a mechanic record; if not, return empty.
  let scopedMechanicId: number | null | undefined = query.data.mechanicId;
  if (!canReadPayroll) {
    const ownMechanicId = req.currentUser?.mechanicId;
    if (!ownMechanicId) {
      res.json(ListTimeEntriesResponse.parse([]));
      return;
    }
    // If they requested a specific mechanicId that isn't their own, reject it.
    if (scopedMechanicId !== undefined && scopedMechanicId !== ownMechanicId) {
      res.status(403).json({
        error: "You do not have permission to view time entries for other mechanics.",
      });
      return;
    }
    scopedMechanicId = ownMechanicId;
  }

  const rows = await db
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
    .orderBy(desc(timeEntriesTable.date), desc(timeEntriesTable.id));

  const filtered = scopedMechanicId !== undefined
    ? rows.filter((r) => r.mechanicId === scopedMechanicId)
    : rows;

  // Non-payroll users must not see pay rates or computed totals.
  const shaped = canReadPayroll
    ? filtered
    : filtered.map((r) => ({ ...r, rate: 0, totalPay: 0 }));

  res.json(ListTimeEntriesResponse.parse(shaped));
});

router.post("/time-entries", async (req, res): Promise<void> => {
  const parsed = CreateTimeEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const canSetPayroll = hasPermission(req, "payroll");

  // Non-payroll users may only create entries for their own linked mechanic.
  // They cannot target arbitrary mechanicIds or set a custom rate.
  if (!canSetPayroll) {
    const ownMechanicId = req.currentUser?.mechanicId;
    if (!ownMechanicId) {
      res.status(403).json({
        error: "Your account is not linked to a mechanic record. Contact an admin.",
      });
      return;
    }
    if (parsed.data.mechanicId !== ownMechanicId) {
      res.status(403).json({
        error: "You do not have permission to create time entries for other mechanics.",
      });
      return;
    }
  }

  let rate: number;
  if (canSetPayroll) {
    rate = parsed.data.rate;
  } else {
    // Rate is always pulled from the mechanic record for non-payroll users.
    const [mechanic] = await db
      .select({ hourlyRate: mechanicsTable.hourlyRate })
      .from(mechanicsTable)
      .where(eq(mechanicsTable.id, parsed.data.mechanicId));
    if (!mechanic) {
      res.status(404).json({ error: "Mechanic not found" });
      return;
    }
    rate = mechanic.hourlyRate ?? 0;
  }

  const totalPay = round2(parsed.data.hours * rate);

  const [entry] = await db
    .insert(timeEntriesTable)
    .values({
      mechanicId: parsed.data.mechanicId,
      date: parsed.data.date,
      job: parsed.data.job ?? null,
      startTime: parsed.data.startTime ?? null,
      endTime: parsed.data.endTime ?? null,
      hours: parsed.data.hours,
      rate,
      totalPay,
      notes: parsed.data.notes ?? null,
    })
    .returning();

  // Non-payroll users must not learn rate/totalPay from the mutation response.
  const responseEntry = canSetPayroll
    ? entry
    : { ...entry, rate: 0, totalPay: 0 };
  res.status(201).json(UpdateTimeEntryResponse.parse(responseEntry));
});

router.patch("/time-entries/:id", async (req, res): Promise<void> => {
  const params = UpdateTimeEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateTimeEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(timeEntriesTable)
    .where(eq(timeEntriesTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  const canSetPayroll = hasPermission(req, "payroll");

  // Non-payroll users may only edit entries that belong to their own mechanic.
  if (!canSetPayroll) {
    const ownMechanicId = req.currentUser?.mechanicId;
    if (!ownMechanicId || existing.mechanicId !== ownMechanicId) {
      res.status(403).json({
        error: "You do not have permission to edit time entries for other mechanics.",
      });
      return;
    }
  }

  const hours = parsed.data.hours ?? existing.hours;
  // Non-payroll users cannot change the rate; it stays pinned to the stored value.
  const rate = canSetPayroll
    ? (parsed.data.rate ?? existing.rate)
    : existing.rate;
  const totalPay = round2(hours * rate);

  const updateFields = canSetPayroll
    ? { ...parsed.data, hours, rate, totalPay }
    : { ...parsed.data, hours, totalPay, rate: existing.rate };

  const [entry] = await db
    .update(timeEntriesTable)
    .set(updateFields)
    .where(eq(timeEntriesTable.id, params.data.id))
    .returning();

  // Non-payroll users must not learn rate/totalPay from the mutation response.
  const responseEntry = canSetPayroll
    ? entry
    : { ...entry, rate: 0, totalPay: 0 };
  res.json(UpdateTimeEntryResponse.parse(responseEntry));
});

router.delete("/time-entries/:id", async (req, res): Promise<void> => {
  // Deleting a time entry directly changes payroll totals; require payroll permission.
  if (!hasPermission(req, "payroll")) {
    res
      .status(403)
      .json({ error: "You do not have permission to access this resource" });
    return;
  }

  const params = DeleteTimeEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [entry] = await db
    .delete(timeEntriesTable)
    .where(eq(timeEntriesTable.id, params.data.id))
    .returning();

  if (!entry) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
