import { describe, expect, it } from "vitest";
import { matchCatalogPart, type CatalogPart } from "../src/lib/partMatch";

const catalog: CatalogPart[] = [
  { id: 1, name: "Oil Filter", unitPrice: 12.99, sku: "OF-100" },
  { id: 2, name: "Filter", unitPrice: 5.0, sku: null },
  { id: 3, name: "Front Brake Pads", unitPrice: 45.0, sku: "BP-FR" },
  { id: 4, name: "Rear Brake Pads", unitPrice: 42.0, sku: "BP-RR" },
  { id: 5, name: "Spark Plug", unitPrice: 8.5, sku: null },
  { id: 6, name: "Engine Air Filter", unitPrice: 18.0, sku: null },
];

describe("matchCatalogPart", () => {
  it("returns null for empty or whitespace descriptions", () => {
    expect(matchCatalogPart("", catalog)).toBeNull();
    expect(matchCatalogPart("   ", catalog)).toBeNull();
  });

  it("matches an exact (normalized) name with high confidence", () => {
    const m = matchCatalogPart("oil filter", catalog);
    expect(m?.part.id).toBe(1);
    expect(m?.confidence).toBe("high");
  });

  it("ignores punctuation and casing in exact matches", () => {
    const m = matchCatalogPart("  OIL-FILTER ", catalog);
    expect(m?.part.id).toBe(1);
    expect(m?.confidence).toBe("high");
  });

  it("matches by SKU token with high confidence", () => {
    const m = matchCatalogPart("replace filter of-100", catalog);
    expect(m?.part.id).toBe(1);
    expect(m?.confidence).toBe("high");
  });

  it("does NOT loosely match a specific description to a generic single-token part", () => {
    // The old bug: "oil filter" loosely matched the generic "Filter" entry.
    // Now the specific "Oil Filter" wins, never the generic "Filter".
    const m = matchCatalogPart("oil filter", catalog);
    expect(m?.part.name).toBe("Oil Filter");
  });

  it("does not match a generic single-token catalog entry from a multi-word description", () => {
    const generic: CatalogPart[] = [{ id: 2, name: "Filter", unitPrice: 5, sku: null }];
    expect(matchCatalogPart("cabin air filter", generic)).toBeNull();
  });

  it("matches minor wording differences (extra words) with medium confidence", () => {
    const m = matchCatalogPart("engine oil filter", catalog);
    expect(m?.part.id).toBe(1);
    expect(m?.confidence).toBe("medium");
  });

  it("matches word-order differences", () => {
    const m = matchCatalogPart("brake pads front", catalog);
    expect(m?.part.id).toBe(3);
    expect(["high", "medium"]).toContain(m?.confidence);
  });

  it("handles plurals via singularization", () => {
    const m = matchCatalogPart("spark plugs", catalog);
    expect(m?.part.id).toBe(5);
    expect(["high", "medium"]).toContain(m?.confidence);
  });

  it("treats front-vs-rear distinctions as low confidence, not a firm match", () => {
    // "brake pads" alone overlaps both front and rear pads; the result should be
    // a low-confidence match so the caller keeps the estimated price.
    const m = matchCatalogPart("brake pads", catalog);
    expect(m).not.toBeNull();
    expect(m?.confidence).toBe("low");
  });

  it("returns null when nothing credibly overlaps", () => {
    expect(matchCatalogPart("alternator", catalog)).toBeNull();
    expect(matchCatalogPart("windshield wiper blade", catalog)).toBeNull();
  });

  it("prefers higher-confidence matches over weaker ones", () => {
    const m = matchCatalogPart("oil filter of-100", catalog);
    expect(m?.part.id).toBe(1);
    expect(m?.confidence).toBe("high");
  });
});
