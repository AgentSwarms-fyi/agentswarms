// Client-side parsers for common knowledge-base document formats.
// Returns plain text for storage in `knowledge_documents.content`.

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

async function parsePdf(file: File): Promise<string> {
  const pdfjsUrl = `https://esm.sh/pdfjs-dist@${PDFJS_VERSION}/build/pdf.mjs`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import(/* @vite-ignore */ pdfjsUrl);
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = content.items.map((it: any) => ("str" in it ? it.str : "")).join(" ");
    parts.push(text);
  }
  return parts.join("\n\n").trim();
}

async function parseDocx(file: File): Promise<string> {
  const mammothUrl = `https://esm.sh/mammoth@${MAMMOTH_VERSION}/mammoth.browser.js`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mammoth: any = await import(/* @vite-ignore */ mammothUrl);
  const buf = await file.arrayBuffer();
  const result = await (mammoth.default ?? mammoth).extractRawText({ arrayBuffer: buf });
  return String(result?.value || "").trim();
}
