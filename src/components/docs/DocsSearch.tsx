// Search across every documentation page and section.
//
// The sidebar knows about pages; the browser's find knows about the page you
// already guessed. Neither helps with "where is the bit about embedding the
// query", which is the question people actually arrive with — the answer lives
// in an H3 on a page whose title does not mention it.
//
// Deliberately not a dependency and not a service: the whole corpus is 27
// pages and 378 headings, which is small enough that filtering it in the
// browser is instant and works offline, on a self-hosted instance, with no
// index to host or keep warm.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search, CornerDownLeft } from "lucide-react";

import { DOCS_INDEX } from "./docsIndex";
import { cn } from "@/lib/utils";

type Hit = {
  route: string;
  hash?: string;
  page: string;
  label: string;
  /** Lower sorts first. */
  score: number;
};

/**
 * Rank a candidate against the query's terms.
 *
 * Every term must appear somewhere, so "embedding model" does not match a page
 * that merely says "model" a lot. Beyond that the ordering is about what the
 * reader most likely meant: a page title beats a section heading, and an exact
 * word beats a word it happens to be a prefix of — otherwise a search for
 * "data" puts every "database" heading above the Data Catalog page itself.
 */
function scoreOf(terms: string[], haystack: string, isTitle: boolean): number | null {
  const hay = haystack.toLowerCase();
  let score = isTitle ? 0 : 10;
  for (const t of terms) {
    const at = hay.indexOf(t);
    if (at === -1) return null;
    const wholeWord = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay);
    if (!wholeWord) score += 3;
    if (at > 0) score += 1;
  }
  return score;
}

export function DocsSearch() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const hits = useMemo<Hit[]>(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const out: Hit[] = [];
    for (const page of DOCS_INDEX) {
      // Title and description first, then the page's inline literals as a
      // fallback — so "sankey" or "ENFORCE_BUDGET_CAP" reaches the page that
      // documents it, while still ranking below a page actually named for the
      // query.
      const pageScore =
        scoreOf(terms, `${page.title} ${page.description}`, true) ??
        (page.terms.length ? scoreOf(terms, `${page.title} ${page.terms.join(" ")}`, true) : null);
      if (pageScore !== null) {
        out.push({ route: page.route, page: page.title, label: page.title, score: pageScore });
      }
      for (const h of page.headings) {
        // Match the heading with its page title behind it, so "swarm
        // approval" finds the approval node on the Swarm Canvas page.
        const s = scoreOf(terms, `${h.text} ${page.title}`, false);
        if (s !== null) {
          out.push({
            route: page.route,
            hash: h.id,
            page: page.title,
            label: h.text,
            score: s + (h.level === 3 ? 1 : 0),
          });
        }
      }
    }
    return out.sort((a, b) => a.score - b.score || a.label.length - b.label.length).slice(0, 12);
  }, [query]);

  useEffect(() => setActive(0), [query]);

  // "/" focuses search from anywhere on the page, the convention every docs
  // site shares — but not while the reader is typing somewhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (hit: Hit) => {
    setQuery("");
    inputRef.current?.blur();
    void navigate({ to: hit.route, hash: hit.hash });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!hits.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(hits[active]);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  };

  return (
    <div className="relative mb-4 print:hidden">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search the docs…"
        aria-label="Search the documentation"
        aria-expanded={hits.length > 0}
        aria-controls="docs-search-results"
        className="w-full rounded-lg border border-border/60 bg-card/40 py-2 pl-8 pr-8 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/60"
      />
      {/* Announced count for screen readers — the visual list alone is
          silent, so a blind reader typing gets no feedback that anything
          matched until they arrow into it. */}
      <span aria-live="polite" className="sr-only">
        {query ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : ""}
      </span>
      {!query && (
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          /
        </kbd>
      )}
      {hits.length > 0 && (
        <ul
          ref={listRef}
          id="docs-search-results"
          className="absolute z-40 mt-1 max-h-80 w-full overflow-y-auto rounded-xl border border-border/60 bg-background p-1 shadow-lg"
        >
          {hits.map((hit, i) => (
            <li key={`${hit.route}${hit.hash ?? ""}`}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(hit)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left",
                  i === active ? "bg-primary/15" : "hover:bg-primary/10",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-foreground">{hit.label}</span>
                  {hit.hash && (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {hit.page}
                    </span>
                  )}
                </span>
                {i === active && (
                  <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Empty searches are deliberately NOT logged anywhere. This is a
          self-hosted product with no telemetry pipeline, and a search box is
          exactly where someone types customer names and internal project
          words — the value of knowing what missed is not worth creating a
          file of what people looked for. The gap it would close is covered
          mechanically instead: the index is generated from the pages, and
          check:docs fails when it is stale. */}
      {query && hits.length === 0 && (
        <p className="absolute z-40 mt-1 w-full rounded-xl border border-border/60 bg-background p-3 text-[13px] text-muted-foreground shadow-lg">
          Nothing matches “{query}”.
        </p>
      )}
    </div>
  );
}
