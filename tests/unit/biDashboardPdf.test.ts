// A dashboard laid out as a PDF on the server (R510): how the grid is cut
// into sheets, how a text widget's markdown is set, and what a whole PDF
// says, with a stand-in chart renderer (the real one is exercised in
// biReportServerPdf.test.ts).
import { decodePDFRawStream, PDFDocument, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  buildDashboardPdfBytes,
  gridGeometry,
  inlineText,
  markdownBlocks,
  MIN_SHEET_SCALE,
  paginateGrid,
  paperColour,
} from "@/lib/biDashboardPdf";
import type { BiLayoutItem, BiWidget } from "@/lib/biDashboards";
import {
  cleanPageIds,
  notDrawnTitles,
  pagesToSend,
  scheduleTargetLink,
} from "@/lib/biReportSchedule";

const item = (i: string, x: number, y: number, w: number, h: number): BiLayoutItem => ({
  i,
  x,
  y,
  w,
  h,
});

describe("cutting a dashboard page into sheets", () => {
  it("keeps cards that fit on one sheet together", () => {
    const bands = paginateGrid(
      [item("a", 0, 0, 6, 4), item("b", 6, 0, 6, 4), item("c", 0, 4, 12, 4)],
      11,
    );
    expect(bands.map((b) => [b.top, b.bottom, b.items.map((i) => i.i)])).toEqual([
      [0, 8, ["a", "b", "c"]],
    ]);
  });

  it("breaks only at a row no card crosses", () => {
    // b runs from row 0 to 8, so row 4 is not a place to cut, even though a
    // ends there; row 8 is.
    const layout = [
      item("a", 0, 0, 6, 4),
      item("b", 6, 0, 6, 8),
      item("c", 0, 4, 6, 4),
      item("d", 0, 8, 12, 4),
    ];
    const bands = paginateGrid(layout, 10);
    expect(bands.map((b) => [b.top, b.bottom])).toEqual([
      [0, 8],
      [8, 12],
    ]);
    // No card is on two sheets.
    const seen = bands.flatMap((b) => b.items.map((i) => i.i));
    expect(seen.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps a card taller than a sheet whole, for the layout to shrink", () => {
    expect(
      paginateGrid([item("tall", 0, 0, 12, 20), item("after", 0, 20, 12, 2)], 10).map((b) => [
        b.top,
        b.bottom,
      ]),
    ).toEqual([
      [0, 20],
      [20, 22],
    ]);
  });

  it("skips empty rows rather than printing a blank sheet", () => {
    const bands = paginateGrid([item("a", 0, 0, 6, 2), item("b", 0, 30, 6, 2)], 10);
    expect(bands.map((b) => [b.top, b.bottom])).toEqual([
      [0, 2],
      [30, 32],
    ]);
  });

  const spans = (bands: { top: number; bottom: number }[]) => bands.map((b) => [b.top, b.bottom]);

  it("shrinks a page a row or so taller than a sheet onto it, not onto a nearly blank one", () => {
    // Two pictures two rows high over ten rows of charts: 12 rows, a sheet
    // holds 11, and the only clean break is under the pictures.
    const layout = [
      item("skyline", 0, 0, 10, 2),
      item("bike", 10, 0, 2, 2),
      item("journey", 0, 2, 5, 7),
      item("map", 5, 2, 5, 10),
      item("controls", 10, 2, 2, 10),
      item("insight", 0, 9, 5, 3),
    ];
    expect(spans(paginateGrid(layout, 11))).toEqual([
      [0, 2],
      [2, 12],
    ]);
    expect(spans(paginateGrid(layout, 11, { minScale: MIN_SHEET_SCALE }))).toEqual([[0, 12]]);
  });

  it("uses the fewest sheets, then shrinks as little as it can", () => {
    // A 4-row card and six 6-row bands: six sheets at full size, four when
    // a sheet may shrink by a fifth.
    const tall = [item("cal", 0, 0, 12, 4)].concat(
      Array.from({ length: 6 }, (_, i) => item(`b${i}`, 0, 4 + i * 6, 12, 6)),
    );
    expect(paginateGrid(tall, 11).length).toBe(6);
    expect(spans(paginateGrid(tall, 11, { minScale: MIN_SHEET_SCALE }))).toEqual([
      [0, 10],
      [10, 22],
      [22, 34],
      [34, 40],
    ]);
    // Four 4-row cards on two sheets: two full-size sheets beat a shrunk
    // sheet of three and a sheet of one.
    const fours = Array.from({ length: 4 }, (_, i) => item(`f${i}`, 0, i * 4, 12, 4));
    expect(spans(paginateGrid(fours, 11, { minScale: MIN_SHEET_SCALE }))).toEqual([
      [0, 8],
      [8, 16],
    ]);
  });

  it("shrinks no further than it is allowed, counting the gaps between rows", () => {
    const short = [item("title", 0, 0, 12, 2), item("body", 0, 2, 12, 14)];
    // 16 rows on an 11-row sheet would be 69% of their height: two sheets.
    expect(spans(paginateGrid(short, 11, { minScale: MIN_SHEET_SCALE }))).toEqual([
      [0, 2],
      [2, 16],
    ]);
    // 10 rows on 8 is 80% by rows, but less once the gaps are counted.
    const ten = [item("a", 0, 0, 12, 5), item("b", 0, 5, 12, 5)];
    expect(paginateGrid(ten, 8, { minScale: 0.8 }).length).toBe(1);
    expect(paginateGrid(ten, 8, { minScale: 0.8, gapShare: 0.5 }).length).toBe(2);
  });

  it("places the 12 columns across the sheet's width", () => {
    const g = gridGeometry(786);
    expect(g.x(0)).toBe(0);
    expect(g.x(6) + g.w(6)).toBeCloseTo(786, 6);
    expect(g.w(12)).toBeCloseTo(786, 6);
    // Rows keep the screen's proportions: 56px rows with 12px gaps.
    expect(g.row / g.gap).toBeCloseTo(56 / 12, 6);
    expect(g.bandHeight(1)).toBeCloseTo(g.row, 6);
  });
});

describe("a text widget's markdown", () => {
  it("is set as headings, paragraphs and list items", () => {
    expect(
      markdownBlocks(
        "# Weekly sales\n\nRevenue is **up** on [last week](https://example.com).\nKeep going.\n\n- EMEA\n* AMER\n1. APJ\n\n---\n| Region | Sales |\n|---|---|\n| EMEA | 4 |",
      ),
    ).toEqual([
      { kind: "h1", text: "Weekly sales" },
      { kind: "p", text: "Revenue is up on last week. Keep going." },
      { kind: "li", text: "EMEA" },
      { kind: "li", text: "AMER" },
      { kind: "li", text: "APJ" },
      { kind: "p", text: "Region   Sales" },
      { kind: "p", text: "EMEA   4" },
    ]);
  });

  it("breaks a styled block's lines where they were typed, as the card does", () => {
    const md = "### Autódromo\nSão Paulo, Brazil · 71 laps\n*First pit stops: laps 14–17*";
    expect(markdownBlocks(md, { lineBreaks: true })).toEqual([
      { kind: "h3", text: "Autódromo" },
      { kind: "p", text: "São Paulo, Brazil · 71 laps" },
      { kind: "p", text: "First pit stops: laps 14–17", tight: true },
    ]);
    // Unstyled, markdown runs a paragraph's lines together.
    expect(markdownBlocks(md).slice(1)).toEqual([
      { kind: "p", text: "São Paulo, Brazil · 71 laps First pit stops: laps 14–17" },
    ]);
  });

  it("keeps its colours where they read on white paper, and prints ink where they do not", () => {
    // Set for a dark canvas: white and gold would vanish on paper.
    expect(paperColour("#ffffff")).toBeNull();
    expect(paperColour("#ffd700")).toBeNull();
    // A racing red and a slate read on white, and print as chosen.
    expect(paperColour("#e10600")).toMatchObject({ r: 225 / 255 });
    expect(paperColour("#1f2937")).not.toBeNull();
    expect(paperColour("red")).toBeNull();
    expect(paperColour(undefined)).toBeNull();
  });

  it("keeps the underscores in a name and drops only the marks", () => {
    expect(inlineText("Filter on order_id and top_n, _not this_ but `code`")).toBe(
      "Filter on order_id and top_n, not this but code",
    );
    expect(inlineText("Escaped \\*star\\* stays")).toBe("Escaped *star* stays");
  });
});

describe("which pages a schedule sends", () => {
  const pages = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];

  it("sends the named ones, every one when none are named", () => {
    expect(pagesToSend(pages, []).pages.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(pagesToSend(pages, ["p3", "p1"]).pages.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("says when a named page is gone, and sends everything rather than nothing", () => {
    expect(pagesToSend(pages, ["p2", "gone"]).note).toMatch(/no longer exist/);
    const none = pagesToSend(pages, ["gone"]);
    expect(none.pages.length).toBe(3);
    expect(none.note).toMatch(/every page was sent/);
  });

  it("keeps only real pages, once, in the dashboard's order", () => {
    expect(cleanPageIds(["p3", "x", "p1", "p3"], ["p1", "p2", "p3"])).toEqual(["p1", "p3"]);
  });

  it("sends its owner to the dashboard, or the report, when a run fails", () => {
    expect(scheduleTargetLink({ report_id: null, dashboard_id: "d1" })).toBe("/bi/d1");
    expect(scheduleTargetLink({ report_id: "r1", dashboard_id: null })).toBe("/bi/report/r1");
    // A report schedule read before the dashboard column existed.
    expect(scheduleTargetLink({ report_id: "r1" })).toBe("/bi/report/r1");
  });

  it("names the visuals a PDF cannot draw, but not a Controls visual", () => {
    expect(
      notDrawnTitles([
        { kind: "chart", title: "Stations", chart: { type: "pointmap" } },
        { kind: "chart", title: "Pick a rider", chart: { type: "controls" } },
        { kind: "chart", title: "Sales", chart: { type: "bar" } },
        { kind: "chart", title: "Rows", chart: { type: "table" } },
        { kind: "text", title: "Notes" },
      ]),
    ).toEqual(["Stations"]);
  });
});

/** Every string a page draws, in order. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let data: Uint8Array;
    try {
      data = decodePDFRawStream(obj).decode();
    } catch {
      continue;
    }
    const ops = Buffer.from(data).toString("latin1");
    for (const m of ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      out.push(Buffer.from(m[1], "hex").toString("latin1"));
    }
  }
  return out.join(" | ");
}

const w = (over: Partial<BiWidget> & { id: string }): BiWidget =>
  ({ kind: "chart", title: "", ...over }) as BiWidget;

describe("a dashboard PDF", () => {
  it("prints every page's cards, headers and numbers", async () => {
    const bytes = await buildDashboardPdfBytes({
      name: "Sales pack",
      clock: { date: "2026-11-19", time: "08:00" },
      valuesLine: "Region: EMEA",
      pages: [
        {
          name: "Summary",
          widgets: [
            w({ id: "k", title: "Revenue", chart: { type: "bar" } as never, rows: [{ a: 1 }] }),
            w({ id: "c", title: "Pick a region", chart: { type: "controls" } as never }),
            w({ id: "f", title: "Broken", chart: { type: "bar" } as never }),
          ],
          layout: [item("k", 0, 0, 8, 5), item("c", 8, 0, 4, 2), item("f", 8, 2, 4, 3)],
        },
        {
          name: "Notes",
          widgets: [
            w({
              id: "t",
              kind: "text",
              text: "## What moved\n- EMEA up 4%",
            }),
            w({
              id: "m",
              title: "Stations",
              chart: { type: "pointmap" } as never,
              rows: [{ a: 1 }],
            }),
            w({ id: "e", title: "Empty", chart: { type: "bar" } as never, rows: [] }),
          ],
          layout: [item("t", 0, 0, 6, 4), item("m", 6, 0, 6, 4), item("e", 0, 4, 6, 3)],
        },
      ],
      failures: new Map([["f", 'relation "orders" does not exist']]),
      // A stand-in: every chart is a sentence, drawn as text.
      renderVisual: () => async () => ({ kind: "none", reason: "stand-in chart" }),
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    const [w0, h0] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect(w0).toBeGreaterThan(h0); // landscape
    const text = await pdfText(bytes);
    for (const s of [
      "Sales pack · Summary",
      "Sales pack · Notes",
      "2026-11-19 08:00",
      "Page 1 of 2",
      "Page 2 of 2",
      "Revenue",
      "stand-in chart",
      "Run for Region: EMEA",
      "Broken",
      "What moved",
      // The bullet is WinAnsi 0x95, which latin1 reads back as a control code.
      "EMEA up 4%",
      "This visual is drawn in the app only (pointmap).",
      "No data",
    ]) {
      expect(text, s).toContain(s);
    }
    expect(text).toMatch(/Not refreshed: relation "orders" does not/);
  });

  it("sets a styled text block for paper: its lines as typed, white text in ink", async () => {
    const bytes = await buildDashboardPdfBytes({
      name: "Race",
      clock: { date: "2026-11-19", time: "08:00" },
      pages: [
        {
          name: "Only",
          widgets: [
            w({
              id: "t",
              kind: "text",
              theme: { card: "none", hideTitle: true },
              // Set for a dark canvas: white body, red headings.
              textStyle: { color: "#ffffff", headingColor: "#e10600", size: "xl", align: "right" },
              text: "### Autódromo José Carlos Pace\nSão Paulo, Brazil · 71 laps\n*First pit stops: laps 14–17*",
            }),
          ],
          layout: [item("t", 6, 0, 6, 3)],
        },
      ],
      renderVisual: () => null,
    });
    const doc = await PDFDocument.load(bytes);
    const ops: string[] = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream) {
        try {
          ops.push(Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"));
        } catch {
          // not a content stream
        }
      }
    }
    const all = ops.join("\n");
    const strings = [...all.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map((m) =>
      Buffer.from(m[1], "hex").toString("latin1"),
    );
    // Each typed line is its own line, not one run-on paragraph.
    expect(strings).toContain("São Paulo, Brazil · 71 laps");
    // (The en dash is WinAnsi 0x96, which latin1 reads back as a control code.)
    expect(strings.filter((s) => s.startsWith("First pit stops: laps 14"))).toHaveLength(1);
    // No white text: the body prints in ink, the red heading stays red.
    expect(all).not.toMatch(/(^|\s)1 1 1 rg/);
    expect(all).toMatch(/0\.88\d* 0\.02\d* 0 rg/);
  });

  it("puts a long page on more sheets, never a card on two", async () => {
    const widgets = Array.from({ length: 6 }, (_, i) =>
      w({ id: `w${i}`, title: `Card ${i}`, chart: { type: "bar" } as never, rows: [{ a: 1 }] }),
    );
    const layout = widgets.map((x, i) => item(x.id, 0, i * 5, 12, 5));
    const bytes = await buildDashboardPdfBytes({
      name: "Long",
      clock: { date: "2026-11-19", time: "08:00" },
      pages: [{ name: "Only", widgets, layout }],
      renderVisual: () => async () => ({ kind: "none", reason: "x" }),
    });
    const doc = await PDFDocument.load(bytes);
    // 30 rows of cards; a landscape sheet holds about 11.
    expect(doc.getPageCount()).toBe(3);
    const text = await pdfText(bytes);
    for (let i = 0; i < 6; i++) expect(text.split(`Card ${i}`).length - 1).toBe(1);
    // One page: the header names the dashboard alone.
    expect(text).not.toContain("Long · Only");
  });
});
