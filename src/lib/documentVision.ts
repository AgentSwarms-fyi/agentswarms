// Document intelligence, the pure half: when a PDF is really a stack of
// pictures, how a page is asked for its text, and how pages are joined back
// into one document. Shared by the browser (which renders the pages) and
// the server (which reads them), so both agree on every rule.

/** Image files the knowledge base accepts; each is read as one page. */
export const VISION_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;

export function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return VISION_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Characters per page below which a PDF's text layer is judged missing.
 * A real page of prose carries thousands; a scanned page carries the few
 * stray characters an exporter stamps in the margin, or none.
 */
export const SCANNED_CHARS_PER_PAGE = 40;

/** A PDF whose pages carry no usable text layer: images of pages, to be read by eye. */
export function looksScanned(pageTexts: string[]): boolean {
  if (!pageTexts.length) return false;
  const chars = pageTexts.reduce((n, t) => n + t.replace(/\s+/g, "").length, 0);
  return chars / pageTexts.length < SCANNED_CHARS_PER_PAGE;
}

/** Rendering: enough for print at reading size, small enough to send. */
export const PAGE_RENDER_SCALE = 1.5;
export const PAGE_MAX_SIDE_PX = 1800;
export const PAGE_JPEG_QUALITY = 0.85;
/** Pages sent to the server in one request; a page is a few hundred kilobytes. */
export const PAGES_PER_REQUEST = 6;

export const NO_TEXT_MARKER = "[no text]";

export const OCR_SYSTEM_PROMPT =
  "You transcribe document pages. Return the page's text exactly as written, in reading order (top to bottom, left to right). " +
  "Keep headings, list items and table rows on their own lines; write a table as rows with cells separated by ' | '. " +
  "Do not describe the image, do not add commentary, do not translate, do not wrap the answer in markdown fences. " +
  `If the page holds no text at all, answer exactly: ${NO_TEXT_MARKER}`;

export function ocrPageRequest(pageNumber: number, totalPages: number): string {
  return `Page ${pageNumber} of ${totalPages}. Transcribe it.`;
}

export function isNoText(answer: string): boolean {
  const t = answer.trim();
  return t === "" || t.toLowerCase() === NO_TEXT_MARKER;
}

/** One document from its pages: a page marker before each page that had text. */
export function joinPageTexts(texts: string[]): string {
  const parts: string[] = [];
  texts.forEach((t, i) => {
    const clean = t
      .trim()
      .replace(/^```[a-zA-Z]*\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
    if (isNoText(clean)) return;
    parts.push(`[page ${i + 1}]\n${clean}`);
  });
  return parts.join("\n\n");
}

export function visionPagesOverCapMessage(pages: number, cap: number): string {
  return (
    `This document has ${pages} pages; the limit for reading scanned pages is ${cap} per document. ` +
    `Split it, or raise "Pages per document" under Admin → Developer runtime → Document intelligence.`
  );
}
