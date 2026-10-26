// The connections behind one "credentials you've connected" card (R385).
//
// The rows are read with the registry's own countOps(), so the list is exactly
// what the card counted — the two cannot disagree. Only display columns are
// selected: these tables hold the credentials themselves, and nothing here
// needs them in the browser. Connecting, testing and removing stay on each
// page, which is said rather than implied.
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { countOps, type ApiKeyCategory, type QueryOp } from "@/lib/apiKeyCategories";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ArrowRight, RefreshCw } from "lucide-react";

type Row = Record<string, string | null>;

/** Per table: the columns safe to show, and how a row is named. Never a credential column. */
const DISPLAY: Record<
  string,
  { select: string; title: (r: Row) => string; detail: (r: Row) => string | null }
> = {
  data_warehouse_connections: {
    select: "id, name, provider",
    title: (r) => r.name ?? "Unnamed connection",
    detail: (r) => r.provider,
  },
  catalog_sources: {
    select: "id, name, kind",
    title: (r) => r.name ?? "Unnamed source",
    detail: (r) => r.kind,
  },
  iceberg_catalogs: {
    select: "id, name",
    title: (r) => r.name ?? "Unnamed catalog",
    detail: () => null,
  },
  saas_connections: {
    select: "id, name, provider",
    title: (r) => r.name ?? "Unnamed connector",
    detail: (r) => r.provider,
  },
  slack_workspaces: {
    select: "id, team_name",
    title: (r) => r.team_name ?? "Slack workspace",
    detail: () => "Slack",
  },
  teams_bots: {
    select: "id, display_name",
    title: (r) => r.display_name ?? "Teams bot",
    detail: () => "Microsoft Teams",
  },
  kb_sources: {
    select: "id, label, kind",
    title: (r) => r.label ?? r.kind ?? "Knowledge Base source",
    detail: (r) => r.kind,
  },
  integrations: {
    select: "id, name, type",
    title: (r) => r.name ?? r.type ?? "Integration",
    detail: (r) => r.type,
  },
  agents: {
    select: "id, name",
    title: (r) => r.name ?? "Agent",
    detail: () => "n8n webhook on this agent",
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyOps(query: any, ops: QueryOp[]): any {
  let q = query;
  for (const op of ops) q = q[op.method](...op.args);
  return q;
}

export function StoredCredentialsPanel({ category }: { category: ApiKeyCategory }) {
  const { session } = useAuth();
  const userId = session?.user?.id ?? "";
  const [items, setItems] = useState<
    { key: string; title: string; detail: string | null }[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const now = new Date();
      const all: { key: string; title: string; detail: string | null }[] = [];
      for (const source of category.sources) {
        const display = DISPLAY[source.table];
        if (!display) throw new Error(`No display columns are defined for ${source.table}.`);
        const { data, error: e } = await applyOps(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase.from(source.table as never) as any).select(display.select),
          countOps(source, { userId, now }),
        );
        if (e) throw new Error(e.message);
        for (const r of (data ?? []) as Row[]) {
          all.push({
            key: `${source.table}:${r.id}`,
            title: display.title(r),
            detail: display.detail(r),
          });
        }
      }
      setItems(all);
    } catch (e) {
      setItems(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [category, userId]);

  useEffect(() => {
    if (userId) void load();
  }, [load, userId]);

  return (
    <div className="space-y-3" data-testid={`stored-credentials-${category.id}`}>
      {error !== null ? (
        <div
          className="flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
          role="alert"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">Could not load these credentials: {error}</span>
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => void load()}>
            <RefreshCw className="h-3 w-3" /> Retry
          </Button>
        </div>
      ) : items === null ? (
        <div className="space-y-2" aria-label="Loading credentials">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">None connected.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((i) => (
            <li key={i.key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 truncate font-medium">{i.title}</span>
              {i.detail ? (
                <span className="shrink-0 text-xs text-muted-foreground">{i.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        These are connected, tested and removed on their own page —{" "}
        <Link
          to={category.route}
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          open it <ArrowRight className="h-3 w-3" />
        </Link>
      </p>
    </div>
  );
}
