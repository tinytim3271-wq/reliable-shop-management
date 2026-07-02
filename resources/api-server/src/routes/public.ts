import { Router, type IRouter } from "express";
import { rateLimit } from "express-rate-limit";
import { eq } from "drizzle-orm";
import { db, shopSettingsTable } from "@workspace/db";
import {
  GetPublicShopInfoResponse,
  GetPublicAvailabilityQueryParams,
  GetPublicAvailabilityResponse,
  CreatePublicBookingBody,
  CreatePublicSmsOptOutBody,
  type PublicBooking,
  type PublicSmsStatusResponse,
  type PublicSmsOptOutResponse,
} from "@workspace/api-zod";
import { csrfCheck } from "../lib/auth";
import { enumerateDates } from "../lib/availability";
import {
  computeAvailabilityForRange,
  createOnlineBooking,
} from "../lib/scheduling";
import {
  getSmsConsentStatus,
  recordSmsConsent,
  phoneConsentKey,
} from "../lib/messaging";

// Public, unauthenticated surface (M3): the shop's website data + online
// booking. Every handler here is reachable before authGate and licenseGate, so
// the router enforces its own per-IP rate limiting and exposes ZERO customer
// PII — availability is computed PII-free and booking only ever echoes back the
// caller's own submitted details.

const router: IRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Public reads (shop-info + availability) — generous but bounded per IP.
const publicReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Public booking writes — strict per IP to resist spam/abuse.
// Tightened from 8 to 4 per hour: combined with the server-side per-slot and
// global pending caps in scheduling.ts, this reduces the contribution a single
// IP can make to the overall junk queue even before rotating proxies come in.
// Skipped in the test environment so that the integration test suite (which
// runs multiple requests from the same loopback IP) does not exhaust the window
// before reaching the per-slot and dedup regression tests.
const publicBookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 4,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many booking attempts. Please try again later." },
  skip: () => process.env.NODE_ENV === "test",
});

router.get(
  "/public/shop-info",
  publicReadLimiter,
  async (_req, res): Promise<void> => {
    const [existing] = await db
      .select()
      .from(shopSettingsTable)
      .where(eq(shopSettingsTable.id, 1));
    const row =
      existing ??
      (await db.insert(shopSettingsTable).values({ id: 1 }).returning())[0];
    res.json(
      GetPublicShopInfoResponse.parse({
        shopName: row.shopName,
        address: row.address,
        phone: row.phone,
        email: row.email,
        website: row.website,
        logoUrl: row.logoUrl,
        timezone: row.timezone,
        openTime: row.openTime,
        closeTime: row.closeTime,
        openWeekdays: row.openWeekdays,
        slotMinutes: row.slotMinutes,
      }),
    );
  },
);

router.get(
  "/public/availability",
  publicReadLimiter,
  async (req, res): Promise<void> => {
    const query = GetPublicAvailabilityQueryParams.safeParse(req.query);
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
    res.json(GetPublicAvailabilityResponse.parse(days));
  },
);

router.post(
  "/public/booking",
  // csrfCheck first so rejected cross-origin requests do not consume a
  // legitimate caller's booking rate-limit budget.
  csrfCheck,
  publicBookingLimiter,
  async (req, res): Promise<void> => {
    const parsed = CreatePublicBookingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const clientIp =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
      req.ip ||
      null;

    const result = await createOnlineBooking({
      customerName: parsed.data.customerName,
      phone: parsed.data.phone,
      serviceType: parsed.data.serviceType ?? null,
      notes: parsed.data.notes ?? null,
      scheduledAt: parsed.data.scheduledAt,
      smsConsent: parsed.data.smsConsent ?? false,
      ipAddress: clientIp,
    });

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    // Only the booker's own submitted data is returned — never other
    // customers' records or internal fields.
    const body: PublicBooking = {
      id: result.appointment.id,
      customerName: result.appointment.customerName ?? "",
      phone: result.appointment.phone,
      serviceType: result.appointment.serviceType,
      scheduledAt: result.appointment.scheduledAt,
      durationMinutes: result.appointment.durationMinutes,
      status: result.appointment.status,
    };
    res.status(201).json(body);
  },
);

// GET /public/sms-status?phone=... — look up the current consent status for a
// phone number. Returns { status: "granted" | "revoked" | null }. Rate-limited
// with the public read limiter to avoid enumeration at scale.
router.get(
  "/public/sms-status",
  publicReadLimiter,
  async (req, res): Promise<void> => {
    const phone = typeof req.query.phone === "string" ? req.query.phone : "";
    if (!phone.trim()) {
      res.status(400).json({ error: "phone is required" });
      return;
    }
    if (!phoneConsentKey(phone)) {
      res.status(400).json({ error: "phone must contain at least 10 digits" });
      return;
    }
    const status = await getSmsConsentStatus(phone);
    const body: PublicSmsStatusResponse = { status };
    res.json(body);
  },
);

// POST /public/sms-opt-out — anonymous opt-out request. Records a "revoked"
// consent row for the phone number. Idempotent: submitting for a number that
// already has "revoked" is a no-op but still returns 200.
router.post(
  "/public/sms-opt-out",
  csrfCheck,
  publicBookingLimiter,
  async (req, res): Promise<void> => {
    const parsed = CreatePublicSmsOptOutBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!phoneConsentKey(parsed.data.phone)) {
      res.status(400).json({ error: "phone must contain at least 10 digits" });
      return;
    }
    await recordSmsConsent({
      phone: parsed.data.phone,
      status: "revoked",
      source: "reply_stop",
    });
    const body: PublicSmsOptOutResponse = { status: "revoked" };
    res.json(body);
  },
);

export default router;
