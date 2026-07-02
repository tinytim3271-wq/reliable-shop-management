import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import { authGate } from "../lib/auth";
import mechanicsRouter from "./mechanics";
import timeEntriesRouter from "./timeEntries";
import advancesRouter from "./advances";
import loansRouter from "./loans";
import reportsRouter from "./reports";
import customersRouter from "./customers";
import vehiclesRouter from "./vehicles";
import workOrdersRouter from "./workOrders";
import partsRouter from "./parts";
import purchaseOrdersRouter from "./purchaseOrders";
import vendorsRouter from "./vendors";
import appointmentsRouter from "./appointments";
import importRouter from "./import";
import estimatesRouter from "./estimates";
import invoicesRouter from "./invoices";
import settingsRouter from "./settings";
import lineItemPresetsRouter from "./lineItemPresets";
import pricingRouter from "./pricing";
import inspectionTemplatesRouter from "./inspectionTemplates";
import inspectionsRouter from "./inspections";
import storageRouter from "./storage";
import expensesRouter from "./expenses";
import employeesRouter from "./employees";
import formCustomizationRouter from "./formCustomization";
import messagesRouter from "./messages";
import messageTemplatesRouter from "./messageTemplates";
import smsConsentEventsRouter from "./smsConsentEvents";
import aiRouter from "./ai";
import aiAgentRouter from "./aiAgent";
import aiVoiceRouter from "./aiVoice";
import licenseRouter from "./license";
import adminStoreRouter from "./adminStore";
import publicRouter from "./public";
import portalRouter from "./portal";
import storeRouter from "./store";
import twilioInboundRouter from "./twilioInbound";
import qboRouter, { qboCallbackRouter } from "./integrations/qbo";
import { licenseGate } from "../lib/licensing";
import { runtimeConfig } from "@workspace/db";

const router: IRouter = Router();

// Public routes (no authentication required).
router.use(healthRouter);
router.use(authRouter);

// Public, unauthenticated surface (shop website + online booking). Mounted
// before authGate AND licenseGate so anonymous customers can reach it; it
// carries its own per-IP rate limiting and never exposes customer PII.
router.use(publicRouter);

// Public customer portal (per-record opaque tokens). Also mounted before
// authGate/licenseGate; the token itself is the bearer credential and the
// router enforces its own rate limiting.
router.use(portalRouter);

// Public inbound SMS webhook (two-way texting). Mounted before authGate AND
// licenseGate because the caller is Twilio, not a staff session; it
// authenticates by verifying the X-Twilio-Signature against the account auth
// token, stays inert when Twilio is not connected, and rate-limits per IP.
router.use(twilioInboundRouter);

// Public license storefront (catalog, checkout, order lookup). Mounted before
// authGate AND licenseGate so anonymous buyers can purchase; it carries its own
// per-IP rate limiting and sources all prices/entitlements server-side. Skipped
// in desktop mode: the offline hub has no Stripe and sells no licenses itself.
if (!runtimeConfig.isDesktop) {
  router.use(storeRouter);
}

// QuickBooks OAuth redirect callback is public: Intuit redirects the owner's
// browser here with a code + the state we minted. It validates/consumes that
// single-use state itself, so it sits before authGate (like the storefront).
router.use(qboCallbackRouter);

// Everything below this gate requires a valid session + the right permission.
router.use(authGate);

// License endpoints sit above the device gate so activation/status/validation
// stay reachable before a device is registered.
router.use(licenseRouter);

// Once a license is provisioned, every data route below requires a registered
// device token. Unprovisioned = no-op (the app runs freely until a key issues).
router.use(licenseGate);

router.use(usersRouter);
router.use(mechanicsRouter);
router.use(timeEntriesRouter);
router.use(advancesRouter);
router.use(loansRouter);
router.use(reportsRouter);
router.use(customersRouter);
router.use(vehiclesRouter);
router.use(workOrdersRouter);
router.use(partsRouter);
router.use(purchaseOrdersRouter);
router.use(vendorsRouter);
router.use(appointmentsRouter);
router.use(importRouter);
router.use(estimatesRouter);
router.use(invoicesRouter);
router.use(settingsRouter);
router.use(lineItemPresetsRouter);
router.use(pricingRouter);
router.use(inspectionTemplatesRouter);
router.use(inspectionsRouter);
router.use(storageRouter);

router.use(expensesRouter);
router.use(employeesRouter);
router.use(formCustomizationRouter);
router.use(messagesRouter);
router.use(messageTemplatesRouter);
router.use(smsConsentEventsRouter);
router.use(aiRouter);
router.use(aiAgentRouter);
router.use(aiVoiceRouter);
router.use(qboRouter);
router.use(adminStoreRouter);

export default router;
