import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, lineItemPresetsTable } from "@workspace/db";
import {
  ListLineItemPresetsResponse,
  CreateLineItemPresetBody,
  UpdateLineItemPresetParams,
  UpdateLineItemPresetBody,
  UpdateLineItemPresetResponse,
  DeleteLineItemPresetParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/line-item-presets", async (_req, res): Promise<void> => {
  const rows = await db.select().from(lineItemPresetsTable).orderBy(desc(lineItemPresetsTable.id));
  res.json(ListLineItemPresetsResponse.parse(rows));
});

router.post("/line-item-presets", async (req, res): Promise<void> => {
  const parsed = CreateLineItemPresetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [created] = await db
    .insert(lineItemPresetsTable)
    .values({
      type: parsed.data.type ?? "labor",
      description: parsed.data.description,
      defaultQuantity: parsed.data.defaultQuantity ?? 1,
      defaultUnitPrice: parsed.data.defaultUnitPrice ?? 0,
    })
    .returning();

  res.status(201).json(UpdateLineItemPresetResponse.parse(created));
});

router.patch("/line-item-presets/:id", async (req, res): Promise<void> => {
  const params = UpdateLineItemPresetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateLineItemPresetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(lineItemPresetsTable)
    .set(parsed.data)
    .where(eq(lineItemPresetsTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }

  res.json(UpdateLineItemPresetResponse.parse(updated));
});

router.delete("/line-item-presets/:id", async (req, res): Promise<void> => {
  const params = DeleteLineItemPresetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(lineItemPresetsTable)
    .where(eq(lineItemPresetsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
