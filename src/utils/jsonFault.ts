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
 * Repair the one malformation this endpoint actually produces.
 *
 * Measured, not guessed: every observed failure of the document planner was the
 * same shape, at a different offset each time —
 *
 *   { "type": "type": "table", "table": { "columns": [...] } }
 *
 * and always immediately before a table block. The cause is a collision in the
 * schema itself: `{ "type": "table", "table": {...} }` is the only block whose
 * type VALUE repeats as the very next KEY, and the model duplicates the key
 * when it meets that. Slide plans carry the same hazard for chart/table/diagram.
 *
 * The rewrite is narrow — a key immediately followed by itself as a quoted
 * value and another colon — and it only ever runs on a payload that has ALREADY
 * failed a strict parse, so it cannot turn good JSON into something else. The
 * caller must still parse the result and must record that a repair happened;
 * a silent repair would hide a real upstream defect.
 *
 * Returns null when there was nothing of this shape to fix.
 */
export function repairDuplicatedKey(text: string): string | null {
  const fixed = text.replace(/("(\w+)"\s*:\s*)"\2"\s*:\s*/g, "$1");
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
