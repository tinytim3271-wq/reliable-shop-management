import { Router, type IRouter } from "express";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, smsConsentEventsTable } from "@workspace/db";
import { phoneConsentKey } from "../lib/messaging";

const router: IRouter = Router();

const ListQuery = z.object({
  phone: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.min(500, Math.max(1, parseInt(v ?? "100", 10) || 100))),
  offset: z
    .string()
    .optional()
    .transform((v) => Math.max(0, parseInt(v ?? "0", 10) || 0)),
});

const ExportQuery = z.object({
  phone: z.string().optional(),
});

// GET /sms-consent-events — paginated list of consent audit events.
// Requires the `communications` permission (enforced by authGate via ROUTE_PERMISSIONS).
router.get("/sms-consent-events", async (req, res): Promise<void> => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { phone, limit, offset } = parsed.data;

  const phoneKey = phone ? phoneConsentKey(phone) : null;
  const whereClause =
    phoneKey != null ? eq(smsConsentEventsTable.phoneKey, phoneKey) : undefined;

  const [totalRow] = await db
    .select({ count: count() })
    .from(smsConsentEventsTable)
    .where(whereClause);

  const events = await db
    .select()
    .from(smsConsentEventsTable)
    .where(whereClause)
    .orderBy(desc(smsConsentEventsTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({ total: totalRow?.count ?? 0, events });
});

// GET /sms-consent-events/export — CSV download of consent audit log.
// Requires the `communications` permission.
router.get("/sms-consent-events/export", async (req, res): Promise<void> => {
  const parsed = ExportQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const phoneKey = parsed.data.phone
    ? phoneConsentKey(parsed.data.phone)
    : null;
  const whereClause =
    phoneKey != null ? eq(smsConsentEventsTable.phoneKey, phoneKey) : undefined;

  const events = await db
    .select()
    .from(smsConsentEventsTable)
    .where(whereClause)
    .orderBy(desc(smsConsentEventsTable.createdAt));

  const CSV_HEADER = "id,phoneKey,phone,oldStatus,newStatus,source,consentTextShown,ipAddress,createdAt";

  function csvCell(val: string | number | null | undefined): string {
    if (val == null) return "";
    const str = String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const rows = events.map((e) =>
    [
      e.id,
      e.phoneKey,
      e.phone,
      e.oldStatus,
      e.newStatus,
      e.source,
      e.consentTextShown,
      e.ipAddress,
      e.createdAt,
    ]
      .map(csvCell)
      .join(","),
  );

  const csv = [CSV_HEADER, ...rows].join("\n");

  const filename = parsed.data.phone
    ? `consent-audit-${phoneKey}.csv`
    : "consent-audit-all.csv";

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

export default router;
