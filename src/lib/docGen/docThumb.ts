// Small SVG thumbnails of a generated document's first slide / page / sheet,
// shown in the chat as a preview card (with a download button) instead of
// auto-downloading the file.
import type { DocxPlan, MaterializedXlsxPlan, PptxPlan } from "./types";

const FONT = "Segoe UI, Arial, sans-serif";
const W = 360;
const H = 224;

function hx(c: string | undefined, fallback: string): string {
  const h = (c ?? "").replace(/^#/, "").trim();
  return "#" + (/^[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : fallback);
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = String(text ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (((cur ? cur + " " : "") + w).length > maxChars && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) break;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines;
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

function toDataUri(s: string): string {
  const b64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(s)))
      : Buffer.from(s, "utf-8").toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}

/** PowerPoint — mirrors the deep-ink cover slide (accent, title, subtitle). */
export function pptxThumb(plan: PptxPlan): string {
  const accent = hx(plan.accent, "4F46E5");
  const title = wrap(plan.title || "Untitled", 26, 3);
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#0B1220"/>`);
  parts.push(`<circle cx="${W - 24}" cy="18" r="70" fill="${accent}" fill-opacity="0.22"/>`);
  parts.push(`<circle cx="${W - 6}" cy="40" r="44" fill="${accent}" fill-opacity="0.30"/>`);
  parts.push(`<rect x="22" y="70" width="26" height="5" rx="2.5" fill="${accent}"/>`);
  parts.push(
    `<text x="56" y="76" font-family="${FONT}" font-size="10" font-weight="700" fill="#CBD5E1" letter-spacing="2">REPORT</text>`,
  );
  title.forEach((ln, i) =>
    parts.push(
      `<text x="22" y="${104 + i * 26}" font-family="${FONT}" font-size="21" font-weight="700" fill="#ffffff">${esc(ln)}</text>`,
    ),
  );
  if (plan.subtitle)
    parts.push(
      `<text x="22" y="${196}" font-family="${FONT}" font-size="12" fill="#94A3B8">${esc(wrap(plan.subtitle, 46, 1)[0] || "")}</text>`,
    );
  return svg(parts.join(""));
}

/** Word — a page with a title, accent rule, and a few text lines. */
export function docxThumb(plan: DocxPlan): string {
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#EEF1F5"/>`);
  // page
  const px = 46;
  const pw = W - px * 2;
  parts.push(
    `<rect x="${px}" y="14" width="${pw}" height="${H - 20}" rx="4" fill="#ffffff" stroke="#E2E8F0"/>`,
  );
  const title = wrap(plan.title || "Document", 30, 2);
  title.forEach((ln, i) =>
    parts.push(
      `<text x="${px + 18}" y="${44 + i * 20}" font-family="${FONT}" font-size="15" font-weight="700" fill="#0F172A">${esc(ln)}</text>`,
    ),
  );
  parts.push(
    `<rect x="${px + 18}" y="${54 + (title.length - 1) * 20}" width="46" height="3" rx="1.5" fill="#2563EB"/>`,
  );
  // body text lines (represent the first paragraphs/headings)
  let y = 78 + (title.length - 1) * 20;
  const blocks = (plan.blocks ?? []).slice(0, 7);
  for (const b of blocks) {
    if (y > H - 22) break;
    if (b.type === "heading") {
      parts.push(
        `<rect x="${px + 18}" y="${y}" width="${Math.min(pw - 36, 120)}" height="7" rx="3.5" fill="#334155"/>`,
      );
      y += 18;
    } else {
      const lines = b.type === "paragraph" ? 2 : 1;
      for (let i = 0; i < lines; i++) {
        const w = pw - 36 - (i === lines - 1 ? 40 : 0);
        parts.push(
          `<rect x="${px + 18}" y="${y}" width="${w}" height="5" rx="2.5" fill="#CBD5E1"/>`,
        );
        y += 12;
      }
      y += 6;
    }
  }
  return svg(parts.join(""));
}

/** Excel — a spreadsheet grid: green header + column headers + a few rows. */
export function xlsxThumb(plan: MaterializedXlsxPlan): string {
  const sheet = (plan.sheets ?? []).find((s) => s && (s.headers?.length || s.rows?.length));
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  // green title bar
  parts.push(`<rect x="0" y="0" width="${W}" height="34" fill="#217346"/>`);
  parts.push(
    `<text x="16" y="22" font-family="${FONT}" font-size="14" font-weight="700" fill="#ffffff">${esc(sheet?.name || "Sheet1")}</text>`,
  );
  const cols = Math.min(4, sheet?.headers?.length || 4);
  const colW = (W - 16) / cols;
  const rowH = 30;
  const startY = 44;
  // header row
  for (let c = 0; c < cols; c++) {
    const x = 8 + c * colW;
    parts.push(
      `<rect x="${x}" y="${startY}" width="${colW - 2}" height="${rowH}" fill="#E8F0EA" stroke="#CFE0D4"/>`,
    );
    const h = sheet?.headers?.[c];
    parts.push(
      `<text x="${x + 8}" y="${startY + 20}" font-family="${FONT}" font-size="11" font-weight="700" fill="#14532D">${esc(wrap(String(h ?? `Col ${c + 1}`), Math.floor(colW / 7), 1)[0] || "")}</text>`,
    );
  }
  // data rows
  const rows = (sheet?.rows ?? []).slice(0, 4);
  const nRows = Math.max(rows.length, 4);
  for (let r = 0; r < nRows; r++) {
    const y = startY + rowH * (r + 1);
    for (let c = 0; c < cols; c++) {
      const x = 8 + c * colW;
      parts.push(
        `<rect x="${x}" y="${y}" width="${colW - 2}" height="${rowH}" fill="#ffffff" stroke="#E7EBF0"/>`,
      );
      const cell = rows[r]?.[c];
      const text = cell && typeof cell === "object" ? "" : cell;
      if (text !== undefined && text !== null && text !== "")
        parts.push(
          `<text x="${x + 8}" y="${y + 20}" font-family="${FONT}" font-size="11" fill="#334155">${esc(wrap(String(text), Math.floor(colW / 7), 1)[0] || "")}</text>`,
        );
    }
  }
  return svg(parts.join(""));
}

export function pptxThumbUri(plan: PptxPlan): string {
  return toDataUri(pptxThumb(plan));
}
export function docxThumbUri(plan: DocxPlan): string {
  return toDataUri(docxThumb(plan));
}
export function xlsxThumbUri(plan: MaterializedXlsxPlan): string {
  return toDataUri(xlsxThumb(plan));
}
