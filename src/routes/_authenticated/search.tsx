// Search results: everything of yours that matches, by kind.
//
// The palette (Ctrl/⌘-K) lists the closest few; this page is where "see all"
// lands, and it is a page so a search can be linked, bookmarked and reloaded.
// With nothing typed it is an overview of what you have: one tile per kind,
// and choosing a kind lists it newest first.
import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2, RefreshCw, Search as SearchIcon, X } from "lucide-react";

import { agoLabel, IconTile, ObjectText } from "@/components/search/parts";
import { Button } from "@/components/ui/button";
import { useCappedMatches, useObjectIndex } from "@/hooks/use-object-index";
import {
  isObjectKindId,
  linkToObject,
  OBJECT_KINDS,
  objectKind,
  type ObjectEntry,
  type ObjectKindId,
} from "@/lib/objectKinds";
import {
  compareRanked,
  countByKind,
  mergeEntries,
  queryTokens,
  rankObjects,
} from "@/lib/objectSearch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/search")({
  component: SearchPage,
  head: () => ({ meta: [{ title: "Search — AgentSwarms" }] }),
  validateSearch: (s: Record<string, unknown>) => {
    const out: { q?: string; kind?: ObjectKindId } = {};
    if (typeof s.q === "string" && s.q.trim()) out.q = s.q.slice(0, 200);
    else if (typeof s.q === "number") out.q = String(s.q);
    if (isObjectKindId(s.kind)) out.kind = s.kind;
    return out;
  },
});

/** How many of a kind are shown before "show all" when every kind is listed. */
const PER_KIND = 5;

function SearchPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/search" });
  const [text, setText] = useState(search.q ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The address is the source of truth for a search arrived at by link or by
  // the back button; typing updates the address a moment after it stops.
  useEffect(() => {
    setText(search.q ?? "");
  }, [search.q]);
  useEffect(() => {
    if (text === (search.q ?? "")) return;
    const timer = setTimeout(() => {
      void navigate({
        search: (prev) => ({ ...prev, q: text.trim() ? text : undefined }),
        replace: true,
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [text, search.q, navigate]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const index = useObjectIndex(true);
  const older = useCappedMatches(text, index.capped);
  const entries = useMemo(() => mergeEntries(index.entries, older), [index.entries, older]);

  const searching = queryTokens(text).length > 0;
  const kind = search.kind;

  // What is listed: matches when something is typed; otherwise everything of
  // the chosen kind, newest first.
  const all = useMemo(() => {
    if (searching) return rankObjects(entries, text);
    return entries.map((e) => ({ ...e, score: 1 })).sort(compareRanked);
  }, [entries, text, searching]);
  const counts = useMemo(() => countByKind(all), [all]);
  const shown = kind ? all.filter((e) => e.kind === kind) : all;
  const kindsWithAny = OBJECT_KINDS.filter((k) => (counts.get(k.id) ?? 0) > 0);

  // Kinds whose names have not arrived yet. The lakehouse is listed through its
  // own engine and can answer well after everything else.
  const stillReading = index.pending.map((k) => objectKind(k).plural.toLowerCase()).join(", ");
  // Something was asked for and nothing is listed: the empty notice is showing.
  const nothingShown = (searching || Boolean(kind)) && shown.length === 0;

  const setKind = (next?: ObjectKindId) =>
    void navigate({ search: (prev) => ({ ...prev, kind: next }), replace: true });

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-6">
      <div>
        <h1 className="text-xl font-semibold">Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find anything you made or that was shared with you, by name.
        </p>
      </div>

      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search your work…"
          aria-label="Search your work"
          className="h-11 w-full rounded-xl border bg-card pl-10 pr-10 text-sm shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-primary/50 focus:ring-2 focus:ring-primary/15 [&::-webkit-search-cancel-button]:hidden"
        />
        {text && (
          <button
            type="button"
            onClick={() => {
              setText("");
              inputRef.current?.focus();
            }}
            aria-label="Clear the search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {(searching || kind) && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Filter by kind"
        >
          <KindChip
            active={!kind}
            onClick={() => setKind(undefined)}
            label="All"
            count={all.length}
          />
          {kindsWithAny.map((k) => (
            <KindChip
              key={k.id}
              active={kind === k.id}
              onClick={() => setKind(kind === k.id ? undefined : k.id)}
              label={k.plural}
              count={counts.get(k.id) ?? 0}
            />
          ))}
        </div>
      )}

      {index.error ? (
        <Notice>
          <p className="font-medium">Search could not load your work.</p>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{index.error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={index.refresh}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
          </Button>
        </Notice>
      ) : index.loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading your work…
        </div>
      ) : !searching && !kind ? (
        <Overview counts={counts} onPick={setKind} />
      ) : shown.length === 0 ? (
        <Notice>
          <p className="font-medium">
            {searching
              ? `Nothing matches “${text.trim()}”`
              : `No ${objectKind(kind!).plural.toLowerCase()} yet`}
            {searching && kind ? ` in ${objectKind(kind).plural.toLowerCase()}` : ""}
            {stillReading ? " so far" : ""}.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {stillReading
              ? `Your ${stillReading} are still being read. They are added here as soon as they arrive.`
              : "Search looks at names and descriptions, not at what is inside. Try fewer words, or part of the name."}
          </p>
        </Notice>
      ) : kind ? (
        <ResultList entries={shown} query={text} />
      ) : (
        <div className="space-y-6">
          {kindsWithAny.map((k) => {
            const ofKind = all.filter((e) => e.kind === k.id);
            return (
              <section key={k.id} aria-label={k.plural}>
                <div className="mb-1.5 flex items-baseline justify-between px-1">
                  <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {k.plural}{" "}
                    <span className="font-normal normal-case tracking-normal">
                      · {ofKind.length}
                    </span>
                  </h2>
                  {ofKind.length > PER_KIND && (
                    <button
                      type="button"
                      onClick={() => setKind(k.id)}
                      className="text-xs text-primary hover:underline"
                    >
                      Show all {ofKind.length}
                    </button>
                  )}
                </div>
                <ResultList entries={ofKind.slice(0, PER_KIND)} query={text} />
              </section>
            );
          })}
        </div>
      )}

      {/* Said once: the empty notice above already says what is still being read. */}
      {stillReading && !index.loading && !index.error && !nothingShown && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-3 w-3 animate-spin" /> Still reading {stillReading}…
        </p>
      )}

      {index.failed.length > 0 && !index.error && (
        <p className="text-xs text-muted-foreground">
          Not searched just now:{" "}
          {index.failed.map((k) => objectKind(k).plural.toLowerCase()).join(", ")}.{" "}
          <button type="button" onClick={index.refresh} className="text-primary hover:underline">
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

function KindChip(props: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition",
        props.active
          ? "border-primary/40 bg-primary/10 font-medium text-foreground"
          : "border-border/70 text-muted-foreground hover:border-primary/30 hover:text-foreground",
      )}
    >
      {props.label}
      <span className="tabular-nums opacity-70">{props.count}</span>
    </button>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border bg-card px-5 py-8 text-sm">{children}</div>;
}

function ResultList({ entries, query }: { entries: ObjectEntry[]; query: string }) {
  return (
    <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border bg-card">
      {entries.map((e) => {
        const link = linkToObject(e);
        return (
          <li key={`${e.kind}:${e.id}`}>
            <Link
              to={link.to as never}
              search={(link.search ?? {}) as never}
              className="flex items-center gap-3 px-3 py-2.5 outline-none transition hover:bg-muted/50 focus-visible:bg-muted/60"
            >
              <IconTile icon={objectKind(e.kind).icon} />
              <ObjectText entry={e} query={query} />
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {agoLabel(e.updatedAt)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** With nothing typed: what you have, one tile per kind. */
function Overview(props: {
  counts: Map<ObjectKindId, number>;
  onPick: (kind: ObjectKindId) => void;
}) {
  const kinds = OBJECT_KINDS.filter((k) => (props.counts.get(k.id) ?? 0) > 0);
  if (!kinds.length) {
    return (
      <Notice>
        <p className="font-medium">Nothing here yet.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          As you make agents, datasets and dashboards, they can all be found from this page and from
          the search box at the top of every page.
        </p>
      </Notice>
    );
  }
  return (
    <div>
      <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Your work
      </h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {kinds.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => props.onPick(k.id)}
            className="flex items-center gap-3 rounded-xl border bg-card px-3 py-3 text-left transition hover:border-primary/40 hover:bg-muted/40"
          >
            <IconTile icon={k.icon} />
            <span className="min-w-0">
              <span className="block truncate text-sm">{k.plural}</span>
              <span className="block text-xs tabular-nums text-muted-foreground">
                {props.counts.get(k.id)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
