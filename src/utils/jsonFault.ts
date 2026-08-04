// Why did JSON.parse reject this payload?
//
// HEAD/TAIL logging cannot answer that for a long document. A 26KB model reply
// is routinely well-formed at both ends and broken somewhere in the middle —
// the usual shape when a model writes long prose into a JSON string and lets a
// raw newline or an unescaped quote through. Printing the first and last 160
// characters of such a payload shows two perfectly good fragments and explains
// nothing.
//
// So: report the parser's own message, and a window of the text AROUND the
// offending offset. The window is JSON.stringify'd on purpose — that renders
// control characters visibly as \n / \t / \r instead of as invisible
// whitespace, which is the single distinction needed to tell "raw newline
// inside a string" apart from "unescaped quote".

/** Characters of context to show either side of the fault. */
const WINDOW = 140;

/**
 * Repair the malformations this endpoint actually produces.
 *
 * The bar for adding a rule here is deliberately high: the rewrite must be
 * UNAMBIGUOUS — exactly one thing the model could have meant — and it only ever
 * runs on a payload that has ALREADY failed a strict parse, so it cannot turn
 * good JSON into something else. The caller must still parse the result, and
 * must record that a repair happened; a silent repair hides an upstream defect
 * that will otherwise never get fixed. Anything requiring a guess (truncation,
 * an unescaped quote mid-sentence) is left alone and fails visibly instead.
 *
 * Both rules below come from observed traces, not from imagination.
 *
 * 1. A duplicated key:
 *
 *      { "type": "type": "table", "table": { ... } }
 *
 *    Five consecutive failures, five different offsets, always immediately
 *    before a table. The cause is a collision in our own schema — `{ "type":
 *    "table", "table": {...} }` is the only block whose type VALUE repeats as
 *    the very next KEY, and the model duplicates the key when it meets that.
 *    Deck plans carry the same hazard on layout/chart/diagram. Only rewritten
 *    when the two keys genuinely match, so `"type": "heading": "table"` is
 *    left alone rather than resolved into content nobody wrote.
 *
 * 2. A stray statement terminator:
 *
 *      "text": "...the widest margin variance.";
 *      }
 *
 *    JSON has no semicolons outside strings, so one sitting between a closing
 *    quote and a `}`/`]`/`,` has exactly one reading. The lookbehind keeps an
 *    escaped quote inside a string from being read as a terminator.
 *
 * Returns null when there was nothing of either shape to fix.
 */
export function repairJsonGlitches(text: string): string | null {
  const fixed = text
    .replace(/("(\w+)"\s*:\s*)"\2"\s*:\s*/g, "$1")
    .replace(/(?<!\\)("\s*);(?=\s*[},\]])/g, "$1");
  return fixed === text ? null : fixed;
}

/**
 * V8 reports the byte offset as `... at position 12345` (and, on newer
 * versions, additionally as `(line 400 column 5)`). Anything that does not
 * carry a position degrades to HEAD/TAIL rather than losing the message.
 */
export function describeJsonFault(text: string, err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).trim();
  const at = /position (\d+)/i.exec(msg);
  if (!at) {
    return `${msg} — HEAD: ${text.slice(0, 160)} … TAIL: ${text.slice(-160)}`;
  }
  const pos = Math.min(Math.max(0, Number(at[1])), text.length);
  const before = text.slice(Math.max(0, pos - WINDOW), pos);
  const after = text.slice(pos, Math.min(text.length, pos + WINDOW));
  // JSON.stringify wraps each side in quotes; strip them so the two halves read
  // as one continuous excerpt with the fault marked between them.
  const show = (s: string) => JSON.stringify(s).slice(1, -1);
  return `${msg} — NEAR position ${pos} of ${text.length}: …${show(before)}⟪FAULT⟫${show(after)}…`;
}
