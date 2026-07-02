import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, inspectionTemplatesTable, inspectionTemplateItemsTable } from "@workspace/db";
import {
  ListInspectionTemplatesResponse,
  CreateInspectionTemplateBody,
  GetInspectionTemplateParams,
  GetInspectionTemplateResponse,
  UpdateInspectionTemplateParams,
  UpdateInspectionTemplateBody,
  UpdateInspectionTemplateResponse,
  DeleteInspectionTemplateParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

type TemplateRow = typeof inspectionTemplatesTable.$inferSelect;
type ItemRow = typeof inspectionTemplateItemsTable.$inferSelect;

const shapeItem = (it: ItemRow) => ({
  id: it.id,
  category: it.category,
  name: it.name,
  sortOrder: it.sortOrder,
});

const detail = (tpl: TemplateRow, items: ItemRow[]) => ({
  id: tpl.id,
  name: tpl.name,
  description: tpl.description,
  createdAt: tpl.createdAt,
  items: items.map(shapeItem),
});

const fetchItems = (templateId: number) =>
  db
    .select()
    .from(inspectionTemplateItemsTable)
    .where(eq(inspectionTemplateItemsTable.templateId, templateId))
    .orderBy(inspectionTemplateItemsTable.sortOrder, inspectionTemplateItemsTable.id);

type ItemInput = { category?: string | null; name: string; sortOrder?: number };

const insertItems = async (templateId: number, items: ItemInput[]) => {
  if (!items.length) return;
  await db.insert(inspectionTemplateItemsTable).values(
    items.map((it, idx) => ({
      templateId,
      category: it.category ?? null,
      name: it.name,
      sortOrder: it.sortOrder ?? idx,
    })),
  );
};

router.get("/inspection-templates", async (_req, res): Promise<void> => {
  const templates = await db
    .select()
    .from(inspectionTemplatesTable)
    .orderBy(desc(inspectionTemplatesTable.id));
  const allItems = await db.select().from(inspectionTemplateItemsTable);
  const shaped = templates.map((tpl) =>
    detail(
      tpl,
      allItems
        .filter((it) => it.templateId === tpl.id)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    ),
  );
  res.json(ListInspectionTemplatesResponse.parse(shaped));
});

router.post("/inspection-templates", async (req, res): Promise<void> => {
  const parsed = CreateInspectionTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [created] = await db
    .insert(inspectionTemplatesTable)
    .values({ name: parsed.data.name, description: parsed.data.description ?? null })
    .returning();

  await insertItems(created.id, parsed.data.items);
  const items = await fetchItems(created.id);
  res.status(201).json(UpdateInspectionTemplateResponse.parse(detail(created, items)));
});

router.get("/inspection-templates/:id", async (req, res): Promise<void> => {
  const params = GetInspectionTemplateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [tpl] = await db
    .select()
    .from(inspectionTemplatesTable)
    .where(eq(inspectionTemplatesTable.id, params.data.id));
  if (!tpl) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const items = await fetchItems(tpl.id);
  res.json(GetInspectionTemplateResponse.parse(detail(tpl, items)));
});

router.patch("/inspection-templates/:id", async (req, res): Promise<void> => {
  const params = UpdateInspectionTemplateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateInspectionTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { items, ...fields } = parsed.data;

  const [updated] = await db
    .update(inspectionTemplatesTable)
    .set(fields)
    .where(eq(inspectionTemplatesTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  if (items) {
    await db
      .delete(inspectionTemplateItemsTable)
      .where(eq(inspectionTemplateItemsTable.templateId, params.data.id));
    await insertItems(params.data.id, items);
  }

  const stored = await fetchItems(params.data.id);
  res.json(UpdateInspectionTemplateResponse.parse(detail(updated, stored)));
});

router.delete("/inspection-templates/:id", async (req, res): Promise<void> => {
  const params = DeleteInspectionTemplateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(inspectionTemplatesTable)
    .where(eq(inspectionTemplatesTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
