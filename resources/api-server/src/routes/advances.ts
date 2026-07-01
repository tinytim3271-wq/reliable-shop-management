import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, advancesTable, mechanicsTable } from "@workspace/db";
import {
  ListAdvancesQueryParams,
  ListAdvancesResponse,
  CreateAdvanceBody,
  UpdateAdvanceParams,
  UpdateAdvanceBody,
  UpdateAdvanceResponse,
  DeleteAdvanceParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/advances", async (req, res): Promise<void> => {
  const query = ListAdvancesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = await db
    .select({
      id: advancesTable.id,
      mechanicId: advancesTable.mechanicId,
      mechanicName: mechanicsTable.name,
      date: advancesTable.date,
      amount: advancesTable.amount,
      reason: advancesTable.reason,
      deductFromPay: advancesTable.deductFromPay,
      notes: advancesTable.notes,
      createdAt: advancesTable.createdAt,
    })
    .from(advancesTable)
    .leftJoin(mechanicsTable, eq(advancesTable.mechanicId, mechanicsTable.id))
    .orderBy(desc(advancesTable.date), desc(advancesTable.id));

  const filtered = query.data.mechanicId
    ? rows.filter((r) => r.mechanicId === query.data.mechanicId)
    : rows;

  res.json(ListAdvancesResponse.parse(filtered));
});

router.post("/advances", async (req, res): Promise<void> => {
  const parsed = CreateAdvanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [advance] = await db
    .insert(advancesTable)
    .values({
      mechanicId: parsed.data.mechanicId,
      date: parsed.data.date,
      amount: parsed.data.amount,
      reason: parsed.data.reason ?? null,
      deductFromPay: parsed.data.deductFromPay ?? true,
      notes: parsed.data.notes ?? null,
    })
    .returning();

  res.status(201).json(UpdateAdvanceResponse.parse(advance));
});

router.patch("/advances/:id", async (req, res): Promise<void> => {
  const params = UpdateAdvanceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateAdvanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [advance] = await db
    .update(advancesTable)
    .set(parsed.data)
    .where(eq(advancesTable.id, params.data.id))
    .returning();

  if (!advance) {
    res.status(404).json({ error: "Advance not found" });
    return;
  }

  res.json(UpdateAdvanceResponse.parse(advance));
});

router.delete("/advances/:id", async (req, res): Promise<void> => {
  const params = DeleteAdvanceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [advance] = await db
    .delete(advancesTable)
    .where(eq(advancesTable.id, params.data.id))
    .returning();

  if (!advance) {
    res.status(404).json({ error: "Advance not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
