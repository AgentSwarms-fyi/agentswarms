// Deep mode's slide review, run as the user (R405, VA-2026-10-25-37).
//
// The doc-gen container renders the slides; this asks a vision model about
// them through the internal chat channel, so the model rules in IAM, the
// budget, the trace (agent name "Deck review") and the cost accounting apply
// as they do to every other call. The model is the one the chat that made
// the deck runs on, else the instance default, each only when this user can
// use it. The container no longer holds a model key.
import { internalChatText } from "@/utils/internalChat.server";
import { MAX_BODY_CHARS } from "@/utils/observability/traceSanitize";
import { chooseModel } from "@/utils/providers/defaultModel.server";
import { parseModelChoice } from "@/utils/providers/modelChoice";
import {
  DECK_REVIEW_PROMPT,
  MAX_REVIEW_IMAGES,
  parseDeckFixes,
  type DeckFix,
} from "@/lib/docGen/deckReview";

const REVIEW_TIMEOUT_MS = 90_000;
/**
 * The slides of one review travel in one request, and the chat channel
 * refuses a request over MAX_BODY_CHARS. The first live review sent ten
 * 90 dpi PNGs and was refused (413); the renderer now sends small JPEGs, and
 * this keeps whatever it sends under the ceiling with room for the prompt.
 */
export const REVIEW_IMAGE_CHARS = MAX_BODY_CHARS - 50_000;

export type DeckReview =
  { ok: true; fixes: DeckFix[]; model: string; cost: number | null } | { ok: false; error: string };

/**
 * The slides that reach the model: rendered JPEG or PNG data URIs only, from
 * the first, as many as fit in one request. `total` is how many were usable.
 */
export function slideImages(
  images: unknown,
  budget = REVIEW_IMAGE_CHARS,
): { images: string[]; total: number } {
  if (!Array.isArray(images)) return { images: [], total: 0 };
  const usable = images
    .filter((u): u is string => typeof u === "string" && /^data:image\/(jpeg|png);base64,/.test(u))
    .slice(0, MAX_REVIEW_IMAGES);
  const out: string[] = [];
  let used = 0;
  for (const url of usable) {
    // The part's JSON around the URL is about sixty characters.
    if (used + url.length + 60 > budget) break;
    out.push(url);
    used += url.length + 60;
  }
  return { images: out, total: usable.length };
}

export async function reviewDeck(args: {
  userId: string;
  /** The chat's model choice as the browser encodes it ("provider::model"), if any. */
  choice: string | null;
  title: string;
  images: string[];
  /** Slides rendered; more than `images.length` when some did not fit. */
  total: number;
}): Promise<DeckReview> {
  if (!args.images.length) return { ok: false, error: "the renderer returned no slide images" };
  const chosen = await chooseModel(args.userId, parseModelChoice(args.choice));
  if (!chosen.ok) return { ok: false, error: chosen.error };
  try {
    const { text, cost } = await internalChatText({
      userId: args.userId,
      provider: chosen.provider,
      model: chosen.model,
      system: DECK_REVIEW_PROMPT,
      user: [
        {
          type: "text",
          text:
            args.images.length < args.total
              ? `The deck "${args.title.slice(0, 200)}": its first ${args.images.length} of ${args.total} slides.`
              : `The deck "${args.title.slice(0, 200)}", ${args.images.length} slides rendered.`,
        },
        ...args.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
      ],
      maxTokens: 800,
      temperature: 0,
      agentName: "Deck review",
      timeoutMs: REVIEW_TIMEOUT_MS,
      modelFallback: chosen.fellBack,
    });
    return { ok: true, fixes: parseDeckFixes(text), model: chosen.spec, cost };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
