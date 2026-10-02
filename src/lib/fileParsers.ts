// Client-side parsers for common knowledge-base document formats.
// Returns plain text for storage in `knowledge_documents.content`.
import {
  isImageFile,
  looksScanned,
  PAGE_JPEG_QUALITY,
  PAGE_MAX_SIDE_PX,
  PAGE_RENDER_SCALE,
} from "@/lib/documentVision";

/**
 * What an upload yields: its text, or - for a scanned PDF or an image - the
 * pages as images, for the server to read with a vision model.
 */
export type ParsedUpload = {
  text: string;
  /** Page images (JPEG data URLs), present only when the text layer is missing. */
  pages: string[] | null;
};

export async function parseFileForKb(file: File): Promise<ParsedUpload> {
  const lower = file.name.toLowerCase();
  if (isImageFile(lower)) {
    return { text: "", pages: [await fileToDataUrl(file)] };
  }
  if (lower.endsWith(".pdf")) {
    const pdf = await loadPdf(file);
    const pageTexts = await pdfPageTexts(pdf);
    if (looksScanned(pageTexts)) {
      return { text: "", pages: await renderPdfPages(pdf) };
    }
    return { text: pageTexts.join("\n\n").trim(), pages: null };
  }
  return { text: await parseFileToText(file), pages: null };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function parseFileToText(file: File): Promise<string> {
  const lower = file.name.toLowerCase();

  if (lower.endsWith(".pdf")) {
    return await parsePdf(file);
  }
  if (lower.endsWith(".docx")) {
    return await parseDocx(file);
  }
  if (lower.endsWith(".doc")) {
    throw new Error("Legacy .doc files are not supported. Please save as .docx and re-upload.");
  }
  // Default: plain text read
  return await file.text();
}

// pdfjs + mammoth are large and only needed when the user actually uploads a
// PDF/DOCX. We load them from a CDN at runtime via @vite-ignore'd dynamic
// imports so they are NOT split into Vite-hashed chunks. Hashed chunks break
// when the deploy is updated while a user has an old tab open
// ("Failed to fetch dynamically imported module: /assets/pdf-XXXX.js").

const PDFJS_VERSION = "4.7.76";
const MAMMOTH_VERSION = "1.8.0";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPdf(file: File): Promise<any> {
  const pdfjsUrl = `https://esm.sh/pdfjs-dist@${PDFJS_VERSION}/build/pdf.mjs`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import(/* @vite-ignore */ pdfjsUrl);
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
  const buf = await file.arrayBuffer();
  return await pdfjs.getDocument({ data: buf }).promise;
}

/** The text layer of every page, in order; a scanned page yields "". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pdfPageTexts(pdf: any): Promise<string[]> {
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = content.items.map((it: any) => ("str" in it ? it.str : "")).join(" ");
    parts.push(text);
  }
  return parts;
}

/** Every page drawn to a JPEG at reading size, for a vision model to read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function renderPdfPages(pdf: any): Promise<string[]> {
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(PAGE_RENDER_SCALE, PAGE_MAX_SIDE_PX / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot draw PDF pages.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push(canvas.toDataURL("image/jpeg", PAGE_JPEG_QUALITY));
    canvas.width = 0;
    canvas.height = 0;
  }
  return out;
}

async function parsePdf(file: File): Promise<string> {
  const pdf = await loadPdf(file);
  return (await pdfPageTexts(pdf)).join("\n\n").trim();
}

async function parseDocx(file: File): Promise<string> {
  const mammothUrl = `https://esm.sh/mammoth@${MAMMOTH_VERSION}/mammoth.browser.js`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mammoth: any = await import(/* @vite-ignore */ mammothUrl);
  const buf = await file.arrayBuffer();
  const result = await (mammoth.default ?? mammoth).extractRawText({ arrayBuffer: buf });
  return String(result?.value || "").trim();
}
