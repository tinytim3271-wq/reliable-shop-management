import { Router, type IRouter } from "express";
import { eq, desc, ilike, sql } from "drizzle-orm";
import { db, customersTable, vehiclesTable } from "@workspace/db";
import {
  ListCustomersQueryParams,
  ListCustomersResponse,
  CreateCustomerBody,
  GetCustomerParams,
  GetCustomerResponse,
  UpdateCustomerParams,
  UpdateCustomerBody,
  UpdateCustomerResponse,
  DeleteCustomerParams,
} from "@workspace/api-zod";
import { customerDeleteBlocker } from "../lib/deleteGuards";
import { ObjectStorageService } from "../lib/objectStorage";
import { collectCustomerCascadePhotoPaths, freeOrphanedPhotos } from "../lib/photoCleanup";
import { normalizeToE164, INVALID_PHONE_MESSAGE } from "../lib/phone";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const baseColumns = {
  id: customersTable.id,
  name: customersTable.name,
  phone: customersTable.phone,
  email: customersTable.email,
  address: customersTable.address,
  notes: customersTable.notes,
  createdAt: customersTable.createdAt,
  vehicleCount: sql<number>`cast(count(${vehiclesTable.id}) as int)`,
};

const selectWithCount = () =>
  db
    .select(baseColumns)
    .from(customersTable)
    .leftJoin(vehiclesTable, eq(vehiclesTable.customerId, customersTable.id))
    .groupBy(customersTable.id);

router.get("/customers", async (req, res): Promise<void> => {
  const query = ListCustomersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = query.data.search
    ? await selectWithCount()
        .where(ilike(customersTable.name, `%${query.data.search}%`))
        .orderBy(desc(customersTable.id))
    : await selectWithCount().orderBy(desc(customersTable.id));

  res.json(ListCustomersResponse.parse(rows));
});

router.post("/customers", async (req, res): Promise<void> => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Normalize the phone toward E.164 so real texts (Twilio) can actually be
  // delivered later; reject loosely-entered numbers we cannot normalize.
  let phone = parsed.data.phone?.trim() || null;
  if (phone) {
    const normalized = normalizeToE164(phone);
    if (!normalized) {
      res.status(400).json({ error: INVALID_PHONE_MESSAGE });
      return;
    }
    phone = normalized;
  }

  const [created] = await db
    .insert(customersTable)
    .values({
      name: parsed.data.name,
      phone,
      email: parsed.data.email ?? null,
      address: parsed.data.address ?? null,
      notes: parsed.data.notes ?? null,
    })
    .returning();

  res.status(201).json(UpdateCustomerResponse.parse({ ...created, vehicleCount: 0 }));
});

router.get("/customers/:id", async (req, res): Promise<void> => {
  const params = GetCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [customer] = await selectWithCount().where(eq(customersTable.id, params.data.id));

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  res.json(GetCustomerResponse.parse(customer));
});

router.patch("/customers/:id", async (req, res): Promise<void> => {
  const params = UpdateCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Normalize the phone toward E.164 when it is part of this update; an empty
  // value clears it, an unnormalizable value is rejected.
  if ("phone" in parsed.data) {
    const phone = parsed.data.phone?.trim() || null;
    if (phone) {
      const normalized = normalizeToE164(phone);
      if (!normalized) {
        res.status(400).json({ error: INVALID_PHONE_MESSAGE });
        return;
      }
      parsed.data.phone = normalized;
    } else {
      parsed.data.phone = null;
    }
  }

  const [updated] = await db
    .update(customersTable)
    .set(parsed.data)
    .where(eq(customersTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const [customer] = await selectWithCount().where(eq(customersTable.id, updated.id));

  res.json(UpdateCustomerResponse.parse(customer));
});

router.delete("/customers/:id", async (req, res): Promise<void> => {
  const params = DeleteCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const id = params.data.id;

  const blocker = await customerDeleteBlocker(id);
  if (blocker) {
    res.status(409).json({ error: blocker });
    return;
  }

  // Gather photos owned by rows that will be cascade-deleted (vehicles ->
  // work orders / inspections -> inspection items) BEFORE the delete, while
  // those rows still exist.
  const cascadePhotoPaths = await collectCustomerCascadePhotoPaths(id);

  const [customer] = await db
    .delete(customersTable)
    .where(eq(customersTable.id, id))
    .returning();

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  // Best-effort: free each cascade-orphaned photo no longer referenced by any
  // surviving record. The owning rows are already gone, so this never blocks
  // the delete.
  await freeOrphanedPhotos(cascadePhotoPaths, objectStorageService, req.log);

  res.sendStatus(204);
});

export default router;
