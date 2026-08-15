// The prose in a dashboard deck — and the hard line around it.
//
// THE MODEL WRITES SENTENCES. IT DOES NOT PRODUCE NUMBERS. Every figure in the
// deck comes from the widget snapshots via biDeck.ts; this layer only names
// things and says what they show. That split is not stylistic. A model handed a
// table and asked for "key takeaways" will cheerfully compute a growth rate,
// and it will sometimes be wrong — and a wrong number inside a confident
// sentence, on a slide, in a meeting, is exactly the failure this codebase is
// built to prevent. So it is given the COMPUTED values as text it may quote,
// and everything it returns is scrubbed of arithmetic it might have invented.
//
// It is also entirely optional. A model that is slow, unconfigured, rate-
// limited or nonsensical yields a clean un-narrated deck — the export never
// fails because the prose did.
import { llmJson, type LlmJsonFn } from "./biAgent";
import { describeForNarrative, type DeckCandidate, type DeckNarrative } from "./biDeck";

/** Longest a takeaway may be before it stops fitting the accent bar. */
export const MAX_TAKEAWAY_CHARS = 130;

/** Longest a supporting bullet may be before the column beside a chart wraps badly. */
export const MAX_BULLET_CHARS = 90;

/** More than this beside a chart and the slide stops being readable. */
export const MAX_BULLETS_PER_SLIDE = 3;

const SYSTEM = `You write the words for an executive slide deck built from a business-intelligence dashboard.

You are given each slide's title and its ACTUAL COMPUTED VALUES.

ABSOLUTE RULE: never calculate anything. Do not compute growth rates, totals,
percentages, differences, averages, ranks or projections. If a number is not
already written in the input, it does not exist and you must not write it.
You may quote a value exactly as given.

Good takeaway:  "Enterprise leads all regions, with EMEA close behind."
Good takeaway:  "Revenue peaks in March and settles through the summer."
BAD takeaway:   "Revenue grew 23% year over year."      (you calculated 23%)
BAD takeaway:   "Total across regions is 48,300."        (you calculated a total)

Return STRICT JSON only:
{
  "title": "short deck title, max 60 chars",
  "subtitle": "one line of context, max 90 chars",
  "summary": ["3-5 bullets on what the dashboard shows overall"],
  "takeaways": [{
    "widgetId": "<id exactly as given>",
    "text": "one headline sentence for this slide",
    "bullets": ["2-3 short supporting insights about THIS visual"]
  }]
}

EVERY slide in the input needs a takeaways entry, with bullets. The bullets sit
beside the chart and are what make the slide worth showing — say what the
audience should notice: which category leads, where the shape changes, what is
grouped together, what is conspicuously small. Each bullet is a short phrase or
clause, not a paragraph.

Every takeaway must reference a widgetId from the input. Keep each takeaway
under ${MAX_TAKEAWAY_CHARS} characters and each bullet under ${MAX_BULLET_CHARS}.
Plain sentences, no markdown.`;

/** Digits that were not in the source data are the tell that it calculated. */
const NUMBER_RE = /\d[\d,.]*\s*%?/g;

/**
 * Strip a sentence that contains a figure the input never provided.
 *
 * WHY REMOVE RATHER THAN REPAIR: there is no way to correct a number we did not
 * compute, and no way to know what the sentence was meant to say without it.
 * Dropping the takeaway costs a caption; keeping it risks a false one presented
 * with the authority of a slide.
 *
 * A percentage is refused outright unless it appeared verbatim in the source:
 * "%" is almost always the shape of a calculation, and it is the single most
 * common way a model smuggles arithmetic into prose.
 */
export function stripInventedNumbers(text: string, allowedValues: string): string | null {
  const found = text.match(NUMBER_RE);
  if (!found) return text;
  const haystack = allowedValues.replace(/[, ]/g, "");
  for (const raw of found) {
    const token = raw
      .trim()
      // A trailing period or comma is the SENTENCE's punctuation, not part of
      // the number — "…with 200." must compare as 200. Stripped only at the
      // end, so a genuine decimal like 12.35 keeps its point. Without this
      // every figure at the end of a sentence looked invented and every
      // takeaway was discarded.
      .replace(/[.,]+$/, "")
      .replace(/[, ]/g, "");
    if (!token) continue;
    // A year or a small ordinal is prose, not a computed figure.
    if (/^(19|20)\d{2}$/.test(token)) continue;
    if (/^\d$/.test(token)) continue;
    if (!haystack.includes(token)) return null;
  }
  return text;
}

/** Keep only what the model is allowed to have written. */
export function sanitizeNarrative(
  raw: unknown,
  candidates: DeckCandidate[],
  allowedValues: string,
): DeckNarrative {
  const r = (raw ?? {}) as Record<string, unknown>;
  const validIds = new Set(candidates.filter((c) => c.ok).map((c) => c.widget.id));

  const takeaways: NonNullable<DeckNarrative["takeaways"]> = [];
  if (Array.isArray(r.takeaways)) {
    for (const t of r.takeaways as Record<string, unknown>[]) {
      const widgetId = typeof t?.widgetId === "string" ? t.widgetId : "";
      const text = typeof t?.text === "string" ? t.text.trim() : "";
      // An id we did not send is a hallucinated slide; matching by position
      // instead would caption a chart with another chart's conclusion.
      if (!validIds.has(widgetId) || !text) continue;
      const clean = stripInventedNumbers(text, allowedValues);
      if (!clean) continue;
      // Bullets go through exactly the same scrub. They are the likeliest
      // place for arithmetic to appear — "grew by a third", "roughly double" —
      // because they are where the model is asked to interpret rather than
      // describe. One bad bullet is dropped; the rest of the slide survives.
      const bullets = Array.isArray((t as { bullets?: unknown }).bullets)
        ? (t as { bullets: unknown[] }).bullets
            .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
            .map((b) => stripInventedNumbers(b.trim(), allowedValues))
            .filter((b): b is string => b !== null)
            .map((b) => b.slice(0, MAX_BULLET_CHARS))
            .slice(0, MAX_BULLETS_PER_SLIDE)
        : [];
      takeaways.push({
        widgetId,
        text: clean.slice(0, MAX_TAKEAWAY_CHARS),
        ...(bullets.length ? { bullets } : {}),
      });
    }
  }

  const summary = Array.isArray(r.summary)
    ? (r.summary as unknown[])
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => stripInventedNumbers(s.trim(), allowedValues))
        .filter((s): s is string => s !== null)
        .slice(0, 5)
    : undefined;

  return {
    title: typeof r.title === "string" ? r.title.trim().slice(0, 60) : undefined,
    subtitle: typeof r.subtitle === "string" ? r.subtitle.trim().slice(0, 90) : undefined,
    summary: summary?.length ? summary : undefined,
    takeaways: takeaways.length ? takeaways : undefined,
  };
}

/**
 * Ask the chosen model for the deck's prose.
 *
 * Returns null on ANY failure — unconfigured provider, timeout, rate limit,
 * unparseable JSON. The caller builds the deck without prose rather than
 * failing the export, because the slides and their numbers are already complete
 * without it.
 */
export async function generateDeckNarrative(args: {
  dashboardName: string;
  dashboardDescription?: string | null;
  candidates: DeckCandidate[];
  model?: string;
  /**
   * The author's own steer — audience, tone, what to emphasise.
   *
   * It shapes the WORDS and nothing else. It is placed after the rules, not
   * before them, and it cannot lift the no-arithmetic rule: an instruction like
   * "include growth percentages" still produces prose whose invented figures
   * are stripped downstream. That is deliberate rather than an oversight —
   * a user asking for a number they cannot see is asking the model to compute
   * one, and a computed-then-presented figure is the failure this whole path
   * exists to prevent. The dialog says so plainly next to the field.
   */
  instructions?: string;
  llm?: LlmJsonFn;
}): Promise<DeckNarrative | null> {
  const facts = describeForNarrative(args.candidates);
  if (!facts.trim()) return null;

  const steer = args.instructions?.trim();
  const call = args.llm ?? llmJson;
  try {
    const raw = await call<unknown>({
      systemPrompt: SYSTEM,
      userPrompt:
        `Dashboard: ${args.dashboardName}\n` +
        (args.dashboardDescription ? `Description: ${args.dashboardDescription}\n` : "") +
        (steer
          ? `\nAuthor's instructions for the writing (tone, audience, emphasis). ` +
            `Follow them where they concern WORDING. They do not permit you to ` +
            `calculate anything:\n${steer.slice(0, 1200)}\n`
          : "") +
        `\nSlides and their computed values:\n${facts}`,
      model: args.model,
      temperature: 0.4,
      maxTokens: 1600,
    });
    return sanitizeNarrative(raw, args.candidates, facts);
  } catch {
    return null;
  }
}
