// ElevenLabs voice (STT + TTS) accessed through the Replit Connectors proxy.
// The proxy injects authentication automatically, so no API key lives in this
// codebase. Integration: connector `elevenlabs` (see the integrations skill).
//
// These helpers are intentionally OUTSIDE the OpenAPI/Orval codegen: the bodies
// are binary (audio upload / audio download) which do not fit the JSON pipeline.
import { ReplitConnectors } from "@replit/connectors-sdk";

// Selectable narration voices. The shop chooses one in settings to match the
// assistant's name; the value is stored as a coarse "male"/"female" key and
// mapped here to a concrete ElevenLabs voice id. "male" is "Adam" (warm,
// confident — the original default); "female" is "Rachel" (calm, clear).
const VOICE_IDS: Record<string, string> = {
  male: "pNInz6obpgDQGcFmaJgB",
  female: "21m00Tcm4TlvDq8ikWAM",
};
const DEFAULT_VOICE = "male";

// Resolve a stored voice key (e.g. "male"/"female") to an ElevenLabs voice id,
// falling back to the default voice when the key is unset or unrecognized.
export function resolveVoiceId(voice?: string | null): string {
  if (voice && Object.prototype.hasOwnProperty.call(VOICE_IDS, voice)) {
    return VOICE_IDS[voice];
  }
  return VOICE_IDS[DEFAULT_VOICE];
}

// Low-latency model so live voice mode stays responsive.
const TTS_MODEL_ID = "eleven_flash_v2_5";
const TTS_OUTPUT_FORMAT = "mp3_44100_128";
const STT_MODEL_ID = "scribe_v1";

export class VoiceError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "VoiceError";
    this.status = status;
  }
}

// Never cache the client — the SDK refreshes tokens internally per call.
function client(): ReplitConnectors {
  return new ReplitConnectors();
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

// Transcribe spoken audio into text. `audio` is the raw recording bytes and
// `mimeType` is its content type (e.g. "audio/webm"). Returns the transcript,
// which may be an empty string when nothing intelligible was said.
export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
): Promise<string> {
  const form = new FormData();
  const ext = mimeType.includes("webm")
    ? "webm"
    : mimeType.includes("mp4") || mimeType.includes("m4a")
      ? "mp4"
      : mimeType.includes("ogg")
        ? "ogg"
        : mimeType.includes("wav")
          ? "wav"
          : "mp3";
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    `audio.${ext}`,
  );
  form.append("model_id", STT_MODEL_ID);

  let resp: Response;
  try {
    resp = await client().proxy("elevenlabs", "/v1/speech-to-text", {
      method: "POST",
      body: form,
    });
  } catch (err) {
    throw new VoiceError(
      `Speech-to-text request failed: ${(err as Error).message}`,
    );
  }
  if (!isOk(resp.status)) {
    const detail = await resp.text().catch(() => "");
    throw new VoiceError(
      `Speech-to-text returned ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const data = (await resp.json()) as { text?: unknown };
  return typeof data.text === "string" ? data.text.trim() : "";
}

// Synthesize speech from text. Returns MP3 bytes (audio/mpeg). `voiceId`
// selects the ElevenLabs voice; pass the result of resolveVoiceId(). Defaults
// to the default voice when omitted.
export async function synthesizeSpeech(
  text: string,
  voiceId: string = resolveVoiceId(),
): Promise<Buffer> {
  let resp: Response;
  try {
    resp = await client().proxy(
      "elevenlabs",
      `/v1/text-to-speech/${voiceId}?output_format=${TTS_OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: TTS_MODEL_ID }),
      },
    );
  } catch (err) {
    throw new VoiceError(
      `Text-to-speech request failed: ${(err as Error).message}`,
    );
  }
  if (!isOk(resp.status)) {
    const detail = await resp.text().catch(() => "");
    throw new VoiceError(
      `Text-to-speech returned ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  return Buffer.from(await resp.arrayBuffer());
}
