import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, vehiclesTable, customersTable, workOrdersTable, estimatesTable, invoicesTable } from "@workspace/db";
import {
  ListVehiclesQueryParams,
  ListVehiclesResponse,
  CreateVehicleBody,
  GetVehicleParams,
  GetVehicleResponse,
  UpdateVehicleParams,
  UpdateVehicleBody,
  UpdateVehicleResponse,
  DeleteVehicleParams,
  DecodeVinParams,
  DecodeVinResponse,
} from "@workspace/api-zod";
import { vehicleDeleteBlocker } from "../lib/deleteGuards";
import { missingRef } from "../lib/refs";
import { ObjectStorageService } from "../lib/objectStorage";
import { collectVehicleCascadePhotoPaths, freeOrphanedPhotos } from "../lib/photoCleanup";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const VIN_DECODE_TIMEOUT_MS = 5_000;
const VIN_DECODE_MAX_CONCURRENT = 5;
let vinDecodeInFlight = 0;

const vehicleColumns = {
  id: vehiclesTable.id,
  customerId: vehiclesTable.customerId,
  customerName: customersTable.name,
  year: vehiclesTable.year,
  make: vehiclesTable.make,
  model: vehiclesTable.model,
  trim: vehiclesTable.trim,
  vin: vehiclesTable.vin,
  licensePlate: vehiclesTable.licensePlate,
  color: vehiclesTable.color,
  mileage: vehiclesTable.mileage,
  engine: vehiclesTable.engine,
  notes: vehiclesTable.notes,
  createdAt: vehiclesTable.createdAt,
};

const selectVehicles = () =>
  db
    .select(vehicleColumns)
    .from(vehiclesTable)
    .leftJoin(customersTable, eq(vehiclesTable.customerId, customersTable.id));

router.get("/vehicles", async (req, res): Promise<void> => {
  const query = ListVehiclesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = query.data.customerId
    ? await selectVehicles()
        .where(eq(vehiclesTable.customerId, query.data.customerId))
        .orderBy(desc(vehiclesTable.id))
    : await selectVehicles().orderBy(desc(vehiclesTable.id));

  res.json(ListVehiclesResponse.parse(rows));
});

router.post("/vehicles", async (req, res): Promise<void> => {
  const parsed = CreateVehicleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const refError = await missingRef(customersTable, parsed.data.customerId, "Customer");
  if (refError) {
    res.status(400).json({ error: refError });
    return;
  }

  const [created] = await db
    .insert(vehiclesTable)
    .values({
      customerId: parsed.data.customerId,
      year: parsed.data.year ?? null,
      make: parsed.data.make ?? null,
      model: parsed.data.model ?? null,
      trim: parsed.data.trim ?? null,
      vin: parsed.data.vin ?? null,
      licensePlate: parsed.data.licensePlate ?? null,
      color: parsed.data.color ?? null,
      mileage: parsed.data.mileage ?? null,
      engine: parsed.data.engine ?? null,
      notes: parsed.data.notes ?? null,
    })
    .returning();

  const [vehicle] = await selectVehicles().where(eq(vehiclesTable.id, created.id));

  res.status(201).json(UpdateVehicleResponse.parse(vehicle));
});

router.get("/vehicles/:id", async (req, res): Promise<void> => {
  const params = GetVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [vehicle] = await selectVehicles().where(eq(vehiclesTable.id, params.data.id));

  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  res.json(GetVehicleResponse.parse(vehicle));
});

router.patch("/vehicles/:id", async (req, res): Promise<void> => {
  const params = UpdateVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateVehicleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const refError = await missingRef(customersTable, parsed.data.customerId, "Customer");
  if (refError) {
    res.status(400).json({ error: refError });
    return;
  }

  // If customerId is changing, reject the update when the vehicle already has
  // linked work orders, estimates, or invoices. Those records store their own
  // customerId/vehicleId pair and cross-module routes treat the alignment as an
  // authorization boundary — silently repointing the vehicle's owner would
  // bypass those checks for all linked records.
  if (parsed.data.customerId !== undefined) {
    const [current] = await db
      .select({ customerId: vehiclesTable.customerId })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, params.data.id));

    if (current && current.customerId !== parsed.data.customerId) {
      const vehicleId = params.data.id;
      const [wo] = await db
        .select({ id: workOrdersTable.id })
        .from(workOrdersTable)
        .where(eq(workOrdersTable.vehicleId, vehicleId))
        .limit(1);
      if (wo) {
        res.status(409).json({
          error:
            "Cannot reassign vehicle to a different customer: the vehicle has linked work orders. Reassign or remove them first.",
        });
        return;
      }
      const [est] = await db
        .select({ id: estimatesTable.id })
        .from(estimatesTable)
        .where(eq(estimatesTable.vehicleId, vehicleId))
        .limit(1);
      if (est) {
        res.status(409).json({
          error:
            "Cannot reassign vehicle to a different customer: the vehicle has linked estimates. Reassign or remove them first.",
        });
        return;
      }
      const [inv] = await db
        .select({ id: invoicesTable.id })
        .from(invoicesTable)
        .where(eq(invoicesTable.vehicleId, vehicleId))
        .limit(1);
      if (inv) {
        res.status(409).json({
          error:
            "Cannot reassign vehicle to a different customer: the vehicle has linked invoices. Reassign or remove them first.",
        });
        return;
      }
    }
  }

  const [updated] = await db
    .update(vehiclesTable)
    .set(parsed.data)
    .where(eq(vehiclesTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  const [vehicle] = await selectVehicles().where(eq(vehiclesTable.id, updated.id));

  res.json(UpdateVehicleResponse.parse(vehicle));
});

router.delete("/vehicles/:id", async (req, res): Promise<void> => {
  const params = DeleteVehicleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const id = params.data.id;

  const blocker = await vehicleDeleteBlocker(id);
  if (blocker) {
    res.status(409).json({ error: blocker });
    return;
  }

  // Gather photos owned by rows that will be cascade-deleted (work orders /
  // inspections -> inspection items) BEFORE the delete, while those rows
  // still exist.
  const cascadePhotoPaths = await collectVehicleCascadePhotoPaths(id);

  const [vehicle] = await db
    .delete(vehiclesTable)
    .where(eq(vehiclesTable.id, id))
    .returning();

  if (!vehicle) {
    res.status(404).json({ error: "Vehicle not found" });
    return;
  }

  // Best-effort: free each cascade-orphaned photo no longer referenced by any
  // surviving record. The owning rows are already gone, so this never blocks
  // the delete.
  await freeOrphanedPhotos(cascadePhotoPaths, objectStorageService, req.log);

  res.sendStatus(204);
});

type NhtsaResult = {
  Variable: string;
  Value: string | null;
};

router.get("/vin/:vin", async (req, res): Promise<void> => {
  const params = DecodeVinParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const vin = params.data.vin.trim();

  if (vinDecodeInFlight >= VIN_DECODE_MAX_CONCURRENT) {
    res.status(503).json({ error: "VIN decode service temporarily busy" });
    return;
  }

  vinDecodeInFlight++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIN_DECODE_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${encodeURIComponent(vin)}?format=json`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      res.status(502).json({ error: "VIN decode service unavailable" });
      return;
    }

    const payload = (await response.json()) as { Results?: NhtsaResult[] };
    const results = payload.Results ?? [];
    const get = (name: string): string | null => {
      const value = results.find((r) => r.Variable === name)?.Value;
      return value && value.trim() !== "" ? value : null;
    };

    const yearRaw = get("Model Year");
    const year = yearRaw ? Number.parseInt(yearRaw, 10) : null;

    res.json(
      DecodeVinResponse.parse({
        vin,
        year: Number.isFinite(year) ? year : null,
        make: get("Make"),
        model: get("Model"),
        trim: get("Trim"),
        engine: get("Displacement (L)")
          ? `${get("Displacement (L)")}L${get("Engine Number of Cylinders") ? ` ${get("Engine Number of Cylinders")}cyl` : ""}`
          : null,
        bodyClass: get("Body Class"),
      }),
    );
  } catch (err) {
    const isTimeout =
      err instanceof Error && err.name === "AbortError";
    req.log.error({ err }, isTimeout ? "VIN decode timed out" : "VIN decode failed");
    res
      .status(502)
      .json({
        error: isTimeout
          ? "VIN decode service timed out"
          : "VIN decode service unavailable",
      });
  } finally {
    clearTimeout(timer);
    vinDecodeInFlight--;
  }
});

export default router;
