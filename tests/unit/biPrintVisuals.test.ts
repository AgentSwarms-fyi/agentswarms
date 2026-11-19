// The seven visuals a PDF used to leave to the app (R511): cards, range, word
// cloud, pictogram, small multiples, bar race and point map, laid out for
// paper by components/bi/biPrintVisuals and drawn by lib/svgPdf.
import { decodePDFRawStream, PDFDocument, PDFRawStream } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fitText,
  isPrintedVisual,
  layoutWordCloud,
  printMapTiles,
  printPictureUrls,
  printVisualSvg,
  PRINTED_VISUALS,
} from "@/components/bi/biPrintVisuals";
import { buildDashboardPdfBytes } from "@/lib/biDashboardPdf";
import type { BiWidget } from "@/lib/biDashboards";
import { SCHEDULED_DRAW } from "@/lib/biReportSchedule";
import { drawSvg, findAll, parseMarkup } from "@/lib/svgPdf";
import { renderVisualMarkup } from "@/utils/bi/reportCharts.server";

/** A stand-in for the PDF font: every character half its size wide. */
const measure = (t: string, size: number) => t.length * size * 0.5;

/** A 1x1 PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(Buffer.from(PNG_B64, "base64"));
const SVG_PIC = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#e10600"/></svg>',
).toString("base64")}`;

function svgOf(markup: string) {
  const tree = parseMarkup(markup);
  const svg = findAll(tree, (e) => e.tag === "svg")[0];
  return { tree, svg };
}

afterEach(() => vi.unstubAllEnvs());

describe("which visuals are laid out for paper", () => {
  it("are the seven, and every one is in the PDF's drawing table", () => {
    expect([...PRINTED_VISUALS].sort()).toEqual([
      "barrace",
      "cards",
      "pictogram",
      "pointmap",
      "range",
      "smallmultiples",
      "wordcloud",
    ]);
    for (const t of PRINTED_VISUALS) expect(SCHEDULED_DRAW[t], t).toBe("svg");
    expect(isPrintedVisual("bar")).toBe(false);
  });
});

describe("a line cut to fit", () => {
  it("keeps what fits and ends with an ellipsis", () => {
    expect(fitText(measure, "Norris", 10, false, 100)).toBe("Norris");
    // 55px holds eleven characters: ten and the ellipsis, the space trimmed.
    expect(fitText(measure, "Autódromo José Carlos Pace", 10, false, 55)).toBe("Autódromo…");
    expect(fitText(measure, "Norris", 10, false, 2)).toBe("");
  });
});

describe("a word cloud on paper", () => {
  const words = Array.from({ length: 40 }, (_, i) => ({
    term: `word${i}`,
    size: 12 + (i % 7) * 5,
  }));

  it("sets every word inside the box, none over another", () => {
    const placed = layoutWordCloud(words, 400, 240, measure);
    expect(placed.length).toBe(40);
    const boxes = placed.map((p) => ({
      x0: p.x,
      x1: p.x + measure(p.term, p.size),
      y0: p.y - p.size,
      y1: p.y,
    }));
    for (const b of boxes) {
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThanOrEqual(400);
      expect(b.y0).toBeGreaterThanOrEqual(0);
      expect(b.y1).toBeLessThanOrEqual(240);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        expect(overlap, `${placed[i].term} / ${placed[j].term}`).toBe(false);
      }
    }
  });

  it("shrinks the words together when they do not fit", () => {
    const roomy = layoutWordCloud(words, 400, 240, measure);
    const tight = layoutWordCloud(words, 400, 90, measure);
    expect(tight[0].size).toBeLessThan(roomy[0].size);
  });
});

describe("a range on paper", () => {
  it("draws gains green, losses red and a held place as a dot, the better end right", () => {
    const rows = [
      { driver: "Hadjar", start: 7, end: 3 },
      { driver: "Russell", start: 2, end: 4 },
      { driver: "Norris", start: 1, end: 1 },
    ];
    const { svg } = svgOf(
      printVisualSvg({
        chart: { type: "range", categoryField: "driver", startField: "start", endField: "end" },
        rows,
        width: 400,
        height: 120,
        measure,
      }),
    );
    const pills = findAll(svg, (e) => e.tag === "rect");
    expect(pills.map((p) => p.attrs.fill)).toEqual(["#16a34a", "#dc2626"]);
    expect(findAll(svg, (e) => e.tag === "circle").length).toBe(1);
    // Positions: lower is better, so the better number is on the right.
    const texts = findAll(svg, (e) => e.tag === "text").map((t) => String(t.children[0]));
    expect(texts.join(" ")).toContain("Hadjar 7 3");
    expect(texts.join(" ")).toContain("Russell 4 2");
  });
});

describe("a bar race on paper", () => {
  it("prints its last frame and says so", () => {
    const rows = ["2023", "2024", "2025"].flatMap((y, k) =>
      ["France", "Spain"].map((c, i) => ({ year: y, country: c, visitors: 10 + k * (i ? 9 : 1) })),
    );
    const html = printVisualSvg({
      chart: { type: "barrace", xField: "country", yField: "visitors", timeField: "year" },
      rows,
      width: 400,
      height: 200,
      measure,
    });
    const { tree, svg } = svgOf(html);
    const texts = findAll(svg, (e) => e.tag === "text").map((t) => String(t.children[0]));
    // 2025: Spain 28, France 12 — Spain first.
    expect(texts.slice(0, 4)).toEqual(["Spain", "28", "France", "12"]);
    expect(texts).toContain("2025");
    const caption = findAll(tree, (e) => e.tag === "p").map((p) => String(p.children[0]));
    expect(caption).toEqual(["The last of 3 frames: 2025. The app plays them all."]);
  });
});

describe("pictures and tiles", () => {
  const podium = [
    { driver: "Norris", pic: "https://example.com/norris.png", badge: SVG_PIC },
    { driver: "Verstappen", pic: "https://example.com/missing.png", badge: SVG_PIC },
    { driver: "Hadjar", pic: "javascript:alert(1)", badge: "" },
  ];
  const cards = {
    type: "cards",
    title: "{{driver}}",
    imageField: "pic",
    iconFields: ["badge"],
  } as const;

  it(
    "fetches each https picture once, uses a data URL as it is, and skips the rest",
    { timeout: 400_000 },
    async () => {
      expect(printPictureUrls(cards as never, podium)).toEqual([
        "https://example.com/norris.png",
        "https://example.com/missing.png",
      ]);
      const fetched: string[] = [];
      const v = await renderVisualMarkup(cards as never, podium, { width: 600, height: 300 }, [], {
        fetchPicture: async (url) => {
          fetched.push(url);
          return url.includes("missing")
            ? new Response(null, { status: 404 })
            : new Response(PNG, { status: 200 });
        },
      });
      expect(fetched).toEqual([
        "https://example.com/norris.png",
        "https://example.com/missing.png",
      ]);
      expect(v.kind).toBe("markup");
      const { svg } = svgOf(v.kind === "markup" ? v.html : "");
      const hrefs = findAll(svg, (e) => e.tag === "image").map((i) => i.attrs.href.slice(0, 22));
      // Norris's photo as a PNG, two badges as SVG; the missing photo and the
      // script address draw nothing.
      expect(hrefs.sort()).toEqual([
        "data:image/png;base64,",
        "data:image/svg+xml;bas",
        "data:image/svg+xml;bas",
      ]);
    },
  );

  it(
    "puts street tiles under a point map only where a tile server is named",
    { timeout: 400_000 },
    async () => {
      const rows = [
        { lat: 40.71, lng: -74.0, name: "A" },
        { lat: 40.75, lng: -73.98, name: "B" },
      ];
      const chart = { type: "pointmap", latField: "lat", lngField: "lng" } as never;
      // No tile server, in either spelling (a developer .env may name one for
      // the dev server): a unit test must never fetch real tiles.
      vi.stubEnv("PUBLIC_MAP_TILES_URL", "");
      vi.stubEnv("VITE_MAP_TILES_URL", "");
      const never = async (): Promise<Response> => {
        throw new Error("no tile should be asked for");
      };
      const plain = await renderVisualMarkup(chart, rows, { width: 400, height: 300 }, [], {
        fetchPicture: never,
      });
      const plainSvg = svgOf(plain.kind === "markup" ? plain.html : "").svg;
      expect(findAll(plainSvg, (e) => e.tag === "image").length).toBe(0);
      expect(findAll(plainSvg, (e) => e.tag === "line").length).toBeGreaterThan(5);

      vi.stubEnv("PUBLIC_MAP_TILES_URL", "https://tiles.example.com/{z}/{x}/{y}.png");
      vi.stubEnv("PUBLIC_MAP_TILES_ATTRIBUTION", "© Example tile makers");
      const asked: string[] = [];
      const tiled = await renderVisualMarkup(chart, rows, { width: 400, height: 300 }, [], {
        fetchPicture: async (url) => {
          asked.push(url);
          return new Response(PNG, { status: 200 });
        },
      });
      const wanted = printMapTiles(
        chart,
        rows,
        400,
        300,
        "https://tiles.example.com/{z}/{x}/{y}.png",
      );
      expect(asked.sort()).toEqual(wanted.map((t) => t.url).sort());
      const tiledSvg = svgOf(tiled.kind === "markup" ? tiled.html : "").svg;
      expect(findAll(tiledSvg, (e) => e.tag === "image").length).toBe(wanted.length);
      expect(tiled.kind === "markup" && tiled.html).toContain("© Example tile makers");
      // Tiles overhang the map. A browser hides that at the svg's edge and a
      // PDF does not: the first Bike Share PDF had street tiles across the
      // page around the card. The ground and the points are clipped to the map.
      expect(
        wanted.some(
          (t) => t.left < 0 || t.top < 0 || t.left + t.size > 400 || t.top + t.size > 300,
        ),
      ).toBe(true);
      const clipped = findAll(
        tiledSvg,
        (e) => e.tag === "g" && e.attrs["clip-path"] === "url(#pm)",
      );
      expect(clipped).toHaveLength(1);
      expect(findAll(clipped[0], (e) => e.tag === "image").length).toBe(wanted.length);
      const box = findAll(tiledSvg, (e) => e.tag === "clippath" && e.attrs.id === "pm").flatMap(
        (c) => findAll(c, (e) => e.tag === "rect"),
      )[0];
      expect(box?.attrs).toMatchObject({
        x: "0",
        y: "0",
        width: tiledSvg.attrs.width,
        height: tiledSvg.attrs.height,
      });
    },
  );
});

/** Every content stream's operators, joined. */
async function operators(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      out.push(Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"));
    } catch {
      // not a content stream
    }
  }
  return out.join("\n");
}

describe("the SVG drawer", () => {
  async function draw(markup: string, pictures?: Map<string, never>) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    const { StandardFonts } = await import("pdf-lib");
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    drawSvg({ page, regular, bold, encode: (s) => s, pictures }, svgOf(markup).svg, {
      x: 0,
      top: 300,
      w: 400,
      h: 300,
    });
    return operators(await doc.save());
  }
  const clipped = (print: boolean) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"${print ? ' data-print="1"' : ""}>` +
    `<defs><clipPath id="c"><rect x="0" y="0" width="50" height="100"/></clipPath></defs>` +
    `<rect width="100" height="100" fill="#ff0000" clip-path="url(#c)"/></svg>`;

  it("clips to a rectangle in a drawing laid out for paper, and only there", async () => {
    expect(await draw(clipped(true))).toMatch(/\bW\s+n\b/);
    // A chart library's own clip paths were never drawn; they still are not.
    expect(await draw(clipped(false))).not.toMatch(/\bW\s+n\b/);
  });

  it("draws an <image> it was handed, and none it was not", async () => {
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(PNG);
    const markup =
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" data-print="1">` +
      `<image x="0" y="0" width="40" height="40" href="data:a"/><image x="50" y="0" width="40" height="40" href="data:b"/></svg>`;
    const page = doc.addPage([400, 300]);
    const { StandardFonts } = await import("pdf-lib");
    drawSvg(
      {
        page,
        regular: await doc.embedFont(StandardFonts.Helvetica),
        bold: await doc.embedFont(StandardFonts.HelveticaBold),
        encode: (s) => s,
        pictures: new Map([["data:a", { kind: "raster", image, w: 1, h: 1 }]]),
      },
      svgOf(markup).svg,
      { x: 0, top: 300, w: 400, h: 300 },
    );
    const ops = await operators(await doc.save());
    expect((ops.match(/ Do\b/g) ?? []).length).toBe(1);
  });
});

describe("a dashboard PDF with all seven", () => {
  it(
    "draws each, its pictures embedded, with no note left for the app",
    { timeout: 400_000 },
    async () => {
      const months = ["2026-01", "2026-02", "2026-03"];
      const regionRows = ["Manhattan", "Brooklyn"].flatMap((r, i) =>
        months.map((m, j) => ({ region: r, month: m, rides: (2 - i) * 100 + j * 10 })),
      );
      const card = (id: string, chart: Record<string, unknown>, rows: object[]) =>
        ({
          id,
          kind: "chart",
          title: `T-${id}`,
          chart,
          rows,
          columns: Object.keys(rows[0]),
        }) as unknown as BiWidget;
      const widgets = [
        card("cards", { type: "cards", title: "{{driver}}", imageField: "pic" }, [
          { driver: "Norris", pic: SVG_PIC },
        ]),
        card("range", { type: "range", categoryField: "d", startField: "s", endField: "e" }, [
          { d: "Hadjar", s: 7, e: 3 },
        ]),
        card("cloud", { type: "wordcloud", textField: "w", valueField: "n" }, [
          { w: "refund", n: 3 },
          { w: "friendly", n: 2 },
        ]),
        card(
          "pict",
          { type: "pictogram", categoryField: "region", valueField: "rides" },
          regionRows,
        ),
        card(
          "sm",
          { type: "smallmultiples", xField: "month", yField: "rides", splitField: "region" },
          regionRows,
        ),
        card(
          "race",
          { type: "barrace", xField: "region", yField: "rides", timeField: "month" },
          regionRows,
        ),
        card("map", { type: "pointmap", latField: "lat", lngField: "lng" }, [
          { lat: 40.7, lng: -74 },
        ]),
      ];
      const bytes = await buildDashboardPdfBytes({
        name: "Seven",
        clock: { date: "2026-11-19", time: "08:00" },
        pages: [
          {
            name: "All",
            widgets,
            layout: widgets.map((w, i) => ({
              i: w.id,
              x: (i % 2) * 6,
              y: Math.floor(i / 2) * 4,
              w: 6,
              h: 4,
            })),
          },
        ],
        renderVisual: (w) => (size) => renderVisualMarkup(w.chart!, w.rows ?? [], size, w.columns),
      });
      const ops = await operators(bytes);
      const strings = [...ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map((m) =>
        Buffer.from(m[1], "hex").toString("latin1"),
      );
      const text = strings.join(" | ");
      expect(text).not.toContain("drawn in the app only");
      for (const s of [
        "Norris",
        "Hadjar",
        "refund",
        "friendly",
        "Each picture is",
        "Manhattan",
        "Brooklyn",
        "2026-03",
      ]) {
        expect(text, s).toContain(s);
      }
      // The card's SVG picture was drawn as vectors (the red square), not left out.
      expect(ops).toMatch(/0\.88\d* 0\.02\d* 0 rg/);
    },
  );
});
