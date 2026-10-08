// Which catalog sources' last crawl failed, said in words (R370).
//
// FOUND FROM THE UI (R369/R370). A source whose crawl failed showed a red dot
// 6 px wide, and the reason only in that dot's and its row's hover titles: the
// row read "R369 fake catalog 2", and nothing else on the page mentioned it. A
// scheduled crawl fails with nobody watching, so there was no toast either.

export type CrawlFailure = { id: string; name: string; reason: string };

type SourceLike = { id: string; name: string; status: string; last_error: string | null };

/** The failed sources the page is showing: every one, or the one picked. */
export function crawlFailures(sources: readonly SourceLike[], filter: string): CrawlFailure[] {
  return sources
    .filter((s) => s.status === "error" && (filter === "all" || filter === s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      reason: s.last_error?.trim() || "No reason was recorded.",
    }));
}
