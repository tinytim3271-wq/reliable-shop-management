import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// POST /ai/voice/speak resolves the shop's stored male/female voice choice into
// a concrete ElevenLabs voice id at speak time and proxies a text-to-speech
// request to the ElevenLabs connector. The voice id is encoded into the proxy
// URL path (/v1/text-to-speech/<voiceId>?...), so mock the connectors SDK and
// capture that URL to prove the saved setting reaches the synthesize call —
// without ever making a real network request.
const { proxyMock } = vi.hoisted(() => ({ proxyMock: vi.fn() }));

vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: vi.fn().mockImplementation(function () {
    return { proxy: proxyMock };
  }),
}));

import { db, shopSettingsTable } from "@workspace/db";
import { agent, seedAdmin, type SeededAdmin } from "./helpers";

// Voice ids must mirror the mapping in src/lib/elevenlabs.ts.
const ADAM_MALE_VOICE_ID = "pNInz6obpgDQGcFmaJgB";
const RACHEL_FEMALE_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

let admin: SeededAdmin;

// Settings is a singleton row (id=1) shared across the run database, so write
// assistantVoice straight to the row to control resolution (including unknown
// values the public enum-validated PUT /settings would reject).
async function setVoice(voice: string): Promise<void> {
  await db.insert(shopSettingsTable).values({ id: 1 }).onConflictDoNothing();
  await db
    .update(shopSettingsTable)
    .set({ assistantVoice: voice })
    .where(eq(shopSettingsTable.id, 1));
}

function speak(cookie: string, text: string) {
  return agent()
    .post("/api/ai/voice/speak")
    .set("Cookie", cookie)
    .set("X-Forwarded-Proto", "https")
    .send({ text });
}

// The synthesize handler reads resp.status then resp.arrayBuffer(); return an
// OK response carrying a tiny MP3 payload so the route succeeds.
function okAudioResponse() {
  return {
    status: 200,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  };
}

// Pull the voice id out of the captured proxy URL path.
function voiceIdFromProxyCall(): string {
  const url = proxyMock.mock.calls[0]?.[1] as string | undefined;
  const match = url?.match(/\/v1\/text-to-speech\/([^?]+)/);
  return match?.[1] ?? "";
}

beforeAll(async () => {
  admin = await seedAdmin();
});

beforeEach(() => {
  proxyMock.mockReset();
  proxyMock.mockResolvedValue(okAudioResponse());
});

afterEach(async () => {
  // Leave the shared singleton on its schema default so other files are not
  // perturbed by whatever value this suite last set.
  await setVoice("male");
});

describe("POST /ai/voice/speak voice selection", () => {
  it("passes the female voice id to ElevenLabs when assistantVoice is 'female'", async () => {
    await setVoice("female");

    const res = await speak(admin.cookie, "Brake pads look fine.");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");
    expect(proxyMock).toHaveBeenCalledTimes(1);
    expect(proxyMock.mock.calls[0]?.[0]).toBe("elevenlabs");
    expect(voiceIdFromProxyCall()).toBe(RACHEL_FEMALE_VOICE_ID);
  });

  it("falls back to the default Adam (male) voice for an unknown stored value", async () => {
    await setVoice("robot");

    const res = await speak(admin.cookie, "Rotors are within spec.");

    expect(res.status).toBe(200);
    expect(proxyMock).toHaveBeenCalledTimes(1);
    expect(voiceIdFromProxyCall()).toBe(ADAM_MALE_VOICE_ID);
  });
});
