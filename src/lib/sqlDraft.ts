// A query typed into the Data SQL editor and never run (sweep 8, R304).
//
// The Workbench is a scratch console: a query is kept once it runs, in Recent
// queries. Three one-click actions replace the editor's text - a table in the
// explorer, a pick from Recent queries, and "Run … in the Workbench" on the
// Catalog - and the editor is a controlled textarea, so Ctrl+Z cannot bring
// back what was there. A query typed and never run was gone without a word.

/**
 * Whether putting `next` in the editor loses a query that was typed and never
 * run: the editor holds text, and it is neither what was last kept (the last
 * query run, or the last text the page put there) nor what is coming in.
 */
export function losesUnrunQuery(current: string, kept: string, next: string): boolean {
  return current.trim() !== "" && current !== kept && current !== next;
}
