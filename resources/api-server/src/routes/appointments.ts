import { Router, type IRouter } from "express";
import { eq, desc, and, gte, lte, or, isNull, gt, sql as sqlExpr, type SQL } from "drizzle-orm";
import { db, appointmentsTable, customersTable, vehiclesTable } from "@workspace/db";
import {
  ListAppointmentsQueryParams,
  ListAppointmentsResponse,
  CreateAppointmentBody,
  GetAppointmentParams,
  GetAppointmentResponse,
  GetAppointmentAvailabilityQueryParams,
  GetAppointmentAvailabilityResponse,
  UpdateAppointmentParams,
  UpdateAppointmentBody,
  UpdateAppointmentResponse,
  DeleteAppointmentParams,
} from "@workspace/api-zod";
import { missingRef } from "../lib/refs";
import { hasPermission } from "../lib/auth";
import { enumerateDates } from "../lib/availability";
import { computeAvailabilityForRange } from "../lib/scheduling";

const router: IRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const resolveCustomerName = async (
  customerId: number | null | undefined,
  provided: string | null | undefined,
): Promise<string | null> => {
  if (provided) return provided;
  if (customerId) {
    const [customer] = await db
      .select({ name: customersTable.name })
      .from(customersTable)
      .where(eq(customersTable.id, customerId));
    return customer?.name ?? null;
  }
  return null;
};

router.get("/appointments", async (req, res): Promise<void> => {
  const query = ListAppointmentsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const filters: SQL[] = [];
  if (query.data.from) filters.push(gte(appointmentsTable.scheduledAt, query.data.from));
  if (query.data.to) filters.push(lte(appointmentsTable.scheduledAt, query.data.to));
  if (query.data.status) filters.push(eq(appointmentsTable.status, query.data.status));

  if (query.data.source) {
    // Explicit source filter: caller opted into a specific view (shop | online).
    filters.push(eq(appointmentsTable.source, query.data.source));
  } else {
    // Secure default: exclude unverified anonymous pending requests so junk
    // online bookings never pollute the main staff scheduling queue.
    // Staff use ?source=online to review the pending public-booking inbox.
    filters.push(
      or(
        sqlExpr`${appointmentsTable.source} != 'online'`,
        sqlExpr`${appointmentsTable.status} != 'pending'`,
      )!,
    );
  }

  // Exclude stale pending online bookings: a "pending" + source="online" booking
  // whose expiresAt has passed is abandoned and should not be shown even in the
  // ?source=online review inbox. Non-online bookings and bookings with no
  // expiresAt are always included.
  const nowISO = new Date().toISOString();
  filters.push(
    or(
      sqlExpr`${appointmentsTable.source} != 'online'`,
      sqlExpr`${appointmentsTable.status} != 'pending'`,
      isNull(appointmentsTable.expiresAt),
      gt(appointmentsTable.expiresAt, nowISO),
    )!,
  );

  const base = db.select().from(appointmentsTable);
  const rows = await base.where(and(...filters)).orderBy(desc(appointmentsTable.scheduledAt));

  res.json(ListAppointmentsResponse.parse(rows));
});

router.post("/appointments", async (req, res): Promise<void> => {
  const parsed = CreateAppointmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Cross-module permission guards: supplying a FK into a protected module
  // requires the caller to also hold that module's permission, otherwise they
  // can probe existence of records they are not authorised to read.
  if (parsed.data.customerId != null && !hasPermission(req, "customers")) {
    res.status(403).json({ error: "You do not have permission to link to a customer record" });
    return;
  }
  if (parsed.data.vehicleId != null && !hasPermission(req, "customers")) {
    res.status(403).json({ error: "You do not have permission to link to a vehicle record" });
    return;
  }

  const refError =
    (await missingRef(customersTable, parsed.data.customerId, "Customer")) ??
    (await missingRef(vehiclesTable, parsed.data.vehicleId, "Vehicle"));
  if (refError) {
    res.status(400).json({ error: refError });
    return;
  }
  if (Number.isNaN(Date.parse(parsed.data.scheduledAt))) {
    res.status(400).json({ error: "scheduledAt must be a valid date/time" });
    return;
  }

  // Only resolve the customer name from the customers table when the caller
  // also has customers permission. Without it, accept only the explicitly
  // provided name so that appointments-only users cannot use the customerId
  // as an oracle into the protected customers module.
  const customerName = hasPermission(req, "customers")
    ? await resolveCustomerName(parsed.data.customerId, parsed.data.customerName)
    : (parsed.data.customerName ?? null);

  const [created] = await db
    .insert(appointmentsTable)
    .values({
      customerId: parsed.data.customerId ?? null,
      vehicleId: parsed.data.vehicleId ?? null,
      customerName,
      phone: parsed.data.phone ?? null,
      serviceType: parsed.data.serviceType ?? null,
      notes: parsed.data.notes ?? null,
      status: parsed.data.status ?? "scheduled",
      scheduledAt: parsed.data.scheduledAt,
      durationMinutes: parsed.data.durationMinutes ?? 60,
      source: parsed.data.source ?? "shop",
    })
    .returning();

  res.status(201).json(UpdateAppointmentResponse.parse(created));
});

// MUST be registered before "/appointments/:id" so the literal path is not
// swallowed by the :id param route. Returns server-computed slot/day capacity
// with ZERO customer data, so the same handler is safe to reuse on the public
// booking surface later.
router.get("/appointments/availability", async (req, res): Promise<void> => {
  const query = GetAppointmentAvailabilityQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const from = query.data.from;
  const to = query.data.to ?? from;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" });
    return;
  }
  if (
    Number.isNaN(Date.parse(`${from}T00:00:00Z`)) ||
    Number.isNaN(Date.parse(`${to}T00:00:00Z`))
  ) {
    res.status(400).json({ error: "from/to must be valid dates" });
    return;
  }
  if (to < from) {
    res.status(400).json({ error: "to must be on or after from" });
    return;
  }

  if (enumerateDates(from, to).length > 31) {
    res.status(400).json({ error: "Date range cannot exceed 31 days" });
    return;
  }

  const days = await computeAvailabilityForRange(from, to);
  res.json(GetAppointmentAvailabilityResponse.parse(days));
});

router.get("/appointments/:id", async (req, res): Promise<void> => {
  const params = GetAppointmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [appointment] = await db
    .select()
    .from(appointmentsTable)
    .where(eq(appointmentsTable.id, params.data.id));
  if (!appointment) {
    res.status(404).json({ error: "Appointment not found" });
    return;
  }

  res.json(GetAppointmentResponse.parse(appointment));
});

router.patch("/appointments/:id", async (req, res): Promise<void> => {
  const params = UpdateAppointmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateAppointmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.customerId != null && !hasPermission(req, "customers")) {
    res.status(403).json({ error: "You do not have permission to link to a customer record" });
    return;
  }
  if (parsed.data.vehicleId != null && !hasPermission(req, "customers")) {
    res.status(403).json({ error: "You do not have permission to link to a vehicle record" });
    return;
  }

  const refError =
    (await missingRef(customersTable, parsed.data.customerId, "Customer")) ??
    (await missingRef(vehiclesTable, parsed.data.vehicleId, "Vehicle"));
  if (refError) {
    res.status(400).json({ error: refError });
    return;
  }
  if (
    parsed.data.scheduledAt !== undefined &&
    Number.isNaN(Date.parse(parsed.data.scheduledAt))
  ) {
    res.status(400).json({ error: "scheduledAt must be a valid date/time" });
    return;
  }

  const [updated] = await db
    .update(appointmentsTable)
    .set(parsed.data)
    .where(eq(appointmentsTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Appointment not found" });
    return;
  }

  res.json(UpdateAppointmentResponse.parse(updated));
});

router.delete("/appointments/:id", async (req, res): Promise<void> => {
  const params = DeleteAppointmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(appointmentsTable)
    .where(eq(appointmentsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Appointment not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
