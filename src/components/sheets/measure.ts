// Text widths in the browser, for overflow, "####", autofit and wrapping.
// One canvas, fonts cached per string; a server render measures nothing.

let ctx: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, Map<string, number>>();

export function measureText(text: string, font: string): number {
  if (ctx === undefined) {
    ctx =
      typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!ctx) return text.length * 7.2;
  let byText = cache.get(font);
  if (!byText) {
    if (cache.size > 64) cache.clear();
    byText = new Map();
    cache.set(font, byText);
  }
  const hit = byText.get(text);
  if (hit !== undefined) return hit;
  ctx.font = font;
  const w = ctx.measureText(text).width;
  if (byText.size > 5000) byText.clear();
  byText.set(text, w);
  return w;
}
