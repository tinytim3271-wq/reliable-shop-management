import { describe, expect, it } from "vitest";
import { normalizeToE164 } from "../src/lib/phone";

// Pure-function unit tests for the E.164 normalizer. No DB or HTTP — this is the
// single source of truth for how loosely-entered numbers are coerced before
// they reach Twilio.
describe("normalizeToE164", () => {
  it("normalizes a formatted 10-digit NANP number to E.164", () => {
    expect(normalizeToE164("(555) 123-4567")).toBe("+15551234567");
    expect(normalizeToE164("555.123.4567")).toBe("+15551234567");
    expect(normalizeToE164("555 123 4567")).toBe("+15551234567");
  });

  it("prefixes + on an 11-digit number that already carries the US country code", () => {
    expect(normalizeToE164("1-555-123-4567")).toBe("+15551234567");
    expect(normalizeToE164("15551234567")).toBe("+15551234567");
  });

  it("keeps an already-international number and strips its separators", () => {
    expect(normalizeToE164("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeToE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("rejects too-short numbers", () => {
    expect(normalizeToE164("555-1234")).toBeNull();
    expect(normalizeToE164("12345")).toBeNull();
  });

  it("rejects empty / blank input", () => {
    expect(normalizeToE164("")).toBeNull();
    expect(normalizeToE164("   ")).toBeNull();
    expect(normalizeToE164("abc")).toBeNull();
  });

  it("rejects an international number whose country code starts with 0 or is too long", () => {
    expect(normalizeToE164("+0123456789")).toBeNull();
    expect(normalizeToE164("+1234567890123456")).toBeNull();
  });
});
