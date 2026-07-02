import { round2 } from "./ledger";

export type MarkupTier = {
  minCost: number;
  maxCost: number | null;
  markupPercent: number;
};

// Picks the best-matching markup tier for a cost: among tiers whose
// [minCost, maxCost] range contains the cost (maxCost null = open-ended), the
// most specific one wins (highest lower bound). Returns null when no tier
// applies or the cost is non-positive.
export const findMarkupTier = (
  cost: number,
  tiers: MarkupTier[],
): MarkupTier | null => {
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const matches = tiers.filter(
    (t) =>
      cost >= t.minCost &&
      (t.maxCost === null || t.maxCost === undefined || cost <= t.maxCost),
  );
  if (matches.length === 0) return null;
  // Most specific tier wins: the one with the highest lower bound.
  return matches.reduce((best, t) => (t.minCost > best.minCost ? t : best));
};

// Returns the matrix sell price for a cost, or null when no tier applies (or
// the cost is non-positive). Null means "leave the existing price untouched" —
// callers must NOT coerce this to 0, which would wipe manually-set prices.
// Markup is ALWAYS computed from cost, so re-applying never compounds.
export const priceFromMatrix = (
  cost: number,
  tiers: MarkupTier[],
): number | null => {
  const tier = findMarkupTier(cost, tiers);
  if (!tier) return null;
  return round2(cost * (1 + tier.markupPercent / 100));
};

// Convenience wrapper: returns the marked-up price, or the original cost when
// no tier applies. Use only where "fall back to cost" is intentional — never in
// bulk repricing or updates, where it would erase manual margins.
export const applyMarkup = (cost: number, tiers: MarkupTier[]): number => {
  const price = priceFromMatrix(cost, tiers);
  return price === null ? round2(Math.max(cost, 0)) : price;
};
