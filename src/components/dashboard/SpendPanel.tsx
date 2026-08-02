// Spend, scoped to a person / their teams / the organisation, over a window.
//
// The dashboard's other numbers come straight from the browser under the
// caller's JWT, which RLS scopes to their own rows. That cannot answer "what
// did my team cost", so this panel is backed by a server function that
// authorises the scope before widening anything — see utils/dashboard.functions.
//
// The scope picker offers only what the SERVER says this caller may ask for.
// Rendering "Whole organisation" to someone who will be refused is a worse
// experience than not offering it, and quietly downgrading them to their own
// numbers under an org label would be a lie.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Users } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { dashboardOverview, type DashboardOverview } from "@/utils/dashboard.functions";
import {
  DASHBOARD_RANGES,
  RANGE_LABELS,
  SCOPE_LABELS,
  type DashboardRange,
  type DashboardScope,
} from "@/utils/dashboard/scope";

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "$0.00");

const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n);

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <span className="block h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
    </span>
  );
}

function Breakdown({
  title,
  rows,
  note,
}: {
  title: string;
  rows: DashboardOverview["byUser"];
  note?: string;
}) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.cost_usd), 0);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h4>
        {note && <span className="text-[10px] text-muted-foreground">{note}</span>}
      </div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate text-foreground" title={r.label}>
                {r.label}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {usd(r.cost_usd)} · {compact(r.runs)} runs
              </span>
            </div>
            <Bar value={r.cost_usd} max={max} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SpendPanel({ className }: { className?: string }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const fetchOverview = useServerFn(dashboardOverview);

  const [scope, setScope] = useState<DashboardScope>("mine");
  const [range, setRange] = useState<DashboardRange>("30d");
  const [data, setData] = useState<DashboardOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (nextScope: DashboardScope, nextRange: DashboardRange) => {
      if (!token) return;
      setLoading(true);
      setError(null);
      try {
        const res = (await fetchOverview({
          data: { access_token: token, scope: nextScope, range: nextRange },
        })) as DashboardOverview;
        setData(res);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [token, fetchOverview],
  );

  useEffect(() => {
    void load(scope, range);
  }, [load, scope, range]);

  // Only scopes the server confirmed. Before the first response we show just
  // "mine", which every caller has.
  const available = data?.available ?? (["mine"] as DashboardScope[]);

  return (
    <Card className={cn("p-6", className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Users className="h-4 w-4 text-primary" /> Spend &amp; usage
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Model cost attributed to people and teams.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={scope} onValueChange={(v) => setScope(v as DashboardScope)}>
            <SelectTrigger className="h-8 w-[168px] text-xs" aria-label="Scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {available.map((s) => (
                <SelectItem key={s} value={s} className="text-xs">
                  {SCOPE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={range} onValueChange={(v) => setRange(v as DashboardRange)}>
            <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Time range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DASHBOARD_RANGES.map((rg) => (
                <SelectItem key={rg} value={rg} className="text-xs">
                  {RANGE_LABELS[rg]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex-1">
            <p>{error}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 text-[11px]"
              onClick={() => setScope("mine")}
            >
              Show just me
            </Button>
          </div>
        </div>
      ) : loading && !data ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : !data || data.totals.runs === 0 ? (
        <p className="py-6 text-xs text-muted-foreground">
          No model calls in this window. Widen the range, or run an agent.
        </p>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Cost", value: usd(data.totals.cost_usd) },
              { label: "Runs", value: compact(data.totals.runs) },
              { label: "Tokens", value: compact(data.totals.tokens) },
              {
                label: "Success",
                // null means "no runs to judge" — distinct from 0%.
                value:
                  data.totals.successRate === null
                    ? "—"
                    : `${Math.round(data.totals.successRate)}%`,
              },
            ].map((s) => (
              <div key={s.label} className="rounded-lg bg-muted/40 p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {s.label}
                </div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
                  {s.value}
                </div>
              </div>
            ))}
          </div>

          <Breakdown
            title="By team"
            rows={data.byGroup}
            note="someone in two teams counts in both"
          />
          <Breakdown title="By person" rows={data.byUser} />

          {data.topModels.length > 0 && (
            <Breakdown
              title="By model"
              rows={data.topModels.map((m) => ({
                id: m.model,
                label: m.model,
                runs: m.runs,
                cost_usd: m.cost_usd,
                tokens: 0,
              }))}
            />
          )}
        </div>
      )}
    </Card>
  );
}
