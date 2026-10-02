// Which audit actions count as a data read.
//
// Pure and import-free on purpose: the server assembles passports with it and
// the traces UI renders counts with it, and those two must never disagree about
// what a "data read" is. A copy on each side is how they drift.
/**
 * Is this audit action a READ OF DATA, as opposed to something else that
 * happened while the decision was underway?
 *
 * FOUND FROM THE UI. Every audit row on the chain was being counted and
 * rendered as a data read, including `agent.chat` -- the row that records the
 * answer itself. A decision with one knowledge-base search reported "2 data
 * reads", and the passport said the same in writing.
 *
 * Overstating the evidence is the one failure this whole feature exists to
 * prevent: an examiner who checks a claim of two reads and finds one stops
 * believing the rest of the document. Non-reads are still shown and still
 * exported -- they are part of what happened -- they are simply not counted as
 * reads.
 *
 * The rule is a suffix rather than a list so a new data tool is counted the day
 * it ships: forgetting to add an action here would silently undercount, which
 * is the same class of error in the other direction. `..._refused` deliberately
 * fails the test — a read that was denied read nothing.
 */
export function isDataRead(action: string): boolean {
  return action.endsWith("query") || action === "kb.search" || action === "lakehouse.select";
}
