// Cell styles beyond bold and alignment: fonts, colors, borders, wrapping,
// and links, with the lists the toolbar offers. Kept as data so a cell style
// round-trips through the workbook, the clipboard and an .xlsx file.

export type BorderStyle = "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
export type BorderSide = { s: BorderStyle; c?: string };
export type Borders = { t?: BorderSide; r?: BorderSide; b?: BorderSide; l?: BorderSide };

/** Fonts offered in the toolbar; any other name from an imported file is kept as it came. */
export const FONTS = [
  "Calibri",
  "Aptos",
  "Arial",
  "Cambria",
  "Courier New",
  "Georgia",
  "Helvetica",
  "Inter",
  "Segoe UI",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
] as const;

export const DEFAULT_FONT = "Calibri";
export const DEFAULT_SIZE = 11;
export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72] as const;

/** Excel's theme colors (rows of tints) and its standard colors. */
export const PALETTE: string[][] = [
  [
    "#000000",
    "#FFFFFF",
    "#E7E6E6",
    "#44546A",
    "#4472C4",
    "#ED7D31",
    "#A5A5A5",
    "#FFC000",
    "#5B9BD5",
    "#70AD47",
  ],
  [
    "#7F7F7F",
    "#F2F2F2",
    "#D0CECE",
    "#D6DCE4",
    "#D9E2F3",
    "#FBE5D5",
    "#EDEDED",
    "#FFF2CC",
    "#DEEBF6",
    "#E2EFD9",
  ],
  [
    "#595959",
    "#D8D8D8",
    "#AEABAB",
    "#ADB9CA",
    "#B4C6E7",
    "#F7CBAC",
    "#DBDBDB",
    "#FFE598",
    "#BDD7EE",
    "#C5E0B3",
  ],
  [
    "#3F3F3F",
    "#BFBFBF",
    "#757070",
    "#8496B0",
    "#8EAADB",
    "#F4B183",
    "#C9C9C9",
    "#FFD965",
    "#9DC3E6",
    "#A8D08D",
  ],
  [
    "#262626",
    "#A5A5A5",
    "#3A3838",
    "#323F4F",
    "#2F5496",
    "#C55A11",
    "#7B7B7B",
    "#BF8F00",
    "#2E75B5",
    "#538135",
  ],
];
export const STANDARD_COLORS = [
  "#C00000",
  "#FF0000",
  "#FFC000",
  "#FFFF00",
  "#92D050",
  "#00B050",
  "#00B0F0",
  "#0070C0",
  "#002060",
  "#7030A0",
];

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A color the style may hold: #RRGGBB, upper-cased. */
export function normalizeColor(c: string | undefined | null): string | undefined {
  if (!c) return undefined;
  const t = c.trim();
  if (HEX.test(t)) return t.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(t)) {
    return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`.toUpperCase();
  }
  // ARGB from a file (FF4472C4) keeps its RGB.
  if (/^[0-9a-fA-F]{8}$/.test(t)) return `#${t.slice(2)}`.toUpperCase();
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t}`.toUpperCase();
  return undefined;
}

const WIDTH: Record<BorderStyle, number> = {
  thin: 1,
  dashed: 1,
  dotted: 1,
  medium: 2,
  double: 3,
  thick: 3,
};

/** A border side as CSS. */
export function cssBorder(side: BorderSide | undefined): string | undefined {
  if (!side) return undefined;
  const style =
    side.s === "dashed"
      ? "dashed"
      : side.s === "dotted"
        ? "dotted"
        : side.s === "double"
          ? "double"
          : "solid";
  return `${WIDTH[side.s]}px ${style} ${side.c ?? "#000000"}`;
}

export type BorderPreset =
  | "all"
  | "outside"
  | "inside"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "thick-outside"
  | "bottom-double"
  | "none";

/**
 * The border each cell of a range gets for a preset, as Excel's border menu
 * applies it: "outside" only on the range's edges, "inside" only between
 * cells, "none" clears all four sides.
 */
export function bordersFor(
  preset: BorderPreset,
  range: { r0: number; c0: number; r1: number; c1: number },
  row: number,
  col: number,
  current: Borders | undefined,
  side: BorderSide,
): Borders | undefined {
  const top = row === range.r0;
  const bottom = row === range.r1;
  const left = col === range.c0;
  const right = col === range.c1;
  const next: Borders = { ...(current ?? {}) };
  const set = (k: keyof Borders, on: boolean, s: BorderSide = side) => {
    if (on) next[k] = s;
  };
  switch (preset) {
    case "none":
      return undefined;
    case "all":
      set("t", true);
      set("b", true);
      set("l", true);
      set("r", true);
      break;
    case "outside":
      set("t", top);
      set("b", bottom);
      set("l", left);
      set("r", right);
      break;
    case "thick-outside": {
      const thick: BorderSide = { s: "thick", c: side.c };
      set("t", top, thick);
      set("b", bottom, thick);
      set("l", left, thick);
      set("r", right, thick);
      break;
    }
    case "inside":
      set("b", !bottom);
      set("r", !right);
      set("t", !top);
      set("l", !left);
      break;
    case "top":
      set("t", top);
      break;
    case "bottom":
      set("b", bottom);
      break;
    case "left":
      set("l", left);
      break;
    case "right":
      set("r", right);
      break;
    case "bottom-double":
      set("b", bottom, { s: "double", c: side.c });
      break;
  }
  return Object.keys(next).length ? next : undefined;
}

/**
 * A link a cell may open: web and mail addresses only (no javascript:, no
 * data:). A bare address gains https://; a bare email gains mailto:.
 */
export function safeLink(url: string | undefined | null): string | null {
  if (!url) return null;
  const t = url.trim();
  if (/^mailto:[^\s]+$/i.test(t)) return t;
  if (/^[^\s@:/]+@[^\s@/]+\.[^\s@/]+$/.test(t)) return `mailto:${t}`;
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(t);
  // Without a scheme it must at least look like a host name (example.com).
  if (!scheme && !/^[^\s/.]+(\.[^\s/.]+)+(\/|$|:|\?|#)/.test(t)) return null;
  try {
    const u = new URL(scheme ? t : `https://${t}`);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A link to a place in this workbook: #A1, #Sheet2!B3, #'Q1 Sales'!A1:C4. */
const INTERNAL =
  /^#(?:(?:'(?:[^']|'')+'|[^!'#\s]+)!)?\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/;

export function isInternalLink(url: string): boolean {
  return INTERNAL.test(url.trim());
}

/** The sheet and cell an internal link points at. */
export function parseInternalLink(url: string): { sheet?: string; ref: string } | null {
  const t = url.trim();
  if (!INTERNAL.test(t)) return null;
  const body = t.slice(1);
  const bang = body.lastIndexOf("!");
  if (bang < 0) return { ref: body.replace(/\$/g, "") };
  let sheet = body.slice(0, bang);
  if (sheet.startsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  return { sheet, ref: body.slice(bang + 1).replace(/\$/g, "") };
}

/**
 * The address to store for what was typed: a web address gains https:// when
 * it has no scheme; mail and in-workbook links stay as they are. Null when
 * it is none of these (javascript:, data:, file: and the like are refused).
 */
export function normalizeLink(url: string | undefined | null): string | null {
  if (!url) return null;
  const t = url.trim();
  if (!t) return null;
  if (isInternalLink(t)) return t;
  return safeLink(t);
}

/** Why a typed address cannot be a link, or null when it can. */
export function linkProblem(url: string): string | null {
  const t = url.trim();
  if (!t) return "Type an address";
  if (normalizeLink(t)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^(https?|mailto):/i.test(t)) {
    return "Only web (http, https), email (mailto:) and in-workbook (#Sheet1!A1) links are allowed";
  }
  return "That is not a web address, an email or a cell in this workbook";
}

/** Fallbacks for fonts a viewer may not have (metric-compatible ones first). */
const FONT_STACKS: Record<string, string> = {
  calibri: "Calibri, Carlito, 'Segoe UI', sans-serif",
  cambria: "Cambria, Caladea, Georgia, serif",
  arial: "Arial, Arimo, 'Liberation Sans', Helvetica, sans-serif",
  helvetica: "Helvetica, Arial, Arimo, sans-serif",
  "times new roman": "'Times New Roman', Tinos, 'Liberation Serif', Times, serif",
  "courier new": "'Courier New', Cousine, 'Liberation Mono', monospace",
  georgia: "Georgia, serif",
  verdana: "Verdana, sans-serif",
  tahoma: "Tahoma, Verdana, sans-serif",
  "trebuchet ms": "'Trebuchet MS', sans-serif",
  "segoe ui": "'Segoe UI', system-ui, sans-serif",
  aptos: "Aptos, 'Segoe UI', system-ui, sans-serif",
  inter: "Inter, system-ui, sans-serif",
};

export function fontStack(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const known = FONT_STACKS[name.toLowerCase()];
  if (known) return known;
  // A name from a file: quoted, so a space or a quote in it cannot escape.
  return `"${name.replace(/["\\]/g, "")}", sans-serif`;
}

/**
 * A font size in points as screen pixels. The grid draws Excel's default
 * 11 pt at 13 px, so every size keeps the same proportion to it.
 */
export function fontPx(size: number | undefined, zoom = 1): number {
  return (((size ?? DEFAULT_SIZE) * 13) / DEFAULT_SIZE) * zoom;
}

/** Excel's indent step: about three characters per level. */
export const INDENT_PX = 9;
