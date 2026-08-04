// Self-contained SVG "SmartArt-style" diagram renderer for generated decks.
//
// This is the layout/diagram engine: the LLM emits a structured spec (a
// DocDiagram) and here we lay it out as a polished SVG (rounded cards,
// connectors, shadows, a multi-colour palette) that build.ts embeds as an image
// (pptxgenjs adds a PNG fallback). It turns "walls of bullets" into process
// flows, timelines, comparisons, cards, funnels and pyramids.
import type { DocDiagram, SketchShape } from "./types";

export type DiagramColors = {
  palette: string[];
  ink: string; // headings
  sub: string; // body text
  card: string; // card fill
  border: string;
  accent: string;
};

/**
 * Normalise a colour to `#rrggbb`, falling back rather than trusting input.
 *
 * Colours land in SVG attributes unescaped — `fill="${color}"` — so a value
 * carrying a quote would close the attribute and open another. Today every
 * caller passes either a module constant or a value already through
 * build.ts's normalizeHex, so nothing reaches here unvalidated. This function
 * used to rely on that: it prefixed a `#` and returned whatever it was given.
 *
 * That made the safety of the SVG a property of the CALLER, in an exported
 * function that takes colours as an argument. Validating here instead means
 * the next caller cannot get it wrong, and costs one regex.
 */
function hx(c: string): string {
  const h = String(c ?? "")
    .replace(/^#/, "")
    .trim();
  return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h}` : "#000000";
}

/** Darken a #hex toward black by amt (0..1) — for gradient stops. */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.replace(/^#/, ""), 16);
  const m = (ch: number) => Math.round(ch * (1 - amt));
  return (
    "#" +
    [m((n >> 16) & 255), m((n >> 8) & 255), m(n & 255)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Vertical gradient per palette colour (grad0, grad1, …) for depth. */
function gradientDefs(palette: string[]): string {
  return palette
    .map(
      (col, i) =>
        `<linearGradient id="grad${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}"/><stop offset="1" stop-color="${shade(col, 0.24)}"/></linearGradient>`,
    )
    .join("");
}

/** Gradient fill for palette index i. */
function grad(i: number, len: number): string {
  return `url(#grad${i % len})`;
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

/** Single-line truncate with an ellipsis. */
function truncate(s: string, max: number): string {
  const str = String(s ?? "");
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

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
    parts.push(
      `<path d="M ${(cxc - wTop / 2).toFixed(1)} ${y.toFixed(1)} L ${(cxc + wTop / 2).toFixed(1)} ${y.toFixed(1)} L ${(cxc + wBot / 2).toFixed(1)} ${(y + rowH).toFixed(1)} L ${(cxc - wBot / 2).toFixed(1)} ${(y + rowH).toFixed(1)} Z" fill="${grad(i, c.palette.length)}"/>`,
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
      `<path d="M ${(cxc - wTop / 2).toFixed(1)} ${y.toFixed(1)} L ${(cxc + wTop / 2).toFixed(1)} ${y.toFixed(1)} L ${(cxc + wBot / 2).toFixed(1)} ${(y + rowH).toFixed(1)} L ${(cxc - wBot / 2).toFixed(1)} ${(y + rowH).toFixed(1)} Z" fill="${grad(i, c.palette.length)}"/>`,
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

// ── matrix: a 2×2 quadrant grid (SWOT / priority / BCG) ───────────────────────
function matrixSvg(
  quadrants: { title: string; items?: string[] }[],
  axisX: [string, string] | undefined,
  axisY: [string, string] | undefined,
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const q = quadrants.slice(0, 4);
  if (!q.length) return "";
  const padL = axisY ? 26 : 6;
  const padB = axisX ? 24 : 6;
  const gx = padL;
  const gy = 6;
  const gw = W - padL - 6;
  const gh = H - padB - 6;
  const cw = (gw - 14) / 2;
  const ch = (gh - 14) / 2;
  const parts: string[] = [];
  const pos = [
    [gx, gy],
    [gx + cw + 14, gy],
    [gx, gy + ch + 14],
    [gx + cw + 14, gy + ch + 14],
  ];
  q.forEach((quad, i) => {
    const [x, y] = pos[i];
    const color = c.palette[i % c.palette.length];
    parts.push(roundRect(x, y, cw, ch, 12, `${color}14`, { stroke: color, strokeW: 1.5 }));
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cw.toFixed(1)}" height="30" rx="12" fill="${grad(i, c.palette.length)}"/>`,
    );
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${(y + 16).toFixed(1)}" width="${cw.toFixed(1)}" height="14" fill="${color}"/>`,
    );
    parts.push(
      `<text x="${(x + 14).toFixed(1)}" y="${(y + 20).toFixed(1)}" font-family="${FONT}" font-size="14" font-weight="700" fill="#ffffff">${esc(quad.title)}</text>`,
    );
    let iy = y + 50;
    (quad.items ?? []).slice(0, 4).forEach((it) => {
      parts.push(
        `<circle cx="${(x + 18).toFixed(1)}" cy="${(iy - 4).toFixed(1)}" r="3" fill="${color}"/>`,
      );
      const lines = wrap(it, Math.floor((cw - 40) / 7), 2);
      parts.push(textLines(x + 28, iy, lines, { size: 12.5, color: c.sub, lineH: 16 }));
      iy += 16 * lines.length + 8;
    });
  });
  if (axisY)
    parts.push(
      `<text x="14" y="${(gy + gh / 2).toFixed(1)}" font-family="${FONT}" font-size="11" font-weight="700" fill="${c.sub}" text-anchor="middle" transform="rotate(-90 14 ${(gy + gh / 2).toFixed(1)})">${esc(axisY[1])} ↑ ${esc(axisY[0])}</text>`,
    );
  if (axisX)
    parts.push(
      `<text x="${(gx + gw / 2).toFixed(1)}" y="${(H - 6).toFixed(1)}" font-family="${FONT}" font-size="11" font-weight="700" fill="${c.sub}" text-anchor="middle">${esc(axisX[0])} → ${esc(axisX[1])}</text>`,
    );
  return parts.join("");
}

// ── roadmap: phased columns with milestone chips ──────────────────────────────
function roadmapSvg(
  phases: { title: string; date?: string; items: string[] }[],
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const ph = phases.slice(0, 5);
  const n = ph.length;
  if (!n) return "";
  const gap = 18;
  const colW = (W - gap * (n - 1)) / n;
  const parts: string[] = [];
  ph.forEach((p, i) => {
    const x = i * (colW + gap);
    const color = c.palette[i % c.palette.length];
    // header pill
    parts.push(
      `<rect x="${x.toFixed(1)}" y="0" width="${colW.toFixed(1)}" height="46" rx="10" fill="${grad(i, c.palette.length)}"/>`,
    );
    parts.push(
      `<text x="${(x + colW / 2).toFixed(1)}" y="22" font-family="${FONT}" font-size="15" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(p.title)}</text>`,
    );
    if (p.date)
      parts.push(
        `<text x="${(x + colW / 2).toFixed(1)}" y="38" font-family="${FONT}" font-size="11" fill="#ffffff" fill-opacity="0.85" text-anchor="middle">${esc(p.date)}</text>`,
      );
    // arrow to next
    if (i < n - 1)
      parts.push(
        `<path d="M ${(x + colW + 3).toFixed(1)} 23 L ${(x + colW + gap - 3).toFixed(1)} 23" stroke="${c.border}" stroke-width="3"/><path d="M ${(x + colW + gap - 8).toFixed(1)} 18 L ${(x + colW + gap - 1).toFixed(1)} 23 L ${(x + colW + gap - 8).toFixed(1)} 28 Z" fill="${c.border}"/>`,
      );
    let iy = 74;
    (p.items ?? []).slice(0, 6).forEach((it) => {
      const lines = wrap(it, Math.floor((colW - 26) / 7), 2);
      const boxH = 16 * lines.length + 14;
      parts.push(roundRect(x, iy - 16, colW, boxH, 8, c.card, { stroke: c.border }));
      parts.push(
        `<circle cx="${(x + 12).toFixed(1)}" cy="${(iy - 16 + boxH / 2).toFixed(1)}" r="3.5" fill="${color}"/>`,
      );
      parts.push(textLines(x + 22, iy, lines, { size: 12.5, color: c.sub, lineH: 16 }));
      iy += boxH + 8;
    });
  });
  return parts.join("");
}

// ── cycle: steps around a ring with a centre label ────────────────────────────
function cycleSvg(
  steps: { title: string; detail?: string }[],
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const items = steps.slice(0, 6);
  const n = items.length;
  if (!n) return "";
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 70;
  const parts: string[] = [];
  // ring
  parts.push(
    `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${c.border}" stroke-width="2" stroke-dasharray="4 6"/>`,
  );
  items.forEach((s, i) => {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const x = cx + R * Math.cos(ang);
    const y = cy + R * Math.sin(ang);
    const color = c.palette[i % c.palette.length];
    parts.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="30" fill="${grad(i, c.palette.length)}" filter="url(#ds)"/>`,
    );
    parts.push(
      `<text x="${x.toFixed(1)}" y="${(y + 6).toFixed(1)}" font-family="${FONT}" font-size="18" font-weight="700" fill="#ffffff" text-anchor="middle">${i + 1}</text>`,
    );
    // label outside
    const lx = cx + (R + 46) * Math.cos(ang);
    const ly = cy + (R + 46) * Math.sin(ang);
    const anchor = Math.abs(Math.cos(ang)) < 0.3 ? "middle" : Math.cos(ang) > 0 ? "start" : "end";
    parts.push(
      textLines(lx, ly, wrap(s.title, 18, 2), {
        size: 13.5,
        color: c.ink,
        weight: 700,
        anchor,
        lineH: 17,
      }),
    );
  });
  return parts.join("");
}

// ── hierarchy: a root box with a row of children ──────────────────────────────
function hierarchySvg(
  root: string,
  children: { title: string; detail?: string }[],
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const kids = children.slice(0, 5);
  const n = kids.length || 1;
  const parts: string[] = [];
  const rootW = Math.min(300, W * 0.4);
  const rootX = (W - rootW) / 2;
  parts.push(roundRect(rootX, 10, rootW, 54, 12, grad(0, c.palette.length), { shadow: true }));
  parts.push(
    `<text x="${(W / 2).toFixed(1)}" y="42" font-family="${FONT}" font-size="17" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(wrap(root, 34, 1)[0] || "")}</text>`,
  );
  const gap = 18;
  const cardW = (W - gap * (n - 1)) / n;
  const cardY = 130;
  const cardH = Math.min(H - cardY - 6, 150);
  kids.forEach((k, i) => {
    const x = i * (cardW + gap);
    const cxk = x + cardW / 2;
    const color = c.palette[(i + 1) % c.palette.length];
    // connector
    parts.push(
      `<path d="M ${(W / 2).toFixed(1)} 64 L ${(W / 2).toFixed(1)} 100 L ${cxk.toFixed(1)} 100 L ${cxk.toFixed(1)} ${cardY}" fill="none" stroke="${c.border}" stroke-width="2"/>`,
    );
    parts.push(roundRect(x, cardY, cardW, cardH, 12, c.card, { stroke: c.border, shadow: true }));
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${cardY.toFixed(1)}" width="${cardW.toFixed(1)}" height="6" rx="3" fill="${color}"/>`,
    );
    parts.push(
      textLines(x + 16, cardY + 34, wrap(k.title, Math.floor(cardW / 9.5), 2), {
        size: 15,
        color: c.ink,
        weight: 700,
        lineH: 20,
      }),
    );
    if (k.detail)
      parts.push(
        textLines(x + 16, cardY + 78, wrap(k.detail, Math.floor(cardW / 8), 3), {
          size: 12.5,
          color: c.sub,
          lineH: 17,
        }),
      );
  });
  return parts.join("");
}

// ── venn: 2–3 overlapping circles ─────────────────────────────────────────────
function vennSvg(
  sets: { label: string }[],
  overlap: string | undefined,
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const s = sets.slice(0, 3);
  if (s.length < 2) return "";
  const cy = H / 2;
  const R = Math.min(H / 2 - 20, 150);
  const parts: string[] = [];
  const centers =
    s.length === 2
      ? [
          [W / 2 - R * 0.55, cy],
          [W / 2 + R * 0.55, cy],
        ]
      : [
          [W / 2, cy - R * 0.5],
          [W / 2 - R * 0.6, cy + R * 0.45],
          [W / 2 + R * 0.6, cy + R * 0.45],
        ];
  centers.forEach(([x, y], i) => {
    const color = c.palette[i % c.palette.length];
    parts.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${R}" fill="${color}" fill-opacity="0.32" stroke="${color}" stroke-width="2"/>`,
    );
  });
  centers.forEach(([x, y], i) => {
    const lx = s.length === 2 ? (i === 0 ? x - R * 0.5 : x + R * 0.5) : x;
    const ly = s.length === 2 ? y : i === 0 ? y - R * 0.55 : y + R * 0.35;
    parts.push(
      `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-family="${FONT}" font-size="15" font-weight="700" fill="${c.ink}" text-anchor="middle">${esc(wrap(s[i].label, 16, 1)[0] || "")}</text>`,
    );
  });
  if (overlap)
    parts.push(
      `<text x="${(W / 2).toFixed(1)}" y="${(cy + (s.length === 2 ? 5 : 20)).toFixed(1)}" font-family="${FONT}" font-size="13" font-weight="600" fill="${c.ink}" text-anchor="middle">${esc(wrap(overlap, 18, 1)[0] || "")}</text>`,
    );
  return parts.join("");
}

// ── kanban: columns of cards ──────────────────────────────────────────────────
function kanbanSvg(
  columns: { title: string; cards: string[] }[],
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const cols = columns.slice(0, 4);
  const n = cols.length;
  if (!n) return "";
  const gap = 16;
  const colW = (W - gap * (n - 1)) / n;
  const parts: string[] = [];
  cols.forEach((col, i) => {
    const x = i * (colW + gap);
    const color = c.palette[i % c.palette.length];
    parts.push(roundRect(x, 0, colW, H, 12, "#F1F5F9", { stroke: c.border }));
    parts.push(
      `<rect x="${x.toFixed(1)}" y="0" width="${colW.toFixed(1)}" height="36" rx="12" fill="${grad(i, c.palette.length)}"/>`,
    );
    parts.push(
      `<rect x="${x.toFixed(1)}" y="20" width="${colW.toFixed(1)}" height="16" fill="${color}"/>`,
    );
    parts.push(
      `<text x="${(x + 14).toFixed(1)}" y="24" font-family="${FONT}" font-size="14" font-weight="700" fill="#ffffff">${esc(col.title)}</text>`,
    );
    let iy = 48;
    (col.cards ?? []).slice(0, 5).forEach((card) => {
      const lines = wrap(card, Math.floor((colW - 28) / 7), 3);
      const boxH = 15 * lines.length + 16;
      if (iy + boxH > H - 6) return;
      parts.push(
        roundRect(x + 8, iy, colW - 16, boxH, 8, "#ffffff", { stroke: c.border, shadow: true }),
      );
      parts.push(
        `<rect x="${(x + 8).toFixed(1)}" y="${iy.toFixed(1)}" width="4" height="${boxH}" rx="2" fill="${color}"/>`,
      );
      parts.push(textLines(x + 20, iy + 20, lines, { size: 12.5, color: c.sub, lineH: 15 }));
      iy += boxH + 8;
    });
  });
  return parts.join("");
}

// ── graph: node-and-edge architecture / flowchart with auto layer layout ──────
function graphSvg(
  nodes: { id: string; label: string; group?: string }[],
  edges: { from: string; to: string; label?: string }[],
  c: DiagramColors,
  W: number,
  H: number,
): string {
  const N = nodes.slice(0, 16);
  if (!N.length) return "";
  const id2node = new Map(N.map((n) => [n.id, n]));
  const E = edges.filter((e) => id2node.has(e.from) && id2node.has(e.to)).slice(0, 30);

  // Assign a layer (column) per node = longest path from a root, so edges flow
  // left→right. Falls back to sequential layers for cyclic/edge-less graphs.
  const layer = new Map<string, number>();
  const indeg = new Map(N.map((n) => [n.id, 0]));
  E.forEach((e) => indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1));
  const out = new Map<string, string[]>();
  E.forEach((e) => out.set(e.from, [...(out.get(e.from) ?? []), e.to]));
  const roots = N.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const queue = roots.length ? [...roots] : [N[0].id];
  queue.forEach((r) => layer.set(r, 0));
  let guard = 0;
  const bfs = [...queue];
  while (bfs.length && guard++ < 400) {
    const u = bfs.shift()!;
    const lu = layer.get(u) ?? 0;
    for (const v of out.get(u) ?? []) {
      const lv = Math.max(layer.get(v) ?? 0, lu + 1);
      if (lv !== layer.get(v)) {
        layer.set(v, lv);
        bfs.push(v);
      }
    }
  }
  N.forEach((n, i) => {
    if (!layer.has(n.id)) layer.set(n.id, i % 3); // orphans spread across columns
  });

  const cols = new Map<number, string[]>();
  N.forEach((n) => {
    const l = layer.get(n.id) ?? 0;
    cols.set(l, [...(cols.get(l) ?? []), n.id]);
  });
  const layers = [...cols.keys()].sort((a, b) => a - b);
  const nCols = layers.length;
  const padX = 20;
  const padY = 16;
  const colGap = (W - padX * 2) / Math.max(1, nCols);
  const nodeW = Math.min(colGap - 30, 190);
  const nodeH = 58;

  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((l, li) => {
    const ids = cols.get(l)!;
    const cx = padX + colGap * li + (colGap - nodeW) / 2;
    const slotH = (H - padY * 2) / ids.length;
    ids.forEach((id, ri) => {
      const y = padY + slotH * ri + (slotH - nodeH) / 2;
      pos.set(id, { x: cx, y });
    });
  });

  const parts: string[] = [];
  // edges first (under nodes)
  E.forEach((e) => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const x1 = a.x + nodeW;
    const y1 = a.y + nodeH / 2;
    const x2 = b.x;
    const y2 = b.y + nodeH / 2;
    const mx = (x1 + x2) / 2;
    // orthogonal-ish curve
    parts.push(
      `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${mx.toFixed(1)} ${y1.toFixed(1)}, ${mx.toFixed(1)} ${y2.toFixed(1)}, ${(x2 - 8).toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${c.sub}" stroke-width="2"/>`,
    );
    parts.push(
      `<path d="M ${(x2 - 9).toFixed(1)} ${(y2 - 5).toFixed(1)} L ${(x2 - 1).toFixed(1)} ${y2.toFixed(1)} L ${(x2 - 9).toFixed(1)} ${(y2 + 5).toFixed(1)} Z" fill="${c.sub}"/>`,
    );
    if (e.label)
      parts.push(
        `<text x="${mx.toFixed(1)}" y="${((y1 + y2) / 2 - 4).toFixed(1)}" font-family="${FONT}" font-size="11" fill="${c.sub}" text-anchor="middle">${esc(truncate(e.label, 18))}</text>`,
      );
  });
  // nodes
  N.forEach((n, i) => {
    const p = pos.get(n.id)!;
    parts.push(roundRect(p.x, p.y, nodeW, nodeH, 10, grad(i, c.palette.length), { shadow: true }));
    parts.push(
      textLines(p.x + nodeW / 2, p.y + nodeH / 2 + 5, wrap(n.label, Math.floor(nodeW / 8.5), 2), {
        size: 13.5,
        color: "#ffffff",
        weight: 700,
        anchor: "middle",
        lineH: 16,
      }),
    );
  });
  return parts.join("");
}

// ── sketch: a freeform "excalidraw-style" canvas of placed primitives ─────────
function sketchSvg(shapes: SketchShape[], c: DiagramColors, W: number, H: number): string {
  const list = (shapes ?? []).slice(0, 40);
  if (!list.length) return "";
  const px = 20;
  const py = 14;
  const sx = (v: number) => px + (Math.max(0, Math.min(100, v)) / 100) * (W - px * 2);
  const sy = (v: number) => py + (Math.max(0, Math.min(100, v)) / 100) * (H - py * 2);
  const sw = (v: number) => (Math.max(0, Math.min(100, v)) / 100) * (W - px * 2);
  const sh = (v: number) => (Math.max(0, Math.min(100, v)) / 100) * (H - py * 2);
  const col = (i?: number) => c.palette[(i ?? 0) % c.palette.length];
  const parts: string[] = [];
  for (const s of list) {
    if (s.type === "box") {
      const w = sw(s.w ?? 22);
      const h = sh(s.h ?? 14);
      const x = sx(s.x);
      const y = sy(s.y);
      parts.push(
        roundRect(x, y, w, h, 10, `${col(s.color)}1A`, { stroke: col(s.color), strokeW: 2 }),
      );
      if (s.label)
        parts.push(
          textLines(x + w / 2, y + h / 2 + 5, wrap(s.label, Math.floor(w / 8), 2), {
            size: 14,
            color: c.ink,
            weight: 600,
            anchor: "middle",
            lineH: 17,
          }),
        );
    } else if (s.type === "ellipse") {
      const w = sw(s.w ?? 20);
      const h = sh(s.h ?? 16);
      const cx = sx(s.x) + w / 2;
      const cy = sy(s.y) + h / 2;
      parts.push(
        `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(w / 2).toFixed(1)}" ry="${(h / 2).toFixed(1)}" fill="${col(s.color)}1A" stroke="${col(s.color)}" stroke-width="2"/>`,
      );
      if (s.label)
        parts.push(
          textLines(cx, cy + 5, wrap(s.label, Math.floor(w / 8), 2), {
            size: 14,
            color: c.ink,
            weight: 600,
            anchor: "middle",
            lineH: 17,
          }),
        );
    } else if (s.type === "text") {
      parts.push(
        textLines(sx(s.x), sy(s.y), wrap(s.label, 40, 3), { size: 14, color: c.ink, lineH: 18 }),
      );
    } else if (s.type === "arrow") {
      const x1 = sx(s.x);
      const y1 = sy(s.y);
      const x2 = sx(s.x2);
      const y2 = sy(s.y2);
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const a1x = x2 - 11 * Math.cos(ang - 0.4);
      const a1y = y2 - 11 * Math.sin(ang - 0.4);
      const a2x = x2 - 11 * Math.cos(ang + 0.4);
      const a2y = y2 - 11 * Math.sin(ang + 0.4);
      parts.push(
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${c.sub}" stroke-width="2.5"/>`,
      );
      parts.push(
        `<path d="M ${a1x.toFixed(1)} ${a1y.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)} L ${a2x.toFixed(1)} ${a2y.toFixed(1)}" fill="none" stroke="${c.sub}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
      if (s.label)
        parts.push(
          `<text x="${((x1 + x2) / 2).toFixed(1)}" y="${((y1 + y2) / 2 - 5).toFixed(1)}" font-family="${FONT}" font-size="12" fill="${c.sub}" text-anchor="middle">${esc(truncate(s.label, 24))}</text>`,
        );
    }
  }
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
    case "matrix":
      body = matrixSvg(diagram.quadrants ?? [], diagram.axisX, diagram.axisY, c, W, H);
      break;
    case "roadmap":
      body = roadmapSvg(diagram.phases ?? [], c, W, H);
      break;
    case "cycle":
      body = cycleSvg(diagram.steps ?? [], c, W, H);
      break;
    case "hierarchy":
      body = hierarchySvg(diagram.root ?? "", diagram.children ?? [], c, W, H);
      break;
    case "venn":
      body = vennSvg(diagram.sets ?? [], diagram.overlap, c, W, H);
      break;
    case "kanban":
      body = kanbanSvg(diagram.columns ?? [], c, W, H);
      break;
    case "graph":
      body = graphSvg(diagram.nodes ?? [], diagram.edges ?? [], c, W, H);
      break;
    case "sketch":
      body = sketchSvg(diagram.shapes ?? [], c, W, H);
      break;
  }
  if (!body) return "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${SHADOW}${gradientDefs(c.palette)}</defs><rect width="${W}" height="${H}" fill="#ffffff"/>${body}</svg>`;
}
