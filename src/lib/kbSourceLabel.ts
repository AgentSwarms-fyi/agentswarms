/**
 * How a knowledge-base source is named in the Sources list and on its
 * documents.
 *
 * FOUND IN R208: an uploaded .txt (or .md, .json, .docx…) is stored as kind
 * "manual", the only kind the table allows for text, and was listed as
 * "MANUAL · Manual paste" with a "Manual" badge on its document, the same as
 * text typed into the Manual tab. An upload records its filename in the
 * source's config, and a paste does not, so that is how the two are told
 * apart.
 */
type SourceLike = { kind: string; config?: unknown } | null | undefined;

export function isUploadedFile(src: SourceLike): boolean {
  if (!src) return false;
  if (src.kind === "pdf" || src.kind === "csv") return true;
  const filename = (src.config as { filename?: unknown } | null | undefined)?.filename;
  return src.kind === "manual" && typeof filename === "string" && filename.length > 0;
}

/** The short badge: URL, GitHub, PDF, CSV, File or Manual. */
export function kbSourceBadge(src: SourceLike): string {
  switch (src?.kind) {
    case "url":
      return "URL";
    case "github":
      return "GitHub";
    case "pdf":
      return "PDF";
    case "csv":
      return "CSV";
    default:
      return isUploadedFile(src) ? "File" : "Manual";
  }
}
