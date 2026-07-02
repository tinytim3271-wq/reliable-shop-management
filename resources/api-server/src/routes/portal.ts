import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { rateLimit } from "express-rate-limit";
import {
  GetPortalViewParams,
  GetPortalViewResponse,
  ApprovePortalEstimateParams,
  ApprovePortalEstimateResponse,
  DeclinePortalEstimateParams,
  DeclinePortalEstimateResponse,
} from "@workspace/api-zod";
import { csrfCheck } from "../lib/auth";
import {
  resolvePortalToken,
  buildPortalView,
  respondToEstimate,
  isPortalPhotoPathLive,
} from "../lib/portal";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  SAFE_INLINE_CONTENT_TYPES,
} from "../lib/objectStorage";

// Public, unauthenticated customer portal (M4): a customer holding an opaque
// per-record token can view their own estimate/invoice and approve/decline an
// estimate. Mounted before authGate and licenseGate, so this router carries its
// own per-IP rate limiting. Unknown/expired/revoked tokens always collapse to a
// single uniform 404 so the surface cannot be used to enumerate records.

const router: IRouter = Router();

const NOT_FOUND = "This link is invalid or has expired.";

const portalReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Photo fetches need a higher budget than view loads: a single portal page can
// request many images at once. Still per-IP bounded so the endpoint cannot be
// used to hammer object storage.
const portalPhotoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const objectStorageService = new ObjectStorageService();

// Approvals/declines are rare per customer — keep the budget tight per IP.
const portalActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

router.get(
  "/public/portal/:token",
  portalReadLimiter,
  async (req, res): Promise<void> => {
    const params = GetPortalViewParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    const token = await resolvePortalToken(params.data.token);
    if (!token) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    const view = await buildPortalView(token);
    if (!view) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    res.json(GetPortalViewResponse.parse(view));
  },
);

// Public, token-scoped photo stream. A customer holding a valid token can fetch
// only the photos attached to the work order behind their estimate/invoice —
// the requested object path is verified against that work order's photoUrls, so
// the endpoint cannot be used to read arbitrary object paths. Non-image content
// is forced to download to prevent active-content execution on this origin.
router.get(
  "/public/portal/:token/photos/*objectPath",
  portalPhotoLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const rawToken = (req.params as Record<string, unknown>).token;
    const token = await resolvePortalToken(
      Array.isArray(rawToken) ? rawToken[0] : (rawToken as string | undefined),
    );
    if (!token) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }

    const raw = (req.params as Record<string, unknown>).objectPath;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
    const objectPath = `/objects/${wildcardPath}`;

    if (!(await isPortalPhotoPathLive(token, objectPath))) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }

    try {
      const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
      const response = await objectStorageService.downloadObject(objectFile);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.setHeader("X-Content-Type-Options", "nosniff");

      const storedContentType = (
        response.headers.get("Content-Type") ?? "application/octet-stream"
      )
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!SAFE_INLINE_CONTENT_TYPES.has(storedContentType)) {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", "attachment");
      }

      if (response.body) {
        const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: NOT_FOUND });
        return;
      }
      req.log.error({ err: error }, "Error serving portal photo");
      res.status(500).json({ error: "Failed to serve photo" });
    }
  },
);

router.post(
  "/public/portal/:token/approve",
  // csrfCheck first so rejected cross-origin requests do not consume a
  // legitimate caller's rate-limit budget.
  csrfCheck,
  portalActionLimiter,
  async (req, res): Promise<void> => {
    const params = ApprovePortalEstimateParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    const token = await resolvePortalToken(params.data.token);
    if (!token) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    const result = await respondToEstimate(token, "approved");
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(ApprovePortalEstimateResponse.parse(result.view));
  },
);

router.post(
  "/public/portal/:token/decline",
  csrfCheck,
  portalActionLimiter,
  async (req, res): Promise<void> => {
    const params = DeclinePortalEstimateParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    const token = await resolvePortalToken(params.data.token);
    if (!token) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    const result = await respondToEstimate(token, "declined");
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(DeclinePortalEstimateResponse.parse(result.view));
  },
);

export default router;
