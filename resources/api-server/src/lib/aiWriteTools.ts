import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  vehiclesTable,
  partsTable,
  stockMovementsTable,
  pricingMarkupTiersTable,
  workOrdersTable,
  workOrderLineItemsTable,
  appointmentsTable,
  estimatesTable,
  estimateLineItemsTable,
  inspectionsTable,
  inspectionItemsTable,
  inspectionTemplatesTable,
  inspectionTemplateItemsTable,
  messagesTable,
  shopSettingsTable,
} from "@workspace/db";
import { priceFromMatrix } from "./pricing";
import {
  CreateCustomerBody,
  UpdateCustomerBody,
  CreateVehicleBody,
  UpdateVehicleBody,
  CreatePartBody,
  UpdatePartBody,
  CreateWorkOrderBody,
  UpdateWorkOrderBody,
  CreateAppointmentBody,
  UpdateAppointmentBody,
  UpdateInspectionBody,
  CreateMessageBody,
} from "@workspace/api-zod";
import { resolveRecipient } from "./messaging";
import {
  markUploadLinked,
  ObjectStorageService,
  ObjectAclRebindingError,
} from "./objectStorage";
import type { AiToolDef } from "./aiTools";
import { customerDeleteBlocker, vehicleDeleteBlocker } from "./deleteGuards";
import {
  estimateNumber,
  invoiceNumber,
  normalizeLineItems,
  clearReorderDismissalsIfReplenished,
  loadCatalog,
  computeTotals,
  computeWorkOrderTotals,
  computePartDeductions,
  type CatalogPart,
} from "./billing";
import { matchCatalogPart, type MatchConfidence } from "./partMatch";
import { convertEstimateToInvoice } from "./estimateToInvoice";
import { convertEstimateToWorkOrder } from "./estimateToWorkOrder";
import { missingRef } from "./refs";
import { runLaborEstimate, type VehicleContext } from "./aiEstimating";
import { round2 } from "./ledger";

// Module-level storage service used for ACL policy stamping on inspection photos,
// mirroring the same instance pattern used in inspections.ts.
const objectStorageService = new ObjectStorageService();

// JSON-schema property helpers for the specs advertised to the model.
const str = (description: string) => ({ type: "string", description }) as const;
const int = (description: string) =>
  ({ type: "integer", description }) as const;
const num = (description: string) => ({ type: "number", description }) as const;

// argsSchema for an update/delete tool: a required integer id plus the generated
// partial body schema. The body schemas already strip unknown keys.
const withId = (body: z.ZodTypeAny): z.ZodTypeAny =>
  z.object({ id: z.number().int() }).and(body);
const idOnly = z.object({ id: z.number().int() });

// ---- label lookups for deterministic confirmation summaries -----------------

async function customerName(id: number): Promise<string> {
  const [c] = await db
    .select({ name: customersTable.name })
    .from(customersTable)
    .where(eq(customersTable.id, id));
  return c?.name ?? `#${id}`;
}

async function vehicleLabel(id: number): Promise<string> {
  const [v] = await db
    .select({
      year: vehiclesTable.year,
      make: vehiclesTable.make,
      model: vehiclesTable.model,
    })
    .from(vehiclesTable)
    .where(eq(vehiclesTable.id, id));
  if (!v) return `#${id}`;
  const label = [v.year, v.make, v.model].filter(Boolean).join(" ");
  return label || `#${id}`;
}

// Resolve a part's sell price from its cost using the markup matrix. Returns
// null when no tier applies (or cost is non-positive) so callers can leave the
// existing price untouched instead of overwriting it.
async function matrixPrice(cost: number): Promise<number | null> {
  const tiers = await db.select().from(pricingMarkupTiersTable);
  return priceFromMatrix(cost, tiers);
}

async function partName(id: number): Promise<string> {
  const [p] = await db
    .select({ name: partsTable.name })
    .from(partsTable)
    .where(eq(partsTable.id, id));
  return p?.name ?? `#${id}`;
}

async function workOrderTitle(id: number): Promise<string> {
  const [w] = await db
    .select({ title: workOrdersTable.title })
    .from(workOrdersTable)
    .where(eq(workOrdersTable.id, id));
  return w?.title ?? `#${id}`;
}

async function inspectionTitle(id: number): Promise<string> {
  const [i] = await db
    .select({ title: inspectionsTable.title })
    .from(inspectionsTable)
    .where(eq(inspectionsTable.id, id));
  return i?.title ?? `#${id}`;
}

async function inspectionTemplateName(id: number): Promise<string> {
  const [t] = await db
    .select({ name: inspectionTemplatesTable.name })
    .from(inspectionTemplatesTable)
    .where(eq(inspectionTemplatesTable.id, id));
  return t?.name ?? `#${id}`;
}

// Resolve a template item's name and the template it belongs to (for
// deterministic delete summaries that name both the item and its template).
async function inspectionTemplateItemInfo(
  id: number,
): Promise<{ name: string; templateId: number | null }> {
  const [it] = await db
    .select({
      name: inspectionTemplateItemsTable.name,
      templateId: inspectionTemplateItemsTable.templateId,
    })
    .from(inspectionTemplateItemsTable)
    .where(eq(inspectionTemplateItemsTable.id, id));
  return { name: it?.name ?? `#${id}`, templateId: it?.templateId ?? null };
}

// Resolve the estimate id a line item belongs to (for deterministic summaries
// that name the parent estimate, e.g. "EST-1003").
async function lineItemEstimateId(lineItemId: number): Promise<number | null> {
  const [li] = await db
    .select({ estimateId: estimateLineItemsTable.estimateId })
    .from(estimateLineItemsTable)
    .where(eq(estimateLineItemsTable.id, lineItemId));
  return li?.estimateId ?? null;
}

async function resolveCustomerName(
  customerId: number | null | undefined,
  provided: string | null | undefined,
): Promise<string | null> {
  if (provided) return provided;
  if (customerId) return customerName(customerId);
  return null;
}

// Fetch the shop's configured default labor rate (returns 0 when unset).
async function fetchDefaultLaborRate(): Promise<number> {
  const [s] = await db
    .select({ defaultLaborRate: shopSettingsTable.defaultLaborRate })
    .from(shopSettingsTable)
    .where(eq(shopSettingsTable.id, 1));
  return s?.defaultLaborRate ?? 0;
}

// Apply the shop default labor rate to any labor line item that has no explicit
// unit price set. Used by AI write tools so the model only has to supply hours.
function applyDefaultLaborRate<T extends { type?: string; unitPrice?: number }>(
  items: T[],
  rate: number,
): T[] {
  if (!rate || rate <= 0) return items;
  return items.map((li) =>
    (li.type === "labor" || li.type == null) && (li.unitPrice == null || li.unitPrice === 0)
      ? { ...li, unitPrice: rate }
      : li,
  );
}

// Drop the id key and return the remaining (validated) fields for an update set.
function updateFields<T extends Record<string, unknown>>(
  args: unknown,
): { id: number; rest: Omit<T, "id"> } {
  const { id, ...rest } = args as T & { id: number };
  return { id, rest: rest as Omit<T, "id"> };
}

// Build a human-readable list of every field that will be mutated so that
// confirmation prompts cannot hide what the model is actually about to change.
// String values are truncated to 120 chars to prevent injected text from
// burying the field list; null means the field will be cleared.
function formatChanges(rest: Record<string, unknown>): string {
  const entries = Object.entries(rest);
  if (entries.length === 0) return "(no changes)";
  return entries
    .map(([k, v]) => {
      let display: string;
      if (v === null || v === undefined) {
        display = "cleared";
      } else if (typeof v === "string") {
        const truncated = v.length > 120 ? v.slice(0, 120) + "…" : v;
        display = `"${truncated}"`;
      } else {
        display = String(v);
      }
      return `${k} → ${display}`;
    })
    .join(", ");
}

type CustomerInput = z.infer<typeof CreateCustomerBody>;
type VehicleInput = z.infer<typeof CreateVehicleBody>;
type PartInput = z.infer<typeof CreatePartBody>;
type WorkOrderInput = z.infer<typeof CreateWorkOrderBody>;
type AppointmentInput = z.infer<typeof CreateAppointmentBody>;

type EstimateLineItemInput = {
  type?: "labor" | "part" | "fee";
  description: string;
  quantity?: number;
  unitPrice?: number;
};
type EstimateInput = {
  customerId: number;
  vehicleId: number;
  workOrderId?: number | null;
  notes?: string | null;
  taxRate?: number;
  status?: "draft" | "sent" | "approved" | "declined";
  lineItems?: EstimateLineItemInput[];
};

// Build the AI estimator vehicle context from an estimate's vehicle.
async function estimateVehicleContext(
  vehicleId: number,
): Promise<VehicleContext> {
  const [v] = await db
    .select({
      year: vehiclesTable.year,
      make: vehiclesTable.make,
      model: vehiclesTable.model,
      engine: vehiclesTable.engine,
      mileage: vehiclesTable.mileage,
    })
    .from(vehiclesTable)
    .where(eq(vehiclesTable.id, vehicleId));
  return {
    vehicleYear: v?.year ?? null,
    vehicleMake: v?.make ?? null,
    vehicleModel: v?.model ?? null,
    vehicleEngine: v?.engine ?? null,
    mileage: v?.mileage ?? null,
  };
}

const baseWriteTools: AiToolDef[] = [
  // ---- customers ------------------------------------------------------------
  {
    name: "create_customer",
    description:
      "Create a new customer record. Requires the user to confirm before it runs.",
    kind: "write",
    requiredPermission: "customers",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: str("Customer's full name."),
        phone: str("Phone number."),
        email: str("Email address."),
        address: str("Mailing address."),
        notes: str("Freeform notes."),
      },
    },
    argsSchema: CreateCustomerBody,
    async execute(args) {
      const a = args as CustomerInput;
      const [created] = await db
        .insert(customersTable)
        .values({
          name: a.name,
          phone: a.phone ?? null,
          email: a.email ?? null,
          address: a.address ?? null,
          notes: a.notes ?? null,
        })
        .returning({ id: customersTable.id, name: customersTable.name });
      return { created };
    },
    async summarize(args) {
      const a = args as CustomerInput;
      const extra = a.phone ? ` with phone ${a.phone}` : "";
      return `add a new customer "${a.name}"${extra}`;
    },
  },
  {
    name: "update_customer",
    description:
      "Update fields on an existing customer. Look up the customer id first. Requires confirmation.",
    kind: "write",
    requiredPermission: "customers",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int("Customer id to update."),
        name: str("New name."),
        phone: str("New phone number."),
        email: str("New email address."),
        address: str("New mailing address."),
        notes: str("New notes."),
      },
    },
    argsSchema: withId(UpdateCustomerBody),
    async execute(args) {
      const { id, rest } = updateFields<z.infer<typeof UpdateCustomerBody>>(
        args,
      );
      if (Object.keys(rest).length === 0) {
        return { error: "No fields to update were provided." };
      }
      const [updated] = await db
        .update(customersTable)
        .set(rest)
        .where(eq(customersTable.id, id))
        .returning({ id: customersTable.id, name: customersTable.name });
      if (!updated) return { error: "No customer with that id." };
      return { updated };
    },
    async summarize(args) {
      const { id, rest } = updateFields(args);
      return `update the customer "${await customerName(id)}" (#${id}): set ${formatChanges(rest as Record<string, unknown>)}`;
    },
  },
  {
    name: "delete_customer",
    description:
      "Permanently delete a customer. Blocked if work orders, estimates, or invoices reference them. Always confirm with the user first.",
    kind: "write",
    requiredPermission: "customers",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: int("Customer id to delete.") },
    },
    argsSchema: idOnly,
    async execute(args) {
      const { id } = args as { id: number };
      const blocker = await customerDeleteBlocker(id);
      if (blocker) return { error: blocker };
      const [deleted] = await db
        .delete(customersTable)
        .where(eq(customersTable.id, id))
        .returning({ id: customersTable.id });
      if (!deleted) return { error: "No customer with that id." };
      return { deleted: true, id };
    },
    async summarize(args) {
      const { id } = args as { id: number };
      return `permanently delete the customer "${await customerName(id)}" (#${id})`;
    },
  },

  // ---- vehicles -------------------------------------------------------------
  {
    name: "create_vehicle",
    description:
      "Add a vehicle for a customer. Resolve the customer id first. Requires confirmation.",
    kind: "write",
    requiredPermission: "customers",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["customerId"],
      properties: {
        customerId: int("Owner customer id."),
        year: int("Model year."),
        make: str("Make, e.g. Toyota."),
        model: str("Model, e.g. Camry."),
        trim: str("Trim level."),
        vin: str("Vehicle identification number."),
        licensePlate: str("License plate."),
        color: str("Color."),
        mileage: int("Odometer reading."),
        engine: str("Engine description."),
        notes: str("Freeform notes."),
      },
    },
    argsSchema: CreateVehicleBody,
    async execute(args) {
      const a = args as VehicleInput;
      const [created] = await db
        .insert(vehiclesTable)
        .values({
          customerId: a.customerId,
          year: a.year ?? null,
          make: a.make ?? null,
          model: a.model ?? null,
          trim: a.trim ?? null,
          vin: a.vin ?? null,
          licensePlate: a.licensePlate ?? null,
          color: a.color ?? null,
          mileage: a.mileage ?? null,
          engine: a.engine ?? null,
          notes: a.notes ?? null,
        })
        .returning({ id: vehiclesTable.id });
      return { created };
    },
    async summarize(args) {
      const a = args as VehicleInput;
      const label = [a.year, a.make, a.model].filter(Boolean).join(" ") || "vehicle";
      return `add a ${label} for ${await customerName(a.customerId)}`;
    },
  },
  {
    name: "update_vehicle",
    description:
      "Update fields on an existing vehicle. Look up the vehicle id first. Requires confirmation.",
    kind: "write",
    requiredPermission: "customers",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int("Vehicle id to update."),
        customerId: int("New owner customer id."),
        year: int("Model year."),
        make: str("Make."),
        model: str("Model."),
        trim: str("Trim level."),
        vin: str("VIN."),
        licensePlate: str("License plate."),
        color: str("Color."),
        mileage: int("Odometer reading."),
        engine: str("Engine description."),
        notes: str("Notes."),
      },
    },
    argsSchema: withId(UpdateVehicleBody),
    async execute(args) {
      const { id, rest } = updateFields<z.infer<typeof UpdateVehicleBody>>(args);
      if (Object.keys(rest).length === 0) {
        return { error: "No fields to update were provided." };
      }
      const [updated] = await db
        .update(vehiclesTable)
        .set(rest)
        .where(eq(vehiclesTable.id, id))
        .returning({ id: vehiclesTable.id });
      if (!updated) return { error: "No vehicle with that id." };
      return { updated };
    },
    async summarize(args) {
      const { id, rest } = updateFields(args);
      return `update vehicle "${await vehicleLabel(id)}" (#${id}): set ${formatChanges(rest as Record<string, unknown>)}`;
    },
  },
  {
    name: "delete_vehicle",
    description:
      "Permanently delete a vehicle. Blocked if work orders, estimates, or invoices reference it. Always confirm first.",
    kind: "write",
    requiredPermission: "customers",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: int("Vehicle id to delete.") },
    },
    argsSchema: idOnly,
    async execute(args) {
      const { id } = args as { id: number };
      const blocker = await vehicleDeleteBlocker(id);
      if (blocker) return { error: blocker };
      const [deleted] = await db
        .delete(vehiclesTable)
        .where(eq(vehiclesTable.id, id))
        .returning({ id: vehiclesTable.id });
      if (!deleted) return { error: "No vehicle with that id." };
      return { deleted: true, id };
    },
    async summarize(args) {
      const { id } = args as { id: number };
      return `permanently delete the vehicle "${await vehicleLabel(id)}" (#${id})`;
    },
  },

  // ---- parts / inventory ----------------------------------------------------
  {
    name: "create_part",
    description: "Add a new inventory part. Requires confirmation.",
    kind: "write",
    requiredPermission: "inventory",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: str("Part name."),
        sku: str("Stock-keeping unit / part number."),
        category: str("Category."),
        vendor: str("Vendor / supplier."),
        location: str("Bin or shelf location."),
        quantityOnHand: num("Quantity currently in stock."),
        reorderLevel: num("Reorder threshold."),
        unitCost: num("Cost per unit."),
        unitPrice: num("Sale price per unit."),
        notes: str("Freeform notes."),
      },
    },
    argsSchema: CreatePartBody,
    async execute(args) {
      const a = args as PartInput;
      const cost = a.unitCost ?? 0;
      // Apply the pricing matrix when the model gives a cost but no explicit
      // price; fall back to 0 when no tier matches (new part, nothing to erase).
      const unitPrice = a.unitPrice ?? (await matrixPrice(cost)) ?? 0;
      const [created] = await db
        .insert(partsTable)
        .values({
          name: a.name,
          sku: a.sku ?? null,
          category: a.category ?? null,
          vendor: a.vendor ?? null,
          location: a.location ?? null,
          quantityOnHand: a.quantityOnHand ?? 0,
          reorderLevel: a.reorderLevel ?? 0,
          unitCost: cost,
          unitPrice,
          notes: a.notes ?? null,
        })
        .returning({ id: partsTable.id, name: partsTable.name });
      return { created };
    },
    async summarize(args) {
      const a = args as PartInput;
      const qty =
        a.quantityOnHand !== undefined && a.quantityOnHand !== null
          ? ` with ${a.quantityOnHand} in stock`
          : "";
      return `add a new part "${a.name}"${qty}`;
    },
  },
  {
    name: "update_part",
    description:
      "Update fields on an existing part, including adjusting stock levels. Look up the part id first. Requires confirmation.",
    kind: "write",
    requiredPermission: "inventory",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int("Part id to update."),
        name: str("New name."),
        sku: str("New SKU."),
        category: str("New category."),
        vendor: str("New vendor."),
        location: str("New location."),
        quantityOnHand: num("New quantity in stock."),
        reorderLevel: num("New reorder threshold."),
        unitCost: num("New unit cost."),
        unitPrice: num("New unit price."),
        notes: str("New notes."),
      },
    },
    argsSchema: withId(UpdatePartBody),
    async execute(args, ctx) {
      const { id, rest } = updateFields<z.infer<typeof UpdatePartBody>>(args);
      if (Object.keys(rest).length === 0) {
        return { error: "No fields to update were provided." };
      }
      // If a new cost is set without an explicit new price, re-derive the sell
      // price from the markup matrix. Leave the existing price untouched when no
      // tier matches (matrixPrice returns null) rather than zeroing it out.
      if (rest.unitCost !== undefined && rest.unitCost !== null && rest.unitPrice === undefined) {
        const derived = await matrixPrice(rest.unitCost);
        if (derived !== null) rest.unitPrice = derived;
      }
      const updated = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(partsTable)
          .where(eq(partsTable.id, id));
        if (!existing) return null;

        const [row] = await tx
          .update(partsTable)
          .set(rest)
          .where(eq(partsTable.id, id))
          .returning({ id: partsTable.id, name: partsTable.name });

        // Mirror the manual-edit and PO-receive paths: any change to a part's
        // on-hand count must write a stock_movements row in the same
        // transaction so the AI path can't change stock without an audit trail.
        if (
          rest.quantityOnHand !== undefined &&
          rest.quantityOnHand !== null &&
          rest.quantityOnHand !== existing.quantityOnHand
        ) {
          await tx.insert(stockMovementsTable).values({
            partId: id,
            delta: rest.quantityOnHand - existing.quantityOnHand,
            reason: "AI assistant adjustment",
            createdByUserId: ctx.userId,
          });

          // Restocking above the reorder level ends the prior low-stock
          // episode, so clear any stale reorder-banner dismissals for it.
          await clearReorderDismissalsIfReplenished(id, tx);
        }

        return row;
      });
      if (!updated) return { error: "No part with that id." };
      return { updated };
    },
    async summarize(args) {
      const { id, rest } = updateFields<z.infer<typeof UpdatePartBody>>(args);
      // Mirror the same unitPrice derivation that execute() applies so the
      // confirmation text discloses every field that will actually be written.
      const effectiveRest: Record<string, unknown> = { ...rest };
      if (
        rest.unitCost !== undefined &&
        rest.unitCost !== null &&
        rest.unitPrice === undefined
      ) {
        const derived = await matrixPrice(rest.unitCost);
        if (derived !== null) effectiveRest.unitPrice = derived;
      }
      return `update the part "${await partName(id)}" (#${id}): set ${formatChanges(effectiveRest)}`;
    },
  },
  {
    name: "delete_part",
    description: "Permanently delete an inventory part. Always confirm first.",
    kind: "write",
    requiredPermission: "inventory",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: int("Part id to delete.") },
    },
    argsSchema: idOnly,
    async execute(args, ctx) {
      const { id } = args as { id: number };
      const deleted = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(partsTable)
          .where(eq(partsTable.id, id));
        if (!existing) return null;

        // Record the deletion in the append-only ledger BEFORE removing the
        // part so the part's prior on-hand count and acting user aren't lost.
        // The movement's partId FK is ON DELETE SET NULL, so this row survives
        // the delete below; the part's name/SKU are snapshotted inline so the
        // audit log keeps a human-readable identity after the row is gone.
        await tx.insert(stockMovementsTable).values({
          partId: id,
          partName: existing.name,
          partSku: existing.sku,
          delta: -existing.quantityOnHand,
          reason: "Part deleted",
          createdByUserId: ctx.userId,
        });

        const [row] = await tx
          .delete(partsTable)
          .where(eq(partsTable.id, id))
          .returning({ id: partsTable.id });
        return row ?? null;
      });
      if (!deleted) return { error: "No part with that id." };
      return { deleted: true, id };
    },
    async summarize(args) {
      const { id } = args as { id: number };
      return `permanently delete the part "${await partName(id)}" (#${id})`;
    },
  },

  // ---- work orders ----------------------------------------------------------
  {
    name: "create_work_order",
    description:
      "Create a work order for a customer's vehicle. Resolve the customer id and vehicle id first. Requires confirmation.",
    kind: "write",
    requiredPermission: "workOrders",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["customerId", "vehicleId", "title"],
      properties: {
        customerId: int("Customer id."),
        vehicleId: int("Vehicle id."),
        assignedMechanicId: int("Mechanic id to assign, if any."),
        title: str("Short title for the work order."),
        description: str("Detailed description of the work."),
        status: {
          type: "string",
          enum: ["open", "in_progress", "awaiting_parts", "completed", "invoiced"],
          description: "Initial status; defaults to open.",
        },
        complaint: str("Customer's reported complaint."),
        notes: str("Internal notes."),
      },
    },
    argsSchema: CreateWorkOrderBody,
    async execute(args, ctx) {
      const a = args as WorkOrderInput;
      const canReadCustomers = ctx.isAdmin || ctx.permissions.includes("customers");
      const canReadPayroll = ctx.isAdmin || ctx.permissions.includes("payroll");
      if (a.customerId != null && !canReadCustomers) {
        return { error: "You do not have permission to link to a customer record" };
      }
      if (a.vehicleId != null && !canReadCustomers) {
        return { error: "You do not have permission to link to a vehicle record" };
      }
      if (a.assignedMechanicId != null && !canReadPayroll) {
        return { error: "You do not have permission to assign a mechanic" };
      }

      // Relational consistency: the vehicle must belong to the specified customer,
      // mirroring the same check enforced by the POST /work-orders REST route.
      if (a.vehicleId != null && a.customerId != null) {
        const [v] = await db
          .select({ id: vehiclesTable.id })
          .from(vehiclesTable)
          .where(and(eq(vehiclesTable.id, a.vehicleId), eq(vehiclesTable.customerId, a.customerId)));
        if (!v) return { error: "Vehicle does not belong to the specified customer" };
      }

      const [created] = await db
        .insert(workOrdersTable)
        .values({
          customerId: a.customerId,
          vehicleId: a.vehicleId,
          assignedMechanicId: a.assignedMechanicId ?? null,
          title: a.title,
          description: a.description ?? null,
          status: a.status ?? "open",
          complaint: a.complaint ?? null,
          notes: a.notes ?? null,
        })
        .returning({ id: workOrdersTable.id, title: workOrdersTable.title });
      return { created };
    },
    async summarize(args, ctx) {
      const a = args as WorkOrderInput;
      const canReadCustomers =
        ctx.isAdmin || ctx.permissions.includes("customers");
      const cn = canReadCustomers
        ? await customerName(a.customerId)
        : `#${a.customerId}`;
      const vl = canReadCustomers
        ? await vehicleLabel(a.vehicleId)
        : `#${a.vehicleId}`;
      return `create a work order "${a.title}" for ${cn}'s ${vl}`;
    },
  },
  {
    name: "update_work_order",
    description:
      "Update an existing work order, e.g. change its status or assigned mechanic. Look up the work order id first. Requires confirmation.",
    kind: "write",
    requiredPermission: "workOrders",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int("Work order id to update."),
        assignedMechanicId: int("Mechanic id to assign."),
        title: str("New title."),
        description: str("New description."),
        status: {
          type: "string",
          enum: ["open", "in_progress", "awaiting_parts", "completed", "invoiced"],
          description: "New status.",
        },
        complaint: str("Updated complaint."),
        notes: str("Updated notes."),
        completedAt: str("Completion timestamp, ISO 8601."),
      },
    },
    argsSchema: withId(UpdateWorkOrderBody),
    async execute(args, ctx) {
      const { id, rest } = updateFields<z.infer<typeof UpdateWorkOrderBody>>(
        args,
      );
      if (Object.keys(rest).length === 0) {
        return { error: "No fields to update were provided." };
      }
      const canReadPayroll = ctx.isAdmin || ctx.permissions.includes("payroll");
      if (rest.assignedMechanicId != null && !canReadPayroll) {
        return { error: "You do not have permission to assign a mechanic" };
      }
      const [updated] = await db
        .update(workOrdersTable)
        .set(rest)
        .where(eq(workOrdersTable.id, id))
        .returning({ id: workOrdersTable.id, status: workOrdersTable.status });
      if (!updated) return { error: "No work order with that id." };
      return { updated };
    },
    async summarize(args) {
      const { id, rest } = updateFields(args);
      return `update work order "${await workOrderTitle(id)}" (#${id}): set ${formatChanges(rest as Record<string, unknown>)}`;
    },
  },
  {
    name: "delete_work_order",
    description: "Permanently delete a work order. Always confirm first.",
    kind: "write",
    requiredPermission: "workOrders",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: int("Work order id to delete.") },
    },
    argsSchema: idOnly,
    async execute(args, ctx) {
      const { id } = args as { id: number };

      // Before acquiring any locks, check whether this work order has already
      // deducted inventory stock. Reversing that deduction is a canonical
      // inventory mutation; the caller must hold the inventory permission —
      // the same guard enforced by the DELETE /work-orders/:id REST route.
      const [preDelete] = await db
        .select({ stockDeducted: workOrdersTable.stockDeducted })
        .from(workOrdersTable)
        .where(eq(workOrdersTable.id, id));
      if (!preDelete) return { error: "No work order with that id." };

      if (preDelete.stockDeducted) {
        const canInventory = ctx.isAdmin || ctx.permissions.includes("inventory");
        if (!canInventory) {
          return { error: "You do not have permission to delete a work order that has deducted inventory stock" };
        }
      }

      const deleted = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(workOrdersTable)
          .where(eq(workOrdersTable.id, id));
        if (!existing) return null;

        // Restore any stock this work order had deducted before its line items
        // cascade away, recording the reversal in the movement ledger so the
        // audit trail stays consistent with the on-hand counts.
        if (existing.stockDeducted) {
          const oldItems = await tx
            .select()
            .from(workOrderLineItemsTable)
            .where(eq(workOrderLineItemsTable.workOrderId, id));
          const catalog = await loadCatalog();
          for (const [partId, qty] of computePartDeductions(oldItems, catalog)) {
            if (qty === 0) continue;
            await tx
              .update(partsTable)
              .set({ quantityOnHand: sql`${partsTable.quantityOnHand} + ${qty}` })
              .where(eq(partsTable.id, partId));
            await tx.insert(stockMovementsTable).values({
              partId,
              delta: qty,
              reason: "Work order deleted",
              sourceType: "work_order",
              sourceId: id,
              createdByUserId: ctx.userId,
            });
          }
        }

        await tx.delete(workOrdersTable).where(eq(workOrdersTable.id, id));
        return existing;
      });

      if (!deleted) return { error: "No work order with that id." };
      return { deleted: true, id };
    },
    async summarize(args) {
      const { id } = args as { id: number };
      return `permanently delete work order "${await workOrderTitle(id)}" (#${id})`;
    },
  },
  {
    name: "duplicate_work_order",
    description:
      "Duplicate an entire work order at once: create a brand-new work order that copies the source work order's title, description, complaint, notes, and ALL of its line items (labor/part/fee, with quantity and unit price), leaving the source untouched. Resolve the source work order id first (use find_work_orders). Optionally re-target the copy to a different customer and vehicle by passing customerId and vehicleId (resolve them first); when omitted the copy keeps the source's customer and vehicle. The new work order starts in the open status and is left unassigned. Use this to clone a recurring job (\"same work order as last time, new vehicle\") without re-dictating every line. Requires the customers module too because it links a customer record. Requires confirmation.",
    kind: "write",
    requiredPermission: "workOrders",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int("Source work order id to duplicate. Resolve it with find_work_orders first."),
        customerId: int(
          "Optional. New customer id to re-target the copy to; defaults to the source work order's customer.",
        ),
        vehicleId: int(
          "Optional. New vehicle id to re-target the copy to; defaults to the source work order's vehicle.",
        ),
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      customerId: z.number().int().nullish(),
      vehicleId: z.number().int().nullish(),
    }),
    async execute(args, ctx) {
      const a = args as {
        id: number;
        customerId?: number | null;
        vehicleId?: number | null;
      };
      // Duplicating links a customer/vehicle record, so it requires the
      // customers module the same way create_work_order does (cross-module gate
      // on top of the workOrders requiredPermission).
      const canReadCustomers =
        ctx.isAdmin || ctx.permissions.includes("customers");
      if (!canReadCustomers) {
        return { error: "You do not have permission to link to a customer record" };
      }
      const [source] = await db
        .select({
          customerId: workOrdersTable.customerId,
          vehicleId: workOrdersTable.vehicleId,
          title: workOrdersTable.title,
          description: workOrdersTable.description,
          complaint: workOrdersTable.complaint,
          notes: workOrdersTable.notes,
        })
        .from(workOrdersTable)
        .where(eq(workOrdersTable.id, a.id));
      if (!source) return { error: "No work order with that id." };

      const targetCustomerId = a.customerId ?? source.customerId;
      const targetVehicleId = a.vehicleId ?? source.vehicleId;
      const refError =
        (await missingRef(customersTable, targetCustomerId, "Customer")) ??
        (await missingRef(vehiclesTable, targetVehicleId, "Vehicle"));
      if (refError) return { error: refError };

      // Relational consistency: the target vehicle must belong to the target
      // customer, mirroring the same check enforced by the POST /work-orders route.
      if (targetVehicleId != null && targetCustomerId != null) {
        const [v] = await db
          .select({ id: vehiclesTable.id })
          .from(vehiclesTable)
          .where(and(eq(vehiclesTable.id, targetVehicleId), eq(vehiclesTable.customerId, targetCustomerId)));
        if (!v) return { error: "Vehicle does not belong to the specified customer" };
      }

      // Read the source line items, create the copy, and seed its line items in
      // one transaction so a partial failure can't leave a half-populated
      // duplicate. The source rows are only read, never modified.
      const result = await db.transaction(async (tx) => {
        const items = await tx
          .select({
            type: workOrderLineItemsTable.type,
            description: workOrderLineItemsTable.description,
            quantity: workOrderLineItemsTable.quantity,
            unitPrice: workOrderLineItemsTable.unitPrice,
            catalogPartId: workOrderLineItemsTable.catalogPartId,
          })
          .from(workOrderLineItemsTable)
          .where(eq(workOrderLineItemsTable.workOrderId, a.id))
          .orderBy(workOrderLineItemsTable.id);
        const [created] = await tx
          .insert(workOrdersTable)
          .values({
            customerId: targetCustomerId,
            vehicleId: targetVehicleId,
            title: source.title,
            description: source.description,
            status: "open",
            complaint: source.complaint,
            notes: source.notes,
          })
          .returning({ id: workOrdersTable.id });
        if (items.length) {
          await tx
            .insert(workOrderLineItemsTable)
            .values(items.map((li) => ({ ...li, workOrderId: created.id })));
        }
        return { created, items };
      });

      const totals = computeWorkOrderTotals(result.items);
      return {
        created: { id: result.created.id, title: source.title },
        lineItemsCopied: result.items.length,
        total: totals.total,
      };
    },
    async summarize(args, ctx) {
      const a = args as {
        id: number;
        customerId?: number | null;
        vehicleId?: number | null;
      };
      const title = await workOrderTitle(a.id);
      const [row] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(workOrderLineItemsTable)
        .where(eq(workOrderLineItemsTable.workOrderId, a.id));
      const count = row?.value ?? 0;
      const plural = count === 1 ? "item" : "items";
      const canReadCustomers =
        ctx.isAdmin || ctx.permissions.includes("customers");
      let retarget = "";
      if (a.customerId != null || a.vehicleId != null) {
        const who =
          a.customerId != null
            ? canReadCustomers
              ? await customerName(a.customerId)
              : `#${a.customerId}`
            : null;
        const veh =
          a.vehicleId != null
            ? canReadCustomers
              ? await vehicleLabel(a.vehicleId)
              : `#${a.vehicleId}`
            : null;
        const target = [who, veh].filter(Boolean).join("'s ");
        retarget = target ? ` for ${target}` : "";
      }
      return `duplicate work order "${title}" (#${a.id}) as a new open work order copying all ${count} line ${plural}${retarget}`;
    },
  },

  // ---- inspections ----------------------------------------------------------
  {
    name: "create_inspection",
    description:
      "Start a new digital vehicle inspection for a vehicle. Resolve the vehicle id (and customer id, if known) first. By default the inspection starts empty and in progress; add checklist items afterwards with add_inspection_item. Optionally pass a templateId to pre-fill the checklist from a saved inspection template (resolve the id from a spoken template name with find_inspection_templates first) — seeding from a template additionally requires the settings module. Requires confirmation. Also requires the customers module permission because it links a vehicle record.",
    kind: "write",
    requiredPermission: "inspections",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["vehicleId"],
      properties: {
        vehicleId: int("Vehicle id to inspect."),
        customerId: int("Owning customer id, if known."),
        workOrderId: int("Work order id to link the inspection to, if any."),
        inspectorId: int("Mechanic id performing the inspection, if any."),
        templateId: int(
          "Inspection template id to seed the checklist items from, if any. Resolve it with find_inspection_templates first.",
        ),
        title: str('Inspection title; defaults to the template name (when seeding) or "Vehicle Inspection".'),
        notes: str("Inspection notes."),
      },
    },
    argsSchema: z.object({
      vehicleId: z.number().int(),
      customerId: z.number().int().nullish(),
      workOrderId: z.number().int().nullish(),
      inspectorId: z.number().int().nullish(),
      templateId: z.number().int().nullish(),
      title: z.string().nullish(),
      notes: z.string().nullish(),
    }),
    async execute(args, ctx) {
      const a = args as {
        vehicleId: number;
        customerId?: number | null;
        workOrderId?: number | null;
        inspectorId?: number | null;
        templateId?: number | null;
        title?: string | null;
        notes?: string | null;
      };
      const canReadCustomers =
        ctx.isAdmin || ctx.permissions.includes("customers");
      const canReadPayroll = ctx.isAdmin || ctx.permissions.includes("payroll");
      const canApplyTemplates =
        ctx.isAdmin || ctx.permissions.includes("settings");
      // vehicleId is mandatory and links a vehicle record, so creating an
      // inspection always requires the customers module (mirrors POST /inspections).
      if (!canReadCustomers) {
        return {
          error: "You do not have permission to link to a vehicle record",
        };
      }
      if (a.inspectorId != null && !canReadPayroll) {
        return { error: "You do not have permission to assign an inspector" };
      }

      let title = a.title ?? null;
      const templateId = a.templateId ?? null;
      let templateItems: {
        category: string | null;
        name: string;
        sortOrder: number;
      }[] = [];

      if (templateId != null) {
        // Seeding from a template copies settings-module data (template name and
        // items) into the inspection, so require the settings module here —
        // mirrors POST /inspections and fails closed when it is missing.
        if (!canApplyTemplates) {
          return {
            error: "You do not have permission to apply inspection templates",
          };
        }
        const [template] = await db
          .select()
          .from(inspectionTemplatesTable)
          .where(eq(inspectionTemplatesTable.id, templateId));
        if (!template) return { error: "No template with that id." };
        if (!title) title = template.name;
        templateItems = await db
          .select({
            category: inspectionTemplateItemsTable.category,
            name: inspectionTemplateItemsTable.name,
            sortOrder: inspectionTemplateItemsTable.sortOrder,
          })
          .from(inspectionTemplateItemsTable)
          .where(eq(inspectionTemplateItemsTable.templateId, templateId))
          .orderBy(
            inspectionTemplateItemsTable.sortOrder,
            inspectionTemplateItemsTable.id,
          );
      }

      const [created] = await db
        .insert(inspectionsTable)
        .values({
          vehicleId: a.vehicleId,
          customerId: a.customerId ?? null,
          workOrderId: a.workOrderId ?? null,
          templateId,
          inspectorId: a.inspectorId ?? null,
          title: title ?? "Vehicle Inspection",
          notes: a.notes ?? null,
          status: "in_progress",
        })
        .returning({ id: inspectionsTable.id, title: inspectionsTable.title });

      if (templateItems.length) {
        await db.insert(inspectionItemsTable).values(
          templateItems.map((ti) => ({
            inspectionId: created.id,
            category: ti.category,
            name: ti.name,
            condition: "pass",
            sortOrder: ti.sortOrder,
          })),
        );
      }

      return { created };
    },
    async summarize(args, ctx) {
      const a = args as {
        vehicleId: number;
        templateId?: number | null;
        title?: string | null;
      };
      const canReadCustomers =
        ctx.isAdmin || ctx.permissions.includes("customers");
      const vl = canReadCustomers
        ? await vehicleLabel(a.vehicleId)
        : `#${a.vehicleId}`;
      let fromTemplate = "";
      if (a.templateId != null) {
        const canApplyTemplates =
          ctx.isAdmin || ctx.permissions.includes("settings");
        const name = canApplyTemplates
          ? await inspectionTemplateName(a.templateId)
          : `#${a.templateId}`;
        fromTemplate = ` pre-filled from the "${name}" template`;
      }
      const t = a.title ?? "Vehicle Inspection";
      return `start a "${t}" inspection for ${vl}${fromTemplate}`;
    },
  },
  {
    name: "update_inspection",
    description:
      "Update an existing inspection: rename it, change its notes, set the inspector, or mark it completed or back to in progress. Look up the inspection id first. Requires confirmation.",
    kind: "write",
    requiredPermission: "inspections",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int("Inspection id to update."),
        title: str("New title."),
        status: {
          type: "string",
          enum: ["in_progress", "completed"],
          description: "New status.",
        },
        notes: str("Updated notes."),
        inspectorId: int("Mechanic id to assign as inspector."),
      },
    },
    argsSchema: withId(UpdateInspectionBody),
    async execute(args, ctx) {
      const { id, rest } = updateFields<z.infer<typeof UpdateInspectionBody>>(
        args,
      );
      if (Object.keys(rest).length === 0) {
        return { error: "No fields to update were provided." };
      }
      const canReadPayroll = ctx.isAdmin || ctx.permissions.includes("payroll");
      if (rest.inspectorId != null && !canReadPayroll) {
        return { error: "You do not have permission to assign an inspector" };
      }
      const [existing] = await db
        .select({ status: inspectionsTable.status })
        .from(inspectionsTable)
        .where(eq(inspectionsTable.id, id));
      if (!existing) return { error: "No inspection with that id." };
      const updates: Partial<typeof inspectionsTable.$inferInsert> = {};
      if (rest.title !== undefined) updates.title = rest.title;
      if (rest.notes !== undefined) updates.notes = rest.notes;
      if (rest.inspectorId !== undefined) updates.inspectorId = rest.inspectorId;
      if (rest.status !== undefined) {
        updates.status = rest.status;
        if (rest.status === "completed") {
          // Stamp completedAt only on the first transition into completed.
          if (existing.status !== "completed") {
            updates.completedAt = new Date().toISOString();
          }
        } else {
          updates.completedAt = null;
        }
      }
      const [updated] = await db
        .update(inspectionsTable)
        .set(updates)
        .where(eq(inspectionsTable.id, id))
        .returning({
          id: inspectionsTable.id,
          status: inspectionsTable.status,
        });
      return { updated };
    },
    async summarize(args) {
      const { id, rest } = updateFields(args);
      return `update inspection "${await inspectionTitle(id)}" (#${id}): set ${formatChanges(rest as Record<string, unknown>)}`;
    },
  },
  {
    name: "add_inspection_item",
    description:
      "Add a checklist item to an existing inspection, recording its condition (pass, attention, fail, or na) and optional notes. Look up the inspection id first. If the user attached photos to the message, attach the relevant ones by listing their numbers in photoRefs. Requires confirmation.",
    kind: "write",
    requiredPermission: "inspections",
    attachesPhotos: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["inspectionId", "name"],
      properties: {
        inspectionId: int("Inspection id to add the item to."),
        name: str('What is being checked, e.g. "Front brake pads".'),
        category: str('Optional grouping, e.g. "Brakes".'),
        condition: {
          type: "string",
          enum: ["pass", "attention", "fail", "na"],
          description: "Condition rating; defaults to pass.",
        },
        notes: str("Notes about the item's condition."),
        sortOrder: int("Display order within the inspection."),
        photoRefs: {
          type: "array",
          items: { type: "integer" },
          description:
            "1-based numbers of the photos attached to this message to attach to the item. Only use the numbers the system told you are available.",
        },
      },
    },
    argsSchema: z.object({
      inspectionId: z.number().int(),
      name: z.string().min(1),
      category: z.string().nullish(),
      condition: z.enum(["pass", "attention", "fail", "na"]).optional(),
      notes: z.string().nullish(),
      sortOrder: z.number().int().optional(),
      // photoRefs is the model-facing input; photoUrls is the server-resolved
      // result that survives the confirm-time re-parse. The agent loop replaces
      // photoRefs with verified photoUrls before staging.
      photoRefs: z.array(z.number().int()).optional(),
      photoUrls: z.array(z.string()).optional(),
    }),
    async execute(args, ctx) {
      const a = args as {
        inspectionId: number;
        name: string;
        category?: string | null;
        condition?: "pass" | "attention" | "fail" | "na";
        notes?: string | null;
        sortOrder?: number;
        photoUrls?: string[];
      };
      const [insp] = await db
        .select({ id: inspectionsTable.id })
        .from(inspectionsTable)
        .where(eq(inspectionsTable.id, a.inspectionId));
      if (!insp) return { error: "No inspection with that id." };
      const photoUrls = a.photoUrls ?? [];
      // Stamp the module binding for each photo — mirrors verifyPhotoUrlOwnership
      // in inspections.ts. This prevents a work-order photo from being re-linked
      // into inspections (cross-module access escalation) and ensures any user
      // with only the inspections permission cannot read an unrelated module's
      // file via the inspection storage route.
      for (const url of photoUrls) {
        try {
          await objectStorageService.trySetObjectEntityAclPolicy(url, {
            owner: String(ctx.userId),
            visibility: "private",
            sourceModule: "inspections",
          });
        } catch (e) {
          if (e instanceof ObjectAclRebindingError) {
            return { error: "One or more photos are already assigned to a different module and cannot be attached here." };
          }
          return { error: "Unable to verify file module assignment; please try again." };
        }
      }
      const [created] = await db
        .insert(inspectionItemsTable)
        .values({
          inspectionId: a.inspectionId,
          category: a.category ?? null,
          name: a.name,
          condition: a.condition ?? "pass",
          notes: a.notes ?? null,
          sortOrder: a.sortOrder ?? 0,
          photoUrls,
        })
        .returning({
          id: inspectionItemsTable.id,
          name: inspectionItemsTable.name,
        });
      // Pin the linked blobs so the orphan sweep never reclaims them.
      for (const url of photoUrls) markUploadLinked(url);
      return { created };
    },
    async summarize(args) {
      const a = args as {
        inspectionId: number;
        name: string;
        condition?: string;
        photoUrls?: string[];
      };
      const cond = a.condition ?? "pass";
      const n = a.photoUrls?.length ?? 0;
      const photoNote = n > 0 ? ` with ${n} photo${n === 1 ? "" : "s"}` : "";
      return `add item "${a.name}" (${cond})${photoNote} to inspection "${await inspectionTitle(a.inspectionId)}" (#${a.inspectionId})`;
    },
  },
  {
    name: "update_inspection_item",
    description:
      "Update a checklist item on an inspection — change its condition (pass, attention, fail, or na) or its notes, and/or attach photos. Look up the inspection and item ids first. If the user attached photos to the message, attach the relevant ones by listing their numbers in photoRefs (they are added to any photos already on the item). Requires confirmation.",
    kind: "write",
    requiredPermission: "inspections",
    attachesPhotos: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["inspectionId", "itemId"],
      properties: {
        inspectionId: int("Inspection id the item belongs to."),
        itemId: int("Inspection item id to update."),
        condition: {
          type: "string",
          enum: ["pass", "attention", "fail", "na"],
          description: "New condition rating.",
        },
        notes: str("Updated notes."),
        photoRefs: {
          type: "array",
          items: { type: "integer" },
          description:
            "1-based numbers of the photos attached to this message to add to the item. Only use the numbers the system told you are available.",
        },
      },
    },
    argsSchema: z.object({
      inspectionId: z.number().int(),
      itemId: z.number().int(),
      condition: z.enum(["pass", "attention", "fail", "na"]).optional(),
      notes: z.string().nullish(),
      // photoRefs is model-facing; photoUrls is the server-resolved result that
      // survives the confirm-time re-parse. The agent loop replaces photoRefs
      // with verified photoUrls before staging.
      photoRefs: z.array(z.number().int()).optional(),
      photoUrls: z.array(z.string()).optional(),
    }),
    async execute(args, ctx) {
      const a = args as {
        inspectionId: number;
        itemId: number;
        condition?: "pass" | "attention" | "fail" | "na";
        notes?: string | null;
        photoUrls?: string[];
      };
      // Scope the item to its inspection so a guessed itemId cannot reach an
      // item under a different inspection.
      const [item] = await db
        .select({
          id: inspectionItemsTable.id,
          photoUrls: inspectionItemsTable.photoUrls,
        })
        .from(inspectionItemsTable)
        .where(
          and(
            eq(inspectionItemsTable.id, a.itemId),
            eq(inspectionItemsTable.inspectionId, a.inspectionId),
          ),
        );
      if (!item) return { error: "No inspection item with that id." };
      const updates: Partial<typeof inspectionItemsTable.$inferInsert> = {};
      if (a.condition !== undefined) updates.condition = a.condition;
      if (a.notes !== undefined) updates.notes = a.notes;
      const newPhotos = a.photoUrls ?? [];
      // Stamp the module binding for each newly-added photo — mirrors
      // verifyPhotoUrlOwnership in inspections.ts. Already-linked photos (those
      // already in item.photoUrls) are skipped by trySetObjectEntityAclPolicy
      // as an idempotent re-registration (same sourceModule → no-op).
      const existingSet = new Set(item.photoUrls ?? []);
      for (const url of newPhotos) {
        if (existingSet.has(url)) continue; // already on this item — no rebind risk
        try {
          await objectStorageService.trySetObjectEntityAclPolicy(url, {
            owner: String(ctx.userId),
            visibility: "private",
            sourceModule: "inspections",
          });
        } catch (e) {
          if (e instanceof ObjectAclRebindingError) {
            return { error: "One or more photos are already assigned to a different module and cannot be attached here." };
          }
          return { error: "Unable to verify file module assignment; please try again." };
        }
      }
      if (newPhotos.length > 0) {
        // Append to (not replace) the photos already on the item.
        updates.photoUrls = [...new Set([...(item.photoUrls ?? []), ...newPhotos])];
      }
      if (Object.keys(updates).length === 0) {
        return { error: "No fields to update were provided." };
      }
      const [updated] = await db
        .update(inspectionItemsTable)
        .set(updates)
        .where(eq(inspectionItemsTable.id, a.itemId))
        .returning({
          id: inspectionItemsTable.id,
          condition: inspectionItemsTable.condition,
        });
      // Pin the linked blobs so the orphan sweep never reclaims them.
      for (const url of newPhotos) markUploadLinked(url);
      return { updated };
    },
    async summarize(args) {
      const a = args as {
        inspectionId: number;
        itemId: number;
        condition?: string;
        notes?: string | null;
        photoUrls?: string[];
      };
      const changes: string[] = [];
      if (a.condition !== undefined) changes.push(`condition → ${a.condition}`);
      if (a.notes !== undefined)
        changes.push(
          `notes → ${a.notes === null ? "cleared" : `"${a.notes}"`}`,
        );
      const n = a.photoUrls?.length ?? 0;
      if (n > 0) changes.push(`add ${n} photo${n === 1 ? "" : "s"}`);
      const summary = changes.length ? changes.join(", ") : "(no changes)";
      return `update item #${a.itemId} on inspection "${await inspectionTitle(a.inspectionId)}" (#${a.inspectionId}): set ${summary}`;
    },
  },

  // ---- inspection templates -------------------------------------------------
  {
    name: "create_inspection_template",
    description:
      'Save a reusable inspection checklist template (e.g. "Standard 21-point", "Pre-delivery") so it can later seed new inspections. Provide a name, an optional description, and the checklist items — either as an explicit list, or captured from an existing inspection by passing fromInspectionId (resolve the inspection id first), or both. Requires the settings module because templates are settings-gated. Capturing items from an existing inspection additionally requires the inspections module. Requires confirmation.',
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: str('Template name, e.g. "Standard 21-point".'),
        description: str("Optional description of what the template covers."),
        fromInspectionId: int(
          "Existing inspection id to capture the current checklist items from, if any. Resolve the inspection id first.",
        ),
        items: {
          type: "array",
          description:
            "Explicit checklist items to include, in order. Appended after any items captured from fromInspectionId.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: str('Checklist item name, e.g. "Check tire tread".'),
              category: str('Optional grouping category, e.g. "Brakes".'),
            },
          },
        },
      },
    },
    argsSchema: z.object({
      name: z.string().trim().min(1),
      description: z.string().nullish(),
      fromInspectionId: z.number().int().nullish(),
      items: z
        .array(
          z.object({
            name: z.string().trim().min(1),
            category: z.string().nullish(),
          }),
        )
        .nullish(),
    }),
    async execute(args, ctx) {
      const a = args as {
        name: string;
        description?: string | null;
        fromInspectionId?: number | null;
        items?: { name: string; category?: string | null }[] | null;
      };
      const canReadInspections =
        ctx.isAdmin || ctx.permissions.includes("inspections");

      const seededItems: { category: string | null; name: string }[] = [];

      if (a.fromInspectionId != null) {
        // Capturing an existing inspection's checklist reads inspection-module
        // data, so require the inspections module here and fail closed when it
        // is missing — the settings gate on the tool is not sufficient.
        if (!canReadInspections) {
          return {
            error: "You do not have permission to read inspection records",
          };
        }
        const [inspection] = await db
          .select({ id: inspectionsTable.id })
          .from(inspectionsTable)
          .where(eq(inspectionsTable.id, a.fromInspectionId));
        if (!inspection) return { error: "No inspection with that id." };
        const captured = await db
          .select({
            category: inspectionItemsTable.category,
            name: inspectionItemsTable.name,
          })
          .from(inspectionItemsTable)
          .where(eq(inspectionItemsTable.inspectionId, a.fromInspectionId))
          .orderBy(inspectionItemsTable.sortOrder, inspectionItemsTable.id);
        for (const it of captured) {
          seededItems.push({ category: it.category, name: it.name });
        }
      }

      if (a.items?.length) {
        for (const it of a.items) {
          seededItems.push({ category: it.category ?? null, name: it.name });
        }
      }

      const [created] = await db
        .insert(inspectionTemplatesTable)
        .values({
          name: a.name,
          description: a.description ?? null,
        })
        .returning({
          id: inspectionTemplatesTable.id,
          name: inspectionTemplatesTable.name,
        });

      if (seededItems.length) {
        await db.insert(inspectionTemplateItemsTable).values(
          seededItems.map((it, idx) => ({
            templateId: created.id,
            category: it.category,
            name: it.name,
            sortOrder: idx,
          })),
        );
      }

      return { created: { ...created, itemCount: seededItems.length } };
    },
    async summarize(args, ctx) {
      const a = args as {
        name: string;
        fromInspectionId?: number | null;
        items?: { name: string }[] | null;
      };
      const canReadInspections =
        ctx.isAdmin || ctx.permissions.includes("inspections");
      let count = a.items?.length ?? 0;
      let from = "";
      if (a.fromInspectionId != null) {
        if (canReadInspections) {
          const [row] = await db
            .select({ value: sql<number>`count(*)::int` })
            .from(inspectionItemsTable)
            .where(
              eq(inspectionItemsTable.inspectionId, a.fromInspectionId),
            );
          count += row?.value ?? 0;
          from = ` capturing the "${await inspectionTitle(a.fromInspectionId)}" inspection's checklist`;
        } else {
          from = ` capturing inspection #${a.fromInspectionId}'s checklist`;
        }
      }
      const itemLabel = count === 1 ? "item" : "items";
      return `save a new inspection template "${a.name}"${from} with ${count} ${itemLabel}`;
    },
  },
  {
    name: "update_inspection_template",
    description:
      "Edit a saved inspection checklist template: rename it, change its description, and/or replace its checklist items. Resolve the template id with find_inspection_templates first. Passing items replaces the template's entire checklist (in order); omit items to leave the checklist unchanged. Requires the settings module because templates are settings-gated. Requires confirmation.",
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int(
          "Inspection template id to update. Resolve it with find_inspection_templates first.",
        ),
        name: str("New template name, if renaming."),
        description: {
          type: ["string", "null"],
          description:
            "New description for the template; pass null to clear it.",
        },
        items: {
          type: "array",
          description:
            "Replacement checklist items, in order. Providing this replaces ALL existing items on the template. Omit to leave the checklist unchanged.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: str('Checklist item name, e.g. "Check tire tread".'),
              category: str('Optional grouping category, e.g. "Brakes".'),
            },
          },
        },
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      name: z.string().trim().min(1).optional(),
      description: z.string().nullish(),
      items: z
        .array(
          z.object({
            name: z.string().trim().min(1),
            category: z.string().nullish(),
          }),
        )
        .optional(),
    }),
    async execute(args) {
      const a = args as {
        id: number;
        name?: string;
        description?: string | null;
        items?: { name: string; category?: string | null }[];
      };
      const set: { name?: string; description?: string | null } = {};
      if (a.name !== undefined) set.name = a.name;
      if (a.description !== undefined) set.description = a.description ?? null;

      // Wrap the row update + full checklist replacement in one transaction so a
      // mid-operation failure can't leave the template with an empty checklist.
      const result = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            id: inspectionTemplatesTable.id,
            name: inspectionTemplatesTable.name,
          })
          .from(inspectionTemplatesTable)
          .where(eq(inspectionTemplatesTable.id, a.id));
        if (!existing) return null;

        let updated = existing;
        if (Object.keys(set).length) {
          [updated] = await tx
            .update(inspectionTemplatesTable)
            .set(set)
            .where(eq(inspectionTemplatesTable.id, a.id))
            .returning({
              id: inspectionTemplatesTable.id,
              name: inspectionTemplatesTable.name,
            });
        }

        let itemCount: number | undefined;
        if (a.items !== undefined) {
          // Replace the whole checklist: clear existing items, then re-seed in
          // the provided order.
          await tx
            .delete(inspectionTemplateItemsTable)
            .where(eq(inspectionTemplateItemsTable.templateId, a.id));
          if (a.items.length) {
            await tx.insert(inspectionTemplateItemsTable).values(
              a.items.map((it, idx) => ({
                templateId: a.id,
                category: it.category ?? null,
                name: it.name,
                sortOrder: idx,
              })),
            );
          }
          itemCount = a.items.length;
        }

        return { updated, itemCount };
      });

      if (!result) return { error: "No inspection template with that id." };

      return {
        updated: {
          ...result.updated,
          ...(result.itemCount !== undefined
            ? { itemCount: result.itemCount }
            : {}),
        },
      };
    },
    async summarize(args) {
      const a = args as {
        id: number;
        name?: string;
        description?: string | null;
        items?: { name: string }[];
      };
      const current = await inspectionTemplateName(a.id);
      const changes: string[] = [];
      if (a.name !== undefined) changes.push(`rename to "${a.name}"`);
      if (a.description !== undefined)
        changes.push(
          a.description === null
            ? "clear the description"
            : `set description to "${a.description}"`,
        );
      if (a.items !== undefined) {
        const n = a.items.length;
        changes.push(
          `replace the checklist with ${n} ${n === 1 ? "item" : "items"}`,
        );
      }
      const summary = changes.length ? changes.join(", ") : "(no changes)";
      return `update inspection template "${current}" (#${a.id}): ${summary}`;
    },
  },
  {
    name: "rename_inspection_template",
    description:
      "Rename a single existing inspection checklist template, without touching its description or checklist items. Resolve the template id with find_inspection_templates first. Use this focused helper when the user only wants to change a template's name; use update_inspection_template when also changing the description or checklist. Requires the settings module because templates are settings-gated. Requires confirmation.",
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name"],
      properties: {
        id: int(
          "Inspection template id to rename. Resolve it with find_inspection_templates first.",
        ),
        name: str("New template name."),
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      name: z.string().trim().min(1),
    }),
    async execute(args) {
      const a = args as { id: number; name: string };
      const [updated] = await db
        .update(inspectionTemplatesTable)
        .set({ name: a.name })
        .where(eq(inspectionTemplatesTable.id, a.id))
        .returning({
          id: inspectionTemplatesTable.id,
          name: inspectionTemplatesTable.name,
        });
      if (!updated) return { error: "No inspection template with that id." };
      return { updated };
    },
    async summarize(args) {
      const a = args as { id: number; name: string };
      const current = await inspectionTemplateName(a.id);
      return `rename inspection template "${current}" (#${a.id}) to "${a.name}"`;
    },
  },
  {
    name: "set_inspection_template_description",
    description:
      "Set or clear the description of a single existing inspection checklist template, without touching its name or checklist items. Resolve the template id with find_inspection_templates first. Use this focused helper when the user only wants to change a template's description; pass null to clear it, or use update_inspection_template when also changing the name or checklist. Requires the settings module because templates are settings-gated. Requires confirmation.",
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "description"],
      properties: {
        id: int(
          "Inspection template id to update. Resolve it with find_inspection_templates first.",
        ),
        description: {
          type: ["string", "null"],
          description:
            "New description for the template; pass null to clear it.",
        },
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      description: z.string().nullable(),
    }),
    async execute(args) {
      const a = args as { id: number; description: string | null };
      const [updated] = await db
        .update(inspectionTemplatesTable)
        .set({ description: a.description })
        .where(eq(inspectionTemplatesTable.id, a.id))
        .returning({
          id: inspectionTemplatesTable.id,
          name: inspectionTemplatesTable.name,
          description: inspectionTemplatesTable.description,
        });
      if (!updated) return { error: "No inspection template with that id." };
      return { updated };
    },
    async summarize(args) {
      const a = args as { id: number; description: string | null };
      const current = await inspectionTemplateName(a.id);
      return a.description === null
        ? `clear the description of inspection template "${current}" (#${a.id})`
        : `set description of inspection template "${current}" (#${a.id}) to "${a.description}"`;
    },
  },
  {
    name: "delete_inspection_template",
    description:
      "Permanently delete a saved inspection checklist template and its items. Resolve the template id with find_inspection_templates first. Any inspections previously seeded from it keep their own checklist items but lose the template link. Always confirm first. Requires the settings module because templates are settings-gated.",
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int(
          "Inspection template id to delete. Resolve it with find_inspection_templates first.",
        ),
      },
    },
    argsSchema: idOnly,
    async execute(args) {
      const { id } = args as { id: number };
      // Items cascade away via the FK; inspections referencing the template
      // have their templateId set to null automatically (onDelete: set null).
      const [deleted] = await db
        .delete(inspectionTemplatesTable)
        .where(eq(inspectionTemplatesTable.id, id))
        .returning({ id: inspectionTemplatesTable.id });
      if (!deleted) return { error: "No inspection template with that id." };
      return { deleted: true, id };
    },
    async summarize(args) {
      const { id } = args as { id: number };
      const name = await inspectionTemplateName(id);
      const [items] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(inspectionTemplateItemsTable)
        .where(eq(inspectionTemplateItemsTable.templateId, id));
      const [refs] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(inspectionsTable)
        .where(eq(inspectionsTable.templateId, id));
      const itemCount = items?.value ?? 0;
      const refCount = refs?.value ?? 0;
      let summary = `permanently delete inspection template "${name}" (#${id}) and its ${itemCount} ${itemCount === 1 ? "item" : "items"}`;
      if (refCount > 0) {
        summary += `; ${refCount} ${refCount === 1 ? "inspection" : "inspections"} will keep their checklist but lose the template link`;
      }
      return summary;
    },
  },
  {
    name: "add_inspection_template_item",
    description:
      "Append a single checklist item (name + optional category) to an existing inspection template, without restating the whole checklist. Resolve the template id with find_inspection_templates first. Adds the item at the end by default, or at a 1-based position to insert it earlier in the checklist. Requires the settings module because templates are settings-gated. Requires confirmation.",
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["templateId", "name"],
      properties: {
        templateId: int(
          "Inspection template id to add the item to. Resolve it with find_inspection_templates first.",
        ),
        name: str('Checklist item name, e.g. "Check tire tread".'),
        category: str('Optional grouping category, e.g. "Brakes".'),
        position: int(
          "Optional 1-based position to insert the item at (1 puts it first). Omit to append at the end.",
        ),
      },
    },
    argsSchema: z.object({
      templateId: z.number().int(),
      name: z.string().trim().min(1),
      category: z.string().nullish(),
      position: z.number().int().min(1).optional(),
    }),
    async execute(args) {
      const a = args as {
        templateId: number;
        name: string;
        category?: string | null;
        position?: number;
      };
      // Wrap the insert + renumber in one transaction so a partial failure can't
      // leave the checklist with duplicate or gapped sort orders.
      const result = await db.transaction(async (tx) => {
        const [tpl] = await tx
          .select({ id: inspectionTemplatesTable.id })
          .from(inspectionTemplatesTable)
          .where(eq(inspectionTemplatesTable.id, a.templateId));
        if (!tpl) return null;

        const existing = await tx
          .select({ id: inspectionTemplateItemsTable.id })
          .from(inspectionTemplateItemsTable)
          .where(eq(inspectionTemplateItemsTable.templateId, a.templateId))
          .orderBy(
            inspectionTemplateItemsTable.sortOrder,
            inspectionTemplateItemsTable.id,
          );

        // Clamp the 1-based position into [0, length]; default to the end.
        const insertIndex =
          a.position !== undefined
            ? Math.max(0, Math.min(a.position - 1, existing.length))
            : existing.length;

        const [created] = await tx
          .insert(inspectionTemplateItemsTable)
          .values({
            templateId: a.templateId,
            category: a.category ?? null,
            name: a.name,
            sortOrder: insertIndex,
          })
          .returning({
            id: inspectionTemplateItemsTable.id,
            name: inspectionTemplateItemsTable.name,
          });

        // Renumber the whole checklist so the new item lands at insertIndex and
        // sort orders stay contiguous regardless of prior gaps.
        const ordered = existing.map((e) => e.id);
        ordered.splice(insertIndex, 0, created.id);
        for (let i = 0; i < ordered.length; i++) {
          await tx
            .update(inspectionTemplateItemsTable)
            .set({ sortOrder: i })
            .where(eq(inspectionTemplateItemsTable.id, ordered[i]));
        }

        return created;
      });

      if (!result) return { error: "No inspection template with that id." };
      return { created: result };
    },
    async summarize(args) {
      const a = args as {
        templateId: number;
        name: string;
        category?: string | null;
        position?: number;
      };
      const tpl = await inspectionTemplateName(a.templateId);
      const cat = a.category ? ` (category "${a.category}")` : "";
      const where =
        a.position !== undefined ? ` at position ${a.position}` : " at the end";
      return `add checklist item "${a.name}"${cat}${where} to inspection template "${tpl}" (#${a.templateId})`;
    },
  },
  {
    name: "delete_inspection_template_item",
    description:
      "Remove a single checklist item from an inspection template by its item id, without restating the whole checklist. Resolve the item id with find_inspection_templates first (it lists each template's items with their ids). Requires the settings module because templates are settings-gated. Always confirm first.",
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int(
          "Inspection template item id to delete. Resolve it with find_inspection_templates first.",
        ),
      },
    },
    argsSchema: idOnly,
    async execute(args) {
      const { id } = args as { id: number };
      const [deleted] = await db
        .delete(inspectionTemplateItemsTable)
        .where(eq(inspectionTemplateItemsTable.id, id))
        .returning({ id: inspectionTemplateItemsTable.id });
      if (!deleted) return { error: "No inspection template item with that id." };
      return { deleted: true, id };
    },
    async summarize(args) {
      const { id } = args as { id: number };
      const { name, templateId } = await inspectionTemplateItemInfo(id);
      const tpl =
        templateId !== null
          ? `"${await inspectionTemplateName(templateId)}"`
          : "(unknown template)";
      return `remove checklist item "${name}" (#${id}) from inspection template ${tpl}`;
    },
  },
  {
    name: "update_inspection_template_item",
    description:
      "Rename a single checklist item on an inspection template and/or change its grouping category, by its item id, without restating the whole checklist. Resolve the item id with find_inspection_templates first (it lists each template's items with their ids). Requires the settings module because templates are settings-gated. Requires confirmation.",
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int(
          "Inspection template item id to update. Resolve it with find_inspection_templates first.",
        ),
        name: str("New checklist item name, if renaming."),
        category: {
          type: ["string", "null"],
          description:
            "New grouping category for the item; pass null to clear it.",
        },
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      name: z.string().trim().min(1).optional(),
      category: z.string().nullish(),
    }),
    async execute(args) {
      const a = args as {
        id: number;
        name?: string;
        category?: string | null;
      };
      const set: { name?: string; category?: string | null } = {};
      if (a.name !== undefined) set.name = a.name;
      if (a.category !== undefined) set.category = a.category ?? null;
      if (Object.keys(set).length === 0) {
        return { error: "No fields to update were provided." };
      }
      const [updated] = await db
        .update(inspectionTemplateItemsTable)
        .set(set)
        .where(eq(inspectionTemplateItemsTable.id, a.id))
        .returning({
          id: inspectionTemplateItemsTable.id,
          name: inspectionTemplateItemsTable.name,
          category: inspectionTemplateItemsTable.category,
        });
      if (!updated) return { error: "No inspection template item with that id." };
      return { updated };
    },
    async summarize(args) {
      const a = args as {
        id: number;
        name?: string;
        category?: string | null;
      };
      const { name, templateId } = await inspectionTemplateItemInfo(a.id);
      const tpl =
        templateId !== null
          ? `"${await inspectionTemplateName(templateId)}"`
          : "(unknown template)";
      const changes: string[] = [];
      if (a.name !== undefined) changes.push(`rename to "${a.name}"`);
      if (a.category !== undefined)
        changes.push(
          a.category === null
            ? "clear the category"
            : `set category to "${a.category}"`,
        );
      const summary = changes.length ? changes.join(", ") : "(no changes)";
      return `update checklist item "${name}" (#${a.id}) on inspection template ${tpl}: ${summary}`;
    },
  },
  {
    name: "set_inspection_template_item_category",
    description:
      "Set or clear the grouping category of a single existing checklist item on an inspection template, by its item id, without touching its name. Resolve the item id with find_inspection_templates first (it lists each template's items with their ids). Use this focused helper when the user only wants to change an item's category; pass null to clear it, or use update_inspection_template_item when also renaming the item. Requires the settings module because templates are settings-gated. Requires confirmation.",
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "category"],
      properties: {
        id: int(
          "Inspection template item id to update. Resolve it with find_inspection_templates first.",
        ),
        category: {
          type: ["string", "null"],
          description:
            "New grouping category for the item; pass null to clear it.",
        },
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      category: z.string().nullable(),
    }),
    async execute(args) {
      const a = args as { id: number; category: string | null };
      const [updated] = await db
        .update(inspectionTemplateItemsTable)
        .set({ category: a.category })
        .where(eq(inspectionTemplateItemsTable.id, a.id))
        .returning({
          id: inspectionTemplateItemsTable.id,
          name: inspectionTemplateItemsTable.name,
          category: inspectionTemplateItemsTable.category,
        });
      if (!updated) return { error: "No inspection template item with that id." };
      return { updated };
    },
    async summarize(args) {
      const a = args as { id: number; category: string | null };
      const { name, templateId } = await inspectionTemplateItemInfo(a.id);
      const tpl =
        templateId !== null
          ? `"${await inspectionTemplateName(templateId)}"`
          : "(unknown template)";
      return a.category === null
        ? `clear the category of checklist item "${name}" (#${a.id}) on inspection template ${tpl}`
        : `set category of checklist item "${name}" (#${a.id}) on inspection template ${tpl} to "${a.category}"`;
    },
  },
  {
    name: "move_inspection_template_item",
    description:
      "Move a single existing checklist item to a new 1-based position within its inspection template, re-numbering the checklist contiguously, without restating the whole checklist. Resolve the item id with find_inspection_templates first (it lists each template's items with their ids). Requires the settings module because templates are settings-gated. Requires confirmation.",
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "position"],
      properties: {
        id: int(
          "Inspection template item id to move. Resolve it with find_inspection_templates first.",
        ),
        position: int(
          "New 1-based position for the item within its template (1 puts it first).",
        ),
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      position: z.number().int().min(1),
    }),
    async execute(args) {
      const a = args as { id: number; position: number };
      // Wrap the move + renumber in one transaction so a partial failure can't
      // leave the checklist with duplicate or gapped sort orders.
      const result = await db.transaction(async (tx) => {
        const [item] = await tx
          .select({ templateId: inspectionTemplateItemsTable.templateId })
          .from(inspectionTemplateItemsTable)
          .where(eq(inspectionTemplateItemsTable.id, a.id));
        if (!item) return null;

        const existing = await tx
          .select({ id: inspectionTemplateItemsTable.id })
          .from(inspectionTemplateItemsTable)
          .where(eq(inspectionTemplateItemsTable.templateId, item.templateId))
          .orderBy(
            inspectionTemplateItemsTable.sortOrder,
            inspectionTemplateItemsTable.id,
          );

        const ordered = existing.map((e) => e.id);
        const from = ordered.indexOf(a.id);
        ordered.splice(from, 1);
        // Clamp the 1-based position into [0, length-1] of the remaining items.
        const to = Math.max(0, Math.min(a.position - 1, ordered.length));
        ordered.splice(to, 0, a.id);

        // Renumber the whole checklist so sort orders stay contiguous.
        for (let i = 0; i < ordered.length; i++) {
          await tx
            .update(inspectionTemplateItemsTable)
            .set({ sortOrder: i })
            .where(eq(inspectionTemplateItemsTable.id, ordered[i]));
        }

        return { moved: true };
      });

      if (!result) return { error: "No inspection template item with that id." };
      return { moved: true, id: a.id };
    },
    async summarize(args) {
      const a = args as { id: number; position: number };
      const { name, templateId } = await inspectionTemplateItemInfo(a.id);
      const tpl =
        templateId !== null
          ? `"${await inspectionTemplateName(templateId)}"`
          : "(unknown template)";
      return `move checklist item "${name}" (#${a.id}) to position ${a.position} in inspection template ${tpl}`;
    },
  },
  {
    name: "move_inspection_template_item_to_template",
    description:
      "Move a single existing checklist item from its current inspection template to a different inspection template, by the item id and the destination template id, re-numbering the destination checklist contiguously. Resolve both the item id and the destination template id with find_inspection_templates first (it lists each template with its items and their ids). Appends the item at the end of the destination by default, or at a 1-based position to insert it earlier. Requires the settings module because templates are settings-gated. Requires confirmation.",
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "templateId"],
      properties: {
        id: int(
          "Inspection template item id to move. Resolve it with find_inspection_templates first.",
        ),
        templateId: int(
          "Destination inspection template id to move the item to. Resolve it with find_inspection_templates first.",
        ),
        position: int(
          "Optional 1-based position to insert the item at within the destination template (1 puts it first). Omit to append at the end.",
        ),
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      templateId: z.number().int(),
      position: z.number().int().min(1).optional(),
    }),
    async execute(args) {
      const a = args as { id: number; templateId: number; position?: number };
      // Wrap the move + renumber of both checklists in one transaction so a
      // partial failure can't leave either side with duplicate or gapped sort
      // orders.
      const result = await db.transaction(async (tx) => {
        const [item] = await tx
          .select({ templateId: inspectionTemplateItemsTable.templateId })
          .from(inspectionTemplateItemsTable)
          .where(eq(inspectionTemplateItemsTable.id, a.id));
        if (!item) return { error: "no-item" as const };

        if (item.templateId === a.templateId)
          return { error: "same-template" as const };

        const [dest] = await tx
          .select({ id: inspectionTemplatesTable.id })
          .from(inspectionTemplatesTable)
          .where(eq(inspectionTemplatesTable.id, a.templateId));
        if (!dest) return { error: "no-template" as const };

        // Reassign the item to the destination template first, then renumber
        // both checklists so each stays contiguous on its own.
        await tx
          .update(inspectionTemplateItemsTable)
          .set({ templateId: a.templateId })
          .where(eq(inspectionTemplateItemsTable.id, a.id));

        const sourceRemaining = await tx
          .select({ id: inspectionTemplateItemsTable.id })
          .from(inspectionTemplateItemsTable)
          .where(eq(inspectionTemplateItemsTable.templateId, item.templateId))
          .orderBy(
            inspectionTemplateItemsTable.sortOrder,
            inspectionTemplateItemsTable.id,
          );
        for (let i = 0; i < sourceRemaining.length; i++) {
          await tx
            .update(inspectionTemplateItemsTable)
            .set({ sortOrder: i })
            .where(eq(inspectionTemplateItemsTable.id, sourceRemaining[i].id));
        }

        // Order the destination by sort order, excluding the moved item, then
        // splice it in at the requested 1-based position (default: the end).
        const destExisting = await tx
          .select({ id: inspectionTemplateItemsTable.id })
          .from(inspectionTemplateItemsTable)
          .where(eq(inspectionTemplateItemsTable.templateId, a.templateId))
          .orderBy(
            inspectionTemplateItemsTable.sortOrder,
            inspectionTemplateItemsTable.id,
          );
        const ordered = destExisting
          .map((e) => e.id)
          .filter((id) => id !== a.id);
        const insertIndex =
          a.position !== undefined
            ? Math.max(0, Math.min(a.position - 1, ordered.length))
            : ordered.length;
        ordered.splice(insertIndex, 0, a.id);
        for (let i = 0; i < ordered.length; i++) {
          await tx
            .update(inspectionTemplateItemsTable)
            .set({ sortOrder: i })
            .where(eq(inspectionTemplateItemsTable.id, ordered[i]));
        }

        return { ok: true as const };
      });

      if ("ok" in result) return { moved: true, id: a.id };
      if (result.error === "no-item")
        return { error: "No inspection template item with that id." };
      if (result.error === "no-template")
        return { error: "No destination inspection template with that id." };
      return { error: "That item is already on that inspection template." };
    },
    async summarize(args) {
      const a = args as { id: number; templateId: number; position?: number };
      const { name, templateId } = await inspectionTemplateItemInfo(a.id);
      const source =
        templateId !== null
          ? `"${await inspectionTemplateName(templateId)}"`
          : "(unknown template)";
      const dest = `"${await inspectionTemplateName(a.templateId)}"`;
      const where =
        a.position !== undefined ? ` at position ${a.position}` : " at the end";
      return `move checklist item "${name}" (#${a.id}) from inspection template ${source} to inspection template ${dest}${where}`;
    },
  },
  {
    name: "copy_inspection_template_item_to_template",
    description:
      "Copy a single existing checklist item into a different inspection template, leaving the original in place, by the item id and the destination template id. Use this when the same check (e.g. \"Check brake fluid\") belongs on several templates without re-dictating it. Resolve both the item id and the destination template id with find_inspection_templates first (it lists each template with its items and their ids). Appends the copy at the end of the destination by default, or at a 1-based position to insert it earlier, re-numbering the destination checklist contiguously. Requires the settings module because templates are settings-gated. Requires confirmation.",
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "templateId"],
      properties: {
        id: int(
          "Inspection template item id to copy. Resolve it with find_inspection_templates first.",
        ),
        templateId: int(
          "Destination inspection template id to copy the item into. Resolve it with find_inspection_templates first.",
        ),
        position: int(
          "Optional 1-based position to insert the copy at within the destination template (1 puts it first). Omit to append at the end.",
        ),
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      templateId: z.number().int(),
      position: z.number().int().min(1).optional(),
    }),
    async execute(args) {
      const a = args as { id: number; templateId: number; position?: number };
      // Wrap the insert + renumber of the destination in one transaction so a
      // partial failure can't leave it with duplicate or gapped sort orders.
      // The source row is never touched, so it always stays intact.
      const result = await db.transaction(async (tx) => {
        const [item] = await tx
          .select({
            templateId: inspectionTemplateItemsTable.templateId,
            name: inspectionTemplateItemsTable.name,
            category: inspectionTemplateItemsTable.category,
          })
          .from(inspectionTemplateItemsTable)
          .where(eq(inspectionTemplateItemsTable.id, a.id));
        if (!item) return { error: "no-item" as const };

        if (item.templateId === a.templateId)
          return { error: "same-template" as const };

        const [dest] = await tx
          .select({ id: inspectionTemplatesTable.id })
          .from(inspectionTemplatesTable)
          .where(eq(inspectionTemplatesTable.id, a.templateId));
        if (!dest) return { error: "no-template" as const };

        // Order the destination by sort order, then splice the new copy in at
        // the requested 1-based position (default: the end).
        const destExisting = await tx
          .select({ id: inspectionTemplateItemsTable.id })
          .from(inspectionTemplateItemsTable)
          .where(eq(inspectionTemplateItemsTable.templateId, a.templateId))
          .orderBy(
            inspectionTemplateItemsTable.sortOrder,
            inspectionTemplateItemsTable.id,
          );
        const insertIndex =
          a.position !== undefined
            ? Math.max(0, Math.min(a.position - 1, destExisting.length))
            : destExisting.length;

        const [created] = await tx
          .insert(inspectionTemplateItemsTable)
          .values({
            templateId: a.templateId,
            category: item.category,
            name: item.name,
            sortOrder: insertIndex,
          })
          .returning({
            id: inspectionTemplateItemsTable.id,
            name: inspectionTemplateItemsTable.name,
          });
        if (!created) return { error: "no-item" as const };

        // Renumber the destination so the copy lands at insertIndex and sort
        // orders stay contiguous regardless of prior gaps.
        const ordered = destExisting.map((e) => e.id);
        ordered.splice(insertIndex, 0, created.id);
        for (let i = 0; i < ordered.length; i++) {
          await tx
            .update(inspectionTemplateItemsTable)
            .set({ sortOrder: i })
            .where(eq(inspectionTemplateItemsTable.id, ordered[i]));
        }

        return { ok: true as const, createdId: created.id };
      });

      if ("ok" in result) return { copied: true, id: result.createdId };
      if (result.error === "no-item")
        return { error: "No inspection template item with that id." };
      if (result.error === "no-template")
        return { error: "No destination inspection template with that id." };
      return { error: "That item is already on that inspection template." };
    },
    async summarize(args) {
      const a = args as { id: number; templateId: number; position?: number };
      const { name, templateId } = await inspectionTemplateItemInfo(a.id);
      const source =
        templateId !== null
          ? `"${await inspectionTemplateName(templateId)}"`
          : "(unknown template)";
      const dest = `"${await inspectionTemplateName(a.templateId)}"`;
      const where =
        a.position !== undefined ? ` at position ${a.position}` : " at the end";
      return `copy checklist item "${name}" (#${a.id}) from inspection template ${source} to inspection template ${dest}${where}`;
    },
  },
  {
    name: "duplicate_inspection_template",
    description:
      'Duplicate an entire inspection checklist template at once: create a brand-new template that copies the source template\'s description and all of its checklist items (names, categories, and order), leaving the source untouched. Resolve the source template id with find_inspection_templates first. Pass an optional newName to name the copy; if omitted it defaults to the source name with " (copy)" appended. Use this to spin up a near-identical template without re-dictating every line. Requires the settings module because templates are settings-gated. Requires confirmation.',
    kind: "write",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int(
          "Source inspection template id to duplicate. Resolve it with find_inspection_templates first.",
        ),
        newName: str(
          'Optional name for the new template. Defaults to the source name with " (copy)" appended.',
        ),
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      newName: z.string().trim().min(1).nullish(),
    }),
    async execute(args) {
      const a = args as { id: number; newName?: string | null };
      // Read the source, create the copy, and seed its items in one
      // transaction so a partial failure can't leave a half-populated
      // duplicate. The source rows are only read, never modified.
      const result = await db.transaction(async (tx) => {
        const [source] = await tx
          .select({
            name: inspectionTemplatesTable.name,
            description: inspectionTemplatesTable.description,
          })
          .from(inspectionTemplatesTable)
          .where(eq(inspectionTemplatesTable.id, a.id));
        if (!source) return { error: "no-template" as const };

        const items = await tx
          .select({
            category: inspectionTemplateItemsTable.category,
            name: inspectionTemplateItemsTable.name,
          })
          .from(inspectionTemplateItemsTable)
          .where(eq(inspectionTemplateItemsTable.templateId, a.id))
          .orderBy(
            inspectionTemplateItemsTable.sortOrder,
            inspectionTemplateItemsTable.id,
          );

        const name =
          a.newName != null && a.newName.trim().length
            ? a.newName.trim()
            : `${source.name} (copy)`;

        const [created] = await tx
          .insert(inspectionTemplatesTable)
          .values({ name, description: source.description })
          .returning({
            id: inspectionTemplatesTable.id,
            name: inspectionTemplatesTable.name,
          });

        if (items.length) {
          await tx.insert(inspectionTemplateItemsTable).values(
            items.map((it, idx) => ({
              templateId: created.id,
              category: it.category,
              name: it.name,
              sortOrder: idx,
            })),
          );
        }

        return { ok: true as const, created, itemCount: items.length };
      });

      if ("ok" in result)
        return {
          created: { ...result.created, itemCount: result.itemCount },
        };
      return { error: "No inspection template with that id." };
    },
    async summarize(args) {
      const a = args as { id: number; newName?: string | null };
      const source = await inspectionTemplateName(a.id);
      const [row] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(inspectionTemplateItemsTable)
        .where(eq(inspectionTemplateItemsTable.templateId, a.id));
      const count = row?.value ?? 0;
      const newName =
        a.newName != null && a.newName.trim().length
          ? a.newName.trim()
          : `${source} (copy)`;
      const plural = count === 1 ? "item" : "items";
      return `duplicate inspection template "${source}" as "${newName}" with all ${count} checklist ${plural}`;
    },
  },

  // ---- appointments ---------------------------------------------------------
  {
    name: "create_appointment",
    description:
      "Book an appointment. Resolve the customer id first when the appointment is for an existing customer. Requires confirmation.",
    kind: "write",
    requiredPermission: "appointments",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["scheduledAt"],
      properties: {
        customerId: int("Existing customer id, if any."),
        vehicleId: int("Vehicle id, if any."),
        customerName: str("Customer name (for walk-ins without a record)."),
        phone: str("Contact phone number."),
        serviceType: str("Type of service requested."),
        notes: str("Freeform notes."),
        status: {
          type: "string",
          enum: ["scheduled", "confirmed", "completed", "cancelled", "no_show"],
          description: "Initial status; defaults to scheduled.",
        },
        scheduledAt: str("Appointment start time, ISO 8601."),
        durationMinutes: int("Duration in minutes (minimum 15); defaults to 60."),
      },
    },
    argsSchema: CreateAppointmentBody,
    async execute(args, ctx) {
      const a = args as AppointmentInput;
      const canReadCustomers =
        ctx.isAdmin || ctx.permissions.includes("customers");
      if (a.customerId != null && !canReadCustomers) {
        return { error: "You do not have permission to link to a customer record" };
      }
      if (a.vehicleId != null && !canReadCustomers) {
        return { error: "You do not have permission to link to a vehicle record" };
      }
      const name = canReadCustomers
        ? await resolveCustomerName(a.customerId, a.customerName)
        : (a.customerName ?? null);
      const [created] = await db
        .insert(appointmentsTable)
        .values({
          customerId: a.customerId ?? null,
          vehicleId: a.vehicleId ?? null,
          customerName: name,
          phone: a.phone ?? null,
          serviceType: a.serviceType ?? null,
          notes: a.notes ?? null,
          status: a.status ?? "scheduled",
          scheduledAt: a.scheduledAt,
          durationMinutes: a.durationMinutes ?? 60,
          source: a.source ?? "shop",
        })
        .returning({ id: appointmentsTable.id });
      return { created };
    },
    async summarize(args, ctx) {
      const a = args as AppointmentInput;
      const canReadCustomers =
        ctx.isAdmin || ctx.permissions.includes("customers");
      const name = canReadCustomers
        ? await resolveCustomerName(a.customerId, a.customerName)
        : (a.customerName ?? (a.customerId ? `#${a.customerId}` : null));
      const who = name ? ` for ${name}` : "";
      const svc = a.serviceType ? ` (${a.serviceType})` : "";
      return `book an appointment${who}${svc} at ${a.scheduledAt}`;
    },
  },
  {
    name: "update_appointment",
    description:
      "Update an appointment, e.g. reschedule it or change its status. Look up the appointment id first. Requires confirmation.",
    kind: "write",
    requiredPermission: "appointments",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int("Appointment id to update."),
        customerId: int("New customer id."),
        vehicleId: int("New vehicle id."),
        customerName: str("New customer name."),
        phone: str("New phone number."),
        serviceType: str("New service type."),
        notes: str("New notes."),
        status: {
          type: "string",
          enum: ["scheduled", "confirmed", "completed", "cancelled", "no_show"],
          description: "New status.",
        },
        scheduledAt: str("New start time, ISO 8601."),
        durationMinutes: int("New duration in minutes (minimum 15)."),
      },
    },
    argsSchema: withId(UpdateAppointmentBody),
    async execute(args, ctx) {
      const { id, rest } = updateFields<z.infer<typeof UpdateAppointmentBody>>(
        args,
      );
      if (Object.keys(rest).length === 0) {
        return { error: "No fields to update were provided." };
      }
      const canReadCustomers = ctx.isAdmin || ctx.permissions.includes("customers");
      if (rest.customerId != null && !canReadCustomers) {
        return { error: "You do not have permission to link to a customer record" };
      }
      if (rest.vehicleId != null && !canReadCustomers) {
        return { error: "You do not have permission to link to a vehicle record" };
      }
      const [updated] = await db
        .update(appointmentsTable)
        .set(rest)
        .where(eq(appointmentsTable.id, id))
        .returning({ id: appointmentsTable.id });
      if (!updated) return { error: "No appointment with that id." };
      return { updated };
    },
    async summarize(args) {
      const { id, rest } = updateFields(args);
      return `update appointment #${id}: set ${formatChanges(rest as Record<string, unknown>)}`;
    },
  },
  {
    name: "delete_appointment",
    description: "Permanently delete an appointment. Always confirm first.",
    kind: "write",
    requiredPermission: "appointments",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: int("Appointment id to delete.") },
    },
    argsSchema: idOnly,
    async execute(args) {
      const { id } = args as { id: number };
      const [deleted] = await db
        .delete(appointmentsTable)
        .where(eq(appointmentsTable.id, id))
        .returning({ id: appointmentsTable.id });
      if (!deleted) return { error: "No appointment with that id." };
      return { deleted: true, id };
    },
    async summarize(args) {
      const { id } = args as { id: number };
      return `permanently delete appointment #${id}`;
    },
  },

  // ---- estimates ------------------------------------------------------------
  {
    name: "create_estimate",
    description:
      "Create an estimate for a customer's vehicle. Resolve the customer id and vehicle id first. Line items are optional — you can create an empty draft and add items afterward. Requires confirmation.",
    kind: "write",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["customerId", "vehicleId"],
      properties: {
        customerId: int("Customer id."),
        vehicleId: int("Vehicle id (must belong to the customer)."),
        workOrderId: int("Work order id to link, if any."),
        notes: str("Notes for the estimate."),
        taxRate: num("Tax rate as a percent (e.g. 8.25); defaults to 0."),
        status: {
          type: "string",
          enum: ["draft", "sent", "approved", "declined"],
          description: "Initial status; defaults to draft.",
        },
        lineItems: {
          type: "array",
          description: "Optional initial line items.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description"],
            properties: {
              type: {
                type: "string",
                enum: ["labor", "part", "fee"],
                description: "Line item type; defaults to labor.",
              },
              description: str("What the line item is for."),
              quantity: num("Quantity (labor hours for labor); defaults to 1."),
              unitPrice: num("Unit price in USD. For labor items, omit or pass 0 to auto-fill the shop's default labor rate."),
            },
          },
        },
      },
    },
    argsSchema: z.object({
      customerId: z.number().int(),
      vehicleId: z.number().int(),
      workOrderId: z.number().int().nullish(),
      notes: z.string().nullish(),
      taxRate: z.number().min(0).optional(),
      status: z.enum(["draft", "sent", "approved", "declined"]).optional(),
      lineItems: z
        .array(
          z.object({
            type: z.enum(["labor", "part", "fee"]).optional(),
            description: z.string().min(1),
            quantity: z.number().min(0).optional(),
            unitPrice: z.number().min(0).optional(),
          }),
        )
        .optional(),
    }),
    async execute(args, ctx) {
      const a = args as EstimateInput;
      const canReadCustomers = ctx.isAdmin || ctx.permissions.includes("customers");
      const canReadWorkOrders = ctx.isAdmin || ctx.permissions.includes("workOrders");
      if (!canReadCustomers) {
        return { error: "You do not have permission to link to a customer record" };
      }
      if (a.workOrderId != null && !canReadWorkOrders) {
        return { error: "You do not have permission to link to a work order" };
      }
      const refError =
        (await missingRef(customersTable, a.customerId, "Customer")) ??
        (await missingRef(vehiclesTable, a.vehicleId, "Vehicle")) ??
        (await missingRef(workOrdersTable, a.workOrderId ?? null, "Work order"));
      if (refError) return { error: refError };

      // Relational consistency: the vehicle must belong to the specified customer,
      // and the work order (if any) must belong to the same customer/vehicle pair.
      // Mirrors the same checks enforced by the POST /estimates REST route.
      if (a.vehicleId != null && a.customerId != null) {
        const [v] = await db
          .select({ id: vehiclesTable.id })
          .from(vehiclesTable)
          .where(and(eq(vehiclesTable.id, a.vehicleId), eq(vehiclesTable.customerId, a.customerId)));
        if (!v) return { error: "Vehicle does not belong to the specified customer" };
      }
      if (a.workOrderId != null) {
        const woConditions = [eq(workOrdersTable.id, a.workOrderId)];
        if (a.customerId != null) woConditions.push(eq(workOrdersTable.customerId, a.customerId));
        if (a.vehicleId != null) woConditions.push(eq(workOrdersTable.vehicleId, a.vehicleId));
        const [wo] = await db
          .select({ id: workOrdersTable.id })
          .from(workOrdersTable)
          .where(and(...woConditions));
        if (!wo) return { error: "Work order does not belong to the specified customer or vehicle" };
      }

      const [created] = await db
        .insert(estimatesTable)
        .values({
          customerId: a.customerId,
          vehicleId: a.vehicleId,
          workOrderId: a.workOrderId ?? null,
          notes: a.notes ?? null,
          taxRate: a.taxRate ?? 0,
          status: a.status ?? "draft",
        })
        .returning({ id: estimatesTable.id });
      const defaultRate = await fetchDefaultLaborRate();
      const pricedLineItems = applyDefaultLaborRate(a.lineItems ?? [], defaultRate);
      const items = normalizeLineItems(pricedLineItems);
      if (items.length) {
        await db
          .insert(estimateLineItemsTable)
          .values(items.map((li) => ({ ...li, estimateId: created.id })));
      }
      return {
        created: { id: created.id, number: estimateNumber(created.id) },
        lineItemsAdded: items.length,
      };
    },
    async summarize(args, ctx) {
      const a = args as EstimateInput;
      const canReadCustomers = ctx.isAdmin || ctx.permissions.includes("customers");
      const cn = canReadCustomers ? await customerName(a.customerId) : `#${a.customerId}`;
      const vl = canReadCustomers ? await vehicleLabel(a.vehicleId) : `#${a.vehicleId}`;
      const count = a.lineItems?.length ?? 0;
      const items = count ? ` with ${count} line item${count === 1 ? "" : "s"}` : "";
      return `create a ${a.status ?? "draft"} estimate for ${cn}'s ${vl}${items}`;
    },
  },
  {
    name: "duplicate_estimate",
    description:
      "Duplicate an entire estimate at once: create a brand-new draft estimate that copies the source estimate's notes, tax rate, and ALL of its line items (labor/part/fee, with quantity and unit price), leaving the source untouched. Resolve the source estimate id first (use find_estimates). Optionally re-target the copy to a different customer and vehicle by passing customerId and vehicleId (resolve them first); when omitted the copy keeps the source's customer and vehicle. The new estimate always starts in the draft status (never carries over a sent/approved state) and is not linked to a work order. Use this to reissue a recurring quote (\"same quote as last time, new customer\") without re-dictating every line. Requires the customers module too because it links a customer record. Requires confirmation.",
    kind: "write",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int("Source estimate id to duplicate. Resolve it with find_estimates first."),
        customerId: int(
          "Optional. New customer id to re-target the copy to; defaults to the source estimate's customer.",
        ),
        vehicleId: int(
          "Optional. New vehicle id to re-target the copy to; defaults to the source estimate's vehicle.",
        ),
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      customerId: z.number().int().nullish(),
      vehicleId: z.number().int().nullish(),
    }),
    async execute(args, ctx) {
      const a = args as {
        id: number;
        customerId?: number | null;
        vehicleId?: number | null;
      };
      // Duplicating links a customer/vehicle record, so it requires the
      // customers module the same way create_estimate does (cross-module gate on
      // top of the estimates requiredPermission).
      const canReadCustomers =
        ctx.isAdmin || ctx.permissions.includes("customers");
      if (!canReadCustomers) {
        return { error: "You do not have permission to link to a customer record" };
      }
      const [source] = await db
        .select({
          customerId: estimatesTable.customerId,
          vehicleId: estimatesTable.vehicleId,
          notes: estimatesTable.notes,
          taxRate: estimatesTable.taxRate,
        })
        .from(estimatesTable)
        .where(eq(estimatesTable.id, a.id));
      if (!source) return { error: "No estimate with that id." };

      const targetCustomerId = a.customerId ?? source.customerId;
      const targetVehicleId = a.vehicleId ?? source.vehicleId;
      const refError =
        (await missingRef(customersTable, targetCustomerId, "Customer")) ??
        (await missingRef(vehiclesTable, targetVehicleId, "Vehicle"));
      if (refError) return { error: refError };

      // Relational consistency: the target vehicle must belong to the target
      // customer, mirroring the same check enforced by the POST /estimates route.
      if (targetVehicleId != null && targetCustomerId != null) {
        const [v] = await db
          .select({ id: vehiclesTable.id })
          .from(vehiclesTable)
          .where(and(eq(vehiclesTable.id, targetVehicleId), eq(vehiclesTable.customerId, targetCustomerId)));
        if (!v) return { error: "Vehicle does not belong to the specified customer" };
      }

      // Read the source line items, create the copy, and seed its line items in
      // one transaction so a partial failure can't leave a half-populated
      // duplicate. The source rows are only read, never modified.
      const result = await db.transaction(async (tx) => {
        const items = await tx
          .select({
            type: estimateLineItemsTable.type,
            description: estimateLineItemsTable.description,
            quantity: estimateLineItemsTable.quantity,
            unitPrice: estimateLineItemsTable.unitPrice,
          })
          .from(estimateLineItemsTable)
          .where(eq(estimateLineItemsTable.estimateId, a.id))
          .orderBy(estimateLineItemsTable.id);
        const [created] = await tx
          .insert(estimatesTable)
          .values({
            customerId: targetCustomerId,
            vehicleId: targetVehicleId,
            workOrderId: null,
            notes: source.notes,
            taxRate: source.taxRate,
            status: "draft",
          })
          .returning({ id: estimatesTable.id });
        if (items.length) {
          await tx
            .insert(estimateLineItemsTable)
            .values(items.map((li) => ({ ...li, estimateId: created.id })));
        }
        return { created, items };
      });

      const totals = computeTotals(result.items, source.taxRate);
      return {
        created: {
          id: result.created.id,
          number: estimateNumber(result.created.id),
        },
        lineItemsCopied: result.items.length,
        total: totals.total,
      };
    },
    async summarize(args, ctx) {
      const a = args as {
        id: number;
        customerId?: number | null;
        vehicleId?: number | null;
      };
      const [row] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(estimateLineItemsTable)
        .where(eq(estimateLineItemsTable.estimateId, a.id));
      const count = row?.value ?? 0;
      const plural = count === 1 ? "item" : "items";
      const canReadCustomers =
        ctx.isAdmin || ctx.permissions.includes("customers");
      let retarget = "";
      if (a.customerId != null || a.vehicleId != null) {
        const who =
          a.customerId != null
            ? canReadCustomers
              ? await customerName(a.customerId)
              : `#${a.customerId}`
            : null;
        const veh =
          a.vehicleId != null
            ? canReadCustomers
              ? await vehicleLabel(a.vehicleId)
              : `#${a.vehicleId}`
            : null;
        const target = [who, veh].filter(Boolean).join("'s ");
        retarget = target ? ` for ${target}` : "";
      }
      return `duplicate ${estimateNumber(a.id)} as a new draft estimate copying all ${count} line ${plural}${retarget}`;
    },
  },
  {
    name: "add_estimate_line_item",
    description:
      "Add a single line item to an existing estimate. Look up the estimate id first. Requires confirmation.",
    kind: "write",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["estimateId", "description"],
      properties: {
        estimateId: int("Estimate id to add the line item to."),
        type: {
          type: "string",
          enum: ["labor", "part", "fee"],
          description: "Line item type; defaults to labor.",
        },
        description: str("What the line item is for."),
        quantity: num("Quantity (labor hours for labor); defaults to 1."),
        unitPrice: num("Unit price in USD. For labor items, omit or pass 0 to auto-fill the shop's default labor rate."),
      },
    },
    argsSchema: z.object({
      estimateId: z.number().int(),
      type: z.enum(["labor", "part", "fee"]).optional(),
      description: z.string().min(1),
      quantity: z.number().min(0).optional(),
      unitPrice: z.number().min(0).optional(),
    }),
    async execute(args) {
      const a = args as EstimateLineItemInput & { estimateId: number };
      const refError = await missingRef(estimatesTable, a.estimateId, "Estimate");
      if (refError) return { error: refError };
      const defaultRate = await fetchDefaultLaborRate();
      const [priced] = applyDefaultLaborRate([a], defaultRate);
      const [item] = normalizeLineItems([priced]);
      const [created] = await db
        .insert(estimateLineItemsTable)
        .values({ ...item, estimateId: a.estimateId })
        .returning();
      return { created };
    },
    async summarize(args) {
      const a = args as EstimateLineItemInput & { estimateId: number };
      const qty = a.quantity ?? 1;
      const price = a.unitPrice ?? 0;
      return `add a ${a.type ?? "labor"} line item "${a.description}" (${qty} × $${price}) to ${estimateNumber(a.estimateId)}`;
    },
  },
  {
    name: "update_estimate_line_item",
    description:
      "Update a single estimate line item by its id (change description, quantity, unit price, or type). Look up the line item id first with get_estimate_line_items. Requires confirmation.",
    kind: "write",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: int("Line item id to update."),
        type: {
          type: "string",
          enum: ["labor", "part", "fee"],
          description: "New line item type.",
        },
        description: str("New description."),
        quantity: num("New quantity."),
        unitPrice: num("New unit price in USD."),
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      type: z.enum(["labor", "part", "fee"]).optional(),
      description: z.string().min(1).optional(),
      quantity: z.number().min(0).optional(),
      unitPrice: z.number().min(0).optional(),
    }),
    async execute(args) {
      const { id, rest } = updateFields<{
        type?: string;
        description?: string;
        quantity?: number;
        unitPrice?: number;
      }>(args);
      if (Object.keys(rest).length === 0) {
        return { error: "No fields to update were provided." };
      }
      const [updated] = await db
        .update(estimateLineItemsTable)
        .set(rest)
        .where(eq(estimateLineItemsTable.id, id))
        .returning();
      if (!updated) return { error: "No line item with that id." };
      return { updated };
    },
    async summarize(args) {
      const { id, rest } = updateFields(args);
      const estId = await lineItemEstimateId(id);
      const where = estId ? ` on ${estimateNumber(estId)}` : "";
      return `update line item #${id}${where}: set ${formatChanges(rest as Record<string, unknown>)}`;
    },
  },
  {
    name: "remove_estimate_line_item",
    description:
      "Remove a single line item from an estimate by its id. Look up the line item id first with get_estimate_line_items. Requires confirmation.",
    kind: "write",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: int("Line item id to remove.") },
    },
    argsSchema: idOnly,
    async execute(args) {
      const { id } = args as { id: number };
      const [deleted] = await db
        .delete(estimateLineItemsTable)
        .where(eq(estimateLineItemsTable.id, id))
        .returning({ id: estimateLineItemsTable.id });
      if (!deleted) return { error: "No line item with that id." };
      return { deleted: true, id };
    },
    async summarize(args) {
      const { id } = args as { id: number };
      const [li] = await db
        .select({
          description: estimateLineItemsTable.description,
          estimateId: estimateLineItemsTable.estimateId,
        })
        .from(estimateLineItemsTable)
        .where(eq(estimateLineItemsTable.id, id));
      const desc = li?.description ?? `#${id}`;
      const where = li ? ` from ${estimateNumber(li.estimateId)}` : "";
      return `remove line item "${desc}" (#${id})${where}`;
    },
  },
  {
    name: "update_estimate_status",
    description:
      "Change an estimate's status (draft, sent, approved, declined). Approving stamps the approval time. Requires confirmation.",
    kind: "write",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id", "status"],
      properties: {
        id: int("Estimate id."),
        status: {
          type: "string",
          enum: ["draft", "sent", "approved", "declined"],
          description: "New status.",
        },
      },
    },
    argsSchema: z.object({
      id: z.number().int(),
      status: z.enum(["draft", "sent", "approved", "declined"]),
    }),
    async execute(args) {
      const { id, status } = args as {
        id: number;
        status: "draft" | "sent" | "approved" | "declined";
      };
      const [updated] = await db
        .update(estimatesTable)
        .set({
          status,
          approvedAt: status === "approved" ? new Date().toISOString() : null,
        })
        .where(eq(estimatesTable.id, id))
        .returning({ id: estimatesTable.id, status: estimatesTable.status });
      if (!updated) return { error: "No estimate with that id." };
      return { updated };
    },
    async summarize(args) {
      const { id, status } = args as { id: number; status: string };
      return `mark ${estimateNumber(id)} as ${status}`;
    },
  },
  {
    name: "suggest_estimate_line_items",
    description:
      "Generate AI-suggested labor and parts line items for a job and add them to an existing draft estimate for staff review. Uses the estimate's vehicle for context. Look up the estimate id first. Requires confirmation. The figures are AI-generated and must be verified before quoting the customer.",
    kind: "write",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["estimateId", "jobDescription"],
      properties: {
        estimateId: int("Estimate id to add the suggested line items to."),
        jobDescription: str("The job to estimate, e.g. 'replace front brake pads and rotors'."),
        notes: str("Any extra context for the estimate."),
      },
    },
    argsSchema: z.object({
      estimateId: z.number().int(),
      jobDescription: z.string().trim().min(1).max(2000),
      notes: z.string().trim().max(2000).nullish(),
    }),
    async execute(args, ctx) {
      const a = args as {
        estimateId: number;
        jobDescription: string;
        notes?: string | null;
      };
      const [estimate] = await db
        .select({ id: estimatesTable.id, vehicleId: estimatesTable.vehicleId })
        .from(estimatesTable)
        .where(eq(estimatesTable.id, a.estimateId));
      if (!estimate) return { error: "No estimate with that id." };

      const vehicleCtx = await estimateVehicleContext(estimate.vehicleId);
      let result;
      try {
        result = await runLaborEstimate({
          jobDescription: a.jobDescription,
          notes: a.notes ?? null,
          ...vehicleCtx,
        });
      } catch {
        return { error: "Failed to generate suggestions from the AI estimator." };
      }

      // Pull real shop pricing in from the parts catalog where a suggested part
      // matches an inventory item; otherwise keep the AI's estimated unit price.
      // Mirrors the POST /ai/labor-estimate route: only callers with the
      // `inventory` permission (or admins) get catalog prices, so an
      // estimates-only caller can't probe inventory data through this tool.
      const callerHasInventory =
        ctx.isAdmin || ctx.permissions.includes("inventory");
      let catalog: CatalogPart[] = [];
      if (callerHasInventory) {
        catalog = await loadCatalog();
      }

      const laborHours = round2(result.laborHours);
      const rows: {
        estimateId: number;
        type: string;
        description: string;
        quantity: number;
        unitPrice: number;
      }[] = [];
      if (laborHours > 0 || result.laborTotal > 0) {
        rows.push({
          estimateId: a.estimateId,
          type: "labor",
          description: `Labor: ${a.jobDescription}`,
          quantity: laborHours,
          unitPrice: result.laborRate,
        });
      }
      // Per-part pricing provenance so the assistant can tell staff which parts
      // were priced from real inventory vs. left as AI estimates, and flag any
      // low-stock matches. Only populated for callers with the inventory
      // permission so no catalog/stock detail leaks to estimates-only callers.
      const partsPricing: {
        description: string;
        unitPrice: number;
        fromCatalog: boolean;
        partId: number | null;
        quantityOnHand: number | null;
        matchConfidence: MatchConfidence | null;
        lowStock: boolean | null;
      }[] = [];
      for (const p of result.parts) {
        const match = callerHasInventory
          ? matchCatalogPart(p.description, catalog)
          : null;
        // Only firm (high/medium) matches adopt catalog pricing; low-confidence
        // matches keep the AI's estimated price.
        const useCatalogPrice =
          match !== null &&
          (match.confidence === "high" || match.confidence === "medium");
        const unitPrice = round2(
          useCatalogPrice ? match.part.unitPrice : p.unitPrice,
        );
        rows.push({
          estimateId: a.estimateId,
          type: "part",
          description: p.description,
          quantity: p.quantity,
          unitPrice,
        });
        partsPricing.push({
          description: p.description,
          unitPrice,
          fromCatalog: useCatalogPrice,
          partId: match ? match.part.id : null,
          quantityOnHand: match ? match.part.quantityOnHand : null,
          matchConfidence: match ? match.confidence : null,
          lowStock: useCatalogPrice
            ? match.part.quantityOnHand <= match.part.reorderLevel
            : null,
        });
      }
      if (rows.length === 0) {
        return {
          added: [],
          message: "The estimator did not return any line items.",
          disclaimer: result.disclaimer,
        };
      }
      const inserted = await db
        .insert(estimateLineItemsTable)
        .values(rows)
        .returning();

      // Deterministic pricing note so the model reliably surfaces which parts
      // used firm shop prices vs. unverified AI estimates, plus low-stock
      // warnings. Built only when the caller can see inventory; otherwise all
      // parts are AI estimates and we say nothing catalog-specific.
      let pricingNote: string | undefined;
      if (callerHasInventory && partsPricing.length > 0) {
        const catalogParts = partsPricing.filter((p) => p.fromCatalog);
        const estimatedParts = partsPricing.filter((p) => !p.fromCatalog);
        const lowStockParts = partsPricing.filter((p) => p.lowStock);
        const segments: string[] = [];
        if (catalogParts.length > 0) {
          segments.push(
            `Priced from the parts catalog (firm): ${catalogParts
              .map((p) => p.description)
              .join(", ")}.`,
          );
        }
        if (estimatedParts.length > 0) {
          segments.push(
            `AI-estimated prices to verify before quoting: ${estimatedParts
              .map((p) => p.description)
              .join(", ")}.`,
          );
        }
        if (lowStockParts.length > 0) {
          segments.push(
            `Low stock, may need reordering: ${lowStockParts
              .map((p) => p.description)
              .join(", ")}.`,
          );
        }
        pricingNote = segments.join(" ");
      }

      return {
        added: inserted,
        ...(callerHasInventory ? { partsPricing } : {}),
        ...(pricingNote ? { pricingNote } : {}),
        summary: result.summary,
        cautions: result.cautions,
        confidence: result.confidence,
        disclaimer: result.disclaimer,
      };
    },
    isStoredResultRestricted(content, ctx) {
      // If the stored result contains inventory-enriched fields (partsPricing or
      // pricingNote) the caller had the `inventory` permission at execution time
      // and the result reveals catalog prices, part ids, stock levels, and
      // low-stock flags. Once that permission is revoked, replaying or surfacing
      // this result would let the user recover inventory data they can no longer
      // access through normal routes.
      if (ctx.isAdmin || ctx.permissions.includes("inventory")) return false;
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (
          (Array.isArray(parsed.partsPricing) && parsed.partsPricing.length > 0) ||
          typeof parsed.pricingNote === "string"
        ) {
          return true;
        }
      } catch {
        // Unparseable content → fail closed: treat as restricted.
        return true;
      }
      return false;
    },
    async summarize(args) {
      const a = args as { estimateId: number; jobDescription: string };
      return `generate AI-suggested labor and parts line items for "${a.jobDescription}" and add them to ${estimateNumber(a.estimateId)}`;
    },
  },
  {
    name: "convert_estimate_to_invoice",
    description:
      "Convert an approved estimate into a new draft invoice, copying its line items, tax rate, and linked customer/vehicle/work order so totals stay consistent. Look up the estimate id first. Requires confirmation. Fails if the estimate has no line items or has already been converted to an invoice. Requires both the estimates and invoices module permissions.",
    kind: "write",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["estimateId"],
      properties: {
        estimateId: int("Estimate id to convert into an invoice."),
      },
    },
    argsSchema: z.object({ estimateId: z.number().int() }),
    async execute(args, ctx) {
      const { estimateId } = args as { estimateId: number };
      // Cross-module gate: creating an invoice also requires the invoices
      // permission. requiredPermission already enforces "estimates"; this fails
      // closed when the caller lacks "invoices".
      const canInvoice = ctx.isAdmin || ctx.permissions.includes("invoices");
      if (!canInvoice) {
        return { error: "You do not have permission to create invoices" };
      }
      // FK inheritance gate: the converted invoice carries over the estimate's
      // customerId, vehicleId, and workOrderId. Enforce the same cross-module
      // checks that POST /estimates/:id/convert-to-invoice applies so a user
      // cannot bypass them through the AI path.
      const [estFks] = await db
        .select({
          customerId: estimatesTable.customerId,
          vehicleId: estimatesTable.vehicleId,
          workOrderId: estimatesTable.workOrderId,
        })
        .from(estimatesTable)
        .where(eq(estimatesTable.id, estimateId));
      if (estFks) {
        const canCustomers = ctx.isAdmin || ctx.permissions.includes("customers");
        if ((estFks.customerId != null || estFks.vehicleId != null) && !canCustomers) {
          return { error: "You do not have permission to link to a customer record" };
        }
        const canWorkOrders = ctx.isAdmin || ctx.permissions.includes("workOrders");
        if (estFks.workOrderId != null && !canWorkOrders) {
          return { error: "You do not have permission to link to a work order" };
        }
      }
      const result = await convertEstimateToInvoice(estimateId);
      if (!result.ok) return { error: result.error };
      return {
        created: {
          id: result.invoiceId,
          number: invoiceNumber(result.invoiceId),
        },
      };
    },
    async summarize(args) {
      const { estimateId } = args as { estimateId: number };
      return `convert ${estimateNumber(estimateId)} into a new invoice`;
    },
  },
  {
    name: "convert_estimate_to_work_order",
    description:
      "Convert an estimate into a new open work order, copying its linked customer and vehicle and seeding the work order title/description from the estimate so the records stay consistent. Look up the estimate id first. Requires confirmation. Fails if the estimate is already linked to a work order. Requires both the estimates and workOrders module permissions.",
    kind: "write",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["estimateId"],
      properties: {
        estimateId: int("Estimate id to convert into a work order."),
      },
    },
    argsSchema: z.object({ estimateId: z.number().int() }),
    async execute(args, ctx) {
      const { estimateId } = args as { estimateId: number };
      // Cross-module gate: creating a work order also requires the workOrders
      // permission. requiredPermission already enforces "estimates"; this fails
      // closed when the caller lacks "workOrders".
      const canWorkOrders = ctx.isAdmin || ctx.permissions.includes("workOrders");
      if (!canWorkOrders) {
        return { error: "You do not have permission to create work orders" };
      }
      // FK inheritance gate: the converted work order carries over the estimate's
      // customerId and vehicleId. Enforce the same cross-module checks that
      // POST /estimates/:id/convert-to-work-order applies so a user cannot bypass
      // them through the AI path.
      const [estFks] = await db
        .select({
          customerId: estimatesTable.customerId,
          vehicleId: estimatesTable.vehicleId,
        })
        .from(estimatesTable)
        .where(eq(estimatesTable.id, estimateId));
      if (estFks) {
        const canCustomers = ctx.isAdmin || ctx.permissions.includes("customers");
        if ((estFks.customerId != null || estFks.vehicleId != null) && !canCustomers) {
          return { error: "You do not have permission to link to a customer record" };
        }
      }
      const result = await convertEstimateToWorkOrder(estimateId);
      if (!result.ok) return { error: result.error };
      return {
        created: { id: result.workOrderId },
      };
    },
    async summarize(args) {
      const { estimateId } = args as { estimateId: number };
      return `convert ${estimateNumber(estimateId)} into a new work order`;
    },
  },

  // ---- communications -------------------------------------------------------
  {
    name: "draft_message",
    description:
      "Draft an email or text (SMS) message to a customer, vendor, or lead for outreach (e.g. appointment reminder, invoice follow-up, marketing promo, review request). This ONLY creates a draft for staff review — it never sends. A staff member must approve and send it from the Outreach screen. Resolve the customer or vendor id first (use find_customers) so their contact details fill in automatically, or pass an explicit toAddress. Requires confirmation before the draft is created.",
    kind: "write",
    requiredPermission: "communications",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["channel", "body"],
      properties: {
        channel: {
          type: "string",
          enum: ["email", "sms"],
          description: "Delivery channel: email or sms (text).",
        },
        category: {
          type: "string",
          enum: ["reminder", "invoice", "marketing", "vendor", "review", "other"],
          description: "What kind of message this is.",
        },
        audience: {
          type: "string",
          enum: ["customer", "vendor", "lead"],
          description: "Who the recipient is.",
        },
        customerId: int("Customer id to send to (resolves their contact info)."),
        vendorId: int("Vendor id to send to (resolves their contact info)."),
        toName: str("Recipient display name (optional if id given)."),
        toAddress: str(
          "Explicit email address or phone number (optional if id given).",
        ),
        subject: str("Email subject line (email only)."),
        body: str("The message body."),
      },
    },
    argsSchema: CreateMessageBody,
    async execute(args, ctx) {
      const a = args as z.infer<typeof CreateMessageBody>;
      // Resolving a customer or vendor id crosses into the customers / inventory
      // modules. Only pass the id through if the caller also holds that module's
      // permission — otherwise fall back to any explicit toName/toAddress the
      // caller supplied so communications-only staff cannot enumerate contact
      // data from modules they are not authorised to read.
      const canReadCustomers =
        ctx.isAdmin || ctx.permissions.includes("customers");
      const canReadInventory =
        ctx.isAdmin || ctx.permissions.includes("inventory");
      const { toName, toAddress } = await resolveRecipient({
        channel: a.channel,
        customerId: canReadCustomers ? (a.customerId ?? null) : null,
        vendorId: canReadInventory ? (a.vendorId ?? null) : null,
        toName: a.toName ?? null,
        toAddress: a.toAddress ?? null,
      });
      const [created] = await db
        .insert(messagesTable)
        .values({
          channel: a.channel,
          category: a.category ?? "other",
          audience: a.audience ?? "customer",
          customerId: a.customerId ?? null,
          vendorId: a.vendorId ?? null,
          toName,
          toAddress,
          subject: a.subject ?? null,
          body: a.body,
          status: "draft",
          source: "ai",
          createdByUserId: ctx.userId,
        })
        .returning({ id: messagesTable.id });
      return {
        created,
        note: "Saved as a draft. A staff member must approve and send it from the Outreach screen.",
      };
    },
    async summarize(args) {
      const a = args as z.infer<typeof CreateMessageBody>;
      const channelLabel = a.channel === "sms" ? "text" : "email";
      const to = a.toName?.trim() || a.toAddress?.trim() || "the recipient";
      const preview =
        a.body.length > 120 ? a.body.slice(0, 120) + "…" : a.body;
      return `draft a ${channelLabel} ${a.category ?? "message"} to ${to} for staff approval: "${preview}"`;
    },
  },
];

// Model-facing argument advertised on every write tool. When the model had to
// pick one record out of several similarly-named matches (an ambiguous lookup,
// e.g. "brake pad" hitting front, rear, and a Bosch set), it lists the human
// labels of the OTHER top candidates here. The agent loop reads these off the
// raw tool-call arguments, attaches them to the pending confirmation, and never
// passes them to the tool's execute() — they exist purely so the user can be
// offered the alternatives if the best guess is wrong.
const ALTERNATIVES_PARAM = {
  type: "array",
  items: { type: "string" },
  maxItems: 3,
  description:
    "Optional. When you resolved this action from an ambiguous lookup — several records with similar names matched and you had to pick one — list the human-readable labels of the other top 2-3 candidates you did NOT choose (for example [\"Rear brake pads\", \"Bosch brake set\"]). This lets the user pick a different record if your best guess is wrong. Omit it entirely when there was only one clear match.",
} as const;

// Advertise the shared `alternatives` argument on a write tool's JSON-schema
// parameters without touching its argsSchema (so execute() never receives it).
function withAlternativesParam(tool: AiToolDef): AiToolDef {
  const params = tool.parameters as {
    type?: string;
    properties?: Record<string, unknown>;
    [k: string]: unknown;
  };
  if (params?.type !== "object" || typeof params.properties !== "object") {
    return tool;
  }
  return {
    ...tool,
    parameters: {
      ...params,
      properties: { ...params.properties, alternatives: ALTERNATIVES_PARAM },
    },
  };
}

export const writeTools: AiToolDef[] = baseWriteTools.map(withAlternativesParam);
