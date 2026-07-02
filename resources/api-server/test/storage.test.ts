import { beforeAll, describe, expect, it } from "vitest";
import {
  registerUpload,
  isUploadTokenValid,
  markUploadConfirmed,
  registerConfirmedUpload,
  removeFromUploadRegistry,
  hasConfirmedUploadToken,
  MAX_OBJECT_UPLOAD_SIZE_BYTES,
} from "../src/lib/objectStorage";
import { agent, seedAdmin, type SeededAdmin } from "./helpers";

let admin: SeededAdmin;

beforeAll(async () => {
  admin = await seedAdmin();
});

const withAuth = (t: ReturnType<ReturnType<typeof agent>["get"]>) =>
  t.set("Cookie", admin.cookie).set("X-Forwarded-Proto", "https");
const authPost = (path: string) => withAuth(agent().post(path));

// ─────────────────────────────────────────────────────────────────────────────
// Upload registry — in-memory security invariants (no GCS required).
//
// These verify the core guarantees the finalization pattern relies on:
//   1. pending tokens do not grant preview/link access
//   2. removeFromUploadRegistry fully revokes any token (pending or confirmed)
//   3. registerConfirmedUpload creates a confirmed token without a pending step
//   4. after finalization, the old temp path is invalid and the new path is valid
// ─────────────────────────────────────────────────────────────────────────────
describe("upload registry – security invariants", () => {
  const TEMP  = "/objects/uploads/aaaaaaaa-test-0000-0000-storage-test001";
  const FINAL = "/objects/uploads/bbbbbbbb-test-0000-0000-storage-test002";
  const USER_1 = 10_001;
  const USER_2 = 10_002;

  it("pending token is valid only for the minting user", () => {
    registerUpload(TEMP, USER_1);
    expect(isUploadTokenValid(TEMP, USER_1)).toBe(true);
    expect(isUploadTokenValid(TEMP, USER_2)).toBe(false);
  });

  it("pending token does not satisfy hasConfirmedUploadToken", () => {
    registerUpload(TEMP, USER_1);
    expect(hasConfirmedUploadToken(TEMP, USER_1)).toBe(false);
  });

  it("markUploadConfirmed promotes pending to confirmed state", () => {
    registerUpload(TEMP, USER_1);
    expect(markUploadConfirmed(TEMP, USER_1)).toBe(true);
    expect(hasConfirmedUploadToken(TEMP, USER_1)).toBe(true);
  });

  it("markUploadConfirmed is rejected for a different user", () => {
    registerUpload(TEMP, USER_1);
    expect(markUploadConfirmed(TEMP, USER_2)).toBe(false);
    expect(hasConfirmedUploadToken(TEMP, USER_2)).toBe(false);
  });

  it("removeFromUploadRegistry invalidates a pending token", () => {
    registerUpload(TEMP, USER_1);
    removeFromUploadRegistry(TEMP);
    expect(isUploadTokenValid(TEMP, USER_1)).toBe(false);
    expect(hasConfirmedUploadToken(TEMP, USER_1)).toBe(false);
  });

  it("removeFromUploadRegistry invalidates a confirmed token", () => {
    registerUpload(TEMP, USER_1);
    markUploadConfirmed(TEMP, USER_1);
    removeFromUploadRegistry(TEMP);
    expect(isUploadTokenValid(TEMP, USER_1)).toBe(false);
    expect(hasConfirmedUploadToken(TEMP, USER_1)).toBe(false);
  });

  it("registerConfirmedUpload creates confirmed state without a prior pending step", () => {
    registerConfirmedUpload(FINAL, USER_1);
    expect(hasConfirmedUploadToken(FINAL, USER_1)).toBe(true);
    expect(hasConfirmedUploadToken(FINAL, USER_2)).toBe(false);
  });

  it("finalization pattern: old temp path revoked, new final path confirmed", () => {
    // Step 1 — mint URL → register pending token for the temp path.
    registerUpload(TEMP, USER_1);
    expect(isUploadTokenValid(TEMP, USER_1)).toBe(true);

    // Step 2 — confirm endpoint validates content, copies to FINAL, then:
    //   registerConfirmedUpload(FINAL, userId)   — marks new path as confirmed
    //   removeFromUploadRegistry(TEMP)           — invalidates old path
    registerConfirmedUpload(FINAL, USER_1);
    removeFromUploadRegistry(TEMP);

    // Old temp path must no longer pass any ownership check.
    expect(isUploadTokenValid(TEMP, USER_1)).toBe(false);
    expect(hasConfirmedUploadToken(TEMP, USER_1)).toBe(false);

    // New final path must be confirmed — only for the owning user.
    expect(hasConfirmedUploadToken(FINAL, USER_1)).toBe(true);
    expect(hasConfirmedUploadToken(FINAL, USER_2)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /storage/uploads/confirm — route-level access control.
//
// These tests exercise the pre-GCS authorization path (400 / 403 / 401)
// which does not require a live GCS connection.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /storage/uploads/confirm – access control", () => {
  it("returns 401 for unauthenticated requests", async () => {
    const res = await agent()
      .post("/api/storage/uploads/confirm")
      .send({ objectPath: "/objects/uploads/99999999-0000-0000-0000-notregistered" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when objectPath is missing", async () => {
    const res = await authPost("/api/storage/uploads/confirm").send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when objectPath does not start with /objects/", async () => {
    const res = await authPost("/api/storage/uploads/confirm").send({
      objectPath: "uploads/not-a-valid-path",
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 when the caller never minted an upload token for this path", async () => {
    const res = await authPost("/api/storage/uploads/confirm").send({
      objectPath: "/objects/uploads/99999999-0000-0000-0000-notregistered",
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/can only confirm uploads you initiated/i);
  });

  it("rejects a confirmed/finalized temp path (token removed after finalization)", async () => {
    // Simulate a prior finalization: register + confirm + remove the old path.
    const tempPath = "/objects/uploads/cccccccc-test-0000-0000-storage-test003";
    registerUpload(tempPath, admin.id);
    markUploadConfirmed(tempPath, admin.id);
    removeFromUploadRegistry(tempPath);

    // Attempting to re-confirm the old temp path must be rejected.
    const res = await authPost("/api/storage/uploads/confirm").send({
      objectPath: tempPath,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/can only confirm uploads you initiated/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /storage/uploads — proxied upload endpoint access control and counter.
//
// These tests exercise the pre-GCS authorization/validation path (401 / 400 /
// 410 / 413) and verify that the concurrency counter is properly released on
// all error paths, including parser rejection before the handler runs.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /storage/uploads – access control", () => {
  it("returns 401 for unauthenticated requests", async () => {
    const res = await agent()
      .post("/api/storage/uploads")
      .set("Content-Type", "image/jpeg")
      .send(Buffer.from("hello"));
    expect(res.status).toBe(401);
  });

  it("returns 400 for unsupported content type", async () => {
    const res = await authPost("/api/storage/uploads")
      .set("Content-Type", "image/svg+xml")
      .send(Buffer.from("<svg/>"));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported file type/i);
  });

  it("returns 400 for empty body", async () => {
    const res = await authPost("/api/storage/uploads")
      .set("Content-Type", "image/jpeg")
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty/i);
  });
});

describe("POST /storage/uploads/request-url – disabled (410)", () => {
  it("returns 410 Gone since the presigned-URL endpoint has been removed", async () => {
    const res = await authPost("/api/storage/uploads/request-url").send({
      name: "test.jpg",
      size: 1024,
      contentType: "image/jpeg",
    });
    expect(res.status).toBe(410);
    expect(res.body).toHaveProperty("error");
  });
});

describe("POST /storage/uploads – concurrency counter recovery", () => {
  it("releases the concurrency slot after an oversized body triggers a 413 parser rejection", async () => {
    // Sending a body larger than MAX_OBJECT_UPLOAD_SIZE_BYTES causes express.raw
    // to reject with 413 before the handler runs. Without the res.once('finish')
    // release, the concurrency counter would permanently leak — after
    // MAX_CONCURRENT_UPLOADS (3) such requests, all further uploads return 429.
    //
    // If any allocation is too slow in CI, note that body-parser checks
    // Content-Length upfront and rejects without reading the body. The full
    // buffer must still be provided for supertest to set Content-Length correctly.
    const oversizeBody = Buffer.alloc(MAX_OBJECT_UPLOAD_SIZE_BYTES + 1);

    // Three sequential oversized requests — each should get 413 (or the error
    // handler's normalized 400) and release its concurrency slot via res.finish.
    for (let i = 0; i < 3; i++) {
      const res = await authPost("/api/storage/uploads")
        .set("Content-Type", "image/jpeg")
        .send(oversizeBody);
      // body-parser emits 413; the global error handler normalizes to 400.
      expect([400, 413]).toContain(res.status);
    }

    // Counter must be back at 0. A fourth request must NOT receive 429 from
    // the concurrency guard. Acceptable outcomes (all prove the slot was released):
    //   201 — GCS write succeeded (best outcome; confirms full pipeline)
    //   400 — validation rejected the body (also proves handler was reached)
    //   500 — GCS unavailable (would fail at write, not at the concurrency gate)
    // Any of these mean the concurrency guard did NOT block the request.
    const followUp = await authPost("/api/storage/uploads")
      .set("Content-Type", "image/jpeg")
      .send(Buffer.from("jpeg-placeholder"));
    expect(followUp.status).not.toBe(429);
    expect([201, 400, 500]).toContain(followUp.status);
  }, 30_000); // generous timeout for 3×50 MB allocations
});
