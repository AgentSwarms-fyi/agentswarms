// Document intelligence, the running half: read the pages of a scanned PDF
// or an image with a vision-capable model and hand back their text, so the
// knowledge base indexes what the page says instead of nothing.
//
// Every page is one call on the internal chat channel as the user, the door
// every other model call uses, so the model rules in IAM, the budget, the
// trace (agent name "Document OCR") and the cost accounting apply per page.
// The instance decides the model and how many pages one document may have.
import { auditEvent } from "@/utils/audit.server";
import { GATEWAY_PROVIDERS } from "@/utils/gateway/providers";
import { parseGatewayModel } from "@/utils/gateway/keys";
import { internalChatText } from "@/utils/internalChat.server";
import {
  isNoText,
  OCR_SYSTEM_PROMPT,
  ocrPageRequest,
  PAGES_PER_REQUEST,
  visionPagesOverCapMessage,
} from "@/lib/documentVision";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";

/** Pages read at once for one document. */
const CONCURRENCY = 3;
/** A page must be transcribed within this; scans of dense pages take a while. */
const PAGE_TIMEOUT_MS = 120_000;

export type OcrBatchResult = {
  /** One entry per page sent, in order; "" for a page with no text. */
  texts: string[];
  model: string;
  cost_usd: number | null;
};

/** The provider/model pages are read with: the caller's choice, else the instance's. */
async function resolveVisionModel(spec: string | null | undefined) {
  const settings = await getPlatformResources();
  const s = (spec ?? "").trim() || settings.documentVisionModel;
  const target = parseGatewayModel(s, GATEWAY_PROVIDERS);
  if (!target || target.kind !== "model") {
    throw new Error(
      `Unknown vision model "${s}". Write it as provider/model, for example openrouter/google/gemini-3-flash-preview.`,
    );
  }
  return {
    provider: target.provider,
    model: target.model,
    spec: `${target.provider}/${target.model}`,
    settings,
  };
}

/**
 * Read one batch of a document's pages. The caller sends a document in
 * batches (PAGES_PER_REQUEST at a time, so a request stays small) and says
 * where the batch sits; the cap is checked against the whole document on
 * every batch, so a document over it is refused before its first page.
 */
export async function readPagesWithVision(args: {
  userId: string;
  /** The document's name, for the audit trail. */
  name: string;
  /** Data URLs (image/png, image/jpeg, image/webp, image/gif). */
  pages: string[];
  /** Index of the first page in this batch within the document (0-based). */
  pageOffset: number;
  totalPages: number;
  model?: string | null;
  decisionId?: string;
}): Promise<OcrBatchResult> {
  const { provider, model, spec, settings } = await resolveVisionModel(args.model);
  const cap = settings.documentVisionMaxPages;
  if (args.totalPages > cap) throw new Error(visionPagesOverCapMessage(args.totalPages, cap));
  if (args.pages.length > PAGES_PER_REQUEST) {
    throw new Error(`Send at most ${PAGES_PER_REQUEST} pages per request.`);
  }
  const texts: string[] = new Array(args.pages.length).fill("");
  let cost: number | null = null;
  let next = 0;
  const worker = async () => {
    while (next < args.pages.length) {
      const i = next++;
      const { text, cost: c } = await internalChatText({
        userId: args.userId,
        decisionId: args.decisionId,
        agentName: "Document OCR",
        provider,
        model,
        system: OCR_SYSTEM_PROMPT,
        user: [
          { type: "text", text: ocrPageRequest(args.pageOffset + i + 1, args.totalPages) },
          { type: "image_url", image_url: { url: args.pages[i] } },
        ],
        maxTokens: 4096,
        timeoutMs: PAGE_TIMEOUT_MS,
      });
      if (c !== null) cost = (cost ?? 0) + c;
      texts[i] = isNoText(text) ? "" : text.trim();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, args.pages.length) }, worker));
  auditEvent({
    userId: args.userId,
    action: "kb.document.ocr",
    resourceType: "knowledge_document",
    resourceName: args.name,
    decisionId: args.decisionId,
    detail: {
      pages_from: args.pageOffset + 1,
      pages_to: args.pageOffset + args.pages.length,
      total_pages: args.totalPages,
      empty_pages: texts.filter((t) => !t).length,
      chars: texts.reduce((n, t) => n + t.length, 0),
      model: spec,
      cost_usd: cost,
    },
  });
  return { texts, model: spec, cost_usd: cost };
}
