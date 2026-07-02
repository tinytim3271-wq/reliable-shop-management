import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The /ai/assistant handler calls the OpenAI integration directly. Mock the
// whole module so the suite never makes a real network call and we fully
// control the reply the handler wraps. Mocking the module also sidesteps the
// import-time env checks in the real OpenAI client.
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn() } },
  },
}));

import { openai } from "@workspace/integrations-openai-ai-server";
import { agent, seedAdmin, seedStaffUser, type SeededAdmin } from "./helpers";

const mockedCreate = vi.mocked(openai.chat.completions.create);

let admin: SeededAdmin;

// The assistant returns the model's text verbatim (no JSON schema), so the mock
// just needs to yield a chat completion whose first choice carries content.
function mockReply(content: string | null | undefined) {
  mockedCreate.mockResolvedValue({
    choices: [{ message: { content } }],
  } as never);
}

function assistant(cookie: string, body: Record<string, unknown>) {
  return agent()
    .post("/api/ai/assistant")
    .set("Cookie", cookie)
    .set("X-Forwarded-Proto", "https")
    .send(body);
}

beforeAll(async () => {
  admin = await seedAdmin();
});

beforeEach(() => {
  mockedCreate.mockReset();
});

describe("/ai/assistant conversational shop assistant", () => {
  it("returns the model reply plus a disclaimer for an authenticated caller", async () => {
    mockReply("Start by checking the brake pad thickness.");

    const res = await assistant(admin.cookie, {
      messages: [
        { role: "user", content: "Grinding noise when braking, where do I start?" },
      ],
    });

    expect(res.status).toBe(200);
    const body = res.body as { reply: string; disclaimer: string };

    expect(body.reply).toBe("Start by checking the brake pad thickness.");
    expect(typeof body.disclaimer).toBe("string");
    expect(body.disclaimer.length).toBeGreaterThan(0);
  });

  it("trims surrounding whitespace from the model reply", async () => {
    mockReply("\n  Check the alternator output.  \n");

    const res = await assistant(admin.cookie, {
      messages: [{ role: "user", content: "Battery keeps dying overnight." }],
    });

    expect(res.status).toBe(200);
    expect((res.body as { reply: string }).reply).toBe(
      "Check the alternator output.",
    );
  });

  it("forwards the full message history (incl. vehicle context) to the model", async () => {
    mockReply("Torque the lug nuts to spec and confirm against service info.");

    const res = await assistant(admin.cookie, {
      messages: [
        { role: "user", content: "What torque for the wheels?" },
        { role: "assistant", content: "Which vehicle are we on?" },
        { role: "user", content: "The Corolla on the lift." },
      ],
      vehicleYear: 2018,
      vehicleMake: "Toyota",
      vehicleModel: "Corolla",
    });

    expect(res.status).toBe(200);
    expect(mockedCreate).toHaveBeenCalledTimes(1);

    const [payload] = mockedCreate.mock.calls[0] as [
      { messages: Array<{ role: string; content: string }> },
    ];
    // System prompt is prepended, then every client message is passed through
    // in order.
    expect(payload.messages[0].role).toBe("system");
    expect(payload.messages[0].content).toContain("2018 Toyota Corolla");
    expect(payload.messages.slice(1)).toEqual([
      { role: "user", content: "What torque for the wheels?" },
      { role: "assistant", content: "Which vehicle are we on?" },
      { role: "user", content: "The Corolla on the lift." },
    ]);
  });

  it("returns 502 when the provider yields an empty reply", async () => {
    mockReply("   ");

    const res = await assistant(admin.cookie, {
      messages: [{ role: "user", content: "Hello?" }],
    });

    expect(res.status).toBe(502);
  });

  it("rejects an invalid request body (no messages) with 400", async () => {
    mockReply("unused");

    const res = await assistant(admin.cookie, { messages: [] });

    expect(res.status).toBe(400);
    // The model must not be called when the body fails validation.
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("stays available to a permission-scoped non-admin staff user", async () => {
    // The threat model treats the AI surface as reachable by ANY authenticated
    // staff user, regardless of their module permissions. Seed a technician
    // scoped to a single unrelated module (workOrders) and confirm the
    // assistant still answers — guarding against an accidental permission gate
    // on this route.
    const staff = await seedStaffUser(["workOrders"]);
    mockReply("Bleed the brakes and recheck pedal feel.");

    const res = await assistant(staff.cookie, {
      messages: [{ role: "user", content: "Spongy brake pedal, what next?" }],
    });

    expect(res.status).toBe(200);
    const body = res.body as { reply: string; disclaimer: string };
    expect(body.reply).toBe("Bleed the brakes and recheck pedal feel.");
    expect(typeof body.disclaimer).toBe("string");
    expect(body.disclaimer.length).toBeGreaterThan(0);
  });

  it("requires authentication", async () => {
    mockReply("unused");

    const res = await agent()
      .post("/api/ai/assistant")
      .set("X-Forwarded-Proto", "https")
      .send({ messages: [{ role: "user", content: "Hi" }] });

    expect(res.status).toBe(401);
    // An unauthenticated request must never reach the AI provider.
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
