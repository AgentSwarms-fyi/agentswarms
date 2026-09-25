// Excel's colors as a file stores them: an ARGB value, an index into the
// legacy 64-color palette, or a theme color with a tint. All become #RRGGBB.

export type FileColor = { argb?: string; theme?: number; tint?: number; indexed?: number };

/** The Office theme a workbook uses when its file names no other. */
export const OFFICE_THEME = [
  "#FFFFFF", // 0 lt1 (Background 1)
  "#000000", // 1 dk1 (Text 1)
  "#E7E6E6", // 2 lt2
  "#44546A", // 3 dk2
  "#4472C4", // 4 accent1
  "#ED7D31", // 5 accent2
  "#A5A5A5", // 6 accent3
  "#FFC000", // 7 accent4
  "#5B9BD5", // 8 accent5
  "#70AD47", // 9 accent6
  "#0563C1", // 10 hlink
  "#954F72", // 11 folHlink
];

/**
 * The theme's colors from its XML, in the order a file's theme index uses:
 * lt1, dk1, lt2, dk2 (the file swaps each pair), then the accents and links.
 */
export function themeColors(xml: string | undefined): string[] {
  if (!xml) return OFFICE_THEME;
  const pick = (tag: string): string | undefined => {
    const m = new RegExp(`<a:${tag}>([\\s\\S]*?)</a:${tag}>`).exec(xml);
    if (!m) return undefined;
    const v =
      /srgbClr val="([0-9A-Fa-f]{6})"/.exec(m[1]) ?? /lastClr="([0-9A-Fa-f]{6})"/.exec(m[1]);
    return v ? `#${v[1].toUpperCase()}` : undefined;
  };
  const order = [
    "lt1",
    "dk1",
    "lt2",
    "dk2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
  ];
  return order.map((t, i) => pick(t) ?? OFFICE_THEME[i]);
}

/** Excel's legacy palette (indexed colors 0–63). */
export const INDEXED_COLORS = [
  "#000000",
  "#FFFFFF",
  "#FF0000",
  "#00FF00",
  "#0000FF",
  "#FFFF00",
  "#FF00FF",
  "#00FFFF",
  "#000000",
  "#FFFFFF",
  "#FF0000",
  "#00FF00",
  "#0000FF",
  "#FFFF00",
  "#FF00FF",
  "#00FFFF",
  "#800000",
  "#008000",
  "#000080",
  "#808000",
  "#800080",
  "#008080",
  "#C0C0C0",
  "#808080",
  "#9999FF",
  "#993366",
  "#FFFFCC",
  "#CCFFFF",
  "#660066",
  "#FF8080",
  "#0066CC",
  "#CCCCFF",
  "#000080",
  "#FF00FF",
  "#FFFF00",
  "#00FFFF",
  "#800080",
  "#800000",
  "#008080",
  "#0000FF",
  "#00CCFF",
  "#CCFFFF",
  "#CCFFCC",
  "#FFFF99",
  "#99CCFF",
  "#FF99CC",
  "#CC99FF",
  "#FFCC99",
  "#3366FF",
  "#33CCCC",
  "#99CC00",
  "#FFCC00",
  "#FF9900",
  "#FF6600",
  "#666699",
  "#969696",
  "#003366",
  "#339966",
  "#003300",
  "#333300",
  "#993300",
  "#993366",
  "#333399",
  "#333333",
];

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = f(p, q, h + 1 / 3);
    g = f(p, q, h);
    b = f(p, q, h - 1 / 3);
  }
  const x = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${x(r)}${x(g)}${x(b)}`.toUpperCase();
}

/** A tint as Excel applies it: toward white (> 0) or black (< 0) in luminance. */
export function applyTint(hex: string, tint: number | undefined): string {
  if (!tint) return hex;
  const [h, s, l] = hexToHsl(hex);
  const nl = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  return hslToHex(h, s, Math.max(0, Math.min(1, nl)));
}

/** A file's color as #RRGGBB, or undefined for "automatic" / none. */
export function resolveColor(
  c: FileColor | undefined,
  theme: string[] = OFFICE_THEME,
): string | undefined {
  if (!c) return undefined;
  if (c.argb && /^[0-9A-Fa-f]{8}$/.test(c.argb)) {
    // A fully transparent color is none.
    if (c.argb.slice(0, 2) === "00" && c.argb !== "00000000")
      return `#${c.argb.slice(2).toUpperCase()}`;
    return `#${c.argb.slice(2).toUpperCase()}`;
  }
  if (c.argb && /^[0-9A-Fa-f]{6}$/.test(c.argb)) return `#${c.argb.toUpperCase()}`;
  if (typeof c.theme === "number") return applyTint(theme[c.theme] ?? "#000000", c.tint);
  if (typeof c.indexed === "number") {
    // 64 and 65 are the system foreground and background: automatic.
    return c.indexed < 64 ? INDEXED_COLORS[c.indexed] : undefined;
  }
  return undefined;
}

/** #RRGGBB as a file's ARGB. */
export function toArgb(hex: string): string {
  return `FF${hex.replace("#", "").toUpperCase()}`;
}
