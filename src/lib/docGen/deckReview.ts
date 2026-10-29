// Deep mode's slide review: a vision model looks at the rendered slides and may
// ask for a few constrained fixes, which are applied to the plan before the
// final render. The model can only shrink a title, trim bullets or drop a
// visual, so a bad suggestion cannot corrupt the deck.
//
// R405 (VA-2026-10-25-37): this used to run inside the doc-gen container, on
// the container's own OpenRouter key and with whatever model the request
// named, untraced and outside every budget. It now runs in the app as the
// user, through the internal chat channel; only the rendering stays in the
// container.
import type { PptxPlan, PptxSlide } from "./types";

export type DeckFixAction = "shrink_title" | "trim_bullets" | "drop_visual";

export type DeckFix = {
  /** 1-based over the content slides; the cover the renderer adds is not counted. */
  slide: number;
  action: DeckFixAction;
  reason?: string;
};

/** At most this many fixes are applied from one review. */
export const MAX_DECK_FIXES = 6;
/** At most this many slide images are shown to the model. */
export const MAX_REVIEW_IMAGES = 10;

export const DECK_REVIEW_PROMPT =
  "You are a presentation design reviewer. These are rendered slides of a deck " +
  "(slide 1 is the cover). Identify ONLY real problems: text overflowing its box, " +
  "text clipped/cut off, unreadable low contrast, or an empty/blank visual area. " +
  'Return STRICT JSON: {"fixes":[{"slide":<1-based content-slide index EXCLUDING the ' +
  'cover>,"action":"shrink_title"|"trim_bullets"|"drop_visual","reason":"..."}]}. ' +
  `If the deck looks good, return {"fixes":[]}. Max ${MAX_DECK_FIXES} fixes.`;

const ACTIONS: ReadonlySet<string> = new Set(["shrink_title", "trim_bullets", "drop_visual"]);

/**
 * The fixes in a model's answer. Tolerates a fenced block or prose around the
 * JSON; anything that is not a known action on a whole slide number is dropped.
 */
export function parseDeckFixes(text: string): DeckFix[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (raw as { fixes?: unknown } | null)?.fixes;
  if (!Array.isArray(list)) return [];
  const out: DeckFix[] = [];
  for (const f of list) {
    if (out.length >= MAX_DECK_FIXES) break;
    const slide = Number((f as { slide?: unknown })?.slide);
    const action = String((f as { action?: unknown })?.action ?? "");
    if (!Number.isInteger(slide) || slide < 1 || !ACTIONS.has(action)) continue;
    const reason = (f as { reason?: unknown }).reason;
    out.push({
      slide,
      action: action as DeckFixAction,
      ...(typeof reason === "string" ? { reason: reason.slice(0, 200) } : {}),
    });
  }
  return out;
}

/** Does the slide still say something once its visual is gone? */
function hasText(s: PptxSlide): boolean {
  return Boolean(s.bullets?.length || s.paragraph || s.table || s.kpis?.length);
}

/** Apply the fixes to the plan in place. True when anything changed. */
export function applyDeckFixes(plan: PptxPlan, fixes: DeckFix[]): boolean {
  const slides = Array.isArray(plan.slides) ? plan.slides : [];
  let changed = false;
  for (const fix of fixes.slice(0, MAX_DECK_FIXES)) {
    const s = slides[fix.slide - 1];
    if (!s) continue;
    // A fix that leaves the slide as it was is not a change: re-rendering an
    // identical deck only costs the caller another LibreOffice run.
    if (fix.action === "shrink_title" && s.title) {
      const title = s.title.slice(0, 70);
      if (title !== s.title) {
        s.title = title;
        changed = true;
      }
    } else if (fix.action === "trim_bullets" && s.bullets?.length) {
      const bullets = s.bullets.slice(0, 4).map((b) => String(b).slice(0, 90));
      if (JSON.stringify(bullets) !== JSON.stringify(s.bullets)) {
        s.bullets = bullets;
        changed = true;
      }
    } else if (fix.action === "drop_visual" && (s.chart || s.diagram || s.diagramSvg)) {
      // On a slide whose only content IS the visual, dropping it would leave a
      // title over white space. Promote the notes (or the takeaway) to body
      // text so the slide still makes its point; with nothing to promote, keep
      // the visual, since a weak one beats a blank slide.
      if (!hasText(s)) {
        const body = String(s.notes ?? "").trim() || String(s.takeaway ?? "").trim();
        if (!body) continue;
        s.paragraph = body.slice(0, 600);
      }
      delete s.chart;
      delete s.diagram;
      delete s.diagramSvg;
      changed = true;
    }
  }
  return changed;
}

/**
 * The note shown with the deck, saying what the review did, and how many
 * slides it saw when it could not see them all.
 */
export function reviewNote(
  model: string,
  applied: DeckFix[],
  changed: boolean,
  seen?: { reviewed: number; total: number },
): string {
  const who =
    seen && seen.reviewed < seen.total
      ? `Reviewed by ${model} (the first ${seen.reviewed} of ${seen.total} slides)`
      : `Reviewed by ${model}`;
  if (!applied.length) return `${who}: no problems found.`;
  if (!changed) return `${who}: its suggestions did not apply to this deck.`;
  const n = applied.length;
  return `${who}: ${n} fix${n === 1 ? "" : "es"} applied.`;
}
