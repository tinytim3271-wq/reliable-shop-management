import { describe, expect, it } from "vitest";
import {
  applyMarkup,
  findMarkupTier,
  priceFromMatrix,
  type MarkupTier,
} from "../src/lib/pricing";

const tiers: MarkupTier[] = [
  { minCost: 0, maxCost: 50, markupPercent: 100 },
  { minCost: 50, maxCost: 200, markupPercent: 50 },
  { minCost: 200, maxCost: null, markupPercent: 25 },
];

describe("findMarkupTier", () => {
  it("picks the most specific tier (highest lower bound) on overlap", () => {
    // 50 is in both [0,50] and [50,200]; the higher-minCost tier wins.
    expect(findMarkupTier(50, tiers)?.markupPercent).toBe(50);
  });

  it("treats a null maxCost as open-ended", () => {
    expect(findMarkupTier(10_000, tiers)?.markupPercent).toBe(25);
  });

  it("returns null when no tier matches or cost is non-positive", () => {
    expect(findMarkupTier(0, tiers)).toBeNull();
    expect(findMarkupTier(-5, tiers)).toBeNull();
    expect(findMarkupTier(40, [{ minCost: 100, maxCost: 200, markupPercent: 10 }])).toBeNull();
  });
});

describe("priceFromMatrix", () => {
  it("computes the sell price from cost using the matching tier", () => {
    expect(priceFromMatrix(40, tiers)).toBe(80); // 100% markup
    expect(priceFromMatrix(100, tiers)).toBe(150); // 50% markup
    expect(priceFromMatrix(400, tiers)).toBe(500); // 25% markup
  });

  it("is idempotent: it always computes from cost, never compounding", () => {
    const cost = 100;
    const once = priceFromMatrix(cost, tiers);
    const twice = priceFromMatrix(cost, tiers);
    expect(once).toBe(twice);
  });

  it("returns null (do not touch the price) when no tier matches", () => {
    expect(priceFromMatrix(40, [{ minCost: 100, maxCost: 200, markupPercent: 10 }])).toBeNull();
  });

  it("returns null for a non-positive cost so manual prices are preserved", () => {
    expect(priceFromMatrix(0, tiers)).toBeNull();
    expect(priceFromMatrix(-1, tiers)).toBeNull();
  });
});

describe("applyMarkup wrapper", () => {
  it("falls back to the cost when no tier applies", () => {
    expect(applyMarkup(40, [{ minCost: 100, maxCost: 200, markupPercent: 10 }])).toBe(40);
  });

  it("clamps a non-positive cost to 0", () => {
    expect(applyMarkup(-10, tiers)).toBe(0);
  });
});
