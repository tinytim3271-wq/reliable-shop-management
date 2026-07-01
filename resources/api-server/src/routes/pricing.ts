import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db, pricingMarkupTiersTable, laborRatesTable } from "@workspace/db";
import {
  ListPricingMarkupTiersResponse,
  CreatePricingMarkupTierBody,
  UpdatePricingMarkupTierParams,
  UpdatePricingMarkupTierBody,
  UpdatePricingMarkupTierResponse,
  DeletePricingMarkupTierParams,
  ListLaborRatesResponse,
  CreateLaborRateBody,
  UpdateLaborRateParams,
  UpdateLaborRateBody,
  UpdateLaborRateResponse,
  DeleteLaborRateParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// --- Parts markup tiers ---

router.get("/pricing-markup-tiers", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(pricingMarkupTiersTable)
    .orderBy(asc(pricingMarkupTiersTable.minCost));
  res.json(ListPricingMarkupTiersResponse.parse(rows));
});

router.post("/pricing-markup-tiers", async (req, res): Promise<void> => {
  const parsed = CreatePricingMarkupTierBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [created] = await db
    .insert(pricingMarkupTiersTable)
    .values({
      label: parsed.data.label ?? null,
      minCost: parsed.data.minCost ?? 0,
      maxCost: parsed.data.maxCost ?? null,
      markupPercent: parsed.data.markupPercent,
    })
    .returning();

  res.status(201).json(UpdatePricingMarkupTierResponse.parse(created));
});

router.patch("/pricing-markup-tiers/:id", async (req, res): Promise<void> => {
  const params = UpdatePricingMarkupTierParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdatePricingMarkupTierBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(pricingMarkupTiersTable)
    .set(parsed.data)
    .where(eq(pricingMarkupTiersTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Markup tier not found" });
    return;
  }

  res.json(UpdatePricingMarkupTierResponse.parse(updated));
});

router.delete("/pricing-markup-tiers/:id", async (req, res): Promise<void> => {
  const params = DeletePricingMarkupTierParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(pricingMarkupTiersTable)
    .where(eq(pricingMarkupTiersTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Markup tier not found" });
    return;
  }

  res.sendStatus(204);
});

// --- Saved labor rates ---

router.get("/labor-rates", async (_req, res): Promise<void> => {
  const rows = await db.select().from(laborRatesTable).orderBy(asc(laborRatesTable.name));
  res.json(ListLaborRatesResponse.parse(rows));
});

router.post("/labor-rates", async (req, res): Promise<void> => {
  const parsed = CreateLaborRateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [created] = await db
    .insert(laborRatesTable)
    .values({
      name: parsed.data.name,
      hourlyRate: parsed.data.hourlyRate,
    })
    .returning();

  res.status(201).json(UpdateLaborRateResponse.parse(created));
});

router.patch("/labor-rates/:id", async (req, res): Promise<void> => {
  const params = UpdateLaborRateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateLaborRateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(laborRatesTable)
    .set(parsed.data)
    .where(eq(laborRatesTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Labor rate not found" });
    return;
  }

  res.json(UpdateLaborRateResponse.parse(updated));
});

router.delete("/labor-rates/:id", async (req, res): Promise<void> => {
  const params = DeleteLaborRateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(laborRatesTable)
    .where(eq(laborRatesTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Labor rate not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
