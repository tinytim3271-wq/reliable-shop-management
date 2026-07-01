import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db, messageTemplatesTable } from "@workspace/db";
import {
  ListMessageTemplatesResponse,
  CreateMessageTemplateBody,
  GetMessageTemplateParams,
  GetMessageTemplateResponse,
  UpdateMessageTemplateParams,
  UpdateMessageTemplateBody,
  UpdateMessageTemplateResponse,
  DeleteMessageTemplateParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/message-templates", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(messageTemplatesTable)
    .orderBy(asc(messageTemplatesTable.name));
  res.json(ListMessageTemplatesResponse.parse(rows));
});

router.post("/message-templates", async (req, res): Promise<void> => {
  const parsed = CreateMessageTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const d = parsed.data;
  const [created] = await db
    .insert(messageTemplatesTable)
    .values({
      name: d.name,
      channel: d.channel ?? "email",
      category: d.category ?? "other",
      subject: d.subject ?? null,
      body: d.body,
    })
    .returning();

  res.status(201).json(UpdateMessageTemplateResponse.parse(created));
});

router.get("/message-templates/:id", async (req, res): Promise<void> => {
  const params = GetMessageTemplateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [template] = await db
    .select()
    .from(messageTemplatesTable)
    .where(eq(messageTemplatesTable.id, params.data.id));
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  res.json(GetMessageTemplateResponse.parse(template));
});

router.patch("/message-templates/:id", async (req, res): Promise<void> => {
  const params = UpdateMessageTemplateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateMessageTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(messageTemplatesTable)
    .set(parsed.data)
    .where(eq(messageTemplatesTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  res.json(UpdateMessageTemplateResponse.parse(updated));
});

router.delete("/message-templates/:id", async (req, res): Promise<void> => {
  const params = DeleteMessageTemplateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(messageTemplatesTable)
    .where(eq(messageTemplatesTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
