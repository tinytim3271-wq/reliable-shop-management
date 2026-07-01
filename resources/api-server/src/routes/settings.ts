import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, shopSettingsTable } from "@workspace/db";
import { GetSettingsResponse, UpdateSettingsBody, UpdateSettingsResponse } from "@workspace/api-zod";
import { normalizeToE164, INVALID_PHONE_MESSAGE } from "../lib/phone";

const router: IRouter = Router();

const ensureRow = async () => {
  const [existing] = await db.select().from(shopSettingsTable).where(eq(shopSettingsTable.id, 1));
  if (existing) return existing;
  const [created] = await db.insert(shopSettingsTable).values({ id: 1 }).returning();
  return created;
};

router.get("/settings", async (_req, res): Promise<void> => {
  const row = await ensureRow();
  res.json(GetSettingsResponse.parse(row));
});

router.put("/settings", async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Reject IANA timezones the runtime cannot resolve, otherwise availability
  // computation would throw on every request once a bad value is persisted.
  if (parsed.data.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.timezone });
    } catch {
      res.status(400).json({ error: "Invalid timezone" });
      return;
    }
  }

  // Guard the open/close ordering. Compare against the persisted row when only
  // one side is being changed so a partial update cannot invert the window.
  if (parsed.data.openTime !== undefined || parsed.data.closeTime !== undefined) {
    const current = await ensureRow();
    const openTime = parsed.data.openTime ?? current.openTime;
    const closeTime = parsed.data.closeTime ?? current.closeTime;
    if (openTime >= closeTime) {
      res.status(400).json({ error: "openTime must be before closeTime" });
      return;
    }
  }

  // Normalize the shop phone toward E.164 so owner SMS alerts (Twilio) can be
  // delivered; an empty value clears it, an unnormalizable value is rejected.
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

  // The assistant name drives the voice wake word, so a whitespace-only value
  // would leave nothing to call the assistant by. Zod's min(1) does not catch
  // whitespace, so trim here and reject empty-after-trim, then persist the
  // trimmed value.
  if (parsed.data.assistantName !== undefined) {
    const trimmed = parsed.data.assistantName.trim();
    if (!trimmed) {
      res.status(400).json({ error: "assistantName cannot be empty" });
      return;
    }
    parsed.data.assistantName = trimmed;
  }

  await ensureRow();
  const [updated] = await db
    .update(shopSettingsTable)
    .set({ ...parsed.data, updatedAt: new Date().toISOString() })
    .where(eq(shopSettingsTable.id, 1))
    .returning();

  res.json(UpdateSettingsResponse.parse(updated));
});

export default router;
