// Which visual the question asked for at each analyst step.
//
// R511 matched the question's visuals to the steps by POSITION when there was
// one per step. R512's UI test asked for "daily total sales for the latest
// year as a calendar, sales by region and segment as a treemap, and a pivot of
// sales by region and segment … What is the total for the year?" — the plan
// put the total first, so the KPI step was offered the calendar, the calendar
// step the treemap, and the region × segment step the pivot: the treemap was
// never drawn, and nothing said so.
//
// Now a step whose goal names a visual keeps it, and the rest are matched by
// SUBJECT: each visual's clause ("sales by region and segment as a treemap")
// against each step's goal, the strongest overlaps first, one visual per step.
// A visual no step matches is reported, so the write-up can say it was not
// drawn instead of claiming it is missing from the data.
import { requestedChartMentions, type ChartMention } from "@/lib/biChartCatalog";

export type AskedVisual = { type: string; phrase: string };

const STOP = new Set(
  (
    "a an the and or of for in on by as with to from per into over across show me give draw " +
    "plot chart charts graph what is are was were how much many its it this that each every"
  ).split(" "),
);

/** The content words of a phrase, singular, without the glue. */
function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOP.has(w)) continue;
    out.add(w.length > 3 ? w.replace(/s$/, "") : w);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/** Fewer shared words than this is a coincidence ("sales"), not a match. */
const MIN_OVERLAP = 2;

export function askedVisualsForSteps(
  question: string,
  goals: string[],
): { perStep: (AskedVisual | undefined)[]; unplaced: AskedVisual[] } {
  const mentions: ChartMention[] = requestedChartMentions(question);
  const used = new Set<number>();
  const perStep: (AskedVisual | undefined)[] = goals.map(() => undefined);
  const visual = (m: ChartMention): AskedVisual => ({ type: m.type, phrase: m.phrase });

  // 1. A goal that names its own visual keeps it, and uses up the question's
  //    mention of the same type.
  goals.forEach((goal, i) => {
    const own = requestedChartMentions(goal)[0];
    if (!own) return;
    perStep[i] = visual(own);
    const j = mentions.findIndex((m, k) => !used.has(k) && m.type === own.type);
    if (j >= 0) used.add(j);
  });

  // 2. The rest by subject, strongest pair first.
  const stepWords = goals.map(contentWords);
  const pairs: { j: number; i: number; score: number }[] = [];
  mentions.forEach((m, j) => {
    if (used.has(j)) return;
    const words = contentWords(m.clause);
    goals.forEach((_, i) => {
      if (perStep[i]) return;
      const score = overlap(words, stepWords[i]);
      if (score >= MIN_OVERLAP) pairs.push({ j, i, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.j - b.j || a.i - b.i);
  let placed = 0;
  for (const p of pairs) {
    if (used.has(p.j) || perStep[p.i]) continue;
    perStep[p.i] = visual(mentions[p.j]);
    used.add(p.j);
    placed++;
  }

  // 3. Nothing matched by name or subject: the R511 rule, by position, only
  //    when the counts line up (or there is one step).
  if (placed === 0 && used.size === 0 && mentions.length > 0) {
    if (mentions.length === goals.length) {
      mentions.forEach((m, k) => {
        perStep[k] = visual(m);
        used.add(k);
      });
    } else if (goals.length === 1) {
      perStep[0] = visual(mentions[0]);
      used.add(0);
    }
  }

  return {
    perStep,
    unplaced: mentions.filter((_, k) => !used.has(k)).map(visual),
  };
}
