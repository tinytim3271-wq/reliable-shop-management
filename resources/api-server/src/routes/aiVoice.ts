import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { db, shopSettingsTable } from "@workspace/db";
import {
  transcribeAudio,
  synthesizeSpeech,
  resolveVoiceId,
  VoiceError,
} from "../lib/elevenlabs";

const router: IRouter = Router();

// Voice turns proxy to ElevenLabs (provider cost). A live conversation issues
// roughly one transcribe + one speak per turn, so allow more headroom than the
// agent loop limiter while still bounding abuse.
const voiceLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many voice requests. Please wait a moment." },
});

function isAuthed(req: Request): boolean {
  return Boolean(req.currentUser);
}

// Per-user in-flight transcription counter. express.raw() buffers the entire
// audio body (up to 8 MB) in RAM before the handler runs. Without a concurrency
// cap a single session could open MAX_RATE_LIMIT parallel uploads and exhaust
// server memory. We enforce a small per-user concurrent-request ceiling so the
// body is never buffered for excess requests.
const activeTrans = new Map<number, number>();
const MAX_CONCURRENT_TRANS_PER_USER = 2;

function transcribeAuthAndConcurrencyGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isAuthed(req)) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const userId = req.currentUser!.id;
  const active = activeTrans.get(userId) ?? 0;
  if (active >= MAX_CONCURRENT_TRANS_PER_USER) {
    res.status(429).json({
      error: "Too many concurrent transcription requests. Please wait for the previous one to finish.",
    });
    return;
  }
  activeTrans.set(userId, active + 1);
  // Decrement the slot exactly once, whichever event fires first:
  // "finish" fires after a normal response; "close" fires on aborted connections
  // and must also be handled to prevent slot leaks that would permanently block
  // the user from making further transcription requests.
  let released = false;
  const releaseSlot = () => {
    if (released) return;
    released = true;
    const cur = activeTrans.get(userId) ?? 1;
    if (cur <= 1) activeTrans.delete(userId);
    else activeTrans.set(userId, cur - 1);
  };
  res.on("finish", releaseSlot);
  res.on("close", releaseSlot);
  next();
}

const SpeakBody = z.object({
  text: z.string().trim().min(1).max(1000),
  // Optional voice override so Settings can preview a voice before it is saved.
  // Only "male"/"female" are accepted (anything else is rejected with 400); when
  // omitted, the stored shop voice is used instead.
  voice: z.enum(["male", "female"]).optional(),
});

// POST /ai/voice/transcribe — raw audio bytes in, transcript out. The global
// express.json (100kb) never touches audio content-types, so parse the body
// here with a generous-but-bounded raw limit.
//
// Auth and per-user concurrency are enforced BEFORE express.raw() so the body
// is never buffered for unauthenticated or over-limit requests (preventing a
// memory-exhaustion DoS by a single session opening many large parallel uploads).
router.post(
  "/ai/voice/transcribe",
  voiceLimiter,
  transcribeAuthAndConcurrencyGate,
  express.raw({ type: ["audio/*", "application/octet-stream"], limit: "8mb" }),
  async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Expected non-empty audio body" });
      return;
    }
    const mimeType =
      req.get("content-type")?.split(";", 1)[0].trim() || "audio/webm";
    try {
      const text = await transcribeAudio(body, mimeType);
      res.json({ text });
    } catch (err) {
      if (err instanceof VoiceError) {
        req.log.warn({ err }, "Voice transcription failed");
        res.status(err.status).json({ error: "Could not transcribe audio." });
        return;
      }
      req.log.error({ err }, "Voice transcription error");
      res.status(500).json({ error: "Could not transcribe audio." });
    }
  },
);

// POST /ai/voice/speak — JSON { text } in, audio/mpeg bytes out.
router.post("/ai/voice/speak", voiceLimiter, async (req, res) => {
  if (!isAuthed(req)) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const parsed = SpeakBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  try {
    const [settings] = await db
      .select({ assistantVoice: shopSettingsTable.assistantVoice })
      .from(shopSettingsTable)
      .where(eq(shopSettingsTable.id, 1));
    const voiceId = resolveVoiceId(settings?.assistantVoice);
    const audio = await synthesizeSpeech(parsed.data.text, voiceId);
    res.setHeader("content-type", "audio/mpeg");
    res.setHeader("cache-control", "no-store");
    res.send(audio);
  } catch (err) {
    if (err instanceof VoiceError) {
      req.log.warn({ err }, "Voice synthesis failed");
      res.status(err.status).json({ error: "Could not generate speech." });
      return;
    }
    req.log.error({ err }, "Voice synthesis error");
    res.status(500).json({ error: "Could not generate speech." });
  }
});

export default router;
