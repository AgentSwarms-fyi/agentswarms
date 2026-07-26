// Self-contained SVG "SmartArt-style" diagram renderer for generated decks.
//
// This is the layout/diagram engine: the LLM emits a structured spec (a
// DocDiagram) and here we lay it out as a polished SVG (rounded cards,
// connectors, shadows, a multi-colour palette) that build.ts embeds as an image
// (pptxgenjs adds a PNG fallback). It turns "walls of bullets" into process
// flows, timelines, comparisons, cards, funnels and pyramids.
import type { DocDiagram } from "./types";

export type DiagramColors = {
  palette: string[];
  ink: string; // headings
  sub: string; // body text
  card: string; // card fill
  border: string;
  accent: string;
};

function hx(c: string): string {
  return "#" + String(c ?? "").replace(/^#/, "");
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Greedy word-wrap into at most `maxLines` lines of ~`maxChars` chars. */
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
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  // If truncated, add an ellipsis to the last line.
  const used = lines.join(" ").split(/\s+/).length;
  if (used < words.length && lines.length) lines[lines.length - 1] += "…";
  return lines;
}

const FONT = "Segoe UI, Arial, sans-serif";

function textLines(
  x: number,
  y: number,
  lines: string[],
  o: {
    size: number;
    color: string;
    anchor?: "start" | "middle" | "end";
    weight?: number;
    lineH?: number;
  },
): string {
  const lh = o.lineH ?? o.size * 1.25;
  return lines
    .map(
      (ln, i) =>
        `<text x="${x}" y="${(y + i * lh).toFixed(1)}" font-family="${FONT}" font-size="${o.size}" ${
          o.weight ? `font-weight="${o.weight}" ` : ""
        }fill="${o.color}" text-anchor="${o.anchor ?? "start"}">${esc(ln)}</text>`,
    )
    .join("");
}

const SHADOW = `<filter id="ds" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#94A3B8" flood-opacity="0.28"/></filter>`;

function roundRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
  opts?: { stroke?: string; shadow?: boolean; strokeW?: number },
): string {
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${r}" fill="${fill}"${
    opts?.stroke ? ` stroke="${opts.stroke}" stroke-width="${opts?.strokeW ?? 1}"` : ""
  }${opts?.shadow ? ' filter="url(#ds)"' : ""}/>`;
}

// ── process: numbered steps left→right with connectors ────────────────────────
function processSvg(
  steps: { title: string; detail?: string }[],
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const items = steps.slice(0, 5);
  const n = items.length;
  if (!n) return "";
  const gap = 26;
  const cardW = (W - gap * (n - 1)) / n;
  const cardH = Math.min(H - 40, 260);
  const y = (H - cardH) / 2;
  const parts: string[] = [];
  items.forEach((s, i) => {
    const x = i * (cardW + gap);
    const color = c.palette[i % c.palette.length];
    if (i > 0) {
      const ax = x - gap + 5;
      const ay = y + cardH / 2;
      parts.push(
        `<path d="M ${(x - gap + 4).toFixed(1)} ${ay} L ${(x - 4).toFixed(1)} ${ay}" stroke="${c.border}" stroke-width="3"/>` +
          `<path d="M ${(x - 10).toFixed(1)} ${(ay - 6).toFixed(1)} L ${(x - 2).toFixed(1)} ${ay} L ${(x - 10).toFixed(1)} ${(ay + 6).toFixed(1)}" fill="${c.border}"/>`,
      );
      void ax;
    }
    parts.push(roundRect(x, y, cardW, cardH, 14, c.card, { stroke: c.border, shadow: true }));
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cardW.toFixed(1)}" height="6" rx="3" fill="${color}"/>`,
    );
    // number chip
    parts.push(
      `<circle cx="${(x + 34).toFixed(1)}" cy="${(y + 44).toFixed(1)}" r="19" fill="${color}"/>`,
    );
    parts.push(
      `<text x="${(x + 34).toFixed(1)}" y="${(y + 51).toFixed(1)}" font-family="${FONT}" font-size="20" font-weight="700" fill="#ffffff" text-anchor="middle">${i + 1}</text>`,
    );
    parts.push(
      textLines(x + 22, y + 92, wrap(s.title, Math.floor(cardW / 11), 2), {
        size: 19,
        color: c.ink,
        weight: 700,
        lineH: 24,
      }),
    );
    if (s.detail)
      parts.push(
        textLines(x + 22, y + 148, wrap(s.detail, Math.floor(cardW / 8.4), 4), {
          size: 14,
          color: c.sub,
          lineH: 20,
        }),
      );
  });
  return parts.join("");
}

// ── timeline: horizontal spine, alternating milestone cards ───────────────────
function timelineSvg(
  steps: { title: string; detail?: string; date?: string }[],
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const items = steps.slice(0, 6);
  const n = items.length;
  if (!n) return "";
  const midY = H / 2;
  const padX = 40;
  const usableW = W - padX * 2;
  const stepX = n > 1 ? usableW / (n - 1) : 0;
  const parts: string[] = [];
  parts.push(
    `<line x1="${padX}" y1="${midY}" x2="${W - padX}" y2="${midY}" stroke="${c.border}" stroke-width="4"/>`,
  );
  const cardW = Math.min(stepX * 0.86 || usableW, 240);
  const cardH = 130;
  items.forEach((s, i) => {
    const cx = padX + stepX * i;
    const color = c.palette[i % c.palette.length];
    const above = i % 2 === 0;
    const cyCard = above ? midY - 30 - cardH : midY + 30;
    const cardX = Math.max(0, Math.min(W - cardW, cx - cardW / 2));
    // connector + dot
    parts.push(
      `<line x1="${cx.toFixed(1)}" y1="${above ? cyCard + cardH : midY}" x2="${cx.toFixed(1)}" y2="${above ? midY : cyCard}" stroke="${color}" stroke-width="2"/>`,
    );
    parts.push(
      `<circle cx="${cx.toFixed(1)}" cy="${midY}" r="10" fill="${color}" stroke="#ffffff" stroke-width="3"/>`,
    );
    parts.push(
      roundRect(cardX, cyCard, cardW, cardH, 12, c.card, { stroke: c.border, shadow: true }),
    );
    parts.push(
      `<rect x="${cardX.toFixed(1)}" y="${cyCard.toFixed(1)}" width="5" height="${cardH}" rx="2.5" fill="${color}"/>`,
    );
    if (s.date)
      parts.push(
        `<text x="${(cardX + 18).toFixed(1)}" y="${(cyCard + 26).toFixed(1)}" font-family="${FONT}" font-size="13" font-weight="700" fill="${color}">${esc(s.date)}</text>`,
      );
    parts.push(
      textLines(
        cardX + 18,
        cyCard + (s.date ? 48 : 30),
        wrap(s.title, Math.floor(cardW / 10.5), 2),
        { size: 16, color: c.ink, weight: 700, lineH: 20 },
      ),
    );
    if (s.detail)
      parts.push(
        textLines(
          cardX + 18,
          cyCard + (s.date ? 92 : 74),
          wrap(s.detail, Math.floor(cardW / 8), 2),
          { size: 13, color: c.sub, lineH: 18 },
        ),
      );
  });
  return parts.join("");
}

// ── comparison: 2–3 columns of headed bullet lists ────────────────────────────
function comparisonSvg(
  columns: { heading: string; points: string[] }[],
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const cols = columns.slice(0, 3);
  const n = cols.length;
  if (!n) return "";
  const gap = 28;
  const colW = (W - gap * (n - 1)) / n;
  const parts: string[] = [];
  cols.forEach((col, i) => {
    const x = i * (colW + gap);
    const color = c.palette[i % c.palette.length];
    parts.push(roundRect(x, 0, colW, H, 14, c.card, { stroke: c.border, shadow: true }));
    parts.push(
      `<path d="M ${x} 14 q 0 -14 14 -14 L ${(x + colW - 14).toFixed(1)} 0 q 14 0 14 14 L ${(x + colW).toFixed(1)} 56 L ${x} 56 Z" fill="${color}"/>`,
    );
    parts.push(
      `<text x="${(x + colW / 2).toFixed(1)}" y="36" font-family="${FONT}" font-size="18" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(col.heading)}</text>`,
    );
    let py = 92;
    col.points.slice(0, 7).forEach((p) => {
      parts.push(
        `<circle cx="${(x + 24).toFixed(1)}" cy="${(py - 5).toFixed(1)}" r="4" fill="${color}"/>`,
      );
      const lines = wrap(p, Math.floor((colW - 48) / 7.6), 3);
      parts.push(textLines(x + 38, py, lines, { size: 14.5, color: c.sub, lineH: 19 }));
      py += 19 * lines.length + 12;
    });
  });
  return parts.join("");
}

// ── cards: 2–4 feature cards in a row ─────────────────────────────────────────
function cardsSvg(
  cards: { title: string; detail?: string }[],
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const items = cards.slice(0, 4);
  const n = items.length;
  if (!n) return "";
  const gap = 26;
  const cardW = (W - gap * (n - 1)) / n;
  const cardH = Math.min(H - 20, 300);
  const y = (H - cardH) / 2;
  const parts: string[] = [];
  items.forEach((s, i) => {
    const x = i * (cardW + gap);
    const color = c.palette[i % c.palette.length];
    parts.push(roundRect(x, y, cardW, cardH, 16, c.card, { stroke: c.border, shadow: true }));
    // accent icon disc
    parts.push(
      `<circle cx="${(x + 40).toFixed(1)}" cy="${(y + 44).toFixed(1)}" r="22" fill="${hx(color)}22"/>`,
    );
    parts.push(
      `<circle cx="${(x + 40).toFixed(1)}" cy="${(y + 44).toFixed(1)}" r="9" fill="${color}"/>`,
    );
    parts.push(
      textLines(x + 24, y + 100, wrap(s.title, Math.floor(cardW / 10), 2), {
        size: 19,
        color: c.ink,
        weight: 700,
        lineH: 24,
      }),
    );
    if (s.detail)
      parts.push(
        textLines(x + 24, y + 156, wrap(s.detail, Math.floor(cardW / 8), 6), {
          size: 14.5,
          color: c.sub,
          lineH: 21,
        }),
      );
  });
  return parts.join("");
}

// ── funnel: stacked decreasing stages ─────────────────────────────────────────
function funnelSvg(
  stages: { title: string; value?: string }[],
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const items = stages.slice(0, 6);
  const n = items.length;
  if (!n) return "";
  const gap = 12;
  const rowH = (H - gap * (n - 1)) / n;
  const maxW = W * 0.92;
  const minW = W * 0.4;
  const parts: string[] = [];
  items.forEach((s, i) => {
    const wTop = maxW - ((maxW - minW) * i) / n;
    const wBot = maxW - ((maxW - minW) * (i + 1)) / n;
    const y = i * (rowH + gap);
    const cxc = W / 2;
    const color = c.palette[i % c.palette.length];
    parts.push(
      `<path d="M ${(cxc - wTop / 2).toFixed(1)} ${y.toFixed(1)} L ${(cxc + wTop / 2).toFixed(1)} ${y.toFixed(1)} L ${(cxc + wBot / 2).toFixed(1)} ${(y + rowH).toFixed(1)} L ${(cxc - wBot / 2).toFixed(1)} ${(y + rowH).toFixed(1)} Z" fill="${color}"/>`,
    );
    const label = s.value ? `${s.title} — ${s.value}` : s.title;
    parts.push(
      `<text x="${cxc.toFixed(1)}" y="${(y + rowH / 2 + 6).toFixed(1)}" font-family="${FONT}" font-size="17" font-weight="600" fill="#ffffff" text-anchor="middle">${esc(label)}</text>`,
    );
  });
  return parts.join("");
}

// ── pyramid: stacked tiers, widest at the base ────────────────────────────────
function pyramidSvg(
  tiers: { title: string; detail?: string }[],
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const items = tiers.slice(0, 5);
  const n = items.length;
  if (!n) return "";
  const gap = 10;
  const rowH = (H - gap * (n - 1)) / n;
  const cxc = W * 0.42;
  const maxW = W * 0.7;
  const parts: string[] = [];
  items.forEach((s, i) => {
    const wTop = (maxW * (i + 1)) / n;
    const wBot = (maxW * (i + 2)) / n;
    const y = i * (rowH + gap);
    const color = c.palette[i % c.palette.length];
    parts.push(
      `<path d="M ${(cxc - wTop / 2).toFixed(1)} ${y.toFixed(1)} L ${(cxc + wTop / 2).toFixed(1)} ${y.toFixed(1)} L ${(cxc + wBot / 2).toFixed(1)} ${(y + rowH).toFixed(1)} L ${(cxc - wBot / 2).toFixed(1)} ${(y + rowH).toFixed(1)} Z" fill="${color}"/>`,
    );
    parts.push(
      `<text x="${cxc.toFixed(1)}" y="${(y + rowH / 2 + 6).toFixed(1)}" font-family="${FONT}" font-size="16" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(s.title)}</text>`,
    );
    // side detail
    if (s.detail) {
      const dx = cxc + maxW / 2 + 24;
      parts.push(
        `<circle cx="${(dx - 12).toFixed(1)}" cy="${(y + rowH / 2 - 4).toFixed(1)}" r="4" fill="${color}"/>`,
      );
      parts.push(
        textLines(dx, y + rowH / 2, wrap(s.detail, Math.floor((W - dx) / 8), 2), {
          size: 14,
          color: c.sub,
          lineH: 18,
        }),
      );
    }
  });
  return parts.join("");
}

/** Render a DocDiagram to an SVG string (or "" when empty). */
export function diagramToSvg(
  diagram: DocDiagram,
  colors: DiagramColors,
  W = 1160,
  H = 470,
): string {
  const c: DiagramColors = {
    palette: colors.palette.map(hx),
    ink: hx(colors.ink),
    sub: hx(colors.sub),
    card: hx(colors.card),
    border: hx(colors.border),
    accent: hx(colors.accent),
  };
  let body = "";
  switch (diagram.kind) {
    case "process":
      body = processSvg(diagram.steps ?? [], c, W, H);
      break;
    case "timeline":
      body = timelineSvg(diagram.steps ?? [], c, W, H);
      break;
    case "comparison":
      body = comparisonSvg(diagram.columns ?? [], c, W, H);
      break;
    case "cards":
      body = cardsSvg(diagram.cards ?? [], c, W, H);
      break;
    case "funnel":
      body = funnelSvg(diagram.stages ?? [], c, W, H);
      break;
    case "pyramid":
      body = pyramidSvg(diagram.tiers ?? [], c, W, H);
      break;
  }
  if (!body) return "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${SHADOW}</defs><rect width="${W}" height="${H}" fill="#ffffff"/>${body}</svg>`;
}
