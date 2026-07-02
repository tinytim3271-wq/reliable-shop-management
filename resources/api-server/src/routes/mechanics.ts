import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, mechanicsTable } from "@workspace/db";
import {
  ListMechanicsQueryParams,
  ListMechanicsResponse,
  CreateMechanicBody,
  GetMechanicParams,
  GetMechanicResponse,
  UpdateMechanicParams,
  UpdateMechanicBody,
  UpdateMechanicResponse,
  DeleteMechanicParams,
  GetMechanicBalanceParams,
  GetMechanicBalanceResponse,
} from "@workspace/api-zod";
import { computeMechanicBalance } from "../lib/ledger";

const router: IRouter = Router();

router.get("/mechanics", async (req, res): Promise<void> => {
  const query = ListMechanicsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = await db
    .select()
    .from(mechanicsTable)
    .orderBy(mechanicsTable.name);

  const filtered = query.data.status
    ? rows.filter((m) => m.status === query.data.status)
    : rows;

  res.json(ListMechanicsResponse.parse(filtered));
});

router.post("/mechanics", async (req, res): Promise<void> => {
  const parsed = CreateMechanicBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [mechanic] = await db
    .insert(mechanicsTable)
    .values({
      name: parsed.data.name,
      phone: parsed.data.phone ?? null,
      hourlyRate: parsed.data.hourlyRate,
      startDate: parsed.data.startDate ?? null,
      status: parsed.data.status ?? "active",
      notes: parsed.data.notes ?? null,
    })
    .returning();

  res.status(201).json(GetMechanicResponse.parse(mechanic));
});

router.get("/mechanics/:id", async (req, res): Promise<void> => {
  const params = GetMechanicParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [mechanic] = await db
    .select()
    .from(mechanicsTable)
    .where(eq(mechanicsTable.id, params.data.id));

  if (!mechanic) {
    res.status(404).json({ error: "Mechanic not found" });
    return;
  }

  res.json(GetMechanicResponse.parse(mechanic));
});

router.patch("/mechanics/:id", async (req, res): Promise<void> => {
  const params = UpdateMechanicParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateMechanicBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [mechanic] = await db
    .update(mechanicsTable)
    .set(parsed.data)
    .where(eq(mechanicsTable.id, params.data.id))
    .returning();

  if (!mechanic) {
    res.status(404).json({ error: "Mechanic not found" });
    return;
  }

  res.json(UpdateMechanicResponse.parse(mechanic));
});

router.delete("/mechanics/:id", async (req, res): Promise<void> => {
  const params = DeleteMechanicParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [mechanic] = await db
    .delete(mechanicsTable)
    .where(eq(mechanicsTable.id, params.data.id))
    .returning();

  if (!mechanic) {
    res.status(404).json({ error: "Mechanic not found" });
    return;
  }

  res.sendStatus(204);
});

router.get("/mechanics/:id/balance", async (req, res): Promise<void> => {
  const params = GetMechanicBalanceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const balance = await computeMechanicBalance(params.data.id);
  if (!balance) {
    res.status(404).json({ error: "Mechanic not found" });
    return;
  }

  res.json(GetMechanicBalanceResponse.parse(balance));
});

export default router;
