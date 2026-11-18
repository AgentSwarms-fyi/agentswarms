// R508: reports become documents. Parameters a report runs with, fields from
// one record, pictures and barcodes, laid out the same in the preview and the
// PDF.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CODE128_PATTERNS,
  barcodeShapes,
  code128Modules,
  code128Problem,
  code128Values,
  qrMatrix,
  qrProblem,
} from "@/lib/biBarcode";
import type { BiWidget } from "@/lib/biDashboards";
import {
  isValidParamValue,
  paramLiteral,
  parseParams,
  substituteParams,
  type BiParamConfig,
} from "@/lib/biParams";
import {
  BLOCK_GAP,
  DEFAULT_PAGE,
  FIELD_ROW_H,
  blockHeight,
  fieldLabel,
  fieldPairs,
  fieldsCaveat,
  fillParamTokens,
  imageSourceProblem,
  pageGeometry,
  paginateBlocks,
  reportParams,
  validateReport,
  type BiReport,
  type ReportBlock,
} from "@/lib/biReports";
import { dataUrlBytes, resolveReportImages, sniffImageType } from "@/lib/biReportImages";
import { blockNeedsRun, newQueryWidget, paramTokens, valuesRead } from "@/lib/biReportDesign";

const read = (p: string) => readFileSync(p, "utf8");

/** A 1x1 PNG. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const orderParam: BiParamConfig = {
  id: "p1",
  kind: "param",
  name: "order_id",
  label: "Order",
  control: "text",
  default: "EMEA-2025-170087",
};

const widget = (over: Partial<BiWidget> = {}): BiWidget => ({
  id: "w1",
  kind: "chart",
  title: "Order",
  columns: ["order_id", "customer", "order_date", "sales"],
  rows: [
    { order_id: "EMEA-2025-170087", customer: "Acme", order_date: "2025-03-01", sales: 1234.5 },
  ],
  ...over,
});

const report = (blocks: ReportBlock[], params: BiParamConfig[] = []): BiReport => ({
  id: "r1",
  name: "Purchase order",
  description: null,
  page: { ...DEFAULT_PAGE, params },
  header: { left: "Order {{order_id}}" },
  footer: { right: "Page {{page}} of {{pages}}" },
  blocks,
});

/** Decode a run of modules back into Code 128 values. */
function decodeCode128(modules: boolean[]): number[] {
  const widths: number[] = [];
  let i = 0;
  while (i < modules.length) {
    let n = 0;
    const v = modules[i];
    while (i < modules.length && modules[i] === v) {
      n++;
      i++;
    }
    widths.push(n);
  }
  const out: number[] = [];
  let at = 0;
  while (at < widths.length) {
    const take = widths.length - at === 7 ? 7 : 6;
    const key = widths.slice(at, at + take).join("");
    out.push(CODE128_PATTERNS.indexOf(key));
    at += take;
  }
  return out;
}

describe("Code 128", () => {
  it("has the 107 symbol patterns, each one well formed", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.forEach((p, v) => {
      const w = [...p].map(Number);
      const total = w.reduce((a, b) => a + b, 0);
      expect(total, `pattern ${v}`).toBe(v === 106 ? 13 : 11);
      // Bars add up to an even width in every Code 128 symbol: a mistyped
      // digit in the table breaks it.
      const bars = w.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
      expect(bars % 2, `pattern ${v} bars`).toBe(0);
      expect(
        w.every((x) => x >= 1 && x <= 4),
        `pattern ${v} widths`,
      ).toBe(true);
    });
  });

  it("encodes text in code set B with the standard checksum", () => {
    // P J J 1 2 3 C in set B: start 104, then character code - 32.
    const v = code128Values("PJJ123C")!;
    expect(v.slice(0, 8)).toEqual([104, 48, 42, 42, 17, 18, 19, 35]);
    const sum = 104 + [48, 42, 42, 17, 18, 19, 35].reduce((a, x, i) => a + x * (i + 1), 0);
    expect(v[8]).toBe(sum % 103);
    expect(v[9]).toBe(106);
  });

  it("packs runs of digits two to a symbol", () => {
    expect(code128Values("12345678")!.slice(0, 5)).toEqual([105, 12, 34, 56, 78]);
    // An odd run gives its first digit to set B, then switches to C.
    expect(code128Values("AB12345")!.slice(0, 7)).toEqual([104, 33, 34, 17, 99, 23, 45]);
    // Short runs stay in B, where they cost nothing extra.
    expect(code128Values("A12B")!.slice(0, 5)).toEqual([104, 33, 17, 18, 34]);
  });

  it("draws bars that decode back to the symbols", () => {
    for (const s of ["EMEA-2025-170087", "PJJ123C", "12345678", "Order #42"]) {
      const modules = code128Modules(s)!;
      expect(modules[0], s).toBe(true);
      expect(decodeCode128(modules), s).toEqual(code128Values(s));
    }
  });

  it("says why a value cannot be drawn", () => {
    expect(code128Problem("")).toMatch(/no value/);
    expect(code128Problem("Zoë")).toMatch(/ASCII/);
    expect(code128Problem("x".repeat(49))).toMatch(/48 characters/);
    expect(code128Problem("EMEA-2025-170087")).toBeNull();
  });
});

describe("QR codes", () => {
  it("draws the three finder squares in their corners", () => {
    const m = qrMatrix("EMEA-2025-170087")!;
    const n = m.length;
    expect(n).toBeGreaterThanOrEqual(21);
    expect((n - 17) % 4).toBe(0);
    for (const [r0, c0] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ]) {
      for (let k = 0; k < 7; k++) {
        expect(m[r0][c0 + k]).toBe(true);
        expect(m[r0 + 6][c0 + k]).toBe(true);
        expect(m[r0 + k][c0]).toBe(true);
      }
      expect(m[r0 + 1][c0 + 1]).toBe(false);
      expect(m[r0 + 3][c0 + 3]).toBe(true);
    }
  });

  it("holds text beyond ASCII, as UTF-8", () => {
    expect(qrMatrix("Zoë · 東京")).not.toBeNull();
  });

  it("refuses an empty or an over-long value", () => {
    expect(qrProblem("")).toMatch(/no value/);
    expect(qrProblem("x".repeat(601))).toMatch(/600/);
  });
});

describe("the shapes the preview and the PDF both draw", () => {
  it("lays Code 128 out one point a module, with quiet zones, narrowed to fit", () => {
    const value = "EMEA-2025-170087";
    const modules = code128Modules(value)!.length;
    const wide = barcodeShapes("code128", value, 40, 500);
    expect("problem" in wide).toBe(false);
    if ("problem" in wide) return;
    expect(wide.width).toBeCloseTo(modules + 20, 5);
    expect(wide.rects[0].x).toBeCloseTo(10, 5);
    const narrow = barcodeShapes("code128", value, 40, 100);
    if ("problem" in narrow) throw new Error(narrow.problem);
    expect(narrow.width).toBeCloseTo(100, 5);
  });

  it("makes a QR square of the height asked for", () => {
    const s = barcodeShapes("qr", "https://example.com/order/42", 72, 500);
    if ("problem" in s) throw new Error(s.problem);
    expect(s.width).toBe(72);
    expect(s.height).toBe(72);
    expect(s.rects.length).toBeGreaterThan(10);
  });

  it("returns the reason instead of shapes when the value cannot be drawn", () => {
    expect(barcodeShapes("code128", "", 40, 500)).toEqual({
      problem: "There is no value to encode",
    });
  });
});

describe("report parameters", () => {
  it("take free text in a report, never on a dashboard", () => {
    const raw = [{ ...orderParam }];
    expect(parseParams(raw)).toHaveLength(0);
    expect(parseParams(raw, { allowText: true })[0]).toMatchObject({
      control: "text",
      default: "EMEA-2025-170087",
    });
  });

  it("go into SQL as a quoted literal, quotes doubled", () => {
    expect(isValidParamValue(orderParam, "O'Brien")).toBe(true);
    expect(isValidParamValue(orderParam, "a\nb")).toBe(false);
    expect(isValidParamValue(orderParam, "x".repeat(201))).toBe(false);
    expect(paramLiteral(orderParam, "O'Brien")).toBe("'O''Brien'");
    expect(
      substituteParams("SELECT * FROM orders WHERE order_id = {{order_id}}", [orderParam], {
        order_id: "EMEA-2025-170087",
      }),
    ).toBe("SELECT * FROM orders WHERE order_id = 'EMEA-2025-170087'");
  });

  it("fill text, the bands and barcodes, leaving the report's own tokens", () => {
    const region: BiParamConfig = {
      id: "p2",
      kind: "param",
      name: "region",
      label: "Region",
      control: "dropdown",
      options: [{ value: "AMER", label: "Americas" }],
      default: "AMER",
    };
    const params = [orderParam, region];
    expect(
      fillParamTokens("Order {{order_id}} · {{region}} · page {{page}}", params, {
        order_id: "X-1",
      }),
    ).toBe("Order X-1 · Americas · page {{page}}");
    // A barcode encodes the value, never the option's label: found in the
    // designer, where a list of orders labelled by customer printed the
    // customer's name into the Code 128.
    expect(fillParamTokens("{{region}}", params, {}, { raw: true })).toBe("AMER");
    expect(read("src/lib/biReportPdf.ts")).toContain("const value = fill(block.value, true);");
    expect(read("src/components/bi/ReportPagePreview.tsx")).toContain(
      "value={fill(block.value, true)}",
    );
    expect(read("src/routes/_authenticated/bi_.report.$reportId.tsx")).toContain(
      "filledValue={fillParamTokens(block.value, params, values, { raw: true })}",
    );
  });

  it("may not take the names the report fills itself", () => {
    const page = { ...DEFAULT_PAGE, params: [{ ...orderParam, name: "page" }] };
    expect(reportParams(page)).toHaveLength(0);
    expect(validateReport({ name: "R", page, blocks: [] })).toMatch(/filled by the report itself/);
    const twice = { ...DEFAULT_PAGE, params: [orderParam, { ...orderParam, id: "p9" }] };
    expect(validateReport({ name: "R", page: twice, blocks: [] })).toMatch(/Two parameters/);
    const bad = { ...DEFAULT_PAGE, params: [{ ...orderParam, name: "Order ID" }] };
    expect(validateReport({ name: "R", page: bad, blocks: [] })).toMatch(/not a parameter name/);
  });

  it("are offered to the insert menus by name", () => {
    expect(paramTokens([orderParam])).toEqual([
      { insert: "{{order_id}}", label: "order_id", detail: "Order" },
    ]);
  });

  it("survive a save and a load, re-read on the server", () => {
    const src = read("src/utils/biReports.functions.ts");
    expect(src).toContain(
      "params: z.array(z.record(z.string(), z.unknown())).max(MAX_REPORT_PARAMS).optional()",
    );
    expect(src).toContain("const params = reportParams(page as ReportPageSetup);");
    expect(src).toContain(
      "const params = reportParams({ ...page, params: data.page.params as never });",
    );
  });
});

describe("fields from one record", () => {
  const block: Extract<ReportBlock, { kind: "fields" }> = {
    id: "f",
    kind: "fields",
    widget: widget(),
    labels: { order_id: "Order no." },
    perRow: 2,
  };

  it("print a label and a value per column, from the first row", () => {
    expect(fieldPairs(block)).toEqual([
      { label: "Order no.", value: "EMEA-2025-170087" },
      { label: "Customer", value: "Acme" },
      { label: "Order date", value: "2025-03-01" },
      { label: "Sales", value: "1,234.5" },
    ]);
    expect(fieldLabel(block, "ship_mode")).toBe("Ship mode");
  });

  it("say so when the query returned several rows", () => {
    expect(fieldsCaveat(block)).toBeNull();
    const many = { ...block, widget: widget({ rows: [{}, {}, {}] }) };
    expect(fieldsCaveat(many)).toMatch(/first of 3 rows/);
  });

  it("take two rows of pairs' room for four fields two across", () => {
    const h = blockHeight(block, 500);
    expect(h).toBe(16 + 2 * FIELD_ROW_H + BLOCK_GAP);
  });
});

describe("pictures", () => {
  it("are kept as a PNG or JPEG data URL, or an https address", () => {
    expect(imageSourceProblem(PNG)).toBeNull();
    expect(imageSourceProblem("https://example.com/logo.png")).toBeNull();
    expect(imageSourceProblem("http://example.com/logo.png")).toMatch(/https/);
    expect(imageSourceProblem("data:image/svg+xml;base64,PHN2Zz4=")).toMatch(/PNG or a JPEG/);
    expect(imageSourceProblem(`data:image/png;base64,${"A".repeat(1_400_001)}`)).toMatch(/1 MB/);
  });

  it("are read by their bytes, and an address that cannot be fetched is left out", async () => {
    const bytes = dataUrlBytes(PNG)!;
    expect(sniffImageType(bytes)).toBe("png");
    const blocks: ReportBlock[] = [
      { id: "a", kind: "image", src: PNG, height: 40 },
      { id: "b", kind: "image", src: "https://example.com/logo.png", height: 40 },
      { id: "c", kind: "image", src: "https://example.com/blocked.png", height: 40 },
    ];
    const fetcher = (async (url: string) => {
      if (url.includes("blocked")) throw new TypeError("Failed to fetch");
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;
    const images = await resolveReportImages(blocks, fetcher);
    expect([...images.keys()]).toEqual(["a", "b"]);
  });
});

describe("the PDF", () => {
  it("draws fields, a picture and both barcodes, and breaks where the preview does", async () => {
    const { buildReportPdfBytes } = await import("@/lib/biReportPdf");
    const { PDFDocument } = await import("pdf-lib");
    const geo = pageGeometry(DEFAULT_PAGE);
    const unit: ReportBlock[] = [
      { id: "logo", kind: "image", src: PNG, height: 40, align: "right" },
      { id: "f", kind: "fields", widget: widget(), perRow: 2 },
      { id: "bc", kind: "barcode", format: "code128", value: "{{order_id}}", height: 40 },
      { id: "qr", kind: "barcode", format: "qr", value: "{{order_id}}", height: 72 },
    ];
    for (const copies of [1, 9]) {
      const blocks = Array.from({ length: copies }, (_, i) =>
        unit.map((b) => ({ ...b, id: `${b.id}${i}` }) as ReportBlock),
      ).flat();
      const r = report(blocks, [orderParam]);
      const images = new Map(
        blocks
          .filter((b) => b.kind === "image")
          .map((b) => [b.id, { bytes: dataUrlBytes(PNG)!, type: "png" as const }]),
      );
      const bytes = await buildReportPdfBytes({
        report: r,
        images,
        values: { order_id: "EMEA-2025-170087" },
      });
      const doc = await PDFDocument.load(bytes);
      const preview = paginateBlocks(r.blocks, geo, (b) => blockHeight(b, geo.contentW)).length;
      expect(doc.getPageCount(), `copies=${copies}`).toBe(preview);
    }
  }, 60000);

  it("says a picture or a barcode is unavailable rather than leaving a gap", async () => {
    const { buildReportPdfBytes } = await import("@/lib/biReportPdf");
    const r = report([
      { id: "logo", kind: "image", src: "https://example.com/blocked.png", height: 40 },
      { id: "bc", kind: "barcode", format: "code128", value: "Zoë", height: 40 },
    ]);
    const bytes = await buildReportPdfBytes({ report: r });
    expect(bytes.byteLength).toBeGreaterThan(500);
    const src = read("src/lib/biReportPdf.ts");
    expect(src).toContain("[picture unavailable");
    expect(src).toContain("[barcode: ${shapes.problem}]");
    // The bands and the text read the parameters before the export's own tokens.
    expect(src).toContain("substituteTokens(fill(raw), ctx)");
  }, 30000);

  it("prints a table a value left empty as one line, in the preview too", () => {
    // A parameter that matches nothing empties a table. The paginator gives it
    // 20pt; the PDF prints a line there, and the preview must not draw a header
    // row in its place, or the two stop agreeing on where pages break.
    const empty: ReportBlock = {
      id: "t",
      kind: "table",
      widget: { ...newQueryWidget(""), columns: ["Product", "Sales"], rows: [] },
    };
    const geo = pageGeometry(DEFAULT_PAGE);
    const pages = paginateBlocks([empty], geo, (b) => blockHeight(b, geo.contentW));
    expect(pages[0].items[0].height).toBe(20);
    expect(read("src/lib/biReportPdf.ts")).toContain('[no rows: ${block.widget.title || "table"}]');
    expect(read("src/components/bi/ReportPagePreview.tsx")).toContain(
      '[no rows: {block.widget.title || "table"}]',
    );
  });
});

describe("a block's own query", () => {
  it("starts empty, local, and drawn as rows", () => {
    expect(newQueryWidget("Details")).toMatchObject({
      kind: "chart",
      title: "Details",
      source: { kind: "local" },
      sql: "",
      chart: { type: "table" },
      rows: [],
    });
  });

  it("runs with the chosen values, and export runs it first when they changed", () => {
    const src = read("src/routes/_authenticated/bi_.report.$reportId.tsx");
    expect(src).toContain('const sql = substituteParams(widget.sql ?? "", params, vals);');
    expect(src).toContain("if (staleValues) {");
    expect(src).toContain("values: effectiveValues,");
  });

  it("records only the values its query reads", () => {
    const region: BiParamConfig = { ...orderParam, id: "p2", name: "region", default: "EMEA" };
    const sql = 'SELECT * FROM saas_sales WHERE "Order ID" = {{order_id}}';
    expect(valuesRead(sql, [orderParam, region], { order_id: "X-1", region: "APJ" })).toEqual({
      order_id: "X-1",
    });
    // An unset value is the default.
    expect(valuesRead(sql, [orderParam], {})).toEqual({ order_id: "EMEA-2025-170087" });
    expect(valuesRead("SELECT 1", [orderParam], {})).toEqual({});
  });

  it("needs a run until it has run with the values now chosen", () => {
    const region: BiParamConfig = { ...orderParam, id: "p2", name: "region", default: "EMEA" };
    const params = [orderParam, region];
    const widget = {
      ...newQueryWidget("Details"),
      sql: 'SELECT * FROM saas_sales WHERE "Order ID" = {{order_id}}',
    };
    const fresh: ReportBlock = { id: "b1", kind: "fields", widget };
    // Never run here: the saved rows may be for any value.
    expect(blockNeedsRun(fresh, params, { order_id: "A" })).toBe(true);
    const ran: ReportBlock = { ...fresh, ranWith: { order_id: "A" } };
    expect(blockNeedsRun(ran, params, { order_id: "A" })).toBe(false);
    expect(blockNeedsRun(ran, params, { order_id: "B" })).toBe(true);
    // A parameter the query does not read never asks for a run.
    expect(blockNeedsRun(ran, params, { order_id: "A", region: "APJ" })).toBe(false);
    // Keys come back from jsonb in another order: compared by name.
    const many: ReportBlock = {
      ...fresh,
      widget: { ...widget, sql: "SELECT {{region}}, {{order_id}}" },
      ranWith: { region: "EMEA", order_id: "A" },
    };
    expect(blockNeedsRun(many, params, { order_id: "A" })).toBe(false);
    // No query, or one that reads no parameter: nothing to run.
    expect(blockNeedsRun({ ...fresh, widget: { ...widget, sql: "" } }, params, {})).toBe(false);
    expect(blockNeedsRun({ id: "t", kind: "text", text: "{{order_id}}" }, params, {})).toBe(false);
  });
});
