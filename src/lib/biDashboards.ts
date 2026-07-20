// BI dashboards ("BI projects") — widget model, grid layout math, and
// Supabase CRUD. Dashboards are a 12-column grid of widgets; each chart
// widget stores its SQL, its source (local AlaSQL datasets or an external
// warehouse connection), and a capped snapshot of the last result so shared
// and published dashboards render without touching the owner's data sources.
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import type { BiTurn, ChartSpec } from "@/lib/biAgent";

export const GRID_COLS = 12;
export const WIDGET_ROW_CAP = 500;

export type BiWidgetSource =
  | { kind: "local" }
  | { kind: "warehouse"; connection_id: string; connection_name: string; provider: string };

export type BiWidget = {
  id: string;
  kind: "chart" | "text";
  title: string;
  // chart widgets
  source?: BiWidgetSource;
  sql?: string;
  chart?: ChartSpec;
  columns?: string[];
  rows?: Record<string, unknown>[];
  narrative?: string;
  refreshed_at?: string;
  // text widgets (markdown)
  text?: string;
};

export type BiLayoutItem = { i: string; x: number; y: number; w: number; h: number };

export type BiDashboardRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  widgets: Json;
  layout: Json;
  published: boolean;
  public_slug: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

// ── Layout math (pure, shared by editor + viewer) ────────────────────────

export function collides(a: BiLayoutItem, b: BiLayoutItem): boolean {
  return a.i !== b.i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Place `anchor` exactly where it is and push every overlapping widget down. */
export function pushDown(layout: BiLayoutItem[], anchor: BiLayoutItem): BiLayoutItem[] {
  const placed: BiLayoutItem[] = [{ ...anchor }];
  const others = layout.filter((l) => l.i !== anchor.i).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const o of others) {
    const item = { ...o };
    while (placed.some((p) => collides(p, item))) item.y += 1;
    placed.push(item);
  }
  return placed;
}

/** Pull every widget up as far as it can go (top gravity). */
export function compactLayout(layout: BiLayoutItem[]): BiLayoutItem[] {
  const sorted = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: BiLayoutItem[] = [];
  for (const o of sorted) {
    const item = { ...o };
    while (item.y > 0 && !placed.some((p) => collides(p, { ...item, y: item.y - 1 }))) {
      item.y -= 1;
    }
    placed.push(item);
  }
  return placed;
}

/** First free slot scanning left-to-right, top-to-bottom. */
export function findFreePosition(
  layout: BiLayoutItem[],
  w: number,
  h: number,
): { x: number; y: number } {
  const maxBottom = layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
  for (let y = 0; y < maxBottom; y++) {
    for (let x = 0; x <= GRID_COLS - w; x++) {
      const test: BiLayoutItem = { i: "__new__", x, y, w, h };
      if (!layout.some((l) => collides(l, test))) return { x, y };
    }
  }
  return { x: 0, y: maxBottom };
}

export function defaultWidgetSize(widget: BiWidget): { w: number; h: number } {
  if (widget.kind === "text") return { w: 6, h: 3 };
  const t = widget.chart?.type;
  if (t === "kpi") return { w: 3, h: 3 };
  return { w: 6, h: 6 };
}

export function addWidgetToLayout(layout: BiLayoutItem[], widget: BiWidget): BiLayoutItem[] {
  const { w, h } = defaultWidgetSize(widget);
  const { x, y } = findFreePosition(layout, w, h);
  return [...layout, { i: widget.id, x, y, w, h }];
}

// ── Row (de)serialisation ────────────────────────────────────────────────

export function parseWidgets(v: Json): BiWidget[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter(
    (w): w is BiWidget => !!w && typeof w === "object" && typeof (w as BiWidget).id === "string",
  );
}

export function parseLayout(v: Json, widgets: BiWidget[]): BiLayoutItem[] {
  const raw = Array.isArray(v) ? (v as unknown[]) : [];
  const items = raw.filter(
    (l): l is BiLayoutItem =>
      !!l &&
      typeof l === "object" &&
      typeof (l as BiLayoutItem).i === "string" &&
      [
        (l as BiLayoutItem).x,
        (l as BiLayoutItem).y,
        (l as BiLayoutItem).w,
        (l as BiLayoutItem).h,
      ].every((n) => typeof n === "number" && Number.isFinite(n)),
  );
  // Keep layout and widgets in sync: drop orphans, append missing.
  const ids = new Set(widgets.map((w) => w.id));
  let layout = items
    .filter((l) => ids.has(l.i))
    .map((l) => ({
      i: l.i,
      x: Math.max(0, Math.min(GRID_COLS - 1, Math.round(l.x))),
      y: Math.max(0, Math.round(l.y)),
      w: Math.max(1, Math.min(GRID_COLS, Math.round(l.w))),
      h: Math.max(1, Math.round(l.h)),
    }))
    .map((l) => (l.x + l.w > GRID_COLS ? { ...l, x: GRID_COLS - l.w } : l));
  const placed = new Set(layout.map((l) => l.i));
  for (const w of widgets) {
    if (!placed.has(w.id)) layout = addWidgetToLayout(layout, w);
  }
  return layout;
}

export function snapshotRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.slice(0, WIDGET_ROW_CAP);
}

/** Build a chart widget from a finished BI-agent turn. */
export function widgetFromBiTurn(turn: BiTurn, source: BiWidgetSource): BiWidget | null {
  if (!turn.sql || !turn.result || turn.status !== "done") return null;
  return {
    id: crypto.randomUUID(),
    kind: "chart",
    title: turn.question,
    source,
    sql: turn.sql,
    chart: turn.chart ?? { type: "table" },
    columns: turn.result.columns,
    rows: snapshotRows(turn.result.rows),
    narrative: turn.narrative,
    refreshed_at: new Date().toISOString(),
  };
}

export function makePublicSlug(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => alphabet[b % 36]).join("");
}

// ── Supabase CRUD (RLS: owner full control, grantees read-only) ─────────

export async function listDashboards(): Promise<BiDashboardRow[]> {
  const { data, error } = await supabase
    .from("bi_dashboards")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as BiDashboardRow[];
}

export async function getDashboard(id: string): Promise<BiDashboardRow | null> {
  const { data, error } = await supabase
    .from("bi_dashboards")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as BiDashboardRow | null) ?? null;
}

export async function createDashboard(args: {
  userId: string;
  name: string;
  description?: string | null;
}): Promise<BiDashboardRow> {
  const { data, error } = await supabase
    .from("bi_dashboards")
    .insert({
      user_id: args.userId,
      name: args.name,
      description: args.description?.trim() || null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not create the BI project");
  return data as BiDashboardRow;
}

export async function updateDashboard(
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    widgets: Json;
    layout: Json;
    published: boolean;
    public_slug: string | null;
    published_at: string | null;
  }>,
): Promise<void> {
  const { error } = await supabase.from("bi_dashboards").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteDashboard(id: string): Promise<void> {
  const { error } = await supabase.from("bi_dashboards").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Append a widget to a dashboard (used by "Add to dashboard" on /data-sql). */
export async function appendWidgetToDashboard(
  dashboardId: string,
  widget: BiWidget,
): Promise<void> {
  const row = await getDashboard(dashboardId);
  if (!row) throw new Error("Dashboard not found");
  const widgets = [...parseWidgets(row.widgets), widget];
  const layout = addWidgetToLayout(parseLayout(row.layout, parseWidgets(row.widgets)), widget);
  await updateDashboard(dashboardId, {
    widgets: widgets as unknown as Json,
    layout: layout as unknown as Json,
  });
}

export function publicDashboardUrl(slug: string): string {
  return `${window.location.origin}/share/bi/${slug}`;
}
