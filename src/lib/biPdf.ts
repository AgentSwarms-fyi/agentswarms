// Client-side PDF export for BI dashboards.
//
// Each widget card is rasterised with html2canvas-pro (which, unlike plain
// html2canvas, understands the oklch() colours our design tokens use) and
// composed into an A4 report with pdf-lib (already a dependency). Widgets
// that share a screen row are kept side by side, preserving the dashboard's
// layout proportions. Multi-page dashboards export every page as its own
// titled section (the caller swaps the live grid to each page in turn).
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from "pdf-lib";

import { AGENTSWARMS_LOGO_BASE64 } from "@/assets/agentswarms-logo-base64";
import type { AnalystTurn } from "@/lib/aiAnalyst";
import { describeVerification, verificationStatus } from "@/lib/analystVerification";

// Loaded on demand: rasterising is a browser-only concern, and keeping it
// out of module scope lets Node tests import the vector PDF builder below.
async function loadHtml2canvas() {
  return (await import("html2canvas-pro")).default;
}

// Landscape A4 — dashboards are wide, so landscape keeps text far more legible
// than portrait (which shrinks a multi-column grid to ~40% and tiny text).
const A4 = { w: 841.89, h: 595.28 };
const MARGIN = 34;
const ROW_GAP = 10;

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
  /** Number of dashboard pages to export (default 1). */
  pageCount?: number;
  /**
   * Make dashboard page `i` the live DOM (the caller swaps the grid) and
   * resolve with its widget container + display name. For a single-page
   * dashboard, just return the current grid container.
   */
  preparePage: (i: number) => Promise<{ container: HTMLElement; name?: string }>;
}): Promise<void> {
  const pageCount = Math.max(1, args.pageCount ?? 1);

  const pdf = await PDFDocument.create();
  pdf.setTitle(args.title);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);

  let page: PDFPage = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN;

  // ── Report header (once, at the top of the document) ──
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

  const contentW = A4.w - MARGIN * 2;
  const pageContentH = A4.h - MARGIN * 2;

  // Append one dashboard page's widgets to the running PDF cursor.
  async function appendContainer(container: HTMLElement): Promise<number> {
    const els = Array.from(container.querySelectorAll<HTMLElement>("[data-widget-id]"));
    if (els.length === 0) return 0;
    const containerLeft = container.getBoundingClientRect().left;

    // Scale by the TRUE content bounds (rightmost widget edge), not just the
    // container width — a widget that extends a hair past the container would
    // otherwise be drawn past the right margin. This guarantees the widest
    // point maps exactly to the content width, so nothing overflows sideways.
    const rects = els.map((el) => el.getBoundingClientRect());
    const rightmost = Math.max(...rects.map((r) => r.right - containerLeft));
    const scale = contentW / Math.max(1, rightmost);

    for (const row of groupIntoRows(els)) {
      const shots = await Promise.all(
        row.map(async (el) => {
          const rect = el.getBoundingClientRect();
          const canvas = await (
            await loadHtml2canvas()
          )(el, {
            scale: 3, // higher DPI so downscaled text stays crisp
            backgroundColor: "#ffffff",
            logging: false,
            // Always capture in light theme so exported reports are
            // print-friendly, regardless of the on-screen theme.
            onclone: (doc) => doc.documentElement.classList.remove("dark"),
          });
          return {
            dataUrl: canvas.toDataURL("image/png"),
            left: rect.left - containerLeft,
            wPx: rect.width,
            hPx: rect.height,
          };
        }),
      );

      // Per-row vertical fit: if a row is taller than a full page, shrink just
      // that row so it can't run off the bottom margin.
      const rowHpx = Math.max(...shots.map((s) => s.hPx));
      const s = rowHpx * scale > pageContentH ? pageContentH / rowHpx : scale;
      const rowH = rowHpx * s;

      if (y - rowH < MARGIN) {
        page = pdf.addPage([A4.w, A4.h]);
        y = A4.h - MARGIN;
      }
      for (const shot of shots) {
        let x = MARGIN + shot.left * s;
        let w = shot.wPx * s;
        let h = shot.hPx * s;
        // Final clamp against sub-pixel drift so an image never crosses a margin.
        if (x < MARGIN) x = MARGIN;
        if (x + w > A4.w - MARGIN) {
          const clamped = A4.w - MARGIN - x;
          if (clamped > 0) {
            h *= clamped / w; // keep aspect ratio
            w = clamped;
          }
        }
        if (w <= 0 || h <= 0) continue;
        const png = await pdf.embedPng(shot.dataUrl);
        page.drawImage(png, { x, y: y - h, width: w, height: h });
      }
      y -= rowH + ROW_GAP;
    }
    return els.length;
  }

  // Section (page) heading between dashboard pages.
  function drawSectionHeading(name: string, fresh: boolean) {
    if (fresh || y - 20 < MARGIN) {
      page = pdf.addPage([A4.w, A4.h]);
      y = A4.h - MARGIN;
    }
    page.drawRectangle({ x: MARGIN, y: y - 13, width: 3, height: 13, color: rgb(0.88, 0.02, 0) });
    page.drawText(name, {
      x: MARGIN + 9,
      y: y - 11,
      size: 12,
      font: bold,
      color: rgb(0.12, 0.12, 0.16),
    });
    y -= 22;
  }

  let drawnWidgets = 0;
  for (let i = 0; i < pageCount; i++) {
    const { container, name } = await args.preparePage(i);
    // Titled section per page when the dashboard has more than one.
    if (pageCount > 1 && name) drawSectionHeading(name, i > 0);
    drawnWidgets += await appendContainer(container);
  }

  if (drawnWidgets === 0) throw new Error("Nothing to export — the dashboard has no widgets");

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

// ── AI Analyst report: VECTOR text, branded ─────────────────────────────
//
// The first version rasterised the thread's DOM blocks; structure survived
// but every paragraph became a downscaled bitmap — soft type on every page.
// This builder lays the report out from the TURN DATA with pdf-lib text
// primitives instead: crisp at any zoom, selectable, searchable, and small.
// Only charts are rasterised (they are pictures). Branding: the AgentSwarms
// mark and wordmark head page one, a brand rule under the title block, and
// every page carries a generated-by footer with page numbers.

const RP = { w: 595.28, h: 841.89 }; // portrait A4
const RM = 44; // page margin
const FOOTER_H = 30;

// Brand teal ≈ the app's --primary (oklch(0.52 0.12 205)).
const BRAND = rgb(0.05, 0.45, 0.55);
const BRAND_TINT = rgb(0.9, 0.955, 0.965);
const INK = rgb(0.1, 0.11, 0.14);
const MUTED = rgb(0.42, 0.44, 0.5);
const FAINT = rgb(0.62, 0.64, 0.68);
const HAIRLINE = rgb(0.87, 0.885, 0.9);
const PANEL = rgb(0.963, 0.968, 0.973);
const PASS_C = rgb(0.13, 0.55, 0.36);
const WARN_C = rgb(0.72, 0.5, 0.08);

/**
 * WinAnsi-safe text: map what has an equivalent, drop what doesn't.
 *
 * NEWLINES SURVIVE. They are structure — SQL lines, markdown paragraphs and
 * bullets — and the wrappers below split on them. A first version left \n
 * outside the kept range, so every statement rendered as one run-on line
 * ("total_salesFROM saas_sales") and every findings list collapsed into a
 * single paragraph. encLine() strips them for single-line draws instead.
 */
function enc(s: string): string {
  return (
    s
      .replace(/→/g, "->")
      // \u00A0, not a literal non-breaking space. Identical behaviour and
      // deliberate — NBSP has no WinAnsi glyph, so it becomes a normal
      // space — but written literally it is a character you cannot see,
      // cannot tell apart from the space beside it, and would delete by
      // accident. That is what no-irregular-whitespace guards against, and it
      // was one of the four errors failing CI.
      .replace(/\u00A0/g, " ")
      .replace(/[^\n\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, "")
  );
}

/** enc() for a single drawText call, which cannot contain line breaks. */
function encLine(s: string): string {
  return enc(s).replace(/\n/g, " ");
}

/**
 * Wrap PRE-formatted text (SQL): keep the author's line breaks and leading
 * indentation, hard-breaking only lines too wide for the column. wrapText
 * reflows words, which is right for prose and wrong for a statement.
 */
function wrapPre(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const original of enc(text).split("\n")) {
    const indent = (/^[ \t]*/.exec(original)?.[0] ?? "").replace(/\t/g, "  ");
    let rest = original.replace(/\t/g, "  ");
    let guard = 0;
    while (font.widthOfTextAtSize(rest, size) > width && guard++ < 200) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
      out.push(rest.slice(0, cut));
      rest = indent + "  " + rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  return out;
}

function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of enc(text).split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (let w of words) {
      // Hard-break tokens wider than the column (long identifiers, URLs).
      while (font.widthOfTextAtSize(w, size) > width) {
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
        const head = w.slice(0, cut);
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(head);
        w = w.slice(cut);
      }
      const probe = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(probe, size) <= width) line = probe;
      else {
        out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

type InlineRun = { text: string; bold: boolean; code: boolean };

/** Minimal markdown: **bold** and `code` runs; bullets handled by caller. */
function parseInlineRuns(line: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) runs.push({ text: line.slice(last, m.index), bold: false, code: false });
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true, code: false });
    else runs.push({ text: m[2], bold: false, code: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) runs.push({ text: line.slice(last), bold: false, code: false });
  return runs;
}

export async function buildAnalysisPdfBytes(args: {
  title: string;
  analystName: string;
  /** Display model id (the part after "provider::"). */
  model: string;
  sourceText: string;
  turns: AnalystTurn[];
  /** Rasterised charts keyed "turnIndex-stepIndex" (PNG + pixel size). */
  charts?: Map<string, { dataUrl: string; wPx: number; hPx: number }>;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(args.title);
  pdf.setAuthor("AgentSwarms AI Analyst");
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const contentW = RP.w - RM * 2;

  let page: PDFPage = pdf.addPage([RP.w, RP.h]);
  let y = RP.h - RM;

  const newPage = () => {
    page = pdf.addPage([RP.w, RP.h]);
    y = RP.h - RM;
  };
  /** Guarantee room for `h` points of content above the footer band. */
  const ensure = (h: number) => {
    if (y - h < RM + FOOTER_H) newPage();
  };
  const text = (
    s: string,
    o: { x?: number; font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> },
  ) => {
    page.drawText(encLine(s), {
      x: o.x ?? RM,
      y: y - (o.size ?? 9.5),
      size: o.size ?? 9.5,
      font: o.font ?? regular,
      color: o.color ?? INK,
    });
  };
  const wrapped = (
    s: string,
    o: {
      font?: PDFFont;
      size?: number;
      color?: ReturnType<typeof rgb>;
      leading?: number;
      x?: number;
      width?: number;
    } = {},
  ) => {
    const font = o.font ?? regular;
    const size = o.size ?? 9.5;
    const leading = o.leading ?? size + 4;
    for (const line of wrapText(s, font, size, o.width ?? contentW - ((o.x ?? RM) - RM))) {
      ensure(leading);
      text(line, { x: o.x, font, size, color: o.color });
      y -= leading;
    }
  };
  const gap = (h: number) => {
    y -= h;
  };

  // ── Brand header (page one) ──
  try {
    const logo = await pdf.embedPng(AGENTSWARMS_LOGO_BASE64);
    page.drawImage(logo, { x: RM, y: y - 24, width: 24, height: 24 });
  } catch {
    page.drawRectangle({ x: RM, y: y - 24, width: 24, height: 24, color: BRAND });
  }
  page.drawText("AgentSwarms", { x: RM + 31, y: y - 16, size: 13.5, font: bold, color: INK });
  const tag = "AI Analyst report";
  page.drawText(tag, {
    x: RP.w - RM - regular.widthOfTextAtSize(tag, 9),
    y: y - 15,
    size: 9,
    font: regular,
    color: MUTED,
  });
  y -= 40;

  // A thread titles itself from its first question, truncated. Printing
  // both the title and that question renders the same sentence twice —
  // once cut short. Print the COMPLETE question as the title instead and
  // skip the duplicate band below.
  const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
  const firstQ = args.turns[0]?.question ?? "";
  const titleIsFirstQuestion =
    firstQ.length > 0 && norm(firstQ).startsWith(norm(args.title).replace(/…$/, ""));
  wrapped(titleIsFirstQuestion ? firstQ : args.title, { font: bold, size: 15, leading: 19 });
  gap(2);
  wrapped(
    `${args.analystName}  ·  ${args.model}  ·  ${args.sourceText}  ·  exported ${new Date().toLocaleString()}`,
    { size: 8.5, color: MUTED, leading: 12 },
  );
  gap(4);
  page.drawRectangle({ x: RM, y: y - 2, width: contentW, height: 2, color: BRAND });
  gap(18);

  // ── Panels (SQL) ──
  const panel = (lines: string[], font: PDFFont, size: number, tint = PANEL) => {
    const leading = size + 3;
    const padX = 8;
    const padY = 6;
    let i = 0;
    while (i < lines.length) {
      const room = Math.floor((y - RM - FOOTER_H - padY * 2) / leading);
      if (room < 2 && i === 0) newPage();
      const take = Math.max(
        2,
        Math.min(lines.length - i, Math.floor((y - RM - FOOTER_H - padY * 2) / leading)),
      );
      const seg = lines.slice(i, i + take);
      const h = seg.length * leading + padY * 2;
      page.drawRectangle({ x: RM, y: y - h, width: contentW, height: h, color: tint });
      let ty = y - padY;
      for (const line of seg) {
        page.drawText(enc(line), { x: RM + padX, y: ty - size, size, font, color: INK });
        ty -= leading;
      }
      y -= h;
      i += take;
      if (i < lines.length) newPage();
    }
  };

  // ── Result table ──
  const table = (allColumns: string[], rows: Record<string, unknown>[], rowCount?: number) => {
    let columns = allColumns;
    const size = 7.5;
    const rowH = 14;
    const maxRows = Math.min(rows.length, 10);
    const cell = (v: unknown) => (v === null || v === undefined ? "null" : String(v));
    // A portrait page cannot hold an unbounded number of columns. Squeezing
    // them all in produces a row of ellipses that says nothing — measured on
    // a live 14-column segment breakdown, which rendered as
    // "… 3719… 777 478.70…", key column included.
    //
    // So NOTHING is scaled down: each column gets the width its header and
    // values actually need, columns are kept while they fit, and the rest
    // are named underneath. A disclosed omission beats an illegible table,
    // and the reader can always re-run the step's SQL for the full result.
    const natural = allColumns.map((c) => {
      let w = bold.widthOfTextAtSize(enc(c), size);
      for (let r = 0; r < maxRows; r++) {
        w = Math.max(w, regular.widthOfTextAtSize(enc(cell(rows[r][c])), size));
      }
      return Math.min(w + 12, 170);
    });
    let used = 0;
    let keep = 0;
    for (let i = 0; i < allColumns.length; i++) {
      if (keep > 0 && used + natural[i] > contentW) break;
      used += natural[i];
      keep++;
    }
    const hiddenCols = allColumns.slice(keep);
    columns = allColumns.slice(0, keep);
    const scaled = natural.slice(0, keep);
    const numeric = columns.map((c) =>
      rows.slice(0, maxRows).every((r) => {
        const v = r[c];
        return v === null || v === undefined || typeof v === "number";
      }),
    );
    const fit = (s: string, w: number) => {
      let t = enc(s);
      while (t.length > 1 && regular.widthOfTextAtSize(t, size) > w - 8) {
        t = `${t.slice(0, -2)}…`;
      }
      return t;
    };
    ensure(rowH * 2);
    // Header
    page.drawRectangle({ x: RM, y: y - rowH, width: contentW, height: rowH, color: PANEL });
    let x = RM;
    columns.forEach((c, ci) => {
      const t = fit(c, scaled[ci]);
      const tx = numeric[ci] ? x + scaled[ci] - 4 - bold.widthOfTextAtSize(t, size) : x + 4;
      page.drawText(t, { x: tx, y: y - rowH + 4, size, font: bold, color: MUTED });
      x += scaled[ci];
    });
    y -= rowH;
    for (let r = 0; r < maxRows; r++) {
      ensure(rowH);
      page.drawLine({
        start: { x: RM, y },
        end: { x: RM + contentW, y },
        thickness: 0.4,
        color: HAIRLINE,
      });
      let cx = RM;
      columns.forEach((c, ci) => {
        const t = fit(cell(rows[r][c]), scaled[ci]);
        const tx = numeric[ci] ? cx + scaled[ci] - 4 - regular.widthOfTextAtSize(t, size) : cx + 4;
        page.drawText(t, { x: tx, y: y - rowH + 4, size, font: regular, color: INK });
        cx += scaled[ci];
      });
      y -= rowH;
    }
    const notes: string[] = [];
    if ((rowCount ?? rows.length) > maxRows) {
      notes.push(`${rowCount ?? rows.length} rows in total — showing the first ${maxRows}`);
    }
    if (hiddenCols.length > 0) {
      notes.push(
        `${hiddenCols.length} more column${hiddenCols.length === 1 ? "" : "s"} not shown: ${hiddenCols.join(", ")}`,
      );
    }
    if (notes.length > 0) {
      gap(3);
      wrapped(`… ${notes.join(". ")}.`, { size: 7.5, color: FAINT, leading: 10 });
    }
  };

  // ── Findings (minimal markdown: paragraphs, bullets, bold/code runs) ──
  const findings = (md: string) => {
    const size = 9.5;
    const leading = 14;
    for (const raw of enc(md).split("\n")) {
      const lineTxt = raw.trim();
      if (!lineTxt) {
        gap(4);
        continue;
      }
      const bullet = /^([-*•]|\d+[.)])\s+/.exec(lineTxt);
      const body = bullet ? lineTxt.slice(bullet[0].length) : lineTxt.replace(/^#+\s*/, "");
      const x0 = bullet ? RM + 12 : RM;
      const width = contentW - (x0 - RM);
      // Fill lines from styled runs, measuring word by word.
      const runs = parseInlineRuns(body);
      let line: InlineRun[] = [];
      let lineW = 0;
      let first = true;
      const flush = () => {
        if (line.length === 0) return;
        ensure(leading);
        if (bullet && first) {
          page.drawText("•", { x: RM + 2, y: y - size, size, font: bold, color: BRAND });
        }
        first = false;
        // Merge adjacent same-style words into ONE text operator. Drawing
        // word by word renders identically but extracts as fragments, so a
        // reader copying "Direct answer:" out of the report would get it in
        // pieces — the report is meant to be quotable.
        const merged: InlineRun[] = [];
        for (const seg of line) {
          const prev = merged[merged.length - 1];
          if (prev && prev.bold === seg.bold && prev.code === seg.code) prev.text += seg.text;
          else merged.push({ ...seg });
        }
        let x = x0;
        for (const seg of merged) {
          const f = seg.bold ? bold : seg.code ? mono : regular;
          const sz = seg.code ? size - 1 : size;
          page.drawText(enc(seg.text), { x, y: y - size, size: sz, font: f, color: INK });
          x += f.widthOfTextAtSize(enc(seg.text), sz);
        }
        y -= leading;
        line = [];
        lineW = 0;
      };
      for (const run of runs) {
        const f = run.bold ? bold : run.code ? mono : regular;
        const sz = run.code ? size - 1 : size;
        for (const word of run.text.split(/(\s+)/)) {
          if (!word) continue;
          const w = f.widthOfTextAtSize(enc(word), sz);
          if (lineW + w > width && lineW > 0 && word.trim()) {
            flush();
          }
          if (lineW === 0 && !word.trim()) continue; // no leading spaces
          line.push({ text: word, bold: run.bold, code: run.code });
          lineW += w;
        }
      }
      flush();
    }
  };

  const label = (t: string) => {
    ensure(14);
    text(t.toUpperCase(), { font: bold, size: 7, color: FAINT });
    y -= 12;
  };

  // ── Turns ──
  for (let ti = 0; ti < args.turns.length; ti++) {
    const turn = args.turns[ti];
    if (ti > 0) {
      gap(10);
      ensure(20);
      page.drawLine({
        start: { x: RM, y },
        end: { x: RM + contentW, y },
        thickness: 0.6,
        color: HAIRLINE,
      });
      gap(14);
    }

    // Question band (skipped for the first turn when the title already is it)
    const qLines =
      ti === 0 && titleIsFirstQuestion ? [] : wrapText(turn.question, bold, 11, contentW - 20);
    const qh = qLines.length === 0 ? 0 : qLines.length * 15 + 12;
    if (qh > 0) {
      ensure(qh);
      page.drawRectangle({ x: RM, y: y - qh, width: contentW, height: qh, color: BRAND_TINT });
      page.drawRectangle({ x: RM, y: y - qh, width: 3, height: qh, color: BRAND });
      let qy = y - 6;
      for (const l of qLines) {
        page.drawText(encLine(l), { x: RM + 10, y: qy - 11, size: 11, font: bold, color: INK });
        qy -= 15;
      }
      y -= qh + 10;
    }

    if (turn.approach) {
      label("Approach");
      wrapped(turn.approach, { size: 9.5, leading: 13.5, color: INK });
      gap(8);
    }

    for (let si = 0; si < turn.steps.length; si++) {
      const s = turn.steps[si];
      ensure(26);
      text(`STEP ${si + 1}`, { font: bold, size: 7.5, color: BRAND });
      y -= 12;
      wrapped(s.goal, { font: bold, size: 9.5, leading: 13 });
      gap(4);
      // Provenance travels with the report. A reader who receives the PDF has
      // no thread to hover over, and "this came from the governed model" is
      // exactly the claim a circulated number needs to carry.
      if (s.governed) {
        wrapped(
          `Compiled from governed model ${s.governed.model}` +
            (s.governed.rollup ? ` · answered by rollup ${s.governed.rollup}` : "") +
            (s.governed.accessNote ? ` · ${s.governed.accessNote}` : ""),
          { size: 8, color: BRAND, leading: 11 },
        );
        gap(4);
      }
      if (s.sql) {
        panel(wrapPre(s.sql, mono, 7.5, contentW - 16), mono, 7.5);
        gap(6);
      }
      if (s.error) {
        wrapped(`Failed: ${s.error}`, { size: 8.5, color: WARN_C, leading: 12 });
        gap(6);
      } else if (s.rows && s.columns) {
        // The step's own visual, above its numbers — the same order the
        // thread shows, and every step that has one gets one.
        const chart = args.charts?.get(`${ti}-${si}`);
        if (chart) {
          const w = contentW;
          const h = Math.min((chart.hPx / Math.max(1, chart.wPx)) * w, 260);
          ensure(h + 8);
          try {
            const png = await pdf.embedPng(chart.dataUrl);
            page.drawImage(png, { x: RM, y: y - h, width: w, height: h });
            page.drawRectangle({
              x: RM,
              y: y - h,
              width: w,
              height: h,
              borderColor: HAIRLINE,
              borderWidth: 0.6,
            });
            y -= h + 8;
          } catch {
            /* a chart that fails to embed must not sink the report */
          }
        }
        table(s.columns, s.rows, s.rowCount);
        gap(6);
      }
      if (s.check) {
        const c =
          s.check.verdict === "pass"
            ? { col: PASS_C, lbl: "Check passed" }
            : s.check.verdict === "refined"
              ? { col: BRAND, lbl: "Self-corrected" }
              : { col: WARN_C, lbl: "Flagged" };
        ensure(14);
        page.drawRectangle({ x: RM, y: y - 11, width: 2, height: 11, color: c.col });
        const lblW = bold.widthOfTextAtSize(`${c.lbl}. `, 8.5);
        page.drawText(`${c.lbl}. `, { x: RM + 7, y: y - 9, size: 8.5, font: bold, color: c.col });
        const noteLines = wrapText(s.check.note, regular, 8.5, contentW - 7 - lblW);
        if (noteLines[0]) {
          page.drawText(enc(noteLines[0]), {
            x: RM + 7 + lblW,
            y: y - 9,
            size: 8.5,
            font: regular,
            color: MUTED,
          });
        }
        y -= 13;
        for (const l of noteLines.slice(1)) {
          ensure(11);
          page.drawText(enc(l), { x: RM + 7, y: y - 9, size: 8.5, font: regular, color: MUTED });
          y -= 11;
        }
        gap(8);
      } else {
        gap(4);
      }
    }

    if (turn.error) {
      wrapped(`Analysis failed: ${turn.error}`, { size: 9, color: WARN_C, leading: 13 });
      gap(6);
    }

    if (turn.answer) {
      gap(2);
      label("Findings");
      findings(turn.answer);
      gap(6);
    }

    // The verdict travels with the report, INCLUDING a voided one. A reader
    // who receives the PDF cannot hover a badge, and "someone checked this"
    // is exactly the claim a circulated answer carries furthest.
    const vstatus = verificationStatus(turn);
    if (vstatus.kind !== "none") {
      wrapped(describeVerification(vstatus), {
        size: 8.5,
        color:
          vstatus.kind === "active" && vstatus.verification.state === "verified" ? BRAND : WARN_C,
        leading: 12,
      });
      gap(6);
    }
  }

  // ── Footer on every page ──
  const pages = pdf.getPages();
  const stamp = `Generated with AgentSwarms AI Analyst · ${new Date().toLocaleDateString()}`;
  pages.forEach((p, i) => {
    p.drawLine({
      start: { x: RM, y: RM + 12 },
      end: { x: RP.w - RM, y: RM + 12 },
      thickness: 0.5,
      color: HAIRLINE,
    });
    p.drawText(stamp, { x: RM, y: RM, size: 7.5, font: regular, color: FAINT });
    const pn = `Page ${i + 1} of ${pages.length}`;
    p.drawText(pn, {
      x: RP.w - RM - regular.widthOfTextAtSize(pn, 7.5),
      y: RM,
      size: 7.5,
      font: regular,
      color: FAINT,
    });
  });

  return pdf.save();
}

/**
 * Browser wrapper: rasterise each turn's chart (the only bitmap content),
 * build the vector report, download it.
 */
export async function exportAnalysisPdf(args: {
  title: string;
  analystName: string;
  model: string;
  sourceText: string;
  turns: AnalystTurn[];
  /** Resolve a step's rendered chart element, if it has one. */
  chartElFor?: (turnIndex: number, stepIndex: number) => HTMLElement | null;
}): Promise<void> {
  if (args.turns.length === 0) {
    throw new Error("Nothing to export — ask the analyst something first");
  }
  const charts = new Map<string, { dataUrl: string; wPx: number; hPx: number }>();
  if (args.chartElFor) {
    const html2canvas = await loadHtml2canvas();
    for (let i = 0; i < args.turns.length; i++) {
      for (let j = 0; j < args.turns[i].steps.length; j++) {
        const el = args.chartElFor(i, j);
        if (!el) continue;
        const canvas = await html2canvas(el, {
          scale: 3,
          backgroundColor: "#ffffff",
          logging: false,
          onclone: (doc) => doc.documentElement.classList.remove("dark"),
        });
        const rect = el.getBoundingClientRect();
        charts.set(`${i}-${j}`, {
          dataUrl: canvas.toDataURL("image/png"),
          wPx: rect.width,
          hPx: rect.height,
        });
      }
    }
  }
  const bytes = await buildAnalysisPdfBytes({ ...args, charts });
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
