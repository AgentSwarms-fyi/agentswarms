// Self-contained SVG chart renderer for generated PPTX/DOCX.
//
// We draw charts ourselves (bars / lines / area / pie) instead of relying on
// pptxgenjs's NATIVE charts, which in practice sometimes embed a chart frame
// with axes + gridlines but no plotted series (an empty-looking visual). An SVG
// image always shows the data we computed, and pptxgenjs additionally emits a
// PNG fallback so the image renders even in viewers without SVG support.
import type { DocChart } from "./types";

export type ChartSvgColors = {
  palette: string[]; // series colours (first = primary/accent-on-white)
  ink: string; // data labels / category text
  sub: string; // axis + muted text
  grid: string; // gridlines
};

/** Compact number for axis + data labels (1_200_000 → "1.2M"). */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Round a max up to a "nice" axis bound. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

const FONT = "Segoe UI, Arial, sans-serif";

/** SVG needs a leading '#'; our palette/ink colours are stored without one
 * (pptxgenjs convention). Without this every fill falls back to BLACK. */
function hx(c: string): string {
  return "#" + String(c ?? "").replace(/^#/, "");
}

type Series = { name: string; values: number[] };

function legendSvg(
  series: Series[],
  colors: ChartSvgColors,
  x: number,
  y: number,
  w: number,
): string {
  // Centered single-row legend of coloured chips + names.
  const items = series.map((s, i) => ({
    name: truncate(s.name || `Series ${i + 1}`, 22),
    color: colors.palette[i % colors.palette.length],
  }));
  const chip = 12;
  const gap = 18;
  const widths = items.map((it) => chip + 6 + it.name.length * 7.2 + gap);
  const total = widths.reduce((a, b) => a + b, 0) - gap;
  let cx = x + Math.max(0, (w - total) / 2);
  const parts: string[] = [];
  items.forEach((it, i) => {
    parts.push(
      `<rect x="${cx}" y="${y - chip + 2}" width="${chip}" height="${chip}" rx="2" fill="${it.color}"/>`,
    );
    parts.push(
      `<text x="${cx + chip + 6}" y="${y + 2}" font-family="${FONT}" font-size="15" fill="${colors.sub}">${esc(it.name)}</text>`,
    );
    cx += widths[i];
  });
  return parts.join("");
}

function cartesianSvg(
  chart: DocChart,
  cats: string[],
  series: Series[],
  colors: ChartSvgColors,
  W: number,
  H: number,
): string {
  const horizontal = chart.type === "bar";
  const isLine = chart.type === "line" || chart.type === "area";
  const isArea = chart.type === "area";
  const showLegend = series.length > 1;

  const padL = horizontal ? Math.min(220, 90) : 64;
  const padR = 26;
  const padT = 24;
  const padB = 44 + (showLegend ? 26 : 0);
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const allVals = series.flatMap((s) => s.values.map((v) => (Number.isFinite(v) ? v : 0)));
  const rawMax = Math.max(0, ...allVals);
  const rawMin = Math.min(0, ...allVals);
  const vMax = niceMax(rawMax || 1);
  const vMin = rawMin < 0 ? -niceMax(-rawMin) : 0;
  const span = vMax - vMin || 1;

  const parts: string[] = [];

  // ── Value axis gridlines + labels (4 steps) ──
  const STEPS = 4;
  for (let i = 0; i <= STEPS; i++) {
    const val = vMin + (span * i) / STEPS;
    if (horizontal) {
      const x = padL + (plotW * i) / STEPS;
      parts.push(
        `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${colors.grid}" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${x}" y="${padT + plotH + 24}" text-anchor="middle" font-family="${FONT}" font-size="14" fill="${colors.sub}">${esc(fmt(val))}</text>`,
      );
    } else {
      const y = padT + plotH - (plotH * i) / STEPS;
      parts.push(
        `<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="${colors.grid}" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${padL - 10}" y="${y + 5}" text-anchor="end" font-family="${FONT}" font-size="14" fill="${colors.sub}">${esc(fmt(val))}</text>`,
      );
    }
  }

  const n = cats.length;
  const scale = (v: number) => (v - vMin) / span; // 0..1

  if (isLine) {
    const stepX = n > 1 ? plotW / (n - 1) : plotW;
    series.forEach((s, si) => {
      const color = colors.palette[si % colors.palette.length];
      const pts = s.values.map((v, i) => {
        const x = padL + (n > 1 ? stepX * i : plotW / 2);
        const y = padT + plotH - plotH * scale(Number.isFinite(v) ? v : 0);
        return [x, y] as const;
      });
      if (isArea) {
        const d =
          `M ${padL} ${padT + plotH} ` +
          pts.map((p) => `L ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ") +
          ` L ${padL + (n > 1 ? plotW : plotW / 2)} ${padT + plotH} Z`;
        parts.push(`<path d="${d}" fill="${color}" fill-opacity="0.18"/>`);
      }
      parts.push(
        `<polyline points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
      pts.forEach((p) =>
        parts.push(
          `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" fill="${color}"/>`,
        ),
      );
    });
    // Category labels
    cats.forEach((c, i) => {
      const x = padL + (n > 1 ? stepX * i : plotW / 2);
      parts.push(
        `<text x="${x}" y="${padT + plotH + 24}" text-anchor="middle" font-family="${FONT}" font-size="14" fill="${colors.sub}">${esc(truncate(c, 12))}</text>`,
      );
    });
  } else if (horizontal) {
    // Horizontal bars (single/grouped). Single series → colour PER CATEGORY so
    // the chart is multi-colour; grouped → colour per series.
    const single = series.length === 1;
    const groupH = plotH / n;
    const inner = groupH * 0.68;
    const barH = inner / series.length;
    cats.forEach((c, i) => {
      const gy = padT + groupH * i + (groupH - inner) / 2;
      series.forEach((s, si) => {
        const v = Number.isFinite(s.values[i]) ? s.values[i] : 0;
        const w = plotW * scale(v) - plotW * scale(0);
        const x = padL + plotW * scale(0);
        const y = gy + barH * si;
        const color = colors.palette[(single ? i : si) % colors.palette.length];
        parts.push(
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${(barH * 0.86).toFixed(1)}" rx="2" fill="${color}"/>`,
        );
      });
      parts.push(
        `<text x="${padL - 10}" y="${(gy + inner / 2 + 5).toFixed(1)}" text-anchor="end" font-family="${FONT}" font-size="14" fill="${colors.sub}">${esc(truncate(c, 22))}</text>`,
      );
    });
  } else {
    // Vertical columns (single/grouped). Single series → colour PER CATEGORY so
    // the chart is multi-colour; grouped → colour per series.
    const single = series.length === 1;
    const groupW = plotW / n;
    const inner = groupW * 0.66;
    const barW = inner / series.length;
    const showValues = single && n <= 8;
    cats.forEach((c, i) => {
      const gx = padL + groupW * i + (groupW - inner) / 2;
      series.forEach((s, si) => {
        const v = Number.isFinite(s.values[i]) ? s.values[i] : 0;
        const h = plotH * scale(v) - plotH * scale(0);
        const zeroY = padT + plotH - plotH * scale(0);
        const y = h >= 0 ? zeroY - h : zeroY;
        const x = gx + barW * si;
        const color = colors.palette[(single ? i : si) % colors.palette.length];
        parts.push(
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW * 0.86).toFixed(1)}" height="${Math.max(0, Math.abs(h)).toFixed(1)}" rx="2.5" fill="${color}"/>`,
        );
        if (showValues)
          parts.push(
            `<text x="${(x + (barW * 0.86) / 2).toFixed(1)}" y="${(y - 7).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="600" fill="${colors.ink}">${esc(fmt(v))}</text>`,
          );
      });
      parts.push(
        `<text x="${(gx + inner / 2).toFixed(1)}" y="${padT + plotH + 24}" text-anchor="middle" font-family="${FONT}" font-size="14" fill="${colors.sub}">${esc(truncate(c, 12))}</text>`,
      );
    });
  }

  if (showLegend) parts.push(legendSvg(series, colors, padL, H - 12, plotW));
  return parts.join("");
}

function pieSvg(
  chart: DocChart,
  cats: string[],
  series: Series[],
  colors: ChartSvgColors,
  W: number,
  H: number,
): string {
  const values = series[0].values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return "";
  const legendW = 250;
  const cx = (W - legendW) / 2;
  const cy = H / 2;
  const r = Math.min((W - legendW) / 2, H / 2) - 20;
  const inner = chart.type === "doughnut" ? r * 0.58 : 0;

  const parts: string[] = [];
  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    const frac = v / total;
    const a2 = angle + frac * Math.PI * 2;
    const color = colors.palette[i % colors.palette.length];
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(angle),
      y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(a2),
      y2 = cy + r * Math.sin(a2);
    if (inner > 0) {
      const ix1 = cx + inner * Math.cos(a2),
        iy1 = cy + inner * Math.sin(a2);
      const ix2 = cx + inner * Math.cos(angle),
        iy2 = cy + inner * Math.sin(angle);
      parts.push(
        `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${ix1.toFixed(1)} ${iy1.toFixed(1)} A ${inner} ${inner} 0 ${large} 0 ${ix2.toFixed(1)} ${iy2.toFixed(1)} Z" fill="${color}"/>`,
      );
    } else {
      parts.push(
        `<path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${color}"/>`,
      );
    }
    // Percent label on slice
    if (frac > 0.05) {
      const mid = (angle + a2) / 2;
      const lr = inner > 0 ? (r + inner) / 2 : r * 0.62;
      const lx = cx + lr * Math.cos(mid),
        ly = cy + lr * Math.sin(mid);
      parts.push(
        `<text x="${lx.toFixed(1)}" y="${(ly + 5).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="600" fill="#ffffff">${Math.round(frac * 100)}%</text>`,
      );
    }
    angle = a2;
  });

  // Legend (right column)
  const lx = W - legendW + 16;
  let ly = cy - (Math.min(cats.length, 8) * 26) / 2;
  cats.slice(0, 8).forEach((c, i) => {
    const color = colors.palette[i % colors.palette.length];
    parts.push(`<rect x="${lx}" y="${ly - 11}" width="13" height="13" rx="2" fill="${color}"/>`);
    parts.push(
      `<text x="${lx + 20}" y="${ly}" font-family="${FONT}" font-size="15" fill="${colors.ink}">${esc(truncate(c, 20))}</text>`,
    );
    ly += 26;
  });
  return parts.join("");
}

/**
 * Render a chart to an SVG string. Returns "" when there's nothing to plot (the
 * caller then shows a table). Guaranteed to draw visible marks when data exists.
 */
export function chartToSvg(chart: DocChart, colors: ChartSvgColors, W = 900, H = 520): string {
  const cats = (chart.categories ?? []).map((c) => String(c ?? ""));
  const series = (chart.series ?? [])
    .filter((s) => (s.values?.length ?? 0) > 0)
    .map((s) => ({ name: s.name, values: s.values }));
  if (cats.length === 0 || series.length === 0) return "";

  // Normalise every colour to a valid SVG value (add the '#') — otherwise fills
  // silently render black, which made every chart monochrome-black.
  const C: ChartSvgColors = {
    palette: colors.palette.map(hx),
    ink: hx(colors.ink),
    sub: hx(colors.sub),
    grid: hx(colors.grid),
  };

  const isPie = chart.type === "pie" || chart.type === "doughnut";
  const body = isPie
    ? pieSvg(chart, cats, series, C, W, H)
    : cartesianSvg(chart, cats, series, C, W, H);
  if (!body) return "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${body}</svg>`;
}

/** Base64 data URI for embedding via pptxgenjs addImage (unicode-safe). */
export function svgToDataUri(svg: string): string {
  const b64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(svg)))
      : Buffer.from(svg, "utf-8").toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}
