// SVG pictures in a PDF (R510): a logo or a drawing kept as an SVG is drawn
// as vectors, in a report's picture block and in a dashboard's picture card,
// rather than printed as "shown in the app only".
import { decodePDFRawStream, PDFDocument, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { buildDashboardPdfBytes } from "@/lib/biDashboardPdf";
import type { BiWidget } from "@/lib/biDashboards";
import {
  dataUrlBytes,
  resolveReportImages,
  sniffImageType,
  svgPicture,
} from "@/lib/biReportImages";
import { buildReportPdfBytes } from "@/lib/biReportPdf";
import { DEFAULT_PAGE, type BiReport, type ReportBlock } from "@/lib/biReports";

const LOGO_SVG =
  '<?xml version="1.0"?>\n<!-- drawn by hand -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50">' +
  '<rect x="2" y="2" width="46" height="46" rx="6" fill="#0f766e"/>' +
  '<path d="M10 40 L25 10 L40 40 Z" fill="#ffffff"/>' +
  '<text x="60" y="34" font-size="24" fill="#111827">Riverside</text>' +
  '<script>alert("never run")</script>' +
  "</svg>";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const SVG_B64 = `data:image/svg+xml;base64,${b64(LOGO_SVG)}`;
const SVG_TEXT = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LOGO_SVG)}`;

/** Every string drawn, and how many filled paths, across the whole PDF. */
async function pdfInk(bytes: Uint8Array): Promise<{ text: string; fills: number }> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  let fills = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let ops: string;
    try {
      ops = Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1");
    } catch {
      continue;
    }
    for (const m of ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      out.push(Buffer.from(m[1], "hex").toString("latin1"));
    }
    fills += (ops.match(/(^|\s)(f|B|f\*|B\*)(\s|$)/g) ?? []).length;
  }
  return { text: out.join(" | "), fills };
}

describe("an SVG picture's bytes", () => {
  it("is read from a data URL, base64 or percent-encoded, and known by its first tag", () => {
    for (const src of [SVG_B64, SVG_TEXT]) {
      const bytes = dataUrlBytes(src);
      expect(bytes, src.slice(0, 30)).not.toBeNull();
      expect(sniffImageType(bytes!)).toBe("svg");
    }
    // Saved with a byte-order mark, as some editors do.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("<svg></svg>")]);
    expect(sniffImageType(bom)).toBe("svg");
    // A PNG written as text is not a picture.
    expect(dataUrlBytes("data:image/png,not-base64")).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("<html><svg></svg></html>"))).toBeNull();
  });

  it("takes its size from width and height, else its viewBox, and has none without both", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(svgPicture(enc(LOGO_SVG))).toMatchObject({ w: 200, h: 50 });
    expect(svgPicture(enc('<svg width="100" viewBox="0 0 200 50"></svg>'))).toMatchObject({
      w: 100,
      h: 25,
    });
    expect(svgPicture(enc('<svg width="100%" height="100%" viewBox="0 0 40 30"/>'))).toMatchObject({
      w: 40,
      h: 30,
    });
    expect(svgPicture(enc("<svg><rect width='5' height='5'/></svg>"))).toBeNull();
  });

  it("is kept for the PDF, and one with no size is left out", async () => {
    const blocks = [
      { id: "logo", kind: "image", src: SVG_B64, height: 40 },
      {
        id: "sizeless",
        kind: "image",
        src: `data:image/svg+xml;base64,${b64("<svg><circle r='4'/></svg>")}`,
        height: 40,
      },
    ] as ReportBlock[];
    const images = await resolveReportImages(blocks);
    expect([...images.keys()]).toEqual(["logo"]);
    expect(images.get("logo")!.type).toBe("svg");
  });
});

describe("an SVG picture in a PDF", () => {
  it("is drawn as shapes and text in a dashboard's picture card", async () => {
    const images = await resolveReportImages([
      { id: "pic", kind: "image", src: SVG_B64, height: 40 } as ReportBlock,
    ]);
    const bytes = await buildDashboardPdfBytes({
      name: "Brand",
      clock: { date: "2026-11-19", time: "08:00" },
      pages: [
        {
          name: "Only",
          widgets: [
            { id: "pic", kind: "image", title: "", image: { src: SVG_B64 } } as unknown as BiWidget,
          ],
          layout: [{ i: "pic", x: 0, y: 0, w: 6, h: 2 }],
        },
      ],
      renderVisual: () => null,
      images,
    });
    const ink = await pdfInk(bytes);
    expect(ink.text).toContain("Riverside");
    expect(ink.text).not.toContain("shown in the app only");
    expect(ink.text).not.toContain("never run");
    // The square and the triangle, besides the card's frame.
    expect(ink.fills).toBeGreaterThanOrEqual(3);
  });

  it("is drawn in a report's picture block", async () => {
    const report: BiReport = {
      name: "Letterhead",
      page: DEFAULT_PAGE,
      header: {},
      footer: {},
      blocks: [{ id: "logo", kind: "image", src: SVG_TEXT, height: 40, align: "center" }],
    };
    const images = await resolveReportImages(report.blocks);
    const ink = await pdfInk(await buildReportPdfBytes({ report, images }));
    expect(ink.text).toContain("Riverside");
    expect(ink.text).not.toContain("picture unavailable");
  });
});
