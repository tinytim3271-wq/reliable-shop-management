import { z } from "zod";
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import {
  db,
  customersTable,
  vehiclesTable,
  partsTable,
  workOrdersTable,
  appointmentsTable,
  estimatesTable,
  estimateLineItemsTable,
  inspectionsTable,
  inspectionItemsTable,
  inspectionTemplatesTable,
  inspectionTemplateItemsTable,
  mechanicsTable,
  aiMemoriesTable,
  messageTemplatesTable,
} from "@workspace/db";
import type OpenAI from "openai";
import type { PermissionKey } from "./auth";
import { writeTools } from "./aiWriteTools";
import { reportTools } from "./aiReportTools";
import { computeTotals, estimateNumber, shapeLineItem, vehicleLabel } from "./billing";

// How many rows any read tool will ever return, to bound the size of the tool
// result we feed back into the model.
const LIMIT = 20;

// Upper bound on per-user durable memories. The remember tool prunes the oldest
// beyond this so a chatty model cannot grow the set without limit.
const MAX_MEMORIES = 60;

export interface AiToolContext {
  userId: number;
  isAdmin: boolean;
  permissions: readonly PermissionKey[];
}

export type AiToolKind = "read" | "write" | "memory";

export interface AiToolDef {
  name: string;
  description: string;
  kind: AiToolKind;
  // Data tools map to exactly one module permission; the agent fails closed if
  // the current user lacks it (admins bypass). Data tools must NEVER set this to
  // null. null is reserved for meta tools (e.g. `remember`) that every
  // authenticated staff member may use regardless of module permissions.
  requiredPermission: PermissionKey | null;
  // JSON schema advertised to the model.
  parameters: Record<string, unknown>;
  // Server-side re-validation of the model-supplied arguments.
  argsSchema: z.ZodTypeAny;
  // Read tools return data immediately. Write tools (added separately) perform
  // the mutation only after the user confirms; the agent calls execute then.
  execute: (args: unknown, ctx: AiToolContext) => Promise<unknown>;
  // Write tools build a deterministic, human-readable confirmation summary.
  summarize?: (args: unknown, ctx: AiToolContext) => Promise<string>;
  // When true, the agent loop resolves the model-supplied integer photoRefs into
  // ownership-verified object paths (and strips any raw photoUrls) before the
  // action is staged. Only photo-attaching inspection-item tools set this.
  attachesPhotos?: boolean;
  // Optional secondary restriction check for tools whose stored results may
  // contain data derived from additional permissions beyond requiredPermission.
  // Called during history replay and transcript generation AFTER the base
  // canUseTool check passes. If present and returns true, the stored tool result
  // and any assistant reply that references it are redacted for the caller.
  // Receives the raw stored content string (the JSON-serialized tool result) so
  // it can inspect what data was actually included at execution time.
  isStoredResultRestricted?: (content: string, ctx: AiToolContext) => boolean;
}

const lowStockExpr = sql<boolean>`${partsTable.quantityOnHand} <= ${partsTable.reorderLevel}`;

const readTools: AiToolDef[] = [
  {
    name: "open_import_dialog",
    description:
      "Open the CSV import hub (or a specific importer) so the user can bring in records from a spreadsheet or another shop-management program (Mitchell1, Tekmetric, Shopmonkey, AutoFluent) or accounting software (QuickBooks). Use this whenever the user asks to import data, bring in records from another system, or upload/open a CSV. Pass the closest 'type' to what they want to import: customers/vehicles, work order history, invoice history, or expenses. Omit 'type' to open the import hub where they choose. Returns a client action that opens the importer.",
    kind: "read",
    // Ungated at the loop level: each importer type needs a different module
    // (e.g. expenses needs accounting, work orders needs workOrders+customers),
    // so the per-type permission check is enforced inside execute via ctx
    // instead of a single requiredPermission.
    requiredPermission: null,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: ["customers", "work-orders", "invoices", "expenses"],
          description:
            "Which importer to open: 'customers' (customers & vehicles), 'work-orders' (work order history), 'invoices' (invoice history), or 'expenses'. Omit to open the import hub.",
        },
      },
    },
    argsSchema: z.object({
      type: z.enum(["customers", "work-orders", "invoices", "expenses"]).optional(),
    }),
    async execute(args, ctx) {
      const { type } = args as { type?: "customers" | "work-orders" | "invoices" | "expenses" };
      const has = (p: PermissionKey) => ctx.isAdmin || ctx.permissions.includes(p);
      // Permissions each importer needs. Work orders and invoices also create
      // customer/vehicle records, so they require the customers module too —
      // matching the inline check on the import routes.
      const required: Record<string, PermissionKey[]> = {
        customers: ["customers"],
        "work-orders": ["workOrders", "customers"],
        invoices: ["invoices", "customers"],
        expenses: ["accounting"],
      };
      const labels: Record<string, string> = {
        customers: "customer and vehicle",
        "work-orders": "work order history",
        invoices: "invoice history",
        expenses: "expense",
      };

      if (type) {
        const missing = required[type].filter((p) => !has(p));
        if (missing.length > 0) {
          return {
            error: `Permission denied: importing ${labels[type]} requires the "${missing.join(
              '" and "',
            )}" module.`,
          };
        }
        return {
          action: { type: "open_import", path: `/import?type=${type}` },
          opened: true,
          message: `Opening the ${labels[type]} CSV import dialog.`,
        };
      }

      // No specific type: open the hub if the caller can use at least one
      // importer; the hub page itself only shows the options they may use.
      const canUseAny = (
        ["customers", "workOrders", "invoices", "accounting"] as PermissionKey[]
      ).some((p) => has(p));
      if (!canUseAny) {
        return {
          error:
            'Permission denied: importing data requires one of the "customers", "workOrders", "invoices", or "accounting" modules.',
        };
      }
      return {
        action: { type: "open_import", path: "/import" },
        opened: true,
        message: "Opening the data import hub.",
      };
    },
  },
  {
    name: "find_customers",
    description:
      "Search customers by name, phone, or email. Returns up to 20 matches with their id. Use this to resolve a customer the user names before acting on them. Omit search to list the most recent customers.",
    kind: "read",
    requiredPermission: "customers",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        search: {
          type: "string",
          description: "Name, phone, or email fragment to search for.",
        },
      },
    },
    argsSchema: z.object({ search: z.string().trim().min(1).optional() }),
    async execute(args) {
      const { search } = args as { search?: string };
      const where = search
        ? or(
            ilike(customersTable.name, `%${search}%`),
            ilike(customersTable.phone, `%${search}%`),
            ilike(customersTable.email, `%${search}%`),
          )
        : undefined;
      const customers = await db
        .select({
          id: customersTable.id,
          name: customersTable.name,
          phone: customersTable.phone,
          email: customersTable.email,
        })
        .from(customersTable)
        .where(where)
        .orderBy(desc(customersTable.id))
        .limit(LIMIT);
      return { customers };
    },
  },
  {
    name: "get_customer",
    description:
      "Get a single customer by id together with the vehicles they own.",
    kind: "read",
    requiredPermission: "customers",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "integer", description: "Customer id." },
      },
    },
    argsSchema: z.object({ id: z.number().int() }),
    async execute(args) {
      const { id } = args as { id: number };
      const [customer] = await db
        .select({
          id: customersTable.id,
          name: customersTable.name,
          phone: customersTable.phone,
          email: customersTable.email,
          address: customersTable.address,
          notes: customersTable.notes,
        })
        .from(customersTable)
        .where(eq(customersTable.id, id));
      if (!customer) return { error: "No customer with that id." };
      const vehicles = await db
        .select({
          id: vehiclesTable.id,
          year: vehiclesTable.year,
          make: vehiclesTable.make,
          model: vehiclesTable.model,
          licensePlate: vehiclesTable.licensePlate,
        })
        .from(vehiclesTable)
        .where(eq(vehiclesTable.customerId, id))
        .limit(LIMIT);
      return { customer, vehicles };
    },
  },
  {
    name: "find_vehicles",
    description:
      "Search vehicles by make, model, VIN, or license plate, and/or filter by customerId. Returns up to 20 matches with their id.",
    kind: "read",
    requiredPermission: "customers",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        search: {
          type: "string",
          description: "Make, model, VIN, or license-plate fragment.",
        },
        customerId: {
          type: "integer",
          description: "Restrict to vehicles owned by this customer.",
        },
      },
    },
    argsSchema: z.object({
      search: z.string().trim().min(1).optional(),
      customerId: z.number().int().optional(),
    }),
    async execute(args) {
      const { search, customerId } = args as {
        search?: string;
        customerId?: number;
      };
      const where = and(
        customerId !== undefined
          ? eq(vehiclesTable.customerId, customerId)
          : undefined,
        search
          ? or(
              ilike(vehiclesTable.make, `%${search}%`),
              ilike(vehiclesTable.model, `%${search}%`),
              ilike(vehiclesTable.vin, `%${search}%`),
              ilike(vehiclesTable.licensePlate, `%${search}%`),
            )
          : undefined,
      );
      const vehicles = await db
        .select({
          id: vehiclesTable.id,
          customerId: vehiclesTable.customerId,
          year: vehiclesTable.year,
          make: vehiclesTable.make,
          model: vehiclesTable.model,
          vin: vehiclesTable.vin,
          licensePlate: vehiclesTable.licensePlate,
        })
        .from(vehiclesTable)
        .where(where)
        .orderBy(desc(vehiclesTable.id))
        .limit(LIMIT);
      return { vehicles };
    },
  },
  {
    name: "get_vehicle",
    description: "Get a single vehicle by id, including its owner's name.",
    kind: "read",
    requiredPermission: "customers",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "integer", description: "Vehicle id." } },
    },
    argsSchema: z.object({ id: z.number().int() }),
    async execute(args) {
      const { id } = args as { id: number };
      const [vehicle] = await db
        .select({
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
        })
        .from(vehiclesTable)
        .leftJoin(customersTable, eq(customersTable.id, vehiclesTable.customerId))
        .where(eq(vehiclesTable.id, id));
      if (!vehicle) return { error: "No vehicle with that id." };
      return { vehicle };
    },
  },
  {
    name: "find_parts",
    description:
      "Search parts/inventory by name or SKU, optionally only those at or below their reorder level. Returns up to 20 matches with their id and stock levels.",
    kind: "read",
    requiredPermission: "inventory",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        search: { type: "string", description: "Name or SKU fragment." },
        lowStockOnly: {
          type: "boolean",
          description: "Only parts at or below their reorder level.",
        },
      },
    },
    argsSchema: z.object({
      search: z.string().trim().min(1).optional(),
      lowStockOnly: z.boolean().optional(),
    }),
    async execute(args) {
      const { search, lowStockOnly } = args as {
        search?: string;
        lowStockOnly?: boolean;
      };
      const where = and(
        search
          ? or(
              ilike(partsTable.name, `%${search}%`),
              ilike(partsTable.sku, `%${search}%`),
            )
          : undefined,
        lowStockOnly ? lowStockExpr : undefined,
      );
      const parts = await db
        .select({
          id: partsTable.id,
          name: partsTable.name,
          sku: partsTable.sku,
          quantityOnHand: partsTable.quantityOnHand,
          reorderLevel: partsTable.reorderLevel,
          unitPrice: partsTable.unitPrice,
          lowStock: lowStockExpr,
        })
        .from(partsTable)
        .where(where)
        .orderBy(desc(partsTable.id))
        .limit(LIMIT);
      return { parts };
    },
  },
  {
    name: "get_part",
    description: "Get a single part/inventory item by id.",
    kind: "read",
    requiredPermission: "inventory",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "integer", description: "Part id." } },
    },
    argsSchema: z.object({ id: z.number().int() }),
    async execute(args) {
      const { id } = args as { id: number };
      const [part] = await db
        .select({
          id: partsTable.id,
          name: partsTable.name,
          sku: partsTable.sku,
          category: partsTable.category,
          vendor: partsTable.vendor,
          location: partsTable.location,
          quantityOnHand: partsTable.quantityOnHand,
          reorderLevel: partsTable.reorderLevel,
          unitCost: partsTable.unitCost,
          unitPrice: partsTable.unitPrice,
          notes: partsTable.notes,
          lowStock: lowStockExpr,
        })
        .from(partsTable)
        .where(eq(partsTable.id, id));
      if (!part) return { error: "No part with that id." };
      return { part };
    },
  },
  {
    name: "find_work_orders",
    description:
      "List work orders, optionally filtered by status, customerId, or vehicleId. Returns up to 20 with their id, title, status, and customer name.",
    kind: "read",
    requiredPermission: "workOrders",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["open", "in_progress", "awaiting_parts", "completed", "invoiced"],
        },
        customerId: { type: "integer" },
        vehicleId: { type: "integer" },
      },
    },
    argsSchema: z.object({
      status: z
        .enum(["open", "in_progress", "awaiting_parts", "completed", "invoiced"])
        .optional(),
      customerId: z.number().int().optional(),
      vehicleId: z.number().int().optional(),
    }),
    async execute(args, ctx) {
      const { status, customerId, vehicleId } = args as {
        status?: string;
        customerId?: number;
        vehicleId?: number;
      };
      const canReadCustomers = ctx.isAdmin || ctx.permissions.includes("customers");
      const where = and(
        status ? eq(workOrdersTable.status, status) : undefined,
        customerId !== undefined
          ? eq(workOrdersTable.customerId, customerId)
          : undefined,
        vehicleId !== undefined
          ? eq(workOrdersTable.vehicleId, vehicleId)
          : undefined,
      );
      const rows = await db
        .select({
          id: workOrdersTable.id,
          title: workOrdersTable.title,
          status: workOrdersTable.status,
          customerId: workOrdersTable.customerId,
          vehicleId: workOrdersTable.vehicleId,
          customerName: customersTable.name,
          openedAt: workOrdersTable.openedAt,
        })
        .from(workOrdersTable)
        .leftJoin(
          customersTable,
          eq(customersTable.id, workOrdersTable.customerId),
        )
        .where(where)
        .orderBy(desc(workOrdersTable.id))
        .limit(LIMIT);
      const workOrders = rows.map((r) => ({
        ...r,
        customerName: canReadCustomers ? r.customerName : null,
      }));
      return { workOrders };
    },
    isStoredResultRestricted(content, ctx) {
      // If the stored result contains non-null customerName entries the caller
      // held `customers` at execution time. Redact if that permission is gone.
      if (ctx.isAdmin || ctx.permissions.includes("customers")) return false;
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const wos = parsed.workOrders;
        if (Array.isArray(wos)) {
          const hasCustomerData = wos.some(
            (wo: unknown) =>
              wo !== null &&
              typeof wo === "object" &&
              (wo as Record<string, unknown>).customerName !== null,
          );
          if (hasCustomerData) return true;
        }
      } catch {
        return true;
      }
      return false;
    },
  },
  {
    name: "get_work_order",
    description: "Get a single work order by id with customer and vehicle info.",
    kind: "read",
    requiredPermission: "workOrders",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "integer", description: "Work order id." } },
    },
    argsSchema: z.object({ id: z.number().int() }),
    async execute(args, ctx) {
      const { id } = args as { id: number };
      const canReadCustomers = ctx.isAdmin || ctx.permissions.includes("customers");
      const [row] = await db
        .select({
          id: workOrdersTable.id,
          title: workOrdersTable.title,
          status: workOrdersTable.status,
          description: workOrdersTable.description,
          complaint: workOrdersTable.complaint,
          notes: workOrdersTable.notes,
          customerId: workOrdersTable.customerId,
          customerName: customersTable.name,
          vehicleId: workOrdersTable.vehicleId,
          assignedMechanicId: workOrdersTable.assignedMechanicId,
          openedAt: workOrdersTable.openedAt,
          completedAt: workOrdersTable.completedAt,
        })
        .from(workOrdersTable)
        .leftJoin(
          customersTable,
          eq(customersTable.id, workOrdersTable.customerId),
        )
        .where(eq(workOrdersTable.id, id));
      if (!row) return { error: "No work order with that id." };
      const workOrder = {
        ...row,
        customerName: canReadCustomers ? row.customerName : null,
      };
      return { workOrder };
    },
    isStoredResultRestricted(content, ctx) {
      // If the stored result contains a non-null customerName the caller held
      // `customers` at execution time. Redact if that permission is gone.
      if (ctx.isAdmin || ctx.permissions.includes("customers")) return false;
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const wo = parsed.workOrder;
        if (
          wo !== null &&
          typeof wo === "object" &&
          (wo as Record<string, unknown>).customerName !== null
        ) {
          return true;
        }
      } catch {
        return true;
      }
      return false;
    },
  },
  {
    name: "find_appointments",
    description:
      "List appointments, optionally filtered by status and a scheduled date range (ISO 8601). Returns up to 20 ordered by soonest first.",
    kind: "read",
    requiredPermission: "appointments",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["scheduled", "confirmed", "completed", "cancelled", "no_show"],
        },
        from: {
          type: "string",
          description: "Earliest scheduled time, ISO 8601 (inclusive).",
        },
        to: {
          type: "string",
          description: "Latest scheduled time, ISO 8601 (inclusive).",
        },
      },
    },
    argsSchema: z.object({
      status: z
        .enum(["scheduled", "confirmed", "completed", "cancelled", "no_show"])
        .optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }),
    async execute(args) {
      const { status, from, to } = args as {
        status?: string;
        from?: string;
        to?: string;
      };
      const where = and(
        status ? eq(appointmentsTable.status, status) : undefined,
        from ? gte(appointmentsTable.scheduledAt, from) : undefined,
        to ? lte(appointmentsTable.scheduledAt, to) : undefined,
      );
      const appointments = await db
        .select({
          id: appointmentsTable.id,
          scheduledAt: appointmentsTable.scheduledAt,
          customerId: appointmentsTable.customerId,
          customerName: appointmentsTable.customerName,
          serviceType: appointmentsTable.serviceType,
          status: appointmentsTable.status,
          durationMinutes: appointmentsTable.durationMinutes,
        })
        .from(appointmentsTable)
        .where(where)
        .orderBy(appointmentsTable.scheduledAt)
        .limit(LIMIT);
      return { appointments };
    },
  },
  {
    name: "get_appointment",
    description: "Get a single appointment by id.",
    kind: "read",
    requiredPermission: "appointments",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "integer", description: "Appointment id." } },
    },
    argsSchema: z.object({ id: z.number().int() }),
    async execute(args) {
      const { id } = args as { id: number };
      const [appointment] = await db
        .select()
        .from(appointmentsTable)
        .where(eq(appointmentsTable.id, id));
      if (!appointment) return { error: "No appointment with that id." };
      return { appointment };
    },
  },

  // ---- inspections ----------------------------------------------------------
  {
    name: "find_inspections",
    description:
      "List digital vehicle inspections, optionally filtered by status (in_progress, completed), vehicleId, customerId, or workOrderId. Returns up to 20, newest first, each with its id, title, status, and (when allowed) the customer name.",
    kind: "read",
    requiredPermission: "inspections",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["in_progress", "completed"],
          description: "Only inspections with this status.",
        },
        vehicleId: { type: "integer", description: "Only this vehicle's inspections." },
        customerId: { type: "integer", description: "Only this customer's inspections." },
        workOrderId: {
          type: "integer",
          description: "Only inspections linked to this work order.",
        },
      },
    },
    argsSchema: z.object({
      status: z.enum(["in_progress", "completed"]).optional(),
      vehicleId: z.number().int().optional(),
      customerId: z.number().int().optional(),
      workOrderId: z.number().int().optional(),
    }),
    async execute(args, ctx) {
      const { status, vehicleId, customerId, workOrderId } = args as {
        status?: string;
        vehicleId?: number;
        customerId?: number;
        workOrderId?: number;
      };
      const canReadCustomers = ctx.isAdmin || ctx.permissions.includes("customers");
      const where = and(
        status ? eq(inspectionsTable.status, status) : undefined,
        vehicleId !== undefined ? eq(inspectionsTable.vehicleId, vehicleId) : undefined,
        customerId !== undefined ? eq(inspectionsTable.customerId, customerId) : undefined,
        workOrderId !== undefined
          ? eq(inspectionsTable.workOrderId, workOrderId)
          : undefined,
      );
      const rows = await db
        .select({
          id: inspectionsTable.id,
          title: inspectionsTable.title,
          status: inspectionsTable.status,
          vehicleId: inspectionsTable.vehicleId,
          customerId: inspectionsTable.customerId,
          workOrderId: inspectionsTable.workOrderId,
          customerName: customersTable.name,
          createdAt: inspectionsTable.createdAt,
        })
        .from(inspectionsTable)
        .leftJoin(customersTable, eq(customersTable.id, inspectionsTable.customerId))
        .where(where)
        .orderBy(desc(inspectionsTable.id))
        .limit(LIMIT);
      const inspections = rows.map((r) => ({
        ...r,
        customerName: canReadCustomers ? r.customerName : null,
      }));
      return { inspections };
    },
    isStoredResultRestricted(content, ctx) {
      // customerName entries are only non-null when the caller had `customers`
      // at execution time. Redact if that permission is gone.
      if (ctx.isAdmin || ctx.permissions.includes("customers")) return false;
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const insp = parsed.inspections;
        if (Array.isArray(insp)) {
          const hasCustomerData = insp.some(
            (i: unknown) =>
              i !== null &&
              typeof i === "object" &&
              (i as Record<string, unknown>).customerName !== null,
          );
          if (hasCustomerData) return true;
        }
      } catch {
        return true;
      }
      return false;
    },
  },
  {
    name: "get_inspection",
    description:
      "Get a single inspection by id with its checklist items (name, category, condition, notes). Condition is one of pass, attention, fail, or na.",
    kind: "read",
    requiredPermission: "inspections",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "integer", description: "Inspection id." } },
    },
    argsSchema: z.object({ id: z.number().int() }),
    async execute(args, ctx) {
      const { id } = args as { id: number };
      const canReadCustomers = ctx.isAdmin || ctx.permissions.includes("customers");
      const canReadPayroll = ctx.isAdmin || ctx.permissions.includes("payroll");
      const [row] = await db
        .select({
          id: inspectionsTable.id,
          title: inspectionsTable.title,
          status: inspectionsTable.status,
          notes: inspectionsTable.notes,
          vehicleId: inspectionsTable.vehicleId,
          customerId: inspectionsTable.customerId,
          workOrderId: inspectionsTable.workOrderId,
          inspectorId: inspectionsTable.inspectorId,
          customerName: customersTable.name,
          vYear: vehiclesTable.year,
          vMake: vehiclesTable.make,
          vModel: vehiclesTable.model,
          inspectorName: mechanicsTable.name,
          createdAt: inspectionsTable.createdAt,
          completedAt: inspectionsTable.completedAt,
        })
        .from(inspectionsTable)
        .leftJoin(customersTable, eq(customersTable.id, inspectionsTable.customerId))
        .leftJoin(vehiclesTable, eq(vehiclesTable.id, inspectionsTable.vehicleId))
        .leftJoin(mechanicsTable, eq(mechanicsTable.id, inspectionsTable.inspectorId))
        .where(eq(inspectionsTable.id, id));
      if (!row) return { error: "No inspection with that id." };
      const items = await db
        .select({
          id: inspectionItemsTable.id,
          category: inspectionItemsTable.category,
          name: inspectionItemsTable.name,
          condition: inspectionItemsTable.condition,
          notes: inspectionItemsTable.notes,
          sortOrder: inspectionItemsTable.sortOrder,
        })
        .from(inspectionItemsTable)
        .where(eq(inspectionItemsTable.inspectionId, id))
        .orderBy(inspectionItemsTable.sortOrder, inspectionItemsTable.id);
      const inspection = {
        id: row.id,
        title: row.title,
        status: row.status,
        notes: row.notes,
        vehicleId: row.vehicleId,
        customerId: row.customerId,
        workOrderId: row.workOrderId,
        inspectorId: row.inspectorId,
        customerName: canReadCustomers ? row.customerName : null,
        vehicleLabel: canReadCustomers
          ? vehicleLabel({ year: row.vYear, make: row.vMake, model: row.vModel })
          : null,
        inspectorName: canReadPayroll ? row.inspectorName : null,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        items,
      };
      return { inspection };
    },
    isStoredResultRestricted(content, ctx) {
      // customerName/vehicleLabel are non-null only when the caller had
      // `customers` at execution time; inspectorName only when they had
      // `payroll`. Redact if either revoked permission produced non-null data.
      if (ctx.isAdmin) return false;
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const insp = parsed.inspection;
        if (insp !== null && typeof insp === "object") {
          const r = insp as Record<string, unknown>;
          if (
            !ctx.permissions.includes("customers") &&
            (r.customerName !== null || r.vehicleLabel !== null)
          ) {
            return true;
          }
          if (!ctx.permissions.includes("payroll") && r.inspectorName !== null) {
            return true;
          }
        }
      } catch {
        return true;
      }
      return false;
    },
  },
  {
    name: "find_inspection_templates",
    description:
      'List saved inspection checklist templates (e.g. "Standard 21-point", "Pre-delivery"), optionally filtered by a name fragment. Returns up to 20 with their id, name, description, item count, and their checklist items (each with id, name, and category). Use this to resolve a template the user names by voice before seeding a new inspection from it with create_inspection, or to resolve a specific item id before adding, renaming, recategorizing, removing, or moving one with add_inspection_template_item / update_inspection_template_item / set_inspection_template_item_category / delete_inspection_template_item / move_inspection_template_item.',
    kind: "read",
    requiredPermission: "settings",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        search: {
          type: "string",
          description: "Name fragment to filter templates by.",
        },
      },
    },
    argsSchema: z.object({ search: z.string().trim().min(1).optional() }),
    async execute(args) {
      const { search } = args as { search?: string };
      const where = search
        ? ilike(inspectionTemplatesTable.name, `%${search}%`)
        : undefined;
      const templates = await db
        .select({
          id: inspectionTemplatesTable.id,
          name: inspectionTemplatesTable.name,
          description: inspectionTemplatesTable.description,
        })
        .from(inspectionTemplatesTable)
        .where(where)
        .orderBy(desc(inspectionTemplatesTable.id))
        .limit(LIMIT);
      // Fetch the items for the returned templates so the model can resolve a
      // specific item id (e.g. to remove one with delete_inspection_template_item)
      // or pick an insert position, without restating the whole checklist.
      const templateIds = templates.map((t) => t.id);
      const itemRows = templateIds.length
        ? await db
            .select({
              id: inspectionTemplateItemsTable.id,
              templateId: inspectionTemplateItemsTable.templateId,
              name: inspectionTemplateItemsTable.name,
              category: inspectionTemplateItemsTable.category,
            })
            .from(inspectionTemplateItemsTable)
            .where(inArray(inspectionTemplateItemsTable.templateId, templateIds))
            .orderBy(
              inspectionTemplateItemsTable.sortOrder,
              inspectionTemplateItemsTable.id,
            )
        : [];
      const itemsByTemplate = new Map<
        number,
        { id: number; name: string; category: string | null }[]
      >();
      for (const it of itemRows) {
        const list = itemsByTemplate.get(it.templateId) ?? [];
        list.push({ id: it.id, name: it.name, category: it.category });
        itemsByTemplate.set(it.templateId, list);
      }
      return {
        templates: templates.map((t) => {
          const items = itemsByTemplate.get(t.id) ?? [];
          return { ...t, itemCount: items.length, items };
        }),
      };
    },
  },

  // ---- estimates ------------------------------------------------------------
  {
    name: "find_estimates",
    description:
      "List estimates, optionally filtered by status (draft, sent, approved, declined), customerId, or vehicleId. Returns up to 20, newest first, each with id, number, status, totals, and (when allowed) the customer name.",
    kind: "read",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["draft", "sent", "approved", "declined"],
          description: "Only return estimates with this status.",
        },
        customerId: { type: "integer", description: "Only this customer's estimates." },
        vehicleId: { type: "integer", description: "Only this vehicle's estimates." },
      },
    },
    argsSchema: z.object({
      status: z.enum(["draft", "sent", "approved", "declined"]).optional(),
      customerId: z.number().int().optional(),
      vehicleId: z.number().int().optional(),
    }),
    async execute(args, ctx) {
      const { status, customerId, vehicleId } = args as {
        status?: string;
        customerId?: number;
        vehicleId?: number;
      };
      const filters = [
        status ? eq(estimatesTable.status, status) : undefined,
        customerId ? eq(estimatesTable.customerId, customerId) : undefined,
        vehicleId ? eq(estimatesTable.vehicleId, vehicleId) : undefined,
      ].filter(Boolean);
      const rows = await db
        .select({
          id: estimatesTable.id,
          customerId: estimatesTable.customerId,
          vehicleId: estimatesTable.vehicleId,
          workOrderId: estimatesTable.workOrderId,
          status: estimatesTable.status,
          taxRate: estimatesTable.taxRate,
          approvedAt: estimatesTable.approvedAt,
          createdAt: estimatesTable.createdAt,
          customerName: customersTable.name,
          vYear: vehiclesTable.year,
          vMake: vehiclesTable.make,
          vModel: vehiclesTable.model,
        })
        .from(estimatesTable)
        .leftJoin(customersTable, eq(estimatesTable.customerId, customersTable.id))
        .leftJoin(vehiclesTable, eq(estimatesTable.vehicleId, vehiclesTable.id))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(estimatesTable.id))
        .limit(LIMIT);

      const canReadCustomers = ctx.isAdmin || ctx.permissions.includes("customers");
      const ids = rows.map((r) => r.id);
      const items = ids.length
        ? await db
            .select({
              estimateId: estimateLineItemsTable.estimateId,
              quantity: estimateLineItemsTable.quantity,
              unitPrice: estimateLineItemsTable.unitPrice,
            })
            .from(estimateLineItemsTable)
            .where(inArray(estimateLineItemsTable.estimateId, ids))
        : [];

      const estimates = rows.map((r) => {
        const li = items.filter((i) => i.estimateId === r.id);
        const { subtotal, taxAmount, total } = computeTotals(li, r.taxRate);
        return {
          id: r.id,
          number: estimateNumber(r.id),
          customerId: r.customerId,
          vehicleId: r.vehicleId,
          workOrderId: r.workOrderId,
          status: r.status,
          customerName: canReadCustomers ? r.customerName : null,
          vehicleLabel: canReadCustomers
            ? vehicleLabel({ year: r.vYear, make: r.vMake, model: r.vModel })
            : null,
          taxRate: r.taxRate,
          subtotal,
          taxAmount,
          total,
          approvedAt: r.approvedAt,
          createdAt: r.createdAt,
        };
      });
      return { estimates };
    },
    isStoredResultRestricted(content, ctx) {
      // customerName/vehicleLabel are non-null only when the caller had
      // `customers` at execution time. Redact if that permission is gone.
      if (ctx.isAdmin || ctx.permissions.includes("customers")) return false;
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const ests = parsed.estimates;
        if (Array.isArray(ests)) {
          const hasCustomerData = ests.some(
            (e: unknown) =>
              e !== null &&
              typeof e === "object" &&
              ((e as Record<string, unknown>).customerName !== null ||
                (e as Record<string, unknown>).vehicleLabel !== null),
          );
          if (hasCustomerData) return true;
        }
      } catch {
        return true;
      }
      return false;
    },
  },
  {
    name: "get_estimate",
    description:
      "Get a single estimate by id with its line items and computed totals (subtotal, tax, total).",
    kind: "read",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "integer", description: "Estimate id." } },
    },
    argsSchema: z.object({ id: z.number().int() }),
    async execute(args, ctx) {
      const { id } = args as { id: number };
      const [row] = await db
        .select({
          id: estimatesTable.id,
          customerId: estimatesTable.customerId,
          vehicleId: estimatesTable.vehicleId,
          workOrderId: estimatesTable.workOrderId,
          status: estimatesTable.status,
          notes: estimatesTable.notes,
          taxRate: estimatesTable.taxRate,
          approvedAt: estimatesTable.approvedAt,
          createdAt: estimatesTable.createdAt,
          customerName: customersTable.name,
          vYear: vehiclesTable.year,
          vMake: vehiclesTable.make,
          vModel: vehiclesTable.model,
        })
        .from(estimatesTable)
        .leftJoin(customersTable, eq(estimatesTable.customerId, customersTable.id))
        .leftJoin(vehiclesTable, eq(estimatesTable.vehicleId, vehiclesTable.id))
        .where(eq(estimatesTable.id, id));
      if (!row) return { error: "No estimate with that id." };

      const lineItems = await db
        .select()
        .from(estimateLineItemsTable)
        .where(eq(estimateLineItemsTable.estimateId, id))
        .orderBy(estimateLineItemsTable.id);
      const { subtotal, taxAmount, total } = computeTotals(lineItems, row.taxRate);
      const canReadCustomers = ctx.isAdmin || ctx.permissions.includes("customers");

      return {
        estimate: {
          id: row.id,
          number: estimateNumber(row.id),
          customerId: row.customerId,
          vehicleId: row.vehicleId,
          workOrderId: row.workOrderId,
          status: row.status,
          customerName: canReadCustomers ? row.customerName : null,
          vehicleLabel: canReadCustomers
            ? vehicleLabel({ year: row.vYear, make: row.vMake, model: row.vModel })
            : null,
          notes: row.notes,
          taxRate: row.taxRate,
          subtotal,
          taxAmount,
          total,
          approvedAt: row.approvedAt,
          createdAt: row.createdAt,
          lineItems: lineItems.map(shapeLineItem),
        },
      };
    },
    isStoredResultRestricted(content, ctx) {
      // customerName/vehicleLabel are non-null only when the caller had
      // `customers` at execution time. Redact if that permission is gone.
      if (ctx.isAdmin || ctx.permissions.includes("customers")) return false;
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const est = parsed.estimate;
        if (est !== null && typeof est === "object") {
          const r = est as Record<string, unknown>;
          if (r.customerName !== null || r.vehicleLabel !== null) return true;
        }
      } catch {
        return true;
      }
      return false;
    },
  },
  {
    name: "get_estimate_line_items",
    description:
      "List the line items on an estimate (id, type, description, quantity, unit price, line total). Use this before updating or removing a specific line item to get its id.",
    kind: "read",
    requiredPermission: "estimates",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["estimateId"],
      properties: {
        estimateId: { type: "integer", description: "Estimate id." },
      },
    },
    argsSchema: z.object({ estimateId: z.number().int() }),
    async execute(args) {
      const { estimateId } = args as { estimateId: number };
      const [estimate] = await db
        .select({ id: estimatesTable.id })
        .from(estimatesTable)
        .where(eq(estimatesTable.id, estimateId));
      if (!estimate) return { error: "No estimate with that id." };
      const lineItems = await db
        .select()
        .from(estimateLineItemsTable)
        .where(eq(estimateLineItemsTable.estimateId, estimateId))
        .orderBy(estimateLineItemsTable.id);
      return { lineItems: lineItems.map(shapeLineItem) };
    },
  },
  {
    name: "list_message_templates",
    description:
      "List saved outreach message templates (reminders, invoice follow-ups, marketing, vendor, review requests). Use this to reuse approved wording when drafting a message with draft_message.",
    kind: "read",
    requiredPermission: "communications",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    argsSchema: z.object({}),
    async execute() {
      const rows = await db
        .select({
          id: messageTemplatesTable.id,
          name: messageTemplatesTable.name,
          channel: messageTemplatesTable.channel,
          category: messageTemplatesTable.category,
          subject: messageTemplatesTable.subject,
          body: messageTemplatesTable.body,
        })
        .from(messageTemplatesTable)
        .orderBy(messageTemplatesTable.name)
        .limit(LIMIT);
      return { templates: rows };
    },
  },
];

// The `remember` tool lets the assistant persist durable notes (preferences,
// corrections, facts) scoped to the current user so they carry across
// conversations. It auto-executes like a read tool (no confirmation) but writes
// a memory row. It requires no module permission: every staff member may use it.
const memoryTools: AiToolDef[] = [
  {
    name: "remember",
    description:
      "Save a durable note so you can recall it in future conversations: a shop preference, a correction the user made, or a lasting fact. Use this when the user tells you how they want things done or corrects you. Do not use it for one-off details of the current task.",
    kind: "memory",
    requiredPermission: null,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: {
          type: "string",
          description: "The note to remember, in one short sentence.",
        },
        kind: {
          type: "string",
          enum: ["preference", "correction", "fact"],
          description: "What kind of note this is. Defaults to fact.",
        },
      },
    },
    argsSchema: z.object({
      content: z.string().trim().min(1).max(500),
      kind: z.enum(["preference", "correction", "fact"]).optional(),
    }),
    async execute(args, ctx) {
      const { content, kind } = args as {
        content: string;
        kind?: "preference" | "correction" | "fact";
      };
      const now = new Date().toISOString();
      // Record the permissions the user held when writing this memory.
      //
      // Encoding:
      //   ["admin"]  — admin-authored; reverts to invisible after role downgrade.
      //   ["__any"]  — non-admin with no module permissions; any authenticated
      //                staff member may read (preferences/general facts only).
      //   [...perms] — non-admin with module perms; reverts to invisible when
      //                those perms are later revoked.
      //   []         — reserved for shop-wide rows (userId IS NULL) backfilled
      //                by migration; new writes must never produce [].
      //   null       — pre-migration unknown provenance; must never be produced
      //                by new writes (fail-closed on read for non-admins).
      const sourcePermissions: string[] = ctx.isAdmin
        ? ["admin"]
        : ctx.permissions.length === 0
          ? ["__any"]
          : [...ctx.permissions];
      // Dedupe: if this user already saved the same note, refresh it in place.
      const [existing] = await db
        .select({ id: aiMemoriesTable.id })
        .from(aiMemoriesTable)
        .where(
          and(
            eq(aiMemoriesTable.userId, ctx.userId),
            eq(aiMemoriesTable.content, content),
          ),
        );
      if (existing) {
        await db
          .update(aiMemoriesTable)
          .set({ kind: kind ?? "fact", updatedAt: now, sourcePermissions })
          .where(eq(aiMemoriesTable.id, existing.id));
        return { remembered: true, content };
      }
      await db
        .insert(aiMemoriesTable)
        .values({ userId: ctx.userId, kind: kind ?? "fact", content, sourcePermissions });
      // Prune the oldest beyond MAX_MEMORIES for this user.
      const rows = await db
        .select({ id: aiMemoriesTable.id })
        .from(aiMemoriesTable)
        .where(eq(aiMemoriesTable.userId, ctx.userId))
        .orderBy(desc(aiMemoriesTable.updatedAt));
      if (rows.length > MAX_MEMORIES) {
        const stale = rows.slice(MAX_MEMORIES).map((r) => r.id);
        await db
          .delete(aiMemoriesTable)
          .where(inArray(aiMemoriesTable.id, stale));
      }
      return { remembered: true, content };
    },
  },
];

// The live registry. Read, write, and memory tools are registered below so each
// source module stays focused on its own tool family.
export const TOOLS: Record<string, AiToolDef> = {};

export function registerTools(defs: AiToolDef[]): void {
  for (const def of defs) TOOLS[def.name] = def;
}

registerTools(readTools);
registerTools(reportTools);
registerTools(writeTools);
registerTools(memoryTools);

// The tool specs advertised to the model, filtered to what the current user is
// allowed to use (admins see everything). Execution re-checks permissions.
export function getToolSpecs(
  ctx: AiToolContext,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return Object.values(TOOLS)
    .filter((tool) => canUseTool(tool, ctx))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
}

export function canUseTool(tool: AiToolDef, ctx: AiToolContext): boolean {
  // null = no module gate (meta tools such as `remember`).
  if (tool.requiredPermission === null) return true;
  return ctx.isAdmin || ctx.permissions.includes(tool.requiredPermission);
}
