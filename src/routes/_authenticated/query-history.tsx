// Query history: every query run for you, and what it cost (R531).
//
// Read from public.query_log, which the server alone writes where every query
// passes (src/utils/queryLog/record.server.ts). Totals come from
// query_log_summary, the list from the table itself; both are the caller's
// own rows under RLS.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Copy, ExternalLink, Search, X } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { agoLabel } from "@/lib/agoLabel";
import {
  engineLabel,
  formatBytes,
  formatMs,
  formatUsd,
  viaLabel,
  workbenchSourceFor,
} from "@/lib/queryLog";
import { reportFailure } from "@/lib/silentFailureNet";
import { cn } from "@/lib/utils";

const PERIODS = {
  day: { label: "Last 24 hours", ms: 86_400_000 },
  week: { label: "Last 7 days", ms: 7 * 86_400_000 },
  month: { label: "Last 30 days", ms: 30 * 86_400_000 },
  quarter: { label: "Last 90 days", ms: 90 * 86_400_000 },
} as const;
type Period = keyof typeof PERIODS;

const SORTS = {
  newest: "Newest first",
  cost: "Most expensive",
  slowest: "Slowest",
  scanned: "Most data read",
} as const;
type Sort = keyof typeof SORTS;

type Search = {
  period?: Period;
  via?: string;
  engine?: string;
  failed?: 1;
  q?: string;
  sort?: Sort;
};

export const Route = createFileRoute("/_authenticated/query-history")({
  component: QueryHistoryPage,
  head: () => ({ meta: [{ title: "Query history — AgentSwarms" }] }),
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {};
    if (typeof s.period === "string" && s.period in PERIODS) out.period = s.period as Period;
    if (typeof s.via === "string" && /^[a-z_]{1,24}$/.test(s.via)) out.via = s.via;
    if (typeof s.engine === "string" && /^[a-z0-9_]{1,32}$/.test(s.engine)) out.engine = s.engine;
    if (s.failed === 1 || s.failed === "1") out.failed = 1;
    if (typeof s.q === "string" && s.q.trim()) out.q = s.q.slice(0, 200);
    if (typeof s.sort === "string" && s.sort in SORTS) out.sort = s.sort as Sort;
    return out;
  },
});

type Row = {
  id: string;
  created_at: string;
  via: string;
  engine: string;
  connection_id: string | null;
  connection_name: string | null;
  sql: string;
  status: string;
  error: string | null;
  row_count: number | null;
  duration_ms: number | null;
  bytes_scanned: number | null;
  engine_query_id: string | null;
  cost_usd: number | null;
  cost_basis: string | null;
  ai_cost_usd: number | null;
  actor_user_id: string | null;
};

type Group = {
  via: string;
  engine: string;
  queries: number;
  failed: number;
  bytes_scanned: number;
  cost_usd: number;
  ai_cost_usd: number;
  duration_ms: number;
};

const COLUMNS =
  "id, created_at, via, engine, connection_id, connection_name, sql, status, error, row_count, duration_ms, bytes_scanned, engine_query_id, cost_usd, cost_basis, ai_cost_usd, actor_user_id";
const PAGE = 100;

/** A search term as an ILIKE pattern that matches it literally. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function QueryHistoryPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/query-history" });
  const { user } = useAuth();
  const period: Period = search.period ?? "week";
  const sort: Sort = search.sort ?? "newest";
  const [query, setQuery] = useState(search.q ?? "");
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failedToLoad, setFailedToLoad] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const set = useCallback(
    (patch: Partial<Search>) =>
      void navigate({ search: (prev: Search) => ({ ...prev, ...patch }), replace: true }),
    [navigate],
  );

  // Typing updates the address once it settles.
  useEffect(() => {
    const t = setTimeout(() => {
      const q = query.trim() || undefined;
      if (q !== search.q) set({ q });
    }, 300);
    return () => clearTimeout(t);
  }, [query, search.q, set]);

  const since = useMemo(
    () => new Date(Date.now() - PERIODS[period].ms).toISOString(),
    // A new period, or a reload, moves the window; a re-render does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [period, user?.id],
  );

  const listQuery = useCallback(
    (from: number) => {
      let q = supabase
        .from("query_log")
        .select(COLUMNS)
        .eq("user_id", user?.id ?? "")
        .gte("created_at", since);
      if (search.via) q = q.eq("via", search.via);
      if (search.engine) q = q.eq("engine", search.engine);
      if (search.failed) q = q.eq("status", "error");
      if (search.q) q = q.ilike("sql", likePattern(search.q));
      if (sort === "cost") {
        q = q
          .order("cost_usd", { ascending: false, nullsFirst: false })
          .order("ai_cost_usd", { ascending: false, nullsFirst: false });
      } else if (sort === "slowest") {
        q = q.order("duration_ms", { ascending: false, nullsFirst: false });
      } else if (sort === "scanned") {
        q = q.order("bytes_scanned", { ascending: false, nullsFirst: false });
      }
      return q.order("created_at", { ascending: false }).range(from, from + PAGE - 1);
    },
    [user?.id, since, search.via, search.engine, search.failed, search.q, sort],
  );

  useEffect(() => {
    if (!user?.id) return;
    let live = true;
    setRows(null);
    setOpen(null);
    setFailedToLoad(null);
    Promise.all([supabase.rpc("query_log_summary", { p_since: since }), listQuery(0)])
      .then(([sum, list]) => {
        if (!live) return;
        const err = sum.error ?? list.error;
        if (err) {
          // Before the migration the table is not there; say what to do.
          setFailedToLoad(
            /query_log|schema cache|does not exist/i.test(err.message)
              ? "Query history needs a database update first (migration 20261127000000). Every other page works as before."
              : err.message,
          );
          setGroups([]);
          setRows([]);
          return;
        }
        setGroups((sum.data ?? []) as Group[]);
        setRows((list.data ?? []) as Row[]);
        setMore((list.data ?? []).length === PAGE);
      })
      .catch((e) => {
        if (!live) return;
        reportFailure("load your query history", e);
        setRows([]);
        setGroups([]);
      });
    return () => {
      live = false;
    };
  }, [user?.id, since, listQuery]);

  const loadMore = async () => {
    if (!rows) return;
    setLoadingMore(true);
    try {
      const { data, error } = await listQuery(rows.length);
      if (error) throw error;
      setRows([...rows, ...((data ?? []) as Row[])]);
      setMore((data ?? []).length === PAGE);
    } catch (e) {
      reportFailure("load more of your query history", e);
    } finally {
      setLoadingMore(false);
    }
  };

  // Totals for the period, narrowed by what the source and engine filters
  // keep. Failed and the search narrow the list only: they are about which
  // queries to look at, not what the period cost.
  const shownGroups = useMemo(
    () =>
      (groups ?? []).filter(
        (g) =>
          (!search.via || g.via === search.via) && (!search.engine || g.engine === search.engine),
      ),
    [groups, search.via, search.engine],
  );
  const totals = useMemo(() => {
    const t = { queries: 0, failed: 0, bytes: 0, cost: 0, ai: 0, ms: 0 };
    for (const g of shownGroups) {
      t.queries += Number(g.queries);
      t.failed += Number(g.failed);
      t.bytes += Number(g.bytes_scanned);
      t.cost += Number(g.cost_usd);
      t.ai += Number(g.ai_cost_usd);
      t.ms += Number(g.duration_ms);
    }
    return t;
  }, [shownGroups]);
  const vias = useMemo(() => countBy(groups ?? [], "via"), [groups]);
  const engines = useMemo(() => countBy(groups ?? [], "engine"), [groups]);

  const openInWorkbench = (row: Row) => {
    const source = workbenchSourceFor(row);
    if (source === null) return;
    void navigate({
      to: "/data-sql",
      state: { workbenchDraft: { sql: row.sql, source } },
    } as never);
  };

  const copySql = (row: Row) =>
    navigator.clipboard
      .writeText(row.sql)
      .then(() => toast.success("SQL copied"))
      .catch((e) => reportFailure("copy the SQL", e));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Query history"
        description="Every query run for you: in the workbench, and by dashboards, agents, schedules and checks. What each took, and what it cost where the engine says."
      />

      {/* Unread is not empty: zeros and "no queries" under this message would
          say nothing ran (seen in the R531 browser test). */}
      {failedToLoad ? (
        <p className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {failedToLoad}
        </p>
      ) : (
        renderBody()
      )}
    </div>
  );

  // A call, not a component: a component declared in here would be a new
  // type on every render, and remount the search box under each keystroke.
  function renderBody() {
    return (
      <>
        <section
          aria-label="Totals for the period"
          className="grid grid-cols-2 divide-y rounded-xl border bg-card sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6 lg:divide-x"
        >
          <Stat label="Queries" value={groups ? totals.queries.toLocaleString() : null} />
          <Stat
            label="Failed"
            value={groups ? totals.failed.toLocaleString() : null}
            tone={totals.failed > 0 ? "warn" : undefined}
          />
          {/* Only some engines say what they read; none saying is not "0 B". */}
          <Stat
            label="Data read"
            hint="What the engines that report it said they read"
            value={groups ? (totals.bytes > 0 ? formatBytes(totals.bytes) : "—") : null}
          />
          <Stat
            label="Warehouse cost"
            hint="Estimated at list price, for engines that charge by data read"
            value={groups ? formatUsd(totals.cost) : null}
          />
          <Stat
            label="AI in SQL"
            hint="Model calls made by ai_* SQL functions"
            value={groups ? formatUsd(totals.ai) : null}
          />
          <Stat label="Time running" value={groups ? formatMs(totals.ms) : null} />
        </section>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={period} onValueChange={(v) => set({ period: v as Period })}>
            <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PERIODS).map(([k, p]) => (
                <SelectItem key={k} value={k} className="text-xs">
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.via ?? "all"}
            onValueChange={(v) => set({ via: v === "all" ? undefined : v })}
          >
            <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="What it was for">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                Every source
              </SelectItem>
              {vias.map(([v, n]) => (
                <SelectItem key={v} value={v} className="text-xs">
                  {viaLabel(v)} · {n.toLocaleString()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.engine ?? "all"}
            onValueChange={(v) => set({ engine: v === "all" ? undefined : v })}
          >
            <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Engine">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                Every engine
              </SelectItem>
              {engines.map(([e, n]) => (
                <SelectItem key={e} value={e} className="text-xs">
                  {engineLabel(e)} · {n.toLocaleString()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sort}
            onValueChange={(v) => set({ sort: v === "newest" ? undefined : (v as Sort) })}
          >
            <SelectTrigger className="h-8 w-[160px] text-xs" aria-label="Order">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SORTS).map(([k, label]) => (
                <SelectItem key={k} value={k} className="text-xs">
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant={search.failed ? "secondary" : "ghost"}
            className="h-8 text-xs"
            aria-pressed={Boolean(search.failed)}
            onClick={() => set({ failed: search.failed ? undefined : 1 })}
          >
            Failed only
          </Button>
          <div className="relative ml-auto w-full sm:w-64">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the SQL"
              aria-label="Search the SQL"
              className="h-8 pl-8 text-xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear the search"
                title="Clear the search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {rows === null ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
            {search.via || search.engine || search.failed || search.q
              ? "No query matches these filters in this period."
              : "No queries in this period. Queries you run, and those run for you, appear here as they happen."}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">For</th>
                  {/* The SQL takes what the figures leave (R531: it was squeezed to "SEL…"). */}
                  <th className="w-full px-3 py-2 font-medium">SQL</th>
                  <th className="px-3 py-2 text-right font-medium">Rows</th>
                  <th className="px-3 py-2 text-right font-medium">Time</th>
                  <th className="px-3 py-2 text-right font-medium">Read</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isOpen = open === r.id;
                  const cost = costOf(r);
                  return (
                    <QueryRow
                      key={r.id}
                      row={r}
                      open={isOpen}
                      cost={cost}
                      onToggle={() => setOpen(isOpen ? null : r.id)}
                      onCopy={() => void copySql(r)}
                      onOpen={workbenchSourceFor(r) === null ? null : () => openInWorkbench(r)}
                    />
                  );
                })}
              </tbody>
            </table>
            {more && (
              <div className="border-t p-2 text-center">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Show more"}
                </Button>
              </div>
            )}
          </div>
        )}
      </>
    );
  }
}

/** Warehouse estimate and model calls together, or null when neither is known. */
function costOf(r: Row): number | null {
  if (r.cost_usd === null && r.ai_cost_usd === null) return null;
  return Number(r.cost_usd ?? 0) + Number(r.ai_cost_usd ?? 0);
}

function countBy(groups: Group[], key: "via" | "engine"): [string, number][] {
  const m = new Map<string, number>();
  for (const g of groups) m.set(g[key], (m.get(g[key]) ?? 0) + Number(g.queries));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | null;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <div className="px-4 py-3" title={hint}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {value === null ? (
        <Skeleton className="mt-1.5 h-6 w-16" />
      ) : (
        <p
          className={cn(
            "mt-1 text-lg font-semibold tabular-nums text-foreground",
            tone === "warn" && "text-amber-700 dark:text-amber-300",
          )}
        >
          {value}
        </p>
      )}
    </div>
  );
}

function QueryRow({
  row: r,
  open,
  cost,
  onToggle,
  onCopy,
  onOpen,
}: {
  row: Row;
  open: boolean;
  cost: number | null;
  onToggle: () => void;
  onCopy: () => void;
  onOpen: (() => void) | null;
}) {
  const failed = r.status === "error";
  const where = r.connection_name
    ? `${engineLabel(r.engine)} · ${r.connection_name}`
    : engineLabel(r.engine);
  return (
    <>
      <tr className={cn("border-b align-top last:border-b-0", open && "bg-muted/30")}>
        <td
          className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground"
          title={new Date(r.created_at).toLocaleString()}
        >
          {agoLabel(r.created_at)}
        </td>
        <td className="px-3 py-2">
          <p className="whitespace-nowrap text-xs font-medium text-foreground">{viaLabel(r.via)}</p>
          <p className="max-w-[180px] truncate text-[11px] text-muted-foreground" title={where}>
            {where}
          </p>
        </td>
        <td className="max-w-0 px-3 py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex w-full min-w-0 items-start gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {open ? (
              <ChevronDown
                aria-hidden
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
            ) : (
              <ChevronRight
                aria-hidden
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
            )}
            <span className="min-w-0">
              <span className="block truncate font-mono text-xs text-foreground">
                {r.sql.replace(/\s+/g, " ").trim()}
              </span>
              {failed && (
                <span className="block truncate text-[11px] text-amber-700 dark:text-amber-300">
                  {r.error ?? "Failed"}
                </span>
              )}
            </span>
          </button>
        </td>
        <Num>{r.row_count === null ? "—" : r.row_count.toLocaleString()}</Num>
        <Num>{formatMs(r.duration_ms)}</Num>
        <Num>{formatBytes(r.bytes_scanned)}</Num>
        <Num>{formatUsd(cost)}</Num>
      </tr>
      {open && (
        <tr className="border-b bg-muted/30 last:border-b-0">
          <td colSpan={7} className="px-3 pb-3 pt-0">
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground">
              {r.sql}
            </pre>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
              {failed && r.error && <Detail term="Error">{r.error}</Detail>}
              {r.cost_usd !== null && (
                <Detail term="Warehouse cost">
                  {formatUsd(Number(r.cost_usd))}
                  {r.cost_basis ? ` (estimated: ${r.cost_basis})` : ""}
                </Detail>
              )}
              {r.ai_cost_usd !== null && (
                <Detail term="AI in SQL">{formatUsd(Number(r.ai_cost_usd))}</Detail>
              )}
              {r.engine_query_id && <Detail term="Engine's query id">{r.engine_query_id}</Detail>}
              {r.actor_user_id && (
                <Detail term="Started by">someone you share this with, on your connection</Detail>
              )}
            </dl>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCopy}>
                <Copy aria-hidden className="mr-1.5 h-3.5 w-3.5" />
                Copy SQL
              </Button>
              {onOpen && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onOpen}>
                  <ExternalLink aria-hidden className="mr-1.5 h-3.5 w-3.5" />
                  Open in workbench
                </Button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Num({ children }: { children: ReactNode }) {
  return (
    <td className="whitespace-nowrap px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
      {children}
    </td>
  );
}

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 font-medium text-foreground">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
