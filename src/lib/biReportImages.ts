// A picture block's bytes for the PDF (R508).
//
// A picture the author chose is kept in the report as a data URL and decodes
// anywhere. One given by https address is fetched by the browser at export,
// which works only where that server allows it (CORS); when it does not, the
// PDF says the picture is unavailable rather than leaving a gap.
import type { ReportImageBytes } from "@/lib/biReportPdf";
import type { ReportBlock } from "@/lib/biReports";

/** PNG and JPEG by their first bytes, which beat a server's content type. */
export function sniffImageType(bytes: Uint8Array): "png" | "jpeg" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/** The bytes of a data:image URL, or null. */
export function dataUrlBytes(src: string): Uint8Array | null {
  const m = /^data:image\/(?:png|jpeg);base64,(.*)$/.exec(src);
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
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
    if (bytes && type) out.set(b.id, { bytes, type });
  }
  return out;
}
