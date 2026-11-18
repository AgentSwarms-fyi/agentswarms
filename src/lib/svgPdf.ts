// Drawing a chart's SVG into a PDF as vectors (R509).
//
// A scheduled report is laid out on the server, where there is no browser to
// rasterise a chart. The server renders the SAME chart component to markup
// (react-dom/server, at a fixed size), and this module reads that markup and
// draws it with pdf-lib: paths, rectangles, lines, circles and text, with
// their transforms, colours and opacity. The chart in the email is the chart
// in the app, drawn by the same code, not a second renderer that drifts.
//
// It is deliberately a SUBSET of SVG: the subset charts are made of. What it
// does not draw (clip paths, patterns, filters, foreignObject) is skipped, and
// gradients are drawn as their average colour. Colours written as theme
// tokens (`var(--primary)`, Tailwind's `fill-muted-foreground`) resolve to the
// LIGHT theme: a PDF is printed on white.
//
// Charts draw their legends as HTML, which has no place in an SVG, so the
// legend is read out of the markup (readLegend) and drawn by the caller in a
// strip it reserves beside the chart.
import {
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type Color,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

// ── Markup ─────────────────────────────────────────────────────────────────

export type MElement = { tag: string; attrs: Record<string, string>; children: MNode[] };
export type MNode = MElement | string;

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}

/**
 * Markup as react-dom/server writes it, into a tree. Not a general HTML
 * parser: it reads well-formed output (quoted attributes, closed elements,
 * HTML void elements), which is what a server render produces.
 */
export function parseMarkup(src: string): MElement {
  const root: MElement = { tag: "#root", attrs: {}, children: [] };
  const stack: MElement[] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      const text = src.slice(i);
      if (text) top().children.push(decodeEntities(text));
      break;
    }
    if (lt > i) top().children.push(decodeEntities(src.slice(i, lt)));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const end = src.indexOf(">", lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      const name = src
        .slice(lt + 2, end === -1 ? src.length : end)
        .trim()
        .toLowerCase();
      // Close the nearest open element of that name; an unmatched close is
      // dropped rather than unwinding the whole tree.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    // An opening tag.
    let j = lt + 1;
    while (j < src.length && /[^\s/>]/.test(src[j])) j++;
    const tag = src.slice(lt + 1, j).toLowerCase();
    const attrs: Record<string, string> = {};
    let selfClose = false;
    while (j < src.length) {
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === ">") {
        j++;
        break;
      }
      if (src[j] === "/" && src[j + 1] === ">") {
        selfClose = true;
        j += 2;
        break;
      }
      let k = j;
      while (k < src.length && /[^\s=/>]/.test(src[k])) k++;
      const name = src.slice(j, k);
      j = k;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "=") {
        j++;
        while (j < src.length && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, j + 1);
          attrs[name] = decodeEntities(src.slice(j + 1, end === -1 ? src.length : end));
          j = end === -1 ? src.length : end + 1;
        } else {
          let e = j;
          while (e < src.length && /[^\s>]/.test(src[e])) e++;
          attrs[name] = decodeEntities(src.slice(j, e));
          j = e;
        }
      } else if (name) {
        attrs[name] = "";
      } else {
        j++;
      }
    }
    const el: MElement = { tag, attrs, children: [] };
    top().children.push(el);
    if (!selfClose && !VOID.has(tag)) stack.push(el);
    i = j;
  }
  return root;
}

export function isElement(n: MNode): n is MElement {
  return typeof n !== "string";
}

export function findAll(el: MElement, pred: (e: MElement) => boolean, out: MElement[] = []) {
  for (const c of el.children) {
    if (!isElement(c)) continue;
    if (pred(c)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
}

export function textContent(el: MNode): string {
  if (!isElement(el)) return el;
  return el.children.map(textContent).join("");
}

export function hasClass(el: MElement, name: string): boolean {
  return (el.attrs.class ?? "").split(/\s+/).includes(name);
}

function styleMap(el: MElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (el.attrs.style ?? "").split(";")) {
    const c = part.indexOf(":");
    if (c > 0) out[part.slice(0, c).trim().toLowerCase()] = part.slice(c + 1).trim();
  }
  return out;
}

// ── Colour ─────────────────────────────────────────────────────────────────

/**
 * The light theme's tokens, as src/styles.css defines them under :root. A
 * test reads styles.css and holds these to it, so a palette change cannot
 * leave printed charts in the old colours.
 */
export const PRINT_TOKENS: Record<string, string> = {
  background: "oklch(0.985 0.002 250)",
  foreground: "oklch(0.15 0.04 265)",
  card: "oklch(1 0 0)",
  "card-foreground": "oklch(0.15 0.04 265)",
  popover: "oklch(1 0 0)",
  "popover-foreground": "oklch(0.15 0.04 265)",
  primary: "oklch(0.52 0.12 205)",
  "primary-foreground": "oklch(0.98 0.003 248)",
  secondary: "oklch(0.96 0.008 248)",
  "secondary-foreground": "oklch(0.2 0.04 265)",
  muted: "oklch(0.96 0.008 248)",
  "muted-foreground": "oklch(0.42 0.04 257)",
  accent: "oklch(0.96 0.008 248)",
  "accent-foreground": "oklch(0.2 0.04 265)",
  destructive: "oklch(0.58 0.24 27)",
  border: "oklch(0.93 0.013 255)",
  input: "oklch(0.93 0.013 255)",
  ring: "oklch(0.52 0.12 205)",
  success: "oklch(0.6 0.19 145)",
  warning: "oklch(0.75 0.18 75)",
  "chart-1": "oklch(0.65 0.22 41)",
  "chart-2": "oklch(0.6 0.12 185)",
  "chart-3": "oklch(0.4 0.07 227)",
  "chart-4": "oklch(0.83 0.19 84)",
  "chart-5": "oklch(0.77 0.19 70)",
};

export type Rgba = { r: number; g: number; b: number; a: number };

const NAMED: Record<string, Rgba> = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 1, g: 1, b: 1, a: 1 },
  red: { r: 1, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 0.5, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 1, a: 1 },
  gray: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
  grey: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
  orange: { r: 1, g: 0.647, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function oklchToRgb(l: number, c: number, hDeg: number): Rgba {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  const gamma = (x: number) =>
    clamp01(x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  return { r: gamma(lin[0]), g: gamma(lin[1]), b: gamma(lin[2]), a: 1 };
}

function hslToRgb(h: number, s: number, l: number): Rgba {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: clamp01(f(0)), g: clamp01(f(8)), b: clamp01(f(4)), a: 1 };
}

/** Split a CSS function's arguments on commas or spaces, slash-aware. */
function cssArgs(inner: string): { parts: string[]; alpha?: string } {
  const [main, alpha] = inner.split("/");
  const parts = main
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (alpha !== undefined) return { parts, alpha: alpha.trim() };
  if (parts.length === 4) return { parts: parts.slice(0, 3), alpha: parts[3] };
  return { parts };
}

const pct = (s: string, of = 1) => (s.endsWith("%") ? (parseFloat(s) / 100) * of : parseFloat(s));

/** Split on commas that are not inside parentheses. */
function topLevelArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out;
}

/** A CSS colour as RGBA in 0-1, or null for none / unreadable. */
export function parseCssColor(raw: string | undefined | null, currentColor?: Rgba): Rgba | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (!v || v === "none") return null;
  if (v === "currentcolor") return currentColor ?? null;
  const varm = /^var\(\s*--([a-z0-9-]+)\s*(?:,\s*(.+))?\)$/.exec(v);
  if (varm) {
    const token = PRINT_TOKENS[varm[1]];
    return token ? parseCssColor(token, currentColor) : parseCssColor(varm[2], currentColor);
  }
  if (v.startsWith("#")) {
    let h = v.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return null;
    const n = (o: number) => parseInt(h.slice(o, o + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  const fn = /^([a-z-]+)\((.*)\)$/.exec(v);
  if (fn) {
    const [, name, inner] = fn;
    if (name === "color-mix") {
      // color-mix(in <space>, A p%, B q%) — mixed in sRGB, which is close
      // enough for a tint on paper.
      const args = topLevelArgs(inner).slice(1);
      const read = (s: string) => {
        const m = /^(.*?)(?:\s+([\d.]+%))?$/.exec(s.trim());
        return { c: parseCssColor(m?.[1] ?? s, currentColor), p: m?.[2] ? pct(m[2]) : undefined };
      };
      const a = read(args[0] ?? "");
      const b = read(args[1] ?? "transparent");
      const pa = a.p ?? (b.p !== undefined ? 1 - b.p : 0.5);
      const ca = a.c ?? NAMED.transparent;
      const cb = b.c ?? NAMED.transparent;
      const alpha = ca.a * pa + cb.a * (1 - pa);
      if (alpha <= 0) return { ...NAMED.transparent };
      const mix = (x: number, y: number) => (x * ca.a * pa + y * cb.a * (1 - pa)) / alpha;
      return { r: mix(ca.r, cb.r), g: mix(ca.g, cb.g), b: mix(ca.b, cb.b), a: alpha };
    }
    const { parts, alpha } = cssArgs(inner);
    const a = alpha === undefined ? 1 : clamp01(pct(alpha));
    if (name === "rgb" || name === "rgba") {
      const ch = (s: string) => clamp01(s.endsWith("%") ? pct(s) : parseFloat(s) / 255);
      return { r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]), a };
    }
    if (name === "hsl" || name === "hsla") {
      const c = hslToRgb(parseFloat(parts[0]), pct(parts[1], 1), pct(parts[2], 1));
      return { ...c, a };
    }
    if (name === "oklch") {
      const l = parts[0].endsWith("%") ? pct(parts[0]) : parseFloat(parts[0]);
      const c = oklchToRgb(l, parseFloat(parts[1]), parseFloat(parts[2]) || 0);
      return { ...c, a };
    }
    return null;
  }
  return NAMED[v] ?? null;
}

export function toPdfColor(c: Rgba): Color {
  return rgb(c.r, c.g, c.b);
}

// ── Geometry ───────────────────────────────────────────────────────────────

/** An affine matrix [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m ∘ n: apply n first, then m. */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** An SVG transform attribute as one matrix. Unknown functions are skipped. */
export function parseTransform(s: string | undefined): Mat {
  let out: Mat = IDENTITY;
  if (!s) return out;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = m[2]
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    let t: Mat | null = null;
    switch (m[1]) {
      case "translate":
        t = [1, 0, 0, 1, n[0] || 0, n[1] || 0];
        break;
      case "scale":
        t = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const r = ((n[0] || 0) * Math.PI) / 180;
        const rot: Mat = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
        if (n.length >= 3) {
          t = mul(mul([1, 0, 0, 1, n[1], n[2]], rot), [1, 0, 0, 1, -n[1], -n[2]]);
        } else t = rot;
        break;
      }
      case "matrix":
        if (n.length === 6) t = n as Mat;
        break;
      case "skewX":
        t = [1, 0, Math.tan(((n[0] || 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        t = [1, Math.tan(((n[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    if (t && t.every(Number.isFinite)) out = mul(out, t);
  }
  return out;
}

const num = (v: string | undefined, fallback = 0) => {
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/** A length relative to a font size: "0.71em", "4", "12px". */
function lengthAt(v: string | undefined, fontSize: number): number {
  if (!v) return 0;
  const t = v.trim();
  if (t.endsWith("em")) return parseFloat(t) * fontSize;
  return num(t);
}

/** The outline of a basic shape as path data, or null when it has none. */
export function shapePath(el: MElement): string | null {
  const a = el.attrs;
  switch (el.tag) {
    case "path":
      // pdf-lib's path tokenizer splits on spaces and commas only. A newline
      // stays in the token after it and is read as an extra 0, which shifts
      // every argument behind it: Recharts writes its pie and donut sectors'
      // arcs across lines, and they came out as huge wedges off the chart
      // (found printing a real report, R509).
      return a.d?.trim() ? a.d.replace(/\s+/g, " ").trim() : null;
    case "rect": {
      const x = num(a.x);
      const y = num(a.y);
      const w = num(a.width);
      const h = num(a.height);
      if (!(w > 0 && h > 0)) return null;
      let rx = num(a.rx, NaN);
      let ry = num(a.ry, NaN);
      if (!Number.isFinite(rx)) rx = Number.isFinite(ry) ? ry : 0;
      if (!Number.isFinite(ry)) ry = rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx <= 0 || ry <= 0) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx},${y}H${x + w - rx}A${rx},${ry},0,0,1,${x + w},${y + ry}` +
        `V${y + h - ry}A${rx},${ry},0,0,1,${x + w - rx},${y + h}` +
        `H${x + rx}A${rx},${ry},0,0,1,${x},${y + h - ry}` +
        `V${y + ry}A${rx},${ry},0,0,1,${x + rx},${y}Z`
      );
    }
    case "circle":
    case "ellipse": {
      const cx = num(a.cx);
      const cy = num(a.cy);
      const rx = el.tag === "circle" ? num(a.r) : num(a.rx);
      const ry = el.tag === "circle" ? num(a.r) : num(a.ry);
      if (!(rx > 0 && ry > 0)) return null;
      return (
        `M${cx - rx},${cy}A${rx},${ry},0,1,0,${cx + rx},${cy}` +
        `A${rx},${ry},0,1,0,${cx - rx},${cy}Z`
      );
    }
    case "line":
      return `M${num(a.x1)},${num(a.y1)}L${num(a.x2)},${num(a.y2)}`;
    case "polyline":
    case "polygon": {
      const pts = (a.points ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter(Number.isFinite);
      if (pts.length < 4) return null;
      let d = `M${pts[0]},${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]},${pts[i + 1]}`;
      return el.tag === "polygon" ? `${d}Z` : d;
    }
    default:
      return null;
  }
}

// ── Style ──────────────────────────────────────────────────────────────────

export type Paint = {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  dash: number[] | undefined;
  lineCap: string | undefined;
  fillOpacity: number;
  strokeOpacity: number;
  /** Group opacity multiplied down the tree. */
  opacity: number;
  fontSize: number;
  bold: boolean;
  anchor: string;
  baseline: string;
  color: string;
  hidden: boolean;
};

/** What an element inherits before it says anything itself. */
export const ROOT_PAINT: Paint = {
  fill: "#000000",
  stroke: null,
  strokeWidth: 1,
  dash: undefined,
  lineCap: undefined,
  fillOpacity: 1,
  strokeOpacity: 1,
  opacity: 1,
  // Chart text without a size takes the card's; 12 is what a card sets.
  fontSize: 12,
  bold: false,
  anchor: "start",
  baseline: "auto",
  color: "var(--foreground)",
  hidden: false,
};

/** Tailwind fill-/stroke-/text- classes the charts use for colour. */
function classPaint(el: MElement): Partial<Record<"fill" | "stroke" | "color", string>> {
  const out: Partial<Record<"fill" | "stroke" | "color", string>> = {};
  for (const c of (el.attrs.class ?? "").split(/\s+/)) {
    const m = /^(fill|stroke|text)-([a-z0-9-]+)$/.exec(c);
    if (!m || !PRINT_TOKENS[m[2]]) continue;
    out[m[1] === "text" ? "color" : (m[1] as "fill" | "stroke")] = `var(--${m[2]})`;
  }
  return out;
}

function inherit(parent: Paint, el: MElement): Paint {
  const a = el.attrs;
  const st = styleMap(el);
  const cls = classPaint(el);
  const pick = (name: string) => st[name] ?? a[name];
  const p: Paint = { ...parent };
  const color = st.color ?? cls.color ?? a.color;
  if (color) p.color = color;
  const fill = st.fill ?? cls.fill ?? a.fill;
  if (fill !== undefined) p.fill = fill === "none" ? null : fill;
  const stroke = st.stroke ?? cls.stroke ?? a.stroke;
  if (stroke !== undefined) p.stroke = stroke === "none" ? null : stroke;
  const sw = pick("stroke-width");
  if (sw !== undefined) p.strokeWidth = num(sw, p.strokeWidth);
  const dash = pick("stroke-dasharray");
  if (dash !== undefined) {
    const d = dash
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= 0);
    p.dash = dash === "none" || d.length === 0 || d.every((n) => n === 0) ? undefined : d;
  }
  const cap = pick("stroke-linecap");
  if (cap) p.lineCap = cap;
  const fo = pick("fill-opacity");
  if (fo !== undefined) p.fillOpacity = clamp01(num(fo, 1));
  const so = pick("stroke-opacity");
  if (so !== undefined) p.strokeOpacity = clamp01(num(so, 1));
  const op = pick("opacity");
  if (op !== undefined) p.opacity = parent.opacity * clamp01(num(op, 1));
  const fs = pick("font-size");
  if (fs !== undefined) p.fontSize = num(fs, p.fontSize);
  const fw = pick("font-weight");
  if (fw !== undefined) p.bold = fw === "bold" || fw === "bolder" || num(fw, 400) >= 600;
  const anchor = pick("text-anchor");
  if (anchor) p.anchor = anchor;
  const base = pick("dominant-baseline") ?? pick("alignment-baseline");
  if (base) p.baseline = base;
  if (st.display === "none" || a.display === "none") p.hidden = true;
  if ((st.visibility ?? a.visibility) === "hidden") p.hidden = true;
  return p;
}

// ── Drawing ────────────────────────────────────────────────────────────────

export type SvgDrawContext = {
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  /** Makes text safe for the standard fonts (WinAnsi). */
  encode: (s: string) => string;
};

type Gradients = Map<string, Rgba>;

/** Each gradient as one colour: its first stop, at its stops' mean opacity. */
function collectGradients(root: MElement, current: Rgba): Gradients {
  const out: Gradients = new Map();
  for (const g of findAll(root, (e) => e.tag === "lineargradient" || e.tag === "radialgradient")) {
    const id = g.attrs.id;
    if (!id) continue;
    const stops = g.children.filter(isElement).filter((c) => c.tag === "stop");
    if (stops.length === 0) continue;
    const read = (s: MElement) => {
      const st = styleMap(s);
      const c = parseCssColor(st["stop-color"] ?? s.attrs["stop-color"] ?? "#000", current);
      const o = clamp01(num(st["stop-opacity"] ?? s.attrs["stop-opacity"], 1));
      return { c, o };
    };
    const all = stops.map(read);
    const first = all.find((s) => s.c)?.c;
    if (!first) continue;
    const mean = all.reduce((t, s) => t + s.o * (s.c?.a ?? 1), 0) / all.length;
    out.set(id, { ...first, a: mean });
  }
  return out;
}

function resolvePaint(v: string | null, grads: Gradients, current: Rgba): Rgba | null {
  if (!v) return null;
  const url = /^url\(\s*#([^)]+)\)/.exec(v.trim());
  if (url) return grads.get(url[1]) ?? null;
  return parseCssColor(v, current);
}

const SKIP = new Set([
  "defs",
  "clippath",
  "mask",
  "pattern",
  "filter",
  "title",
  "desc",
  "style",
  "script",
  "lineargradient",
  "radialgradient",
  "foreignobject",
  "symbol",
  "marker",
]);

/**
 * Draw one <svg> element into a box on the page, scaled to fit and anchored
 * at the box's top-left (or centred, for an svg that sizes itself only by a
 * viewBox). Returns the size it drew at, in points.
 */
export function drawSvg(
  ctx: SvgDrawContext,
  svg: MElement,
  box: { x: number; top: number; w: number; h: number },
): { w: number; h: number } {
  const vb = (svg.attrs.viewbox ?? svg.attrs.viewBox ?? "")
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  const hasVb = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
  let W = num(svg.attrs.width, NaN);
  let H = num(svg.attrs.height, NaN);
  if (!(W > 0 && H > 0)) {
    if (!hasVb) return { w: 0, h: 0 };
    W = vb[2];
    H = vb[3];
  }
  const s = Math.min(box.w / W, box.h / H);
  const drawnW = W * s;
  const drawnH = H * s;
  // A self-sizing svg (a gauge) sits in the middle of its box, as it does in
  // a card; a chart drawn at the box's size fills it either way.
  const ox = box.x + (box.w - drawnW) / 2;
  const oyTop = box.top - (box.h - drawnH) / 2;
  // SVG user space → page: y runs down in SVG and up in PDF.
  let base: Mat = [s, 0, 0, -s, ox, oyTop];
  if (hasVb) {
    const k = Math.min(W / vb[2], H / vb[3]);
    const tx = (W - vb[2] * k) / 2 - vb[0] * k;
    const ty = (H - vb[3] * k) / 2 - vb[1] * k;
    base = mul(base, [k, 0, 0, k, tx, ty]);
  }
  const current = parseCssColor(ROOT_PAINT.color) ?? NAMED.black;
  const grads = collectGradients(svg, current);
  walk(ctx, svg, base, inherit(ROOT_PAINT, svg), grads);
  return { w: drawnW, h: drawnH };
}

const FLIP: Mat = [1, 0, 0, -1, 0, 0];

function walk(
  ctx: SvgDrawContext,
  el: MElement,
  m: Mat,
  paint: Paint,
  grads: Gradients,
  skip?: Set<MElement>,
) {
  for (const child of el.children) {
    if (!isElement(child) || SKIP.has(child.tag) || skip?.has(child)) continue;
    const p = inherit(paint, child);
    if (p.hidden) continue;
    const cm = mul(m, parseTransform(child.attrs.transform));
    if (child.tag === "text") {
      drawText(ctx, child, cm, p);
      continue;
    }
    if (child.tag === "svg") {
      // A nested svg: positioned by x/y, drawn in its own user space.
      walk(ctx, child, mul(cm, [1, 0, 0, 1, num(child.attrs.x), num(child.attrs.y)]), p, grads);
      continue;
    }
    const d = shapePath(child);
    if (d) drawPath(ctx, d, cm, p, grads, child.tag === "line" || child.tag === "polyline");
    if (child.children.length && child.tag !== "path") {
      const crowded = hasClass(child, "recharts-cartesian-axis-ticks")
        ? crowdedTicks(child, p, (text, size, bold) =>
            (bold ? ctx.bold : ctx.regular).widthOfTextAtSize(ctx.encode(text), size),
          )
        : undefined;
      walk(ctx, child, cm, p, grads, crowded);
    }
  }
}

/** Width of a label at a size, in the same units as the size. */
export type MeasureText = (text: string, size: number, bold: boolean) => number;

/**
 * The axis ticks to leave out so the labels that print do not overlap.
 *
 * In a browser Recharts measures each label and drops the ones that would
 * collide. On the server it has nothing to measure with, so it keeps every
 * tick: 48 months printed as one smudge under a trend line (found printing a
 * real report, R509). This does what the browser would: the first and last
 * labels stay, and a label in between stays when it clears the last one kept
 * and the final one. Measured with the PDF's own font. A rotated label or a
 * vertical axis takes a line of text's height along the axis.
 */
export function crowdedTicks(
  ticksGroup: MElement,
  paint: Paint,
  measure: MeasureText,
): Set<MElement> {
  type Span = { tick: MElement; lo: number; hi: number };
  const spans: Span[] = [];
  for (const tick of ticksGroup.children) {
    if (!isElement(tick)) continue;
    const tp = inherit(paint, tick);
    const text = findAll(tick, (e) => e.tag === "text")[0];
    if (!text) continue;
    const xp = inherit(tp, text);
    const label = textContent(text).replace(/\s+/g, " ").trim();
    if (!label) continue;
    const span = findAll(text, (e) => e.tag === "tspan")[0];
    const x = num(span?.attrs.x ?? text.attrs.x);
    const y = num(span?.attrs.y ?? text.attrs.y);
    const side = text.attrs.orientation ?? "bottom";
    const across = side === "left" || side === "right";
    const rotated = /rotate\(\s*-?[1-9]/.test(
      `${text.attrs.transform ?? ""} ${tick.attrs.transform ?? ""}`,
    );
    if (across || rotated) {
      const at = across ? y : x;
      const half = xp.fontSize * 0.6;
      spans.push({ tick, lo: at - half, hi: at + half });
    } else {
      const w = measure(label, xp.fontSize, xp.bold);
      const lo = xp.anchor === "middle" ? x - w / 2 : xp.anchor === "end" ? x - w : x;
      spans.push({ tick, lo, hi: lo + w });
    }
  }
  const out = new Set<MElement>();
  if (spans.length < 3) return out;
  spans.sort((a, b) => a.lo - b.lo);
  const GAP = 4;
  const last = spans[spans.length - 1];
  let kept = spans[0];
  for (const s of spans.slice(1, -1)) {
    if (s.lo >= kept.hi + GAP && s.hi + GAP <= last.lo) kept = s;
    else out.add(s.tick);
  }
  return out;
}

function drawPath(
  ctx: SvgDrawContext,
  d: string,
  m: Mat,
  p: Paint,
  grads: Gradients,
  openShape: boolean,
) {
  const current = parseCssColor(p.color) ?? NAMED.black;
  // A line or polyline has no inside to fill.
  const fill = openShape ? null : resolvePaint(p.fill, grads, current);
  const stroke = resolvePaint(p.stroke, grads, current);
  const fillA = fill ? fill.a * p.fillOpacity * p.opacity : 0;
  const strokeA = stroke ? stroke.a * p.strokeOpacity * p.opacity : 0;
  const doFill = fill && fillA > 0.003;
  const doStroke = stroke && strokeA > 0.003 && p.strokeWidth > 0;
  if (!doFill && !doStroke) return;
  // pdf-lib's drawSvgPath flips y itself, so the matrix handed to it is the
  // SVG→page matrix with one flip undone.
  const ctm = mul(m, FLIP);
  ctx.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...ctm));
  ctx.page.drawSvgPath(d, {
    x: 0,
    y: 0,
    scale: 1,
    color: doFill ? toPdfColor(fill) : undefined,
    opacity: doFill ? fillA : undefined,
    borderColor: doStroke ? toPdfColor(stroke) : undefined,
    borderOpacity: doStroke ? strokeA : undefined,
    borderWidth: doStroke ? p.strokeWidth : 0,
    borderDashArray: doStroke ? p.dash : undefined,
    borderLineCap:
      doStroke && p.lineCap === "round" ? 1 : doStroke && p.lineCap === "square" ? 2 : undefined,
  });
  ctx.page.pushOperators(popGraphicsState());
}

function drawText(ctx: SvgDrawContext, el: MElement, m: Mat, p: Paint) {
  let cx = num(el.attrs.x);
  let cy = num(el.attrs.y);
  cx += lengthAt(el.attrs.dx, p.fontSize);
  cy += lengthAt(el.attrs.dy, p.fontSize);
  const runs: Array<{ x: number; y: number; text: string; paint: Paint }> = [];
  const spans = el.children.filter(isElement).filter((c) => c.tag === "tspan");
  if (spans.length === 0) {
    runs.push({ x: cx, y: cy, text: textContent(el), paint: p });
  } else {
    // Text directly inside <text> before its first tspan is drawn too.
    const lead = el.children
      .filter((c): c is string => typeof c === "string")
      .join("")
      .trim();
    if (lead) runs.push({ x: cx, y: cy, text: lead, paint: p });
    for (const t of spans) {
      const tp = inherit(p, t);
      if (tp.hidden) continue;
      if (t.attrs.x !== undefined) cx = num(t.attrs.x);
      if (t.attrs.y !== undefined) cy = num(t.attrs.y);
      cx += lengthAt(t.attrs.dx, tp.fontSize);
      cy += lengthAt(t.attrs.dy, tp.fontSize);
      runs.push({ x: cx, y: cy, text: textContent(t), paint: tp });
    }
  }
  const ctm = mul(m, FLIP);
  for (const r of runs) {
    const text = ctx.encode(r.text.replace(/\s+/g, " ").trim());
    if (!text) continue;
    const rp = r.paint;
    const current = parseCssColor(rp.color) ?? NAMED.black;
    const fill = parseCssColor(rp.fill, current);
    const alpha = fill ? fill.a * rp.fillOpacity * rp.opacity : 0;
    if (!fill || alpha <= 0.003 || rp.fontSize <= 0) continue;
    const font = rp.bold ? ctx.bold : ctx.regular;
    const w = font.widthOfTextAtSize(text, rp.fontSize);
    const x = rp.anchor === "middle" ? r.x - w / 2 : rp.anchor === "end" ? r.x - w : r.x;
    let y = r.y;
    if (rp.baseline === "middle" || rp.baseline === "central") y += rp.fontSize * 0.35;
    else if (rp.baseline === "hanging" || rp.baseline === "text-before-edge") {
      y += rp.fontSize * 0.8;
    }
    ctx.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...ctm));
    ctx.page.drawText(text, {
      x,
      // In the flipped space SVG's y is drawn at -y.
      y: -y,
      size: rp.fontSize,
      font,
      color: toPdfColor(fill),
      opacity: alpha < 1 ? alpha : undefined,
    });
    ctx.page.pushOperators(popGraphicsState());
  }
}

// ── Legends ────────────────────────────────────────────────────────────────

export type LegendItem = { label: string; color: Rgba };
export type ChartLegend = {
  /** Where the chart put it; a legend beside the chart lists down. */
  position: "top" | "bottom" | "left" | "right";
  items: LegendItem[];
  fontSize: number;
};

/**
 * The legend a chart drew as HTML, or null. Charts lay legends out in the
 * browser by measuring them; a server render cannot, so the caller reserves
 * a strip and draws the items there (drawLegend).
 */
export function readLegend(root: MElement): ChartLegend | null {
  const wrap = findAll(root, (e) => hasClass(e, "recharts-legend-wrapper"))[0];
  if (!wrap) return null;
  const st = styleMap(wrap);
  const items: LegendItem[] = [];
  let vertical = false;
  for (const li of findAll(wrap, (e) => e.tag === "li")) {
    if ((styleMap(li).display ?? "") === "block") vertical = true;
    const label = textContent(li).replace(/\s+/g, " ").trim();
    const mark = findAll(li, (e) => e.tag === "path" || e.tag === "rect" || e.tag === "line")[0];
    const span = findAll(li, (e) => e.tag === "span")[0];
    const raw =
      (mark &&
        (mark.attrs.fill && mark.attrs.fill !== "none" ? mark.attrs.fill : mark.attrs.stroke)) ??
      (span ? styleMap(span).color : undefined);
    const color = parseCssColor(raw) ?? parseCssColor(PRINT_TOKENS["muted-foreground"])!;
    if (label) items.push({ label, color });
  }
  if (items.length === 0) return null;
  const position: ChartLegend["position"] = vertical
    ? st.left !== undefined && parseFloat(st.left) < 20 && st.right === undefined
      ? "left"
      : "right"
    : st.top !== undefined && st.bottom === undefined
      ? "top"
      : "bottom";
  const fontSize = num(st["font-size"], 11);
  return { position, items, fontSize };
}

const DOT = 6;
const GAP_AFTER_DOT = 4;
const GAP_BETWEEN = 12;

/** Rows of a horizontal legend laid out across `width`. */
export function legendRows(
  legend: ChartLegend,
  font: PDFFont,
  encode: (s: string) => string,
  width: number,
): LegendItem[][] {
  const rows: LegendItem[][] = [[]];
  let used = 0;
  for (const it of legend.items) {
    const w = DOT + GAP_AFTER_DOT + font.widthOfTextAtSize(encode(it.label), legend.fontSize);
    const row = rows[rows.length - 1];
    if (row.length > 0 && used + GAP_BETWEEN + w > width) {
      rows.push([it]);
      used = w;
    } else {
      used += (row.length ? GAP_BETWEEN : 0) + w;
      row.push(it);
    }
  }
  return rows;
}

export function legendLineHeight(legend: ChartLegend): number {
  return Math.ceil(legend.fontSize * 1.45);
}

/** How tall a top or bottom legend is, or how wide a side legend is. */
export function legendExtent(
  legend: ChartLegend,
  font: PDFFont,
  encode: (s: string) => string,
  box: { w: number; h: number },
): number {
  const lh = legendLineHeight(legend);
  if (legend.position === "top" || legend.position === "bottom") {
    return legendRows(legend, font, encode, box.w).length * lh + 4;
  }
  const widest = Math.max(
    ...legend.items.map((it) => font.widthOfTextAtSize(encode(it.label), legend.fontSize)),
  );
  // At most a third of the box, as the card caps it.
  return Math.min(box.w * 0.34, DOT + GAP_AFTER_DOT + widest + 10);
}

/** Draw the legend in the strip reserved for it. */
export function drawLegend(
  ctx: SvgDrawContext,
  legend: ChartLegend,
  strip: { x: number; top: number; w: number; h: number },
) {
  const lh = legendLineHeight(legend);
  const size = legend.fontSize;
  const item = (it: LegendItem, x: number, baselineTop: number, maxW: number) => {
    const midY = baselineTop - lh / 2;
    ctx.page.drawCircle({
      x: x + DOT / 2,
      y: midY,
      size: DOT / 2,
      color: toPdfColor(it.color),
      opacity: it.color.a,
    });
    let label = ctx.encode(it.label);
    while (label.length > 1 && ctx.regular.widthOfTextAtSize(label, size) > maxW) {
      label = `${label.slice(0, -2)}…`.replace(/……$/, "…");
    }
    ctx.page.drawText(ctx.encode(label), {
      x: x + DOT + GAP_AFTER_DOT,
      y: midY - size * 0.35,
      size,
      font: ctx.regular,
      color: toPdfColor(it.color),
    });
  };
  if (legend.position === "top" || legend.position === "bottom") {
    const rows = legendRows(legend, ctx.regular, ctx.encode, strip.w);
    rows.forEach((row, r) => {
      const widths = row.map(
        (it) => DOT + GAP_AFTER_DOT + ctx.regular.widthOfTextAtSize(ctx.encode(it.label), size),
      );
      const total = widths.reduce((a, b) => a + b, 0) + GAP_BETWEEN * (row.length - 1);
      let x = strip.x + Math.max(0, (strip.w - total) / 2);
      const top = strip.top - 2 - r * lh;
      row.forEach((it, i) => {
        item(it, x, top, strip.w);
        x += widths[i] + GAP_BETWEEN;
      });
    });
    return;
  }
  const fits = Math.max(1, Math.floor(strip.h / lh));
  const shown = legend.items.slice(0, fits);
  const startTop = strip.top - Math.max(0, (strip.h - shown.length * lh) / 2);
  shown.forEach((it, i) => {
    item(it, strip.x + 6, startTop - i * lh, strip.w - 6 - DOT - GAP_AFTER_DOT);
  });
}
