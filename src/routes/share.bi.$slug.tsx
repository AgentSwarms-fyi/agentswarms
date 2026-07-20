// Public, read-only view of a published BI dashboard at /share/bi/<slug>.
// No sign-in required: the dashboard is fetched server-side by its
// unguessable slug (only if published) and rendered from stored snapshots.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { BarChart3, Clock } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { BiWidgetCard } from "@/components/bi/BiWidgetCard";
import { DashboardGrid } from "@/components/bi/DashboardGrid";
import { parseLayout, parseWidgets } from "@/lib/biDashboards";
import { biGetPublicDashboard, type PublicDashboard } from "@/utils/bi.functions";

export const Route = createFileRoute("/share/bi/$slug")({
  head: () => ({
    meta: [{ title: "Shared dashboard — AgentSwarms" }],
  }),
  component: PublicBiDashboardPage,
});

function PublicBiDashboardPage() {
  const { slug } = Route.useParams();
  const fetchFn = useServerFn(biGetPublicDashboard);
  const [dashboard, setDashboard] = useState<PublicDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchFn({ data: { slug } }).then((res) => {
      if (res.ok) setDashboard(res.dashboard);
      else setError(res.error);
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

  const widgets = parseWidgets(dashboard.widgets);
  const layout = parseLayout(dashboard.layout, widgets);
  const widgetById = new Map(widgets.map((w) => [w.id, w]));

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b border-border bg-background px-6 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{dashboard.name}</h1>
            {dashboard.description && (
              <p className="mt-0.5 text-sm text-muted-foreground">{dashboard.description}</p>
            )}
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            Data as of {new Date(dashboard.updated_at).toLocaleString()}
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-6">
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
            return w ? <BiWidgetCard widget={w} /> : null;
          }}
        />
      </main>

      <footer className="px-6 pb-8 text-center text-xs text-muted-foreground">
        Built with{" "}
        <Link to="/" className="font-medium text-primary underline-offset-4 hover:underline">
          AgentSwarms
        </Link>{" "}
        — the self-hosted agentic AI platform
      </footer>
    </div>
  );
}
