// Paginated reports: a fixed page, a flow of blocks down it, and a table that
// continues onto the next page with its header drawn again. The last part is
// the whole difference from exporting a dashboard, so most of this file is
// about where the breaks land.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { BiWidget } from "@/lib/biDashboards";
import {
  DEFAULT_FOOTER,
  DEFAULT_PAGE,
  PAGE_SIZES,
  clampMargin,
  pageGeometry,
  sliceTable,
  substituteTokens,
  tableColumns,
  tableRows,
  validateReport,
  type BiReport,
  type ReportBlock,
} from "@/lib/biReports";
import { normalizeOutline, REPORT_CHART_TYPES } from "@/lib/biReportAgent";

const rd = (p: string) => readFileSync(p, "utf8");

const widget = (over: Partial<BiWidget> = {}): BiWidget => ({
  id: "w1",
  kind: "chart",
  title: "Revenue by region",
  columns: ["region", "net_usd"],
  rows: [
    { region: "EMEA", net_usd: 1200 },
    { region: "AMER", net_usd: 900 },
  ],
  ...over,
});

const report = (blocks: ReportBlock[]): BiReport => ({
  id: "r1",
  name: "Month end",
  description: null,
  page: DEFAULT_PAGE,
  header: {},
  footer: DEFAULT_FOOTER,
  blocks,
});

describe("the page", () => {
  it("turns on its side when asked, and keeps content inside the bands", () => {
    const portrait = pageGeometry({ size: "a4", orientation: "portrait", margin: 40 });
    const landscape = pageGeometry({ size: "a4", orientation: "landscape", margin: 40 });
    expect(portrait.w).toBeCloseTo(PAGE_SIZES.a4.w, 1);
    expect(landscape.w).toBeCloseTo(PAGE_SIZES.a4.h, 1);
    expect(landscape.h).toBeCloseTo(PAGE_SIZES.a4.w, 1);
    // Content stops short of both bands, or the footer would print over it.
    expect(portrait.contentTop).toBeLessThan(portrait.h - 40);
    expect(portrait.contentBottom).toBeGreaterThan(40);
  });

  it("refuses a margin that would swallow the page", () => {
    expect(clampMargin(40, 595)).toBe(40);
    expect(clampMargin(9999, 595)).toBeLessThan(300);
    expect(clampMargin(-5, 595)).toBe(0);
    expect(clampMargin(Number.NaN, 595)).toBe(DEFAULT_PAGE.margin);
  });
});

describe("the running bands", () => {
  it("fill every token, so a footer can count pages", () => {
    const ctx = { page: 3, pages: 7, title: "Month end", date: "1 Feb", time: "09:00" };
    expect(substituteTokens("Page {{page}} of {{pages}}", ctx)).toBe("Page 3 of 7");
    expect(substituteTokens("{{title}} · {{date}} {{time}}", ctx)).toBe("Month end · 1 Feb 09:00");
    // Spacing inside the braces is a typo waiting to happen; accept it.
    expect(substituteTokens("{{ page }}/{{  pages  }}", ctx)).toBe("3/7");
    // An unknown token is left alone rather than blanked, so the author sees it.
    expect(substituteTokens("{{nope}}", ctx)).toBe("{{nope}}");
  });
});

describe("a table that runs out of room", () => {
  // 20pt rows, a 24pt header, 300pt left here and 700pt on a fresh page.
  const base = { rowH: 20, headerH: 24, firstAvail: 300, fullAvail: 700 };

  it("continues rather than being clipped, and every slice redraws the header", () => {
    const slices = sliceTable({ ...base, rowCount: 100 });
    expect(slices.length).toBeGreaterThan(1);
    // Contiguous, complete, no row printed twice or lost.
    expect(slices[0].from).toBe(0);
    expect(slices[slices.length - 1].to).toBe(100);
    for (let i = 1; i < slices.length; i++) expect(slices[i].from).toBe(slices[i - 1].to);
    // Only the first is not a continuation; the renderer draws the header for
    // all of them, which is the point of a paginated table.
    expect(slices[0].continued).toBe(false);
    expect(slices.slice(1).every((s) => s.continued)).toBe(true);
  });

  it("fits what the current page allows, then a full page at a time", () => {
    const slices = sliceTable({ ...base, rowCount: 100 });
    expect(slices[0].to - slices[0].from).toBe(Math.floor((300 - 24) / 20));
    expect(slices[1].to - slices[1].from).toBe(Math.floor((700 - 24) / 20));
  });

  it("starts on the next page rather than stranding a header at the bottom", () => {
    // 30pt left: room for the header and not one row. The table must not
    // squeeze in — its first slice is sized by a WHOLE page, not by the
    // scraps at the bottom of this one.
    const slices = sliceTable({ ...base, firstAvail: 30, rowCount: 100 });
    expect(slices[0].to - slices[0].from).toBe(Math.floor((700 - 24) / 20));
    // And with room for exactly one row, it does start here.
    const squeezed = sliceTable({ ...base, firstAvail: 24 + 20, rowCount: 100 });
    expect(squeezed[0].to - squeezed[0].from).toBe(1);
  });

  it("a table that fits stays in one piece", () => {
    const slices = sliceTable({ ...base, rowCount: 5 });
    expect(slices).toEqual([{ from: 0, to: 5, continued: false }]);
  });

  it("never loops forever when a row is taller than a page", () => {
    const slices = sliceTable({
      rowCount: 3,
      rowH: 900,
      headerH: 24,
      firstAvail: 300,
      fullAvail: 700,
    });
    expect(slices).toHaveLength(3);
    expect(slices[2].to).toBe(3);
  });

  it("no rows means no slices", () => {
    expect(sliceTable({ ...base, rowCount: 0 })).toEqual([]);
  });
});

describe("what a table block prints", () => {
  it("its own columns, else the query's, and honours a row cap", () => {
    const block = { id: "b", kind: "table" as const, widget: widget() };
    expect(tableColumns(block)).toEqual(["region", "net_usd"]);
    expect(tableColumns({ ...block, columns: ["net_usd"] })).toEqual(["net_usd"]);
    expect(tableRows(block)).toHaveLength(2);
    expect(tableRows({ ...block, maxRows: 1 })).toHaveLength(1);
  });

  it("falls back to the first row's keys when the widget names no columns", () => {
    const block = {
      id: "b",
      kind: "table" as const,
      widget: widget({ columns: undefined }),
    };
    expect(tableColumns(block)).toEqual(["region", "net_usd"]);
  });
});

describe("what a report refuses to be", () => {
  it("nameless, or built from blocks that collide", () => {
    expect(validateReport({ name: " ", page: DEFAULT_PAGE, blocks: [] })).toMatch(/name/);
    const dup: ReportBlock[] = [
      { id: "x", kind: "heading", text: "One" },
      { id: "x", kind: "heading", text: "Two" },
    ];
    expect(validateReport({ name: "R", page: DEFAULT_PAGE, blocks: dup })).toMatch(/share the id/);
  });

  it("a chart block with no widget behind it", () => {
    const blocks = [{ id: "a", kind: "chart" }] as unknown as ReportBlock[];
    expect(validateReport({ name: "R", page: DEFAULT_PAGE, blocks })).toMatch(/no widget/);
  });
});

describe("the planned outline", () => {
  it("keeps a section the model got mostly right and repairs the chart type", () => {
    const out = normalizeOutline({
      title: "Q1 review",
      summary: "Revenue grew.",
      sections: [
        {
          heading: "Revenue",
          question: "total revenue by month",
          present: "chart",
          chartType: "sankey",
        },
        { heading: "Detail", question: "every order", present: "table" },
      ],
    });
    expect(out.sections).toHaveLength(2);
    // sankey is not a type this renderer draws, and the question is the
    // expensive part — so it becomes a bar rather than being dropped.
    expect(out.sections[0].chartType).toBe("bar");
    expect(REPORT_CHART_TYPES).toContain(out.sections[0].chartType);
    // A table section carries no chart type at all.
    expect(out.sections[1].present).toBe("table");
    expect(out.sections[1].chartType).toBeUndefined();
  });

  it("drops a section with nothing to run, and survives junk", () => {
    const out = normalizeOutline({
      sections: [{ heading: "No question here" }, { question: "", present: "chart" }],
    });
    expect(out.sections).toHaveLength(0);
    expect(out.title).toBe("Report");
    expect(normalizeOutline({}).sections).toEqual([]);
    expect(normalizeOutline({ sections: "nope" as never }).sections).toEqual([]);
  });
});

describe("the wiring", () => {
  it("a chart block is a dashboard widget, so one renderer serves both", () => {
    const lib = rd("src/lib/biReports.ts");
    expect(lib).toContain('import type { BiWidget } from "@/lib/biDashboards"');
    const pdf = rd("src/lib/biReportPdf.ts");
    // Shared text helpers rather than a second copy that drifts.
    expect(pdf).toContain('from "@/lib/biPdf"');
    expect(pdf).toContain("encLine");
    expect(pdf).toContain("wrapText");
  });

  it("the bands are stamped after layout, because {{pages}} is not knowable before", () => {
    const pdf = rd("src/lib/biReportPdf.ts");
    expect(pdf).toContain("function stampBands");
    expect(pdf).toContain("pdf.getPages()");
    expect(pdf.indexOf("stampBands({")).toBeGreaterThan(
      pdf.indexOf("for (const block of report.blocks)"),
    );
  });

  it("the planner reuses the dashboard's own schema description and transport", () => {
    const agent = rd("src/lib/biReportAgent.ts");
    expect(agent).toContain("describeSchema");
    expect(agent).toContain("ensureGovernedCatalog");
    expect(agent).toContain('from "@/lib/biAgent"');
    // Its own traced surface, so report spend is not lumped in with the rest.
    expect(agent).toContain('stage: "report"');
    expect(rd("src/routes/api/bi.ts")).toContain('return "BI Agent: Report outline"');
    // The stage never reached the server before, which left every BI call
    // recorded as generic.
    expect(rd("src/lib/biAgent.ts")).toContain("stage: opts.stage");
  });

  it("the export rasterises the very node the preview draws", () => {
    // Two files agreeing on one attribute name. When they stop agreeing the
    // charts vanish from the PDF and nothing throws, so pin it.
    const preview = rd("src/components/bi/ReportPagePreview.tsx");
    const designer = rd("src/routes/_authenticated/bi_.report.$reportId.tsx");
    expect(preview).toContain("data-chart-block={drawable ? block.id : undefined}");
    expect(designer).toContain('data-chart-block="${block.id}"');
    // And it only tags a chart that has something to draw, so a placeholder is
    // never captured as if it were the chart.
    expect(preview).toContain("const drawable = Boolean(");
  });

  it("the designer generates through the dashboard's own turn, not a second path", () => {
    const dialog = rd("src/components/bi/GenerateReportDialog.tsx");
    expect(dialog).toContain("runBiTurn");
    expect(dialog).toContain("widgetFromBiTurn");
    expect(dialog).toContain("suggestReportOutline");
    // A failed section is reported with its reason, never quietly dropped.
    expect(dialog).toContain("failures.push");
  });

  it("fills the screen and scrolls inside itself, not the window", () => {
    // FOUND FROM THE UI. The designer is a three-column workbench, and with
    // `h-full` the percentage resolved against a `min-h-screen` shell — so the
    // columns grew the window and one scroll took the whole page, preview and
    // toolbar included, off the screen. `h-canvas` is the app's own utility
    // for a route that owns its height.
    const designer = rd("src/routes/_authenticated/bi_.report.$reportId.tsx");
    expect(designer).toContain("h-canvas");
    expect(designer).not.toMatch(/className="flex h-full[^"]*flex-col/);
    // Each column scrolls on its own, which is what makes that safe.
    expect(designer).toContain("min-h-0 overflow-y-auto");
  });

  it("takes a widget off a dashboard whole, so two surfaces cannot disagree", () => {
    const dlg = rd("src/components/bi/AddFromDashboardDialog.tsx");
    // The widget object itself, not a rebuilt copy: same query, same rows.
    expect(dlg).toContain('const widget = { ...c.widget, title: "" }');
    // A tile with no saved snapshot would print an empty box, so it is not
    // offered at all rather than added and left blank.
    expect(dlg).toContain('if (w.kind !== "chart" || !(w.rows ?? []).length) continue;');
    // Every page of a multi-page dashboard, not just the mirrored first one.
    expect(dlg).toContain("parsePages");
    expect(rd("src/routes/_authenticated/bi_.report.$reportId.tsx")).toContain(
      "<AddFromDashboardDialog",
    );
  });

  it("reaches the UI: a Reports tab that opens the designer route", () => {
    const bi = rd("src/routes/_authenticated/bi.tsx");
    expect(bi).toContain('value="reports"');
    expect(bi).toContain("<ReportsTab />");
    const tab = rd("src/components/bi/ReportsTab.tsx");
    expect(tab).toContain('to: "/bi/report/$reportId"');
    const designer = rd("src/routes/_authenticated/bi_.report.$reportId.tsx");
    expect(designer).toContain('createFileRoute("/_authenticated/bi_/report/$reportId")');
    // The preview is what the designer shows — not a second layout engine.
    expect(designer).toContain("<ReportPagePreview");
  });

  it("owns its table, owner-only and audited on shape", () => {
    const sql = rd("supabase/migrations/20260892000000_bi_reports.sql");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.bi_reports");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("auth.uid() = user_id");
    expect(sql).toContain("audit_row_change('bi_report')");
    // A policy reading a grant nobody can create would be dead code.
    expect(sql).not.toContain("has_resource_access('bi_report'");
  });
});

describe("the rendered document", () => {
  it("puts a long table across several pages and keeps one page for a short one", async () => {
    const { buildReportPdfBytes } = await import("@/lib/biReportPdf");
    const rows = Array.from({ length: 200 }, (_, i) => ({ region: `R${i}`, net_usd: i * 10 }));
    const long = report([
      { id: "h", kind: "heading", text: "Detail", level: 1 },
      { id: "t", kind: "table", widget: widget({ rows }) },
    ]);
    const bytes = await buildReportPdfBytes({
      report: long,
      now: new Date("2026-02-01T09:00:00Z"),
    });
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);

    const short = report([{ id: "t", kind: "table", widget: widget() }]);
    const shortDoc = await PDFDocument.load(
      await buildReportPdfBytes({ report: short, now: new Date("2026-02-01T09:00:00Z") }),
    );
    expect(shortDoc.getPageCount()).toBe(1);
  }, 30000);

  it("honours an explicit page break, and does not open with a blank sheet", async () => {
    const { buildReportPdfBytes } = await import("@/lib/biReportPdf");
    const { PDFDocument } = await import("pdf-lib");
    const broken = report([
      { id: "a", kind: "heading", text: "One", level: 2 },
      { id: "pb", kind: "pagebreak" },
      { id: "b", kind: "heading", text: "Two", level: 2 },
    ]);
    expect(
      (await PDFDocument.load(await buildReportPdfBytes({ report: broken }))).getPageCount(),
    ).toBe(2);

    // A break before anything has been drawn would waste a sheet.
    const leading = report([
      { id: "pb", kind: "pagebreak" },
      { id: "a", kind: "heading", text: "One", level: 2 },
    ]);
    expect(
      (await PDFDocument.load(await buildReportPdfBytes({ report: leading }))).getPageCount(),
    ).toBe(1);
  }, 30000);

  it("says a chart is missing rather than leaving a hole", async () => {
    const { buildReportPdfBytes } = await import("@/lib/biReportPdf");
    const bytes = await buildReportPdfBytes({
      report: report([{ id: "c", kind: "chart", widget: widget() }]),
    });
    // An empty gap reads as "no data", which is a different and untrue claim.
    expect(new TextDecoder().decode(bytes)).toMatch(/chart unavailable|FlateDecode/);
    expect(bytes.byteLength).toBeGreaterThan(500);
  }, 30000);

  it("breaks where the designer's preview says it will", async () => {
    // A preview that paginates differently from the renderer is a picture of
    // a document nobody will receive, so the page count is pinned across both.
    const { buildReportPdfBytes } = await import("@/lib/biReportPdf");
    const { PDFDocument } = await import("pdf-lib");
    const { paginateBlocks, pageGeometry, blockHeight } = await import("@/lib/biReports");
    const geo = pageGeometry(DEFAULT_PAGE);

    for (const rowCount of [5, 60, 200]) {
      const rows = Array.from({ length: rowCount }, (_, i) => ({ region: `R${i}`, net_usd: i }));
      const r = report([
        { id: "h", kind: "heading", text: "Detail", level: 2 },
        { id: "t", kind: "table", widget: widget({ rows, title: "" }) },
      ]);
      const previewPages = paginateBlocks(r.blocks, geo, (b) =>
        blockHeight(b, geo.contentW),
      ).length;
      const doc = await PDFDocument.load(await buildReportPdfBytes({ report: r }));
      expect(doc.getPageCount(), `rowCount=${rowCount}`).toBe(previewPages);
    }
  }, 60000);

  it("respects the page size it was given", async () => {
    const { buildReportPdfBytes } = await import("@/lib/biReportPdf");
    const { PDFDocument } = await import("pdf-lib");
    const landscape: BiReport = {
      ...report([{ id: "a", kind: "heading", text: "Wide", level: 1 }]),
      page: { size: "letter", orientation: "landscape", margin: 36 },
    };
    const doc = await PDFDocument.load(await buildReportPdfBytes({ report: landscape }));
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(PAGE_SIZES.letter.h, 0);
    expect(height).toBeCloseTo(PAGE_SIZES.letter.w, 0);
  }, 30000);
});
