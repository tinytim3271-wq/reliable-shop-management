import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  extractDocumentText,
  isExtractableDocumentType,
  DocumentExtractError,
  DOCUMENT_TEXT_CHAR_LIMIT,
} from "../src/lib/documentExtract";

// Unit tests for the server-side document text extractor that feeds attached
// documents into a single AI chat turn (see aiAgent.buildDocumentContext). The
// extractor selects a parser from the server-trusted content type, fails loudly
// (DocumentExtractError) on unsupported/empty input, and trims overlong text.
//
// DOCX and PDF have no writer dependency in this repo, so this file builds the
// smallest valid buffers each parser accepts: a store-only (uncompressed) ZIP
// for DOCX and a hand-assembled single-page PDF. XLSX is produced by the same
// `xlsx` library the extractor reads with.

// ── Minimal store-only ZIP writer (for DOCX) ────────────────────────────────
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function zipStore(files: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.data, "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // store (no compression)
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`)
    .join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return zipStore([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "word/document.xml", data: documentXml },
  ]);
}

// ── Minimal single-page PDF writer ──────────────────────────────────────────
function makePdf(lines: string[]): Buffer {
  let content = "BT /F1 18 Tf 72 720 Td 20 TL ";
  lines.forEach((ln, i) => {
    const esc = ln
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
    content += i === 0 ? `(${esc}) Tj ` : `T* (${esc}) Tj `;
  });
  content += "ET";
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${Buffer.byteLength(content)}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((bodyText, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${bodyText}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

function makeXlsx(rows: string[][], sheetName = "Sheet1"): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("isExtractableDocumentType", () => {
  it("accepts the supported document MIME types, ignoring params and case", () => {
    expect(isExtractableDocumentType("application/pdf")).toBe(true);
    expect(isExtractableDocumentType("text/csv; charset=utf-8")).toBe(true);
    expect(isExtractableDocumentType("TEXT/PLAIN")).toBe(true);
    expect(isExtractableDocumentType("text/tab-separated-values")).toBe(true);
    expect(
      isExtractableDocumentType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(true);
    expect(
      isExtractableDocumentType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(true);
  });

  it("rejects unsupported types", () => {
    expect(isExtractableDocumentType("image/png")).toBe(false);
    expect(isExtractableDocumentType("application/zip")).toBe(false);
    expect(isExtractableDocumentType("")).toBe(false);
  });
});

describe("extractDocumentText — text formats", () => {
  it("extracts plain text (text/plain)", async () => {
    const { text, truncated } = await extractDocumentText(
      Buffer.from("  Hello plain text.\nSecond line.  ", "utf8"),
      "text/plain",
    );
    expect(text).toBe("Hello plain text.\nSecond line.");
    expect(truncated).toBe(false);
  });

  it("extracts CSV content (text/csv)", async () => {
    const { text } = await extractDocumentText(
      Buffer.from("name,qty\nbrake pad,4\n", "utf8"),
      "text/csv",
    );
    expect(text).toContain("name,qty");
    expect(text).toContain("brake pad,4");
  });

  it("extracts TSV content (text/tab-separated-values)", async () => {
    const { text } = await extractDocumentText(
      Buffer.from("name\tqty\noil filter\t2\n", "utf8"),
      "text/tab-separated-values",
    );
    expect(text).toContain("name\tqty");
    expect(text).toContain("oil filter\t2");
  });

  it("strips NUL bytes before evaluating emptiness", async () => {
    const { text } = await extractDocumentText(
      Buffer.from("a\u0000b\u0000c", "utf8"),
      "text/plain",
    );
    expect(text).toBe("abc");
  });
});

describe("extractDocumentText — binary office formats", () => {
  it("extracts text from a DOCX", async () => {
    const buf = makeDocx([
      "Hello from DOCX fixture.",
      "Second paragraph here.",
    ]);
    const { text, truncated } = await extractDocumentText(
      buf,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(text).toContain("Hello from DOCX fixture.");
    expect(text).toContain("Second paragraph here.");
    expect(truncated).toBe(false);
  });

  it("extracts text from an XLSX (CSV-rendered per sheet)", async () => {
    const buf = makeXlsx(
      [
        ["Part", "Qty"],
        ["Brake Pad", "4"],
      ],
      "Inventory",
    );
    const { text } = await extractDocumentText(
      buf,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(text).toContain("# Sheet: Inventory");
    expect(text).toContain("Part,Qty");
    expect(text).toContain("Brake Pad,4");
  });

  it("extracts text from a PDF", async () => {
    const buf = makePdf([
      "Hello PDF fixture line one.",
      "Second PDF line two.",
    ]);
    const { text } = await extractDocumentText(buf, "application/pdf");
    expect(text).toContain("Hello PDF fixture line one.");
    expect(text).toContain("Second PDF line two.");
  });
});

describe("extractDocumentText — error paths", () => {
  it("throws DocumentExtractError for an unsupported type", async () => {
    await expect(
      extractDocumentText(Buffer.from("whatever"), "image/png"),
    ).rejects.toBeInstanceOf(DocumentExtractError);
  });

  it("throws DocumentExtractError when no readable text is found", async () => {
    await expect(
      extractDocumentText(Buffer.from("   \n\t  ", "utf8"), "text/plain"),
    ).rejects.toBeInstanceOf(DocumentExtractError);
  });

  it("throws DocumentExtractError when a parser fails on malformed input", async () => {
    // Not a valid DOCX (zip) — mammoth throws, which the extractor wraps.
    await expect(
      extractDocumentText(
        Buffer.from("definitely not a docx", "utf8"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).rejects.toBeInstanceOf(DocumentExtractError);
  });
});

describe("extractDocumentText — trimming", () => {
  it("trims text longer than the limit and flags it truncated", async () => {
    const head = "START";
    const tail = "ENDMARKER";
    const big = head + "A".repeat(DOCUMENT_TEXT_CHAR_LIMIT) + tail;
    const { text, truncated } = await extractDocumentText(
      Buffer.from(big, "utf8"),
      "text/plain",
    );
    expect(truncated).toBe(true);
    expect(text.length).toBe(DOCUMENT_TEXT_CHAR_LIMIT);
    expect(text.startsWith(head)).toBe(true);
    expect(text).not.toContain(tail);
  });

  it("does not flag text at exactly the limit as truncated", async () => {
    const exact = "B".repeat(DOCUMENT_TEXT_CHAR_LIMIT);
    const { text, truncated } = await extractDocumentText(
      Buffer.from(exact, "utf8"),
      "text/plain",
    );
    expect(truncated).toBe(false);
    expect(text.length).toBe(DOCUMENT_TEXT_CHAR_LIMIT);
  });
});
