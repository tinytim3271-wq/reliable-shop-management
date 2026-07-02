// Match an AI-suggested part description to a parts-catalog entry so estimates
// can use real shop pricing where it exists. The previous implementation did a
// normalized exact match plus a loose substring match in either direction, which
// produced clearly wrong hits (e.g. "oil filter" loosely matching a generic
// "filter" entry) and missed obvious matches with minor wording differences
// (plurals, word order). This version favors precise matches, uses token overlap
// for fuzzy matches, is SKU-aware, and returns a confidence signal so callers can
// surface uncertain matches as estimates rather than firm catalog prices.

export type MatchConfidence = "high" | "medium" | "low";

export type CatalogPart = {
  id: number;
  name: string;
  unitPrice: number;
  sku?: string | null;
};

export type PartMatch<T extends CatalogPart = CatalogPart> = {
  part: T;
  confidence: MatchConfidence;
};

// Lowercase, replace any non-alphanumeric run with a single space, and trim.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Crude singularization so plurals match their singular form ("pads" -> "pad",
// "plugs" -> "plug"). Only strip a trailing "s" from longer tokens to avoid
// mangling short tokens like "abs" or "gas".
function singularize(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(s: string): Set<string> {
  const normalized = normalize(s);
  if (!normalized) return new Set();
  return new Set(
    normalized
      .split(" ")
      .filter(Boolean)
      .map(singularize),
  );
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

// Dice coefficient over the two token sets: 2 * shared / (sizeA + sizeB).
function diceCoefficient(a: Set<string>, b: Set<string>): number {
  const total = a.size + b.size;
  if (total === 0) return 0;
  return (2 * intersectionSize(a, b)) / total;
}

type ScoredMatch = { confidence: MatchConfidence; dice: number };

// True when the normalized SKU appears in the normalized description as a whole
// word (boundary-padded substring). SKUs often contain separators (e.g. "OF-100"
// normalizes to "of 100"), so a single-token check would miss them.
function descriptionMentionsSku(normalizedDesc: string, sku: string): boolean {
  const normSku = normalize(sku);
  // Require a few alphanumeric chars so tiny/empty SKUs don't match loosely.
  if (normSku.replace(/ /g, "").length < 3) return false;
  return ` ${normalizedDesc} `.includes(` ${normSku} `);
}

// Score a single catalog candidate against the (already tokenized) description.
// Returns a confidence tier with its token-overlap strength, or null when the
// candidate is not a credible match.
function scoreCandidate(
  description: string,
  descTokens: Set<string>,
  part: CatalogPart,
): ScoredMatch | null {
  // 1. SKU match is unambiguous — if the description mentions the part's SKU,
  //    treat it as a confident match regardless of name wording.
  if (part.sku && descriptionMentionsSku(description, part.sku)) {
    return { confidence: "high", dice: 1 };
  }

  // 2. Exact normalized name equality.
  if (normalize(part.name) === description) return { confidence: "high", dice: 1 };

  // 3. Token overlap. Require shared tokens and a meaningful overlap ratio so we
  //    never match on a single generic token (the old "oil filter" -> "filter"
  //    bug). A lone shared token only counts when both names are multi-word and
  //    the overlap still dominates.
  const nameTokens = tokenize(part.name);
  if (nameTokens.size === 0) return null;
  const shared = intersectionSize(descTokens, nameTokens);
  if (shared === 0) return null;
  const dice = diceCoefficient(descTokens, nameTokens);

  // Identical token sets (just reordered / repluralized) are a precise match.
  if (dice >= 1) return { confidence: "high", dice };
  if (shared >= 2 && dice >= 0.7) return { confidence: "medium", dice };
  if (shared >= 2 && dice >= 0.5) return { confidence: "low", dice };
  if (shared >= 1 && descTokens.size >= 2 && nameTokens.size >= 2 && dice >= 0.5) {
    return { confidence: "low", dice };
  }
  return null;
}

const CONFIDENCE_RANK: Record<MatchConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const DOWNGRADE: Record<MatchConfidence, MatchConfidence> = {
  high: "medium",
  medium: "low",
  low: "low",
};

// Find the best catalog match for a free-text part description. Returns the
// matched part plus a confidence tier, or null when nothing matches credibly.
// Higher-confidence candidates win; ties are broken by token-overlap strength.
// When two distinct parts tie at the same confidence and overlap strength the
// match is genuinely ambiguous (e.g. "brake pads" between front and rear), so the
// result is downgraded one tier to signal uncertainty to the caller.
export function matchCatalogPart<T extends CatalogPart>(
  description: string,
  catalog: T[],
): PartMatch<T> | null {
  const desc = normalize(description);
  if (!desc) return null;
  const descTokens = tokenize(description);
  if (descTokens.size === 0) return null;

  let best: { part: T; confidence: MatchConfidence; dice: number } | null = null;
  let ambiguous = false;

  for (const part of catalog) {
    const scored = scoreCandidate(desc, descTokens, part);
    if (!scored) continue;
    if (!best) {
      best = { part, confidence: scored.confidence, dice: scored.dice };
      continue;
    }
    const rankDiff =
      CONFIDENCE_RANK[scored.confidence] - CONFIDENCE_RANK[best.confidence];
    const diceDiff = scored.dice - best.dice;
    if (rankDiff > 0 || (rankDiff === 0 && diceDiff > 1e-9)) {
      best = { part, confidence: scored.confidence, dice: scored.dice };
      ambiguous = false;
    } else if (
      rankDiff === 0 &&
      Math.abs(diceDiff) < 1e-9 &&
      part.id !== best.part.id
    ) {
      // Genuine tie: the match is ambiguous, so downgrade confidence. Break the
      // tie deterministically by lowest id (oldest part) so callers don't depend
      // on catalog ordering.
      ambiguous = true;
      if (part.id < best.part.id) {
        best = { part, confidence: scored.confidence, dice: scored.dice };
      }
    }
  }

  if (!best) return null;
  const confidence = ambiguous ? DOWNGRADE[best.confidence] : best.confidence;
  return { part: best.part, confidence };
}
