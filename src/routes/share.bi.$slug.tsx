// Public, read-only view of a published BI dashboard at /share/bi/<slug>.
// No sign-in required: the dashboard is fetched server-side by its
// unguessable slug (only if published) and rendered from stored snapshots.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { BarChart3, Clock } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { BiFilterBar } from "@/components/bi/BiFilterBar";
import { BiWidgetCard } from "@/components/bi/BiWidgetCard";
import { DashboardGrid } from "@/components/bi/DashboardGrid";
import {
  dashSurfaceStyle,
  defaultFilterState,
  filterWidgetRows,
  parseDashTheme,
  parseFilters,
  parseLayout,
  parseWidgets,
  type BiCrossFilter,
  type BiFilterState,
} from "@/lib/biDashboards";
import { biGetPublicDashboard, type PublicDashboard } from "@/utils/bi.functions";

export const Route = createFileRoute("/share/bi/$slug")({
  head: () => ({
    meta: [{ title: "Shared dashboard — AgentSwarms" }],
  }),
  // ?embed=1 renders a chrome-less grid for <iframe> embedding.
  validateSearch: (s: Record<string, unknown>) => ({
    embed: s.embed === "1" || s.embed === 1 || s.embed === true ? ("1" as const) : undefined,
  }),
  component: PublicBiDashboardPage,
});

function PublicBiDashboardPage() {
  const { slug } = Route.useParams();
  const { embed } = Route.useSearch();
  const isEmbed = embed === "1";
  const fetchFn = useServerFn(biGetPublicDashboard);
  const [dashboard, setDashboard] = useState<PublicDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterState, setFilterState] = useState<BiFilterState>({});
  const [cross, setCross] = useState<BiCrossFilter>(null);

  useEffect(() => {
    fetchFn({ data: { slug } }).then((res) => {
      if (res.ok) {
        setDashboard(res.dashboard);
        // Apply the owner's saved filter defaults (presets resolve to today).
        setFilterState(defaultFilterState(parseFilters(res.dashboard.filters)));
      } else setError(res.error);
    });
  }, [slug, fetchFn]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-8 text-center">
        <BarChart3 className="h-10 w-10 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Dashboard unavailable</h1>
        <p className="max-w-md text-sm text-muted-foreground">{error}</p>
        <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
          Go to AgentSwarms
        </Link>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="mx-auto min-h-screen max-w-6xl space-y-4 bg-background p-6">
        <Skeleton className="h-10 w-80" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  const theme = parseDashTheme(dashboard.theme);
  const widgets = parseWidgets(dashboard.widgets);
  const layout = parseLayout(dashboard.layout, widgets);
  const filterConfigs = parseFilters(dashboard.filters);
  const widgetById = new Map(
    widgets.map((w) => [
      w.id,
      w.kind === "chart" && (w.rows?.length ?? 0) > 0
        ? { ...w, rows: filterWidgetRows(w, filterConfigs, filterState, cross) }
        : w,
    ]),
  );

  return (
    <div className={isEmbed ? "min-h-screen bg-background" : "min-h-screen bg-muted/30"}>
      {!isEmbed && (
        <header className="border-b border-border bg-background px-6 py-5">
          <div className="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-3">
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-primary">
                <BarChart3 className="h-3 w-3" /> AgentSwarms BI
              </p>
              <h1 className="text-3xl font-bold tracking-tight">{dashboard.name}</h1>
              {dashboard.description && (
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                  {dashboard.description}
                </p>
              )}
            </div>
            <p className="flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              Data as of {new Date(dashboard.updated_at).toLocaleString()}
            </p>
          </div>
        </header>
      )}

      <main
        className={isEmbed ? "p-3" : "mx-auto max-w-7xl p-6"}
        style={{
          ...(isEmbed || theme.bg
            ? {}
            : {
                backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
                backgroundSize: "22px 22px",
              }),
          ...dashSurfaceStyle(theme),
        }}
      >
        <BiFilterBar
          configs={filterConfigs}
          widgets={widgets}
          state={filterState}
          onStateChange={setFilterState}
          cross={cross}
          onClearCross={() => setCross(null)}
        />
        <DashboardGrid
          layout={layout}
          editable={false}
          emptyState={
            <p className="py-20 text-center text-sm text-muted-foreground">
              This dashboard has no widgets yet.
            </p>
          }
          renderItem={(id) => {
            const w = widgetById.get(id);
            return w ? (
              <BiWidgetCard
                widget={w}
                onElementClick={(column, value) =>
                  setCross((prev) =>
                    prev && prev.column === column && prev.value === value
                      ? null
                      : { widgetId: id, column, value },
                  )
                }
              />
            ) : null;
          }}
        />
      </main>

      {!isEmbed && (
        <footer className="border-t border-border/50 bg-background px-6 py-5 text-center text-xs text-muted-foreground">
          Built with{" "}
          <Link to="/" className="font-medium text-primary underline-offset-4 hover:underline">
            AgentSwarms
          </Link>{" "}
          — the self-hosted agentic AI platform
        </footer>
      )}
    </div>
  );
}
