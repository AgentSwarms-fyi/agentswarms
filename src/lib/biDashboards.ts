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
  /** Reader AI model (OpenRouter id); null = server default. */
  ai_model: string | null;
  /** Owner-defined dashboard filter definitions (BiFilterConfig[]). */
  filters: Json;
  created_at: string;
  updated_at: string;
};

// ── Dashboard filters & cross-filtering ────────────────────────────────
//
// Filter DEFINITIONS are persisted on the dashboard; SELECTIONS are runtime
// state. Both apply purely client-side to widget snapshots: a widget is
// affected only when it actually contains the filter's column (standard BI
// semantics), so unrelated widgets stay untouched.

export type BiFilterKind = "select" | "daterange";

export type BiFilterConfig = {
  id: string;
  label: string;
  column: string;
  kind: BiFilterKind;
};

/** Runtime selections, keyed by filter id. */
export type BiFilterState = Record<string, { values?: string[]; from?: string; to?: string }>;

/** Click-to-filter: set by clicking a bar/slice; excludes its own widget. */
export type BiCrossFilter = { widgetId: string; column: string; value: string } | null;

export function parseFilters(v: Json): BiFilterConfig[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter(
    (f): f is BiFilterConfig =>
      !!f &&
      typeof f === "object" &&
      typeof (f as BiFilterConfig).id === "string" &&
      typeof (f as BiFilterConfig).column === "string" &&
      ((f as BiFilterConfig).kind === "select" || (f as BiFilterConfig).kind === "daterange"),
  );
}

/** Normalise any value to a comparable YYYY-MM-DD string (or null). */
export function toIsoDay(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Distinct values a "select" filter can offer, unioned across widgets. */
export function filterOptions(column: string, widgets: BiWidget[], cap = 100): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of widgets) {
    if (w.kind !== "chart" || !w.columns?.includes(column)) continue;
    for (const row of w.rows ?? []) {
      const v = row[column];
      if (v === null || v === undefined) continue;
      const s = String(v);
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
        if (out.length >= cap) return out.sort();
      }
    }
  }
  return out.sort();
}

/** Apply dashboard filters + the cross-filter to one widget's snapshot. */
export function filterWidgetRows(
  widget: BiWidget,
  configs: BiFilterConfig[],
  state: BiFilterState,
  cross: BiCrossFilter,
): Record<string, unknown>[] {
  let rows = widget.rows ?? [];
  if (widget.kind !== "chart" || rows.length === 0) return rows;
  const cols = new Set(widget.columns ?? []);

  for (const cfg of configs) {
    if (!cols.has(cfg.column)) continue;
    const st = state[cfg.id];
    if (!st) continue;
    if (cfg.kind === "select" && st.values && st.values.length > 0) {
      const wanted = new Set(st.values);
      rows = rows.filter((r) => wanted.has(String(r[cfg.column])));
    } else if (cfg.kind === "daterange" && (st.from || st.to)) {
      rows = rows.filter((r) => {
        const day = toIsoDay(r[cfg.column]);
        if (!day) return false;
        if (st.from && day < st.from) return false;
        if (st.to && day > st.to) return false;
        return true;
      });
    }
  }

  if (cross && cross.widgetId !== widget.id && cols.has(cross.column)) {
    rows = rows.filter((r) => String(r[cross.column]) === cross.value);
  }
  return rows;
}

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
  if (t === "gauge") return { w: 4, h: 4 };
  if (t === "map" || t === "bubblemap") return { w: 8, h: 6 };
  if (t === "matrix") return { w: 8, h: 6 };
  if (t === "ontology") return { w: 12, h: 8 };
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
    filters: Json;
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
