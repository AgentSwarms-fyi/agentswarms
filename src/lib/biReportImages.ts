// A picture block's bytes for the PDF (R508).
//
// A picture the author chose is kept in the report as a data URL and decodes
// anywhere. One given by https address is fetched by the browser at export,
// which works only where that server allows it (CORS); when it does not, the
// PDF says the picture is unavailable rather than leaving a gap.
//
// PNG and JPEG are embedded as they are. An SVG (R510) is drawn as vectors by
// the same code that draws the charts (lib/svgPdf), so a logo or a drawing
// stays sharp; its scripts, links and embedded pictures are never followed.
import type { ReportImageBytes } from "@/lib/biReportPdf";
import type { ReportBlock } from "@/lib/biReports";
import { findAll, parseMarkup, type MElement } from "@/lib/svgPdf";

/** PNG and JPEG by their first bytes, which beat a server's content type; SVG by its first tag. */
export function sniffImageType(bytes: Uint8Array): "png" | "jpeg" | "svg" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  // TextDecoder drops a leading byte-order mark itself.
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).trimStart();
  // An XML declaration, comments and a doctype may come before the <svg>.
  if (
    /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)
  ) {
    return "svg";
  }
  return null;
}

/** The bytes of a data:image URL (PNG, JPEG or SVG, base64 or percent-encoded), or null. */
export function dataUrlBytes(src: string): Uint8Array | null {
  const m = /^data:image\/(png|jpeg|svg\+xml)((?:;[\w.+-]+=[\w.+-]+)*)(;base64)?,(.*)$/s.exec(src);
  if (!m) return null;
  try {
    if (!m[3]) {
      // Only SVG is sensibly written as text; a PNG must be base64.
      if (m[1] !== "svg+xml") return null;
      return new TextEncoder().encode(decodeURIComponent(m[4]));
    }
    const bin = atob(m[4]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * An SVG picture's root element and the size it asks for (its width and
 * height, else its viewBox), or null when it has neither and so cannot be
 * placed.
 */
export function svgPicture(bytes: Uint8Array): { svg: MElement; w: number; h: number } | null {
  let root: MElement;
  try {
    root = parseMarkup(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const svg = root.tag === "svg" ? root : findAll(root, (e) => e.tag === "svg")[0];
  if (!svg) return null;
  const n = (v: string | undefined) => {
    const x = Number.parseFloat(v ?? "");
    return Number.isFinite(x) && x > 0 && !/%$/.test(v ?? "") ? x : NaN;
  };
  const vb = (svg.attrs.viewbox ?? svg.attrs.viewBox ?? "")
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  let w = n(svg.attrs.width);
  let h = n(svg.attrs.height);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    // One side given: the other follows the viewBox's proportions.
    if (w > 0 && !(h > 0)) h = (w * vb[3]) / vb[2];
    else if (h > 0 && !(w > 0)) w = (h * vb[2]) / vb[3];
    else if (!(w > 0 && h > 0)) [w, h] = [vb[2], vb[3]];
  }
  if (!(w > 0 && h > 0)) return null;
  // drawSvg reads the size from the element; give it the one worked out here.
  return { svg: { ...svg, attrs: { ...svg.attrs, width: String(w), height: String(h) } }, w, h };
}

export async function resolveReportImages(
  blocks: ReportBlock[],
  fetcher: typeof fetch = fetch,
): Promise<Map<string, ReportImageBytes>> {
  const out = new Map<string, ReportImageBytes>();
  for (const b of blocks) {
    if (b.kind !== "image" || !b.src) continue;
    let bytes: Uint8Array | null = null;
    if (b.src.startsWith("data:")) bytes = dataUrlBytes(b.src);
    else if (/^https:\/\//i.test(b.src)) {
      try {
        const res = await fetcher(b.src, { referrerPolicy: "no-referrer" });
        if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
      } catch {
        bytes = null;
      }
    }
    const type = bytes ? sniffImageType(bytes) : null;
    // An SVG with no size to place it at is left out, like a broken PNG.
    if (bytes && type && (type !== "svg" || svgPicture(bytes))) out.set(b.id, { bytes, type });
  }
  return out;
}
