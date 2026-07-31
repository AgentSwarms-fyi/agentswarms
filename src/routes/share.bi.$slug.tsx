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
  parsePages,
  parseWidgets,
  type BiCrossFilter,
  type BiFilterState,
} from "@/lib/biDashboards";
import { dashboardFreshness } from "@/lib/biFreshness";
import { cn } from "@/lib/utils";
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
  const [activePageIndex, setActivePageIndex] = useState(0);

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
  const filterConfigs = parseFilters(dashboard.filters);
  // Multi-page: render one page at a time; pages come from `pages`, falling
  // back to the legacy top-level widgets/layout for pre-migration dashboards.
  const topWidgets = parseWidgets(dashboard.widgets);
  const pages = parsePages(dashboard.pages, topWidgets, parseLayout(dashboard.layout, topWidgets));
  const activePage = pages[Math.min(activePageIndex, pages.length - 1)] ?? pages[0];
  const widgets = activePage.widgets;
  const layout = activePage.layout;
  const widgetById = new Map(
    widgets.map((w) => [
      w.id,
      w.kind === "chart" && (w.rows?.length ?? 0) > 0
        ? { ...w, rows: filterWidgetRows(w, filterConfigs, filterState, cross) }
        : w,
    ]),
  );

  // Freshness is computed from EVERY widget on the dashboard, not just the
  // active page — a viewer switching pages shouldn't see the claim change.
  const freshness = dashboardFreshness(pages.flatMap((p) => p.widgets));

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
            {/* The DATA's age, not the document's. This used to read
                `updated_at`, which changes when someone renames a tile — so a
                dashboard whose numbers were months old could claim to be
                current. The oldest widget decides: a dashboard is only as
                fresh as its stalest tile. */}
            <p
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs",
                freshness?.stale
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : "border-border/60 bg-muted/50 text-muted-foreground",
              )}
              title={freshness ? `Oldest widget refreshed ${freshness.absolute}` : undefined}
            >
              <Clock className="h-3 w-3" />
              {freshness ? `Data as of ${freshness.relative}` : "Data not refreshed yet"}
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
        {pages.length > 1 && (
          <div className="mb-3 flex items-center gap-1 overflow-x-auto pb-1">
            {pages.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setActivePageIndex(i);
                  setCross(null);
                }}
                className={cn(
                  "h-8 shrink-0 rounded-md px-3 text-xs",
                  i === activePageIndex
                    ? "border border-border bg-background font-medium shadow-sm"
                    : "text-muted-foreground hover:bg-background/60",
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
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
