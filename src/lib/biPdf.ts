// Client-side PDF export for BI dashboards.
//
// Each widget card is rasterised with html2canvas-pro (which, unlike plain
// html2canvas, understands the oklch() colours our design tokens use) and
// composed into an A4 report with pdf-lib (already a dependency). Widgets
// that share a screen row are kept side by side, preserving the dashboard's
// layout proportions.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import html2canvas from "html2canvas-pro";

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 40;
const ROW_GAP = 12;

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "dashboard";
}

/** Group widget elements into visual rows by their on-screen top edge. */
function groupIntoRows(els: HTMLElement[]): HTMLElement[][] {
  const sorted = [...els].sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return ra.top - rb.top || ra.left - rb.left;
  });
  const rows: HTMLElement[][] = [];
  let currentTop = Number.NEGATIVE_INFINITY;
  for (const el of sorted) {
    const top = el.getBoundingClientRect().top;
    if (Math.abs(top - currentTop) > 16) {
      rows.push([el]);
      currentTop = top;
    } else {
      rows[rows.length - 1].push(el);
    }
  }
  return rows;
}

export async function exportDashboardPdf(args: {
  title: string;
  description?: string | null;
  /** The grid container; widgets are found via [data-widget-id]. */
  container: HTMLElement;
}): Promise<void> {
  const els = Array.from(args.container.querySelectorAll<HTMLElement>("[data-widget-id]"));
  if (els.length === 0) throw new Error("Nothing to export — the dashboard has no widgets");

  const containerWidth = args.container.getBoundingClientRect().width;
  const contentW = A4.w - MARGIN * 2;
  const scale = contentW / containerWidth;

  const pdf = await PDFDocument.create();
  pdf.setTitle(args.title);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);

  let page = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN;

  // Header
  page.drawText(args.title, {
    x: MARGIN,
    y: y - 16,
    size: 17,
    font: bold,
    color: rgb(0.09, 0.09, 0.13),
  });
  y -= 26;
  if (args.description) {
    page.drawText(args.description.slice(0, 160), {
      x: MARGIN,
      y: y - 9,
      size: 9,
      font: regular,
      color: rgb(0.35, 0.35, 0.4),
    });
    y -= 15;
  }
  page.drawText(`Exported ${new Date().toLocaleString()} · AgentSwarms BI`, {
    x: MARGIN,
    y: y - 8,
    size: 7.5,
    font: regular,
    color: rgb(0.55, 0.55, 0.6),
  });
  y -= 22;

  const containerLeft = args.container.getBoundingClientRect().left;

  for (const row of groupIntoRows(els)) {
    // Rasterise the whole row first so we know its height on the page.
    const captures = await Promise.all(
      row.map(async (el) => {
        const rect = el.getBoundingClientRect();
        const canvas = await html2canvas(el, {
          scale: 2,
          backgroundColor: "#ffffff",
          logging: false,
          // Always capture in light theme so exported reports are
          // print-friendly, regardless of the on-screen theme.
          onclone: (doc) => doc.documentElement.classList.remove("dark"),
        });
        return {
          dataUrl: canvas.toDataURL("image/png"),
          x: MARGIN + (rect.left - containerLeft) * scale,
          w: rect.width * scale,
          h: rect.height * scale,
        };
      }),
    );
    const rowH = Math.max(...captures.map((c) => c.h));

    if (y - rowH < MARGIN) {
      page = pdf.addPage([A4.w, A4.h]);
      y = A4.h - MARGIN;
    }
    for (const c of captures) {
      const png = await pdf.embedPng(c.dataUrl);
      page.drawImage(png, { x: c.x, y: y - c.h, width: c.w, height: c.h });
    }
    y -= rowH + ROW_GAP;
  }

  const bytes = await pdf.save();
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFileName(args.title)}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
