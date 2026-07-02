import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  licensesTable,
  licenseDevicesTable,
  storeOrdersTable,
  withCriticalSection,
} from "@workspace/db";
import {
  LicenseStatusResponse,
  ActivateDeviceBody,
  ActivateDeviceResponse,
  ValidateDeviceBody,
  ValidateDeviceResponse,
  GetLicenseResponse,
  IssueLicenseBody,
  IssueLicenseResponse,
  DeactivateDeviceParams,
  DeactivateDeviceResponse,
  RevokeLicenseParams,
} from "@workspace/api-zod";
import {
  generateLicenseKey,
  generateDeviceToken,
  hashDeviceToken,
  invalidateLicenseCache,
  enforcementEnabled,
  isMasterKey,
  checkStripePaymentIntentStanding,
} from "../lib/licensing";
import { isAdmin } from "../lib/auth";

const router: IRouter = Router();

type DeviceRow = typeof licenseDevicesTable.$inferSelect;
type LicenseRow = typeof licensesTable.$inferSelect;

function shapeDevice(d: DeviceRow) {
  return {
    id: d.id,
    name: d.name,
    deviceFingerprint: d.deviceFingerprint,
    status: d.status,
    activatedAt: d.activatedAt,
    lastSeenAt: d.lastSeenAt,
    deactivatedAt: d.deactivatedAt,
  };
}

async function shapeLicense(license: LicenseRow) {
  const devices = await db
    .select()
    .from(licenseDevicesTable)
    .where(eq(licenseDevicesTable.licenseId, license.id))
    .orderBy(licenseDevicesTable.id);
  return {
    id: license.id,
    licenseKey: license.licenseKey,
    status: license.status,
    plan: license.plan,
    maxDevices: license.maxDevices,
    issuedAt: license.issuedAt,
    devices: devices.map(shapeDevice),
  };
}

async function getSingleLicense(): Promise<LicenseRow | undefined> {
  const [license] = await db.select().from(licensesTable).limit(1);
  return license;
}

// Fixed advisory-lock key that serializes the "provision exactly one license
// row" critical section. The device gate reads the licenses table with
// .limit(1), so two concurrent fresh-install activations (the master key, or
// two different sold keys) must not both pass the "no license yet" check and
// insert two rows. A transaction-scoped advisory lock makes the
// check-then-insert atomic across connections.
const LICENSE_SINGLETON_LOCK = 528491;

// Provision the single license row if and only if none exists yet, race-safe.
// Returns the resulting license (existing or freshly created) and whether this
// call created it.
async function provisionLicenseIfEmpty(values: {
  licenseKey: string;
  plan: string;
  maxDevices: number;
  stripePaymentIntentId?: string | null;
}): Promise<{ created: boolean; license: LicenseRow | undefined }> {
  return withCriticalSection(LICENSE_SINGLETON_LOCK, async (tx) => {
    const [existing] = await tx.select().from(licensesTable).limit(1);
    if (existing) return { created: false, license: existing };
    const [created] = await tx.insert(licensesTable).values(values).returning();
    return { created: true, license: created };
  });
}

// GET /license/status — any authenticated staff member.
router.get("/license/status", async (_req, res) => {
  const license = await getSingleLicense();
  let deviceCount = 0;
  if (license) {
    const active = await db
      .select({ id: licenseDevicesTable.id })
      .from(licenseDevicesTable)
      .where(
        and(
          eq(licenseDevicesTable.licenseId, license.id),
          eq(licenseDevicesTable.status, "active"),
        ),
      );
    deviceCount = active.length;
  }
  res.json(
    LicenseStatusResponse.parse({
      provisioned: Boolean(license && license.status === "active"),
      deviceCount,
      maxDevices: license?.maxDevices ?? 1,
      enforcementEnabled: enforcementEnabled(),
    }),
  );
});

// POST /license/activate — bind this device to the license key.
router.post("/license/activate", async (req, res) => {
  const parsed = ActivateDeviceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const { licenseKey, deviceFingerprint, deviceName } = parsed.data;

  // The owner's personal master key works on any installation: it attaches the
  // device to whatever license exists, and bootstraps one on a fresh install so
  // the owner can license a brand-new program with a single key.
  const usingMasterKey = isMasterKey(licenseKey);
  let license: LicenseRow | undefined;
  if (usingMasterKey) {
    // The master key attaches to whatever license exists, bootstrapping one
    // (race-safe) on a fresh install.
    const { created, license: provisioned } = await provisionLicenseIfEmpty({
      licenseKey: generateLicenseKey(),
      plan: "master",
      maxDevices: 99,
    });
    if (created) invalidateLicenseCache();
    license = provisioned;
  } else {
    [license] = await db
      .select()
      .from(licensesTable)
      .where(eq(licensesTable.licenseKey, licenseKey.trim()))
      .limit(1);

    // Storefront bridge: a key sold through the public store lives in
    // `store_orders`, not `licenses`. If THIS install has no license row yet,
    // consume the purchased key to provision exactly one license row (using the
    // tier's plan + device entitlement). This preserves the single-row
    // invariant the gate relies on (it reads .limit(1)) while making purchased
    // keys actually activate the software.
    //
    // Provisioning the singleton license row is an admin-only action: it
    // permanently claims the installation's license slot and affects every
    // user on this instance. Non-admin staff can still activate a device
    // against an already-provisioned license (the branch above) but must not
    // be able to seize the shop-wide license slot.
    if (!license) {
      if (!isAdmin(req)) {
        res.status(403).json({
          error:
            "Only an administrator can provision a new license for this installation.",
        });
        return;
      }
      const [order] = await db
        .select()
        .from(storeOrdersTable)
        .where(
          and(
            eq(storeOrdersTable.licenseKey, licenseKey.trim()),
            eq(storeOrdersTable.status, "paid"),
          ),
        )
        .limit(1);
      if (order) {
        // Race-safe provisioning: if a DIFFERENT key already licensed this
        // install (or won a concurrent race), refuse — a sold key for another
        // machine must not override it. A concurrent activation of the SAME
        // sold key collapses onto the one row instead of erroring.
        //
        // stripePaymentIntentId is stored alongside the license so the gate and
        // heartbeat can perform authoritative Stripe-backed standing checks on
        // every subsequent gate evaluation (see loadLicenseState in licensing.ts).
        const { created, license: provisioned } = await provisionLicenseIfEmpty({
          licenseKey: order.licenseKey,
          plan: order.plan,
          maxDevices: order.maxDevices,
          stripePaymentIntentId: order.stripePaymentIntentId ?? null,
        });
        if (
          !created &&
          provisioned &&
          provisioned.licenseKey !== order.licenseKey
        ) {
          res
            .status(409)
            .json({ error: "This installation is already licensed." });
          return;
        }
        if (created) invalidateLicenseCache();
        license = provisioned;
      }
    }
  }
  if (!license || license.status !== "active") {
    res.status(404).json({ error: "Unknown or inactive license key" });
    return;
  }

  const token = generateDeviceToken();
  const tokenHash = hashDeviceToken(token);

  // Re-activating from the same browser rotates the token instead of consuming
  // another device slot (covers a lost/cleared token on a known device).
  const [existing] = await db
    .select()
    .from(licenseDevicesTable)
    .where(
      and(
        eq(licenseDevicesTable.licenseId, license.id),
        eq(licenseDevicesTable.deviceFingerprint, deviceFingerprint),
        eq(licenseDevicesTable.status, "active"),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(licenseDevicesTable)
      .set({
        deviceTokenHash: tokenHash,
        name: deviceName,
        lastSeenAt: new Date().toISOString(),
      })
      .where(eq(licenseDevicesTable.id, existing.id))
      .returning();
    invalidateLicenseCache();
    res
      .status(200)
      .json(
        ActivateDeviceResponse.parse({ deviceToken: token, device: shapeDevice(updated) }),
      );
    return;
  }

  const activeDevices = await db
    .select({ id: licenseDevicesTable.id })
    .from(licenseDevicesTable)
    .where(
      and(
        eq(licenseDevicesTable.licenseId, license.id),
        eq(licenseDevicesTable.status, "active"),
      ),
    );
  if (!usingMasterKey && activeDevices.length >= license.maxDevices) {
    res.status(409).json({
      error: "Device limit reached. Deactivate another device first.",
      code: "DEVICE_LIMIT_REACHED",
    });
    return;
  }

  const [created] = await db
    .insert(licenseDevicesTable)
    .values({
      licenseId: license.id,
      deviceFingerprint,
      deviceTokenHash: tokenHash,
      name: deviceName,
      lastSeenAt: new Date().toISOString(),
    })
    .returning();
  invalidateLicenseCache();
  res
    .status(200)
    .json(
      ActivateDeviceResponse.parse({ deviceToken: token, device: shapeDevice(created) }),
    );
});

// POST /license/validate — heartbeat; confirms a device token is still active.
router.post("/license/validate", async (req, res) => {
  const parsed = ValidateDeviceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const tokenHash = hashDeviceToken(parsed.data.deviceToken);
  const [device] = await db
    .select()
    .from(licenseDevicesTable)
    .where(
      and(
        eq(licenseDevicesTable.deviceTokenHash, tokenHash),
        eq(licenseDevicesTable.status, "active"),
      ),
    )
    .limit(1);

  if (!device) {
    res.json(ValidateDeviceResponse.parse({ valid: false, status: null }));
    return;
  }

  // Re-verify that the license backing this device is still in good standing.
  // For store-provisioned licenses:
  //   1. Check Stripe directly via the stored payment-intent id (authoritative;
  //      catches reversals even when the licenses row is in a different DB from
  //      the storefront's store_orders).
  //   2. Fall back to the local store_orders cross-check when Stripe is
  //      unavailable (authoritative for same-DB hosted deployments where the
  //      webhook keeps store_orders current).
  const [licenseRow] = await db
    .select({
      licenseKey: licensesTable.licenseKey,
      stripePaymentIntentId: licensesTable.stripePaymentIntentId,
    })
    .from(licensesTable)
    .where(eq(licensesTable.id, device.licenseId))
    .limit(1);

  if (licenseRow) {
    if (licenseRow.stripePaymentIntentId) {
      // Authoritative Stripe check — same fail-closed semantics as the gate:
      //   "reversed"    → deny
      //   "unavailable" → deny (fail-closed; prevents perpetual access after refund)
      //   "paid"        → confirmed valid
      const standing = await checkStripePaymentIntentStanding(licenseRow.stripePaymentIntentId);
      if (standing === "reversed" || standing === "unavailable") {
        res.json(ValidateDeviceResponse.parse({ valid: false, status: null }));
        return;
      }
    } else {
      // No PI on the licenses row — look up store_orders by key.
      // If the order has a PI id, use Stripe (authoritative for cross-DB
      // deployments; same fail-closed semantics as the PI-stored branch).
      // If the order has no PI id, fall back to local status check (valid
      // only for same-DB hosted deployments where webhook keeps status current).
      const [storeOrder] = await db
        .select({
          status: storeOrdersTable.status,
          piId: storeOrdersTable.stripePaymentIntentId,
        })
        .from(storeOrdersTable)
        .where(eq(storeOrdersTable.licenseKey, licenseRow.licenseKey))
        .limit(1);

      if (storeOrder) {
        if (storeOrder.piId) {
          const standing = await checkStripePaymentIntentStanding(storeOrder.piId);
          if (standing === "reversed" || standing === "unavailable") {
            res.json(ValidateDeviceResponse.parse({ valid: false, status: null }));
            return;
          }
        } else if (storeOrder.status !== "paid") {
          res.json(ValidateDeviceResponse.parse({ valid: false, status: null }));
          return;
        }
      }
    }
  }

  await db
    .update(licenseDevicesTable)
    .set({ lastSeenAt: new Date().toISOString() })
    .where(eq(licenseDevicesTable.id, device.id));
  res.json(
    ValidateDeviceResponse.parse({
      valid: true,
      status: "active",
      deviceFingerprint: device.deviceFingerprint,
    }),
  );
});

// GET /license — admin: full key + device list.
router.get("/license", async (_req, res) => {
  const license = await getSingleLicense();
  if (!license) {
    res.status(404).json({ error: "No license issued" });
    return;
  }
  res.json(GetLicenseResponse.parse(await shapeLicense(license)));
});

// POST /license/issue — admin: one-time issue of the shop license.
router.post("/license/issue", async (req, res) => {
  const parsed = IssueLicenseBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const existing = await getSingleLicense();
  if (existing) {
    res.status(409).json({ error: "A license has already been issued" });
    return;
  }
  const licenseKey = parsed.data.licenseKey?.trim() || generateLicenseKey();
  const [created] = await db
    .insert(licensesTable)
    .values({
      licenseKey,
      plan: parsed.data.plan ?? undefined,
      maxDevices: parsed.data.maxDevices ?? undefined,
    })
    .returning();
  invalidateLicenseCache();
  res.status(200).json(IssueLicenseResponse.parse(await shapeLicense(created)));
});

// POST /license/devices/:id/deactivate — admin: free a slot (transfer step 1).
router.post("/license/devices/:id/deactivate", async (req, res) => {
  const params = DeactivateDeviceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [device] = await db
    .select()
    .from(licenseDevicesTable)
    .where(eq(licenseDevicesTable.id, params.data.id))
    .limit(1);
  if (!device) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  if (device.status === "active") {
    await db
      .update(licenseDevicesTable)
      .set({ status: "deactivated", deactivatedAt: new Date().toISOString() })
      .where(eq(licenseDevicesTable.id, device.id));
    invalidateLicenseCache();
  }
  const [license] = await db
    .select()
    .from(licensesTable)
    .where(eq(licensesTable.id, device.licenseId))
    .limit(1);
  if (!license) {
    res.status(404).json({ error: "License not found" });
    return;
  }
  res.json(DeactivateDeviceResponse.parse(await shapeLicense(license)));
});

// DELETE /license/:id — admin: revoke license (cascades devices).
router.delete("/license/:id", async (req, res) => {
  const params = RevokeLicenseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const deleted = await db
    .delete(licensesTable)
    .where(eq(licensesTable.id, params.data.id))
    .returning({ id: licensesTable.id });
  if (!deleted.length) {
    res.status(404).json({ error: "License not found" });
    return;
  }
  invalidateLicenseCache();
  res.status(204).end();
});

export default router;
