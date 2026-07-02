import { Router, type IRouter } from "express";
import { eq, desc, ilike } from "drizzle-orm";
import { db, partsTable, pricingMarkupTiersTable, stockMovementsTable, usersTable } from "@workspace/db";
import { priceFromMatrix } from "../lib/pricing";
import { loadCatalog, matchCatalogPart, clearReorderDismissalsIfReplenished } from "../lib/billing";
import {
  ListPartsQueryParams,
  ListPartsResponse,
  CreatePartBody,
  GetPartParams,
  GetPartResponse,
  UpdatePartParams,
  UpdatePartBody,
  UpdatePartResponse,
  DeletePartParams,
  ApplyPricingMatrixResponse,
  LookupPartStockBody,
  LookupPartStockResponse,
  ListPartMovementsParams,
  ListPartMovementsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

type PartRow = typeof partsTable.$inferSelect;

const shapePart = (p: PartRow) => ({
  ...p,
  lowStock: p.quantityOnHand <= p.reorderLevel,
});

router.get("/parts", async (req, res): Promise<void> => {
  const query = ListPartsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = query.data.search
    ? await db
        .select()
        .from(partsTable)
        .where(ilike(partsTable.name, `%${query.data.search}%`))
        .orderBy(desc(partsTable.id))
    : await db.select().from(partsTable).orderBy(desc(partsTable.id));

  const shaped = rows.map(shapePart);
  const filtered = query.data.lowStock ? shaped.filter((p) => p.lowStock) : shaped;

  res.json(ListPartsResponse.parse(filtered));
});

router.post("/parts", async (req, res): Promise<void> => {
  const parsed = CreatePartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [created] = await db
    .insert(partsTable)
    .values({
      name: parsed.data.name,
      sku: parsed.data.sku ?? null,
      category: parsed.data.category ?? null,
      vendor: parsed.data.vendor ?? null,
      location: parsed.data.location ?? null,
      quantityOnHand: parsed.data.quantityOnHand ?? 0,
      reorderLevel: parsed.data.reorderLevel ?? 0,
      unitCost: parsed.data.unitCost ?? 0,
      unitPrice: parsed.data.unitPrice ?? 0,
      notes: parsed.data.notes ?? null,
    })
    .returning();

  res.status(201).json(UpdatePartResponse.parse(shapePart(created)));
});

// Recompute every part's sell price from its cost using the markup matrix.
// Markup is applied to cost, so re-running is idempotent (never compounds).
router.post("/parts/apply-pricing-matrix", async (_req, res): Promise<void> => {
  const updated = await db.transaction(async (tx) => {
    const tiers = await tx.select().from(pricingMarkupTiersTable);
    const parts = await tx.select().from(partsTable);
    let count = 0;
    for (const p of parts) {
      // Skip parts with no matching tier or non-positive cost: priceFromMatrix
      // returns null there, and writing it back would wipe a manually-set price.
      const newPrice = priceFromMatrix(p.unitCost, tiers);
      if (newPrice !== null && newPrice !== p.unitPrice) {
        await tx.update(partsTable).set({ unitPrice: newPrice }).where(eq(partsTable.id, p.id));
        count += 1;
      }
    }
    return count;
  });

  res.json(ApplyPricingMatrixResponse.parse({ updated }));
});

// Match part line-item descriptions against the catalog so estimate/intake
// forms can show remaining stock as quantities are entered. On-hand counts are
// inventory-scoped: this route sits under the `/parts` -> `inventory` permission
// gate, so non-inventory callers are rejected (403) before reaching here and the
// endpoint cannot become a side channel into stock levels.
router.post("/parts/stock-lookup", async (req, res): Promise<void> => {
  const parsed = LookupPartStockBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { descriptions } = parsed.data;

  const catalog = await loadCatalog();
  const results = descriptions.map((description) => {
    const match = matchCatalogPart(description, catalog);
    return {
      description,
      partId: match ? match.id : null,
      quantityOnHand: match ? match.quantityOnHand : null,
      lowStock: match ? match.quantityOnHand <= match.reorderLevel : null,
    };
  });

  res.json(LookupPartStockResponse.parse(results));
});

router.get("/parts/:id", async (req, res): Promise<void> => {
  const params = GetPartParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [part] = await db.select().from(partsTable).where(eq(partsTable.id, params.data.id));
  if (!part) {
    res.status(404).json({ error: "Part not found" });
    return;
  }

  res.json(GetPartResponse.parse(shapePart(part)));
});

// Stock movement ledger for a part: every change to its on-hand count, newest
// first. Inventory-scoped via the /parts route gate. Returns 404 when the part
// does not exist so callers cannot probe ids through this endpoint.
router.get("/parts/:id/movements", async (req, res): Promise<void> => {
  const params = ListPartMovementsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [part] = await db.select().from(partsTable).where(eq(partsTable.id, params.data.id));
  if (!part) {
    res.status(404).json({ error: "Part not found" });
    return;
  }

  // Join users so the ledger can show who triggered each change. Left join keeps
  // legacy/system rows (no acting user) visible with a null name.
  const movements = await db
    .select({
      id: stockMovementsTable.id,
      partId: stockMovementsTable.partId,
      delta: stockMovementsTable.delta,
      reason: stockMovementsTable.reason,
      sourceType: stockMovementsTable.sourceType,
      sourceId: stockMovementsTable.sourceId,
      createdByUserId: stockMovementsTable.createdByUserId,
      createdByName: usersTable.displayName,
      createdAt: stockMovementsTable.createdAt,
    })
    .from(stockMovementsTable)
    .leftJoin(usersTable, eq(stockMovementsTable.createdByUserId, usersTable.id))
    .where(eq(stockMovementsTable.partId, params.data.id))
    .orderBy(desc(stockMovementsTable.id));

  res.json(ListPartMovementsResponse.parse(movements));
});

router.patch("/parts/:id", async (req, res): Promise<void> => {
  const params = UpdatePartParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdatePartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updated = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(partsTable)
      .where(eq(partsTable.id, params.data.id));
    if (!existing) return null;

    const [row] = await tx
      .update(partsTable)
      .set(parsed.data)
      .where(eq(partsTable.id, params.data.id))
      .returning();

    // Record a manual stock adjustment in the ledger so hand-edited on-hand
    // counts are traceable alongside automatic (PO/invoice) movements. Only
    // write a row when the count actually changed.
    if (
      parsed.data.quantityOnHand !== undefined &&
      parsed.data.quantityOnHand !== existing.quantityOnHand
    ) {
      await tx.insert(stockMovementsTable).values({
        partId: params.data.id,
        delta: parsed.data.quantityOnHand - existing.quantityOnHand,
        reason: "Manual adjustment",
        createdByUserId: req.currentUser?.id ?? null,
      });

      // A manual restock above the reorder level ends the prior low-stock
      // episode, so drop any stale reorder-banner dismissals for this part.
      await clearReorderDismissalsIfReplenished(params.data.id, tx);
    }

    return row;
  });

  if (!updated) {
    res.status(404).json({ error: "Part not found" });
    return;
  }

  res.json(UpdatePartResponse.parse(shapePart(updated)));
});

router.delete("/parts/:id", async (req, res): Promise<void> => {
  const params = DeletePartParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const deleted = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(partsTable)
      .where(eq(partsTable.id, params.data.id));
    if (!existing) return null;

    // Mirror the AI delete path: record the deletion in the append-only ledger
    // before removing the part so its prior on-hand count and the acting user
    // aren't lost. The movement's partId FK is ON DELETE SET NULL, so this row
    // survives the delete; name/SKU are snapshotted inline to keep a readable
    // identity in the audit log after the part is gone.
    await tx.insert(stockMovementsTable).values({
      partId: existing.id,
      partName: existing.name,
      partSku: existing.sku,
      delta: -existing.quantityOnHand,
      reason: "Part deleted",
      createdByUserId: req.currentUser?.id ?? null,
    });

    const [row] = await tx
      .delete(partsTable)
      .where(eq(partsTable.id, params.data.id))
      .returning();
    return row ?? null;
  });

  if (!deleted) {
    res.status(404).json({ error: "Part not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
