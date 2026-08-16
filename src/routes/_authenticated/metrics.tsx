// /metrics — the metric catalog.
//
// A semantic layer earns its keep when someone hunting for "revenue" can find
// the one everybody else uses and tell, in one glance, whether to trust it.
// That is this page: search across names, labels, descriptions and SYNONYMS,
// then per metric the three signals that actually decide the question —
// certification, freshness, and where it is already in use.
//
// Each signal is worded as what it really covers. Certification belongs to the
// MODEL. Freshness is when the DATA loaded, not when the metric ran, because a
// metric is a definition and is not computed until asked. Usage is evidence of
// use and never proof of disuse, so the page never prints "unused" — it names
// what was searched, because deprecating a metric on the strength of an
// incomplete scan is the expensive mistake here.
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, Layers, Search, Sigma, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { selectAllPages, type PagedResult } from "@/lib/pagedSelect";
import {
  catalogSummary,
  dataFreshness,
  describeCertification,
  describeFreshness,
  describeUsage,
  flattenMetrics,
  matchesQuery,
  metricUsageInDashboards,
  qualifiedName,
  type SemanticModelRow,
} from "@/lib/metricsCatalog";

export const Route = createFileRoute("/_authenticated/metrics")({
  component: MetricsPage,
  head: () => ({ meta: [{ title: "Metrics — AgentSwarms" }] }),
});

type DashboardRow = { id: string; name: string; widgets: unknown };
type TableRow = { name: string; data_loaded_at: string | null };

function MetricsPage() {
  const { user } = useAuth();
  const [models, setModels] = useState<SemanticModelRow[] | null>(null);
  const [dashboards, setDashboards] = useState<DashboardRow[]>([]);
  const [tables, setTables] = useState<TableRow[]>([]);
  const [query, setQuery] = useState("");
  /** The dashboard read hit its row ceiling, so "no references" is not a fact. */
  const [scanTruncated, setScanTruncated] = useState(false);

  const load = useCallback(async () => {
    if (!user?.id) return;
    // RLS returns the caller's models plus any shared with them, which is
    // exactly the set they may legitimately build on.
    //
    // PAGED, not a bare select. PostgREST caps one response at 1000 rows
    // silently (see lib/pagedSelect), and this page's whole promise is that a
    // usage scan is honest about its own reach. Truncation only ever REMOVES
    // references, never adds them, so a capped read pushes every metric toward
    // "no dashboard widget references it" — the one direction that gets a
    // metric deprecated, which the file header names as the expensive mistake.
    let m: PagedResult<SemanticModelRow>;
    let d: PagedResult<DashboardRow>;
    let t: PagedResult<TableRow>;
    try {
      [m, d, t] = await Promise.all([
        selectAllPages<SemanticModelRow>(() =>
          supabase.from("semantic_models").select("*").order("name"),
        ),
        selectAllPages<DashboardRow>(() =>
          supabase.from("bi_dashboards").select("id, name, widgets").order("id"),
        ),
        selectAllPages<TableRow>(() =>
          supabase.from("user_data_tables").select("name, data_loaded_at").order("name"),
        ),
      ]);
    } catch (e) {
      // A read that FAILED is not an empty semantic layer. Reporting it, and
      // leaving models as [] only after saying so, is what stops the page
      // rendering "No governed metrics yet" over a network error.
      toast.error(e instanceof Error ? e.message : "Could not read the semantic layer");
      setModels([]);
      return;
    }
    setModels(m.rows);
    setDashboards(d.rows);
    setTables(t.rows);
    // If the ceiling stopped the read, the usage scan is genuinely incomplete
    // and must say so rather than report a clean "no references".
    setScanTruncated(d.truncated);
  }, [user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics = useMemo(() => flattenMetrics(models ?? []), [models]);
  const shown = useMemo(() => metrics.filter((m) => matchesQuery(m, query)), [metrics, query]);
  const summary = useMemo(() => catalogSummary(metrics), [metrics]);
  const now = Date.now();

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Sigma className="h-5 w-5" /> Metrics
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every governed metric you can use, and how far to trust each one.
        </p>
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search names, descriptions and synonyms…"
              className="h-8 pl-7 text-xs"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {models === null
              ? "Loading…"
              : `${summary.total} metric${summary.total === 1 ? "" : "s"} in ${summary.models} model${
                  summary.models === 1 ? "" : "s"
                } · ${summary.certified} certified · ${summary.draft} draft · ${summary.deprecated} deprecated`}
          </p>
        </div>
      </Card>

      {models === null ? (
        <p className="text-sm text-muted-foreground">Reading the semantic layer…</p>
      ) : metrics.length === 0 ? (
        <Card className="p-8 text-center">
          <Layers className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="text-sm font-medium">No governed metrics yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
            Define metrics on a semantic model and they appear here — with their certification, the
            freshness of the data behind them, and where they are already used.
          </p>
        </Card>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing matches “{query}”. Synonyms are searched too, so a metric with no match here
          genuinely has none of these words.
        </p>
      ) : (
        <div className="space-y-2">
          {shown.map((m) => {
            const usage = metricUsageInDashboards(dashboards, m.model, m.name);
            const fresh = describeFreshness(dataFreshness(m.model, models, tables), now);
            return (
              <Card key={`${m.model}.${m.name}`} className="p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {m.label || m.name}
                      {/* One source of truth for this string: it is both what
                          the card publishes and what the search must match. */}
                      <code className="rounded bg-muted px-1 font-mono text-[10px] font-normal text-muted-foreground">
                        {qualifiedName(m)}
                      </code>
                      {m.status === "certified" && (
                        <BadgeCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      )}
                      {m.status === "deprecated" && (
                        <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />
                      )}
                    </p>
                    {m.description && (
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {m.description}
                      </p>
                    )}
                    {m.formula && (
                      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                        {m.formula}
                      </p>
                    )}
                    {m.synonyms.length > 0 && (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        also called {m.synonyms.join(", ")}
                      </p>
                    )}
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[9px] uppercase">
                    {m.agg}
                  </Badge>
                </div>

                {/* The three signals, each worded as what it actually covers. */}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                  <span>{describeCertification(m.status)}</span>
                  <span>
                    {/* null freshness is UNKNOWN, and must not read as "never". */}
                    {fresh ? `Data loaded ${fresh}` : "Data freshness unknown for this source"}
                  </span>
                  <span className={scanTruncated ? "text-amber-600 dark:text-amber-400" : ""}>
                    {describeUsage(usage, scanTruncated)}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
