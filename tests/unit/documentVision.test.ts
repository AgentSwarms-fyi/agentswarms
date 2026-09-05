// Document intelligence: when a PDF is judged scanned, how pages are asked
// for and joined, and the wiring that reads them as the user through the
// governed channel.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  isImageFile,
  isNoText,
  joinPageTexts,
  looksScanned,
  NO_TEXT_MARKER,
  OCR_SYSTEM_PROMPT,
  ocrPageRequest,
  PAGES_PER_REQUEST,
  SCANNED_CHARS_PER_PAGE,
  visionPagesOverCapMessage,
} from "@/lib/documentVision";

const rd = (p: string) => readFileSync(p, "utf8");

describe("judging a PDF scanned", () => {
  it("a page of prose is not; an empty text layer is; a few stray characters per page still is", () => {
    expect(
      looksScanned([
        "The quarterly report shows revenue grew twelve percent over the prior period.",
      ]),
    ).toBe(false);
    expect(looksScanned(["", "", ""])).toBe(true);
    expect(looksScanned(["Page 1", "Page 2", "  3 "])).toBe(true);
    expect(looksScanned([])).toBe(false);
  });

  it("the threshold is per page, so one text page in a long scan does not rescue it", () => {
    const prose = "x".repeat(SCANNED_CHARS_PER_PAGE * 3);
    expect(looksScanned([prose, "", "", "", "", "", ""])).toBe(true);
    expect(looksScanned([prose, prose])).toBe(false);
  });

  it("images are one-page documents", () => {
    expect(isImageFile("receipt.JPG")).toBe(true);
    expect(isImageFile("scan.webp")).toBe(true);
    expect(isImageFile("notes.pdf")).toBe(false);
  });
});

describe("asking for a page and joining the answers", () => {
  it("the prompt forbids description and names the empty-page marker", () => {
    expect(OCR_SYSTEM_PROMPT).toContain("Do not describe the image");
    expect(OCR_SYSTEM_PROMPT).toContain(NO_TEXT_MARKER);
    expect(ocrPageRequest(3, 12)).toBe("Page 3 of 12. Transcribe it.");
  });

  it("an empty page is dropped, fences are stripped, and each page is marked", () => {
    expect(isNoText("  [No Text] ")).toBe(true);
    expect(isNoText("")).toBe(true);
    expect(isNoText("Total: 42")).toBe(false);
    expect(joinPageTexts(["```\nHello\n```", "[no text]", "World"])).toBe(
      "[page 1]\nHello\n\n[page 3]\nWorld",
    );
    expect(joinPageTexts(["", "[no text]"])).toBe("");
  });

  it("the cap message says what to do, and a batch is small", () => {
    const m = visionPagesOverCapMessage(340, 200);
    expect(m).toContain("340 pages");
    expect(m).toContain("limit for reading scanned pages is 200");
    expect(m).toContain("Document intelligence");
    expect(PAGES_PER_REQUEST).toBeLessThanOrEqual(10);
  });
});

describe("the wiring", () => {
  it("pages are read as the user on the internal channel, one call each, and audited", () => {
    const v = rd("src/utils/documents/vision.server.ts");
    expect(v).toContain("await internalChatText({");
    expect(v).toContain('agentName: "Document OCR",');
    expect(v).toContain('{ type: "image_url", image_url: { url: args.pages[i] } }');
    expect(v).toContain('action: "kb.document.ocr"');
    const cap = v.indexOf("throw new Error(visionPagesOverCapMessage(");
    const call = v.indexOf("await internalChatText({");
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(call);
  });

  it("the chat route keeps image parts only for an internal vision run on an OpenAI-compatible provider", () => {
    const chat = rd("src/routes/api/chat.ts");
    expect(chat).toContain("vision?: boolean;");
    expect(chat.replace(/\s+/g, " ")).toContain(
      "isInternalRun && body.vision === true && VISION_PASSTHROUGH_PROVIDERS.has(",
    );
    const m = chat.match(/VISION_PASSTHROUGH_PROVIDERS = new Set<ProviderId>\(\[([\s\S]*?)\]\)/);
    expect(m).not.toBeNull();
    const set = [...(m?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    expect(set).toContain("openrouter");
    expect(set).toContain("openai");
    // Adapters that rebuild the request from plain text never see parts.
    expect(set).not.toContain("anthropic");
    expect(set).not.toContain("bedrock");
    expect(set).not.toContain("vertex");
  });

  it("the helper sends parts as parts and flags the run", () => {
    const helper = rd("src/utils/internalChat.server.ts");
    expect(helper).toContain('vision: typeof args.user !== "string" ? true : undefined,');
  });

  it("the upload path renders scanned pages and images, reads them in batches, and says so", () => {
    const parsers = rd("src/lib/fileParsers.ts");
    expect(parsers).toContain("export async function parseFileForKb(");
    expect(parsers).toContain("looksScanned(");
    expect(parsers).toContain("isImageFile(");
    expect(parsers).toContain('toDataURL("image/jpeg", PAGE_JPEG_QUALITY)');
    const dialog = rd("src/components/knowledge/AddSourceDialog.tsx");
    expect(dialog).toContain("documentVisionExtract");
    expect(dialog).toContain("PAGES_PER_REQUEST");
    expect(dialog).toContain("joinPageTexts(");
    expect(dialog).toContain('".png"');
  });

  it("the settings, admin form, migration and docs carry the two knobs", () => {
    const sql = rd("supabase/migrations/20260866000000_document_vision.sql");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS document_vision_model text");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS document_vision_max_pages integer");
    const cfg = rd("src/utils/notebookRuntime/config.server.ts");
    expect(cfg).toContain("process.env.DOCUMENT_VISION_MODEL");
    expect(cfg).toContain('envInt("DOCUMENT_VISION_MAX_PAGES") ??');
    for (const col of ["document_vision_model", "document_vision_max_pages"]) {
      expect(rd("src/utils/notebookRuntimeAdmin.functions.ts")).toContain(`${col}:`);
      expect(rd("src/components/admin/RuntimeTab.tsx")).toContain(`"${col}"`);
    }
    expect(rd("src/routes/docs.knowledge.tsx")).toContain("Scanned PDFs and images");
    expect(rd("docs/KNOWLEDGE_BASES.md")).toContain("## Scanned documents and images");
  });
});
