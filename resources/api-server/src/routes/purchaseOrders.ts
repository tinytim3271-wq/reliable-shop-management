import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import {
  db,
  purchaseOrdersTable,
  poLineItemsTable,
  partsTable,
  stockMovementsTable,
} from "@workspace/db";
import {
  ListPurchaseOrdersResponse,
  CreatePurchaseOrderBody,
  GetPurchaseOrderParams,
  GetPurchaseOrderResponse,
  UpdatePurchaseOrderParams,
  UpdatePurchaseOrderBody,
  UpdatePurchaseOrderResponse,
  DeletePurchaseOrderParams,
} from "@workspace/api-zod";
import { round2 } from "../lib/ledger";
import { clearReorderDismissalsIfReplenished } from "../lib/billing";

const router: IRouter = Router();

type LineItemRow = typeof poLineItemsTable.$inferSelect;

const shapeLineItem = (li: LineItemRow) => ({
  id: li.id,
  partId: li.partId,
  description: li.description,
  quantity: li.quantity,
  unitCost: li.unitCost,
});

const fetchLineItems = (poId: number) =>
  db.select().from(poLineItemsTable).where(eq(poLineItemsTable.purchaseOrderId, poId));

const computeTotal = (items: { quantity: number; unitCost: number }[]): number =>
  round2(items.reduce((sum, li) => sum + li.quantity * li.unitCost, 0));

router.get("/purchase-orders", async (_req, res): Promise<void> => {
  const rows = await db.select().from(purchaseOrdersTable).orderBy(desc(purchaseOrdersTable.id));
  res.json(ListPurchaseOrdersResponse.parse(rows));
});

router.post("/purchase-orders", async (req, res): Promise<void> => {
  const parsed = CreatePurchaseOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const total = computeTotal(parsed.data.lineItems);

  const [created] = await db
    .insert(purchaseOrdersTable)
    .values({
      vendor: parsed.data.vendor,
      notes: parsed.data.notes ?? null,
      total,
    })
    .returning();

  if (parsed.data.lineItems.length) {
    await db.insert(poLineItemsTable).values(
      parsed.data.lineItems.map((li) => ({
        purchaseOrderId: created.id,
        partId: li.partId ?? null,
        description: li.description,
        quantity: li.quantity,
        unitCost: li.unitCost,
      })),
    );
  }

  const lineItems = await fetchLineItems(created.id);
  res.status(201).json(
    UpdatePurchaseOrderResponse.parse({ ...created, lineItems: lineItems.map(shapeLineItem) }),
  );
});

router.get("/purchase-orders/:id", async (req, res): Promise<void> => {
  const params = GetPurchaseOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [po] = await db
    .select()
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, params.data.id));
  if (!po) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const lineItems = await fetchLineItems(po.id);
  res.json(GetPurchaseOrderResponse.parse({ ...po, lineItems: lineItems.map(shapeLineItem) }));
});

router.patch("/purchase-orders/:id", async (req, res): Promise<void> => {
  const params = UpdatePurchaseOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdatePurchaseOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const becomingReceived = parsed.data.status === "received" && existing.status !== "received";
  const becomingOrdered = parsed.data.status === "ordered" && existing.status !== "ordered";

  // Status change and any resulting stock increments happen in one transaction so
  // the stock movement ledger can never drift from the on-hand count.
  await db.transaction(async (tx) => {
    await tx
      .update(purchaseOrdersTable)
      .set({
        ...parsed.data,
        ...(becomingReceived ? { receivedAt: new Date().toISOString() } : {}),
        ...(becomingOrdered ? { orderedAt: new Date().toISOString() } : {}),
      })
      .where(eq(purchaseOrdersTable.id, params.data.id));

    // Receiving a PO adds the ordered quantities into linked parts' stock and
    // records each addition in the movement ledger.
    if (becomingReceived) {
      const lineItems = await fetchLineItems(params.data.id);
      for (const li of lineItems) {
        if (!li.partId) continue;
        const delta = Math.round(li.quantity);
        if (delta <= 0) continue;
        await tx
          .update(partsTable)
          .set({ quantityOnHand: sql`${partsTable.quantityOnHand} + ${delta}` })
          .where(eq(partsTable.id, li.partId));
        await tx.insert(stockMovementsTable).values({
          partId: li.partId,
          delta,
          reason: "Received purchase order",
          sourceType: "purchase_order",
          sourceId: params.data.id,
          createdByUserId: req.currentUser?.id ?? null,
        });

        // Receiving stock can lift the part back above its reorder level, ending
        // the prior low-stock episode; clear any stale reorder-banner dismissals
        // so a genuinely new shortage later surfaces again.
        await clearReorderDismissalsIfReplenished(li.partId, tx);
      }
    }
  });

  const [po] = await db
    .select()
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, params.data.id));
  const lineItems = await fetchLineItems(po.id);
  res.json(UpdatePurchaseOrderResponse.parse({ ...po, lineItems: lineItems.map(shapeLineItem) }));
});

router.delete("/purchase-orders/:id", async (req, res): Promise<void> => {
  const params = DeletePurchaseOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
