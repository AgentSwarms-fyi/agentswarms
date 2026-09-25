// The "automatic" text color over a filled cell. Excel's automatic is black,
// which reads on the light fills people use; the app's is the theme's text
// color, which in the dark theme is near white and vanished on a light fill
// (R124). Over a fill with no text color of its own, text is dark on a light
// fill and white on a dark one, in either theme.

const DARK_INK = "#1f1f1f";
const LIGHT_INK = "#ffffff";

/** Relative luminance (0 black … 1 white) of "#rrggbb" or "#rgb", or null. */
export function luminance(color: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text color for a cell filled with `bg` that has none of its own. */
export function inkOn(bg: string | undefined): string | undefined {
  if (!bg) return undefined;
  const l = luminance(bg);
  if (l === null) return undefined;
  // Where black and white text contrast equally with the fill.
  return l > 0.179 ? DARK_INK : LIGHT_INK;
}
