import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The shared per-IP AI rate limiter (aiLimiter in routes/ai.ts) protects every
// /ai/* route from request floods, which would be slow and burn provider
// credits. Mock the OpenAI integration so successful requests never make a real
// network call and so the only thing that can produce a 429 is the limiter
// itself (not a provider error).
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import { agent, seedAdmin, type SeededAdmin } from "./helpers";

const mockedCreate = vi.mocked(openai.chat.completions.create);

// The limiter is module-level state shared across the whole /ai/* surface.
// Vitest isolates module state per test file, so this file starts with a fresh
// limiter window (0 of the 30 allowed requests used). Keep this assumption in
// one file: do not add other limiter-consuming AI tests here.
const LIMIT = 30;
// Must match aiLimiter's windowMs in routes/ai.ts (5 minutes). The limiter's
// MemoryStore decides whether to reset a client by comparing Date.now() to the
// client's resetTime, so advancing a stubbed Date.now() past this window is
// enough to simulate the cool-down without faking I/O timers (which would stall
// supertest's real network requests).
const WINDOW_MS = 5 * 60 * 1000;

let admin: SeededAdmin;

function assistant(cookie: string) {
  return agent()
    .post("/api/ai/assistant")
    .set("Cookie", cookie)
    .set("X-Forwarded-Proto", "https")
    .send({ messages: [{ role: "user", content: "Quick brake question." }] });
}

beforeAll(async () => {
  admin = await seedAdmin();
});

beforeEach(() => {
  mockedCreate.mockReset();
  mockedCreate.mockResolvedValue({
    choices: [{ message: { content: "Check the brake pads." } }],
  } as never);
});

describe("/ai/* shared rate limiter", () => {
  it("returns 429 once the per-IP window is exhausted", async () => {
    // Spend exactly the allowed budget. Every one of these must succeed —
    // otherwise the limit is misconfigured below the documented value.
    for (let i = 0; i < LIMIT; i += 1) {
      const res = await assistant(admin.cookie);
      expect(res.status).toBe(200);
    }

    // The next request crosses the limit and must be rejected with 429 and the
    // limiter's own error message (not a provider/empty-reply 502).
    const limited = await assistant(admin.cookie);
    expect(limited.status).toBe(429);
    expect((limited.body as { error: string }).error).toBe(
      "Too many AI requests. Please wait a moment and try again.",
    );

    // The provider must not be called for the rejected request: the limiter has
    // to short-circuit before the handler reaches OpenAI.
    expect(mockedCreate).toHaveBeenCalledTimes(LIMIT);
  });

  it("lets staff back in once the window has cooled down", async () => {
    // This file shares one limiter instance across tests, so start from a clean
    // window regardless of what earlier tests consumed: jump the clock forward
    // so the limiter resets and we get a fresh, deterministic budget. Using a
    // mutable closure for Date.now (rather than fake timers) keeps supertest's
    // real network I/O working.
    let clock = Date.now() + WINDOW_MS + 1000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      // Exhaust the whole budget in this fresh window, then confirm we are
      // actually rate-limited (so the recovery assertion below is meaningful).
      for (let i = 0; i < LIMIT; i += 1) {
        const res = await assistant(admin.cookie);
        expect(res.status).toBe(200);
      }
      const limited = await assistant(admin.cookie);
      expect(limited.status).toBe(429);

      // Cool-down: advance past the window. The next request must succeed again
      // (200) instead of staying permanently locked out — that's the recovery
      // behavior a misconfigured window/store reset would silently break.
      clock += WINDOW_MS + 1000;
      const recovered = await assistant(admin.cookie);
      expect(recovered.status).toBe(200);
      expect((recovered.body as { reply: string }).reply).toBeTruthy();
    } finally {
      nowSpy.mockRestore();
    }
  });
});
