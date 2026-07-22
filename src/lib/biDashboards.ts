// BI dashboards ("BI projects") — widget model, grid layout math, and
// Supabase CRUD. Dashboards are a 12-column grid of widgets; each chart
// widget stores its SQL, its source (local AlaSQL datasets or an external
// warehouse connection), and a capped snapshot of the last result so shared
// and published dashboards render without touching the owner's data sources.
import type { CSSProperties } from "react";

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
  /** Per-widget appearance (accent colour + card surface). */
  theme?: BiWidgetTheme;
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
  /** Dashboard theme (background image, font) — see BiDashTheme. */
  theme: Json;
  /** Usage analytics: opens across editor, shares and embeds. */
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
  updated_at: string;
};

// ── Dashboard filters & cross-filtering ────────────────────────────────
//
// Filter DEFINITIONS are persisted on the dashboard; SELECTIONS are runtime
// state. Both apply purely client-side to widget snapshots: a widget is
// affected only when it actually contains the filter's column (standard BI
// semantics), so unrelated widgets stay untouched.

export type BiFilterKind = "select" | "daterange" | "numrange";

/** Relative-date presets resolved to concrete ranges at load time. */
export type BiDatePreset = "last7" | "last30" | "last90" | "mtd" | "qtd" | "ytd";

/** A saved default selection, applied whenever a viewer opens the dashboard. */
export type BiFilterDefault = {
  values?: string[];
  from?: string;
  to?: string;
  min?: number;
  max?: number;
  /** Takes precedence over from/to — recomputed against "today" on load. */
  preset?: BiDatePreset;
};

export type BiFilterConfig = {
  id: string;
  label: string;
  column: string;
  kind: BiFilterKind;
  default?: BiFilterDefault;
};

/** Runtime selections, keyed by filter id. */
export type BiFilterState = Record<
  string,
  { values?: string[]; from?: string; to?: string; min?: number; max?: number }
>;

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
      ((f as BiFilterConfig).kind === "select" ||
        (f as BiFilterConfig).kind === "daterange" ||
        (f as BiFilterConfig).kind === "numrange"),
  );
}

/** Concrete YYYY-MM-DD range for a relative-date preset (as of today). */
export function presetRange(preset: BiDatePreset): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = new Date();
  const to = iso(today);
  const back = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - days);
    return iso(d);
  };
  switch (preset) {
    case "last7":
      return { from: back(6), to };
    case "last30":
      return { from: back(29), to };
    case "last90":
      return { from: back(89), to };
    case "mtd":
      return { from: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`, to };
    case "qtd": {
      const qm = Math.floor(today.getMonth() / 3) * 3 + 1;
      return { from: `${today.getFullYear()}-${pad(qm)}-01`, to };
    }
    case "ytd":
      return { from: `${today.getFullYear()}-01-01`, to };
  }
}

export const DATE_PRESETS: { id: BiDatePreset; label: string }[] = [
  { id: "last7", label: "Last 7 days" },
  { id: "last30", label: "Last 30 days" },
  { id: "last90", label: "Last 90 days" },
  { id: "mtd", label: "Month to date" },
  { id: "qtd", label: "Quarter to date" },
  { id: "ytd", label: "Year to date" },
];

/** Initial runtime state from each filter's saved default (presets resolve
 * against today, so "last 30 days" is always the CURRENT last 30 days). */
export function defaultFilterState(configs: BiFilterConfig[]): BiFilterState {
  const state: BiFilterState = {};
  for (const cfg of configs) {
    const d = cfg.default;
    if (!d) continue;
    if (cfg.kind === "select" && d.values && d.values.length > 0) {
      state[cfg.id] = { values: [...d.values] };
    } else if (cfg.kind === "daterange") {
      if (d.preset) state[cfg.id] = presetRange(d.preset);
      else if (d.from || d.to) state[cfg.id] = { from: d.from, to: d.to };
    } else if (cfg.kind === "numrange" && (d.min !== undefined || d.max !== undefined)) {
      state[cfg.id] = { min: d.min, max: d.max };
    }
  }
  return state;
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
    } else if (cfg.kind === "numrange" && (st.min !== undefined || st.max !== undefined)) {
      rows = rows.filter((r) => {
        const raw = r[cfg.column];
        const n = typeof raw === "number" ? raw : raw != null ? Number(raw) : NaN;
        if (!Number.isFinite(n)) return false;
        if (st.min !== undefined && n < st.min) return false;
        if (st.max !== undefined && n > st.max) return false;
        return true;
      });
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

// ── Row-level security (grant row filters) ───────────────────────────────

/** A mandatory row scope attached to a dashboard share grant. */
export type BiRowFilter = { column: string; values: string[] };

/**
 * Merge the viewer's applicable grants into the row filters to enforce.
 * Returns null (unrestricted) when the viewer has no grants — the owner —
 * or when at least one applicable grant carries no filter: an unrestricted
 * grant always wins over a filtered one, matching permissive-union RLS.
 */
export function mergeGrantRowFilters(grants: { row_filter: Json | null }[]): BiRowFilter[] | null {
  if (grants.length === 0) return null;
  const filters: BiRowFilter[] = [];
  for (const g of grants) {
    const rf = g.row_filter as { column?: unknown; values?: unknown } | null;
    const column = typeof rf?.column === "string" ? rf.column.trim() : "";
    const values = Array.isArray(rf?.values)
      ? rf.values.map((v) => String(v)).filter((s) => s !== "")
      : [];
    if (!column || values.length === 0) return null;
    filters.push({ column, values });
  }
  return filters;
}

/**
 * Apply mandatory grant row filters to a snapshot. A row passes when it
 * satisfies ANY grant's filter (union of scopes). A filter only constrains
 * rows that actually carry its column — widgets that never select the
 * column are left intact, mirroring how model-level RLS scopes only the
 * tables it is defined on.
 */
export function applyRowFilters(
  rows: Record<string, unknown>[],
  filters: BiRowFilter[] | null,
): Record<string, unknown>[] {
  if (!filters || filters.length === 0 || rows.length === 0) return rows;
  return rows.filter((r) =>
    filters.some((f) => !(f.column in r) || f.values.includes(String(r[f.column]))),
  );
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

// ── Dashboard & widget theming ──────────────────────────────────────────

/** Dashboard-level theme, stored in bi_dashboards.theme (jsonb). */
export type BiDashTheme = {
  bg?: {
    /** Compressed data-URL image (kept in-row so public pages & PDF work). */
    url: string;
    fit: "cover" | "contain" | "tile";
    /** 0-0.8 dark overlay so widgets stay readable over busy images. */
    dim: number;
  };
  font?: string;
};

/** Per-widget appearance, stored inside the widget json. */
export type BiWidgetTheme = {
  /** Accent id from WIDGET_ACCENTS — recolours the chart primary + header. */
  accent?: string;
  /** Card surface: default, soft accent tint, or glass (over backgrounds). */
  card?: "default" | "tint" | "glass";
};

export const DASH_FONTS: Record<string, { label: string; stack: string }> = {
  default: { label: "Inter (default)", stack: "" },
  serif: { label: "Serif", stack: "Georgia, 'Times New Roman', serif" },
  humanist: { label: "Humanist", stack: "'Segoe UI', 'Trebuchet MS', Verdana, sans-serif" },
  mono: { label: "Mono", stack: "ui-monospace, 'Cascadia Code', Consolas, monospace" },
  rounded: { label: "Rounded", stack: "'Comfortaa', 'Trebuchet MS', 'Segoe UI', sans-serif" },
};

export const WIDGET_ACCENTS: Record<string, { label: string; color: string }> = {
  default: { label: "Default", color: "" },
  blue: { label: "Blue", color: "#4E79A7" },
  emerald: { label: "Emerald", color: "#59A14F" },
  amber: { label: "Amber", color: "#F28E2B" },
  violet: { label: "Violet", color: "#B07AA1" },
  rose: { label: "Rose", color: "#E15759" },
  teal: { label: "Teal", color: "#76B7B2" },
  slate: { label: "Slate", color: "#9c755f" },
};

export function parseDashTheme(v: Json | undefined): BiDashTheme {
  const t = (v ?? {}) as BiDashTheme;
  const out: BiDashTheme = {};
  if (t.bg && typeof t.bg.url === "string" && t.bg.url.length > 0) {
    out.bg = {
      url: t.bg.url,
      fit: t.bg.fit === "contain" || t.bg.fit === "tile" ? t.bg.fit : "cover",
      dim: Math.max(0, Math.min(0.8, Number(t.bg.dim) || 0)),
    };
  }
  if (typeof t.font === "string" && t.font in DASH_FONTS) out.font = t.font;
  return out;
}

/** Inline style for the dashboard canvas surface (editor, shared, public). */
export function dashSurfaceStyle(theme: BiDashTheme): CSSProperties {
  const style: CSSProperties = {};
  if (theme.bg) {
    const dim =
      theme.bg.dim > 0
        ? `linear-gradient(rgb(0 0 0 / ${theme.bg.dim}), rgb(0 0 0 / ${theme.bg.dim})), `
        : "";
    style.backgroundImage = `${dim}url(${theme.bg.url})`;
    if (theme.bg.fit === "tile") {
      style.backgroundRepeat = "repeat";
    } else {
      style.backgroundSize = theme.bg.fit;
      style.backgroundPosition = "center";
      style.backgroundRepeat = "no-repeat";
      style.backgroundAttachment = "local";
    }
  }
  const font = theme.font ? DASH_FONTS[theme.font]?.stack : "";
  if (font) style.fontFamily = font;
  return style;
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
    theme: Json;
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

/**
 * Row filters this viewer must respect for a dashboard. RLS on
 * iam_resource_grants only returns grants that apply to the caller (their
 * user grants + their groups'), so merging what comes back yields exactly
 * this viewer's scope. null = unrestricted (owner, or an unfiltered grant).
 */
export async function getMyDashboardRowFilters(dashboardId: string): Promise<BiRowFilter[] | null> {
  const { data, error } = await supabase
    .from("iam_resource_grants")
    .select("row_filter")
    .eq("resource_type", "bi_dashboard")
    .eq("resource_id", dashboardId);
  if (error || !data) return null;
  return mergeGrantRowFilters(data);
}

/** Count a dashboard view (owner or grantee); fire-and-forget, never throws. */
export function touchDashboardView(dashboardId: string): void {
  void supabase.rpc("bi_touch_view", { _dashboard_id: dashboardId }).then(
    () => {},
    () => {},
  );
}

// ── Version history ──────────────────────────────────────────────────────

export type BiVersionRow = {
  id: string;
  dashboard_id: string;
  label: string | null;
  name: string;
  widgets: Json;
  layout: Json;
  filters: Json;
  theme: Json;
  created_at: string;
};

/** Keep the newest N versions per dashboard; older ones are pruned on save. */
export const VERSION_KEEP = 30;
/** Minimum spacing between automatic snapshots. */
export const AUTO_SNAPSHOT_MS = 10 * 60 * 1000;

/** Epoch ms of the newest stored version (0 = none) — seeds the snapshot throttle. */
export async function latestDashboardVersionAt(dashboardId: string): Promise<number> {
  const { data } = await supabase
    .from("bi_dashboard_versions")
    .select("created_at")
    .eq("dashboard_id", dashboardId)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] ? new Date(data[0].created_at).getTime() : 0;
}

export async function listDashboardVersions(dashboardId: string): Promise<BiVersionRow[]> {
  const { data, error } = await supabase
    .from("bi_dashboard_versions")
    .select("id, dashboard_id, label, name, widgets, layout, filters, theme, created_at")
    .eq("dashboard_id", dashboardId)
    .order("created_at", { ascending: false })
    .limit(VERSION_KEEP);
  if (error) throw new Error(error.message);
  return (data ?? []) as BiVersionRow[];
}

/** Snapshot the dashboard's current persisted state into the history. */
export async function saveDashboardVersion(
  row: BiDashboardRow,
  label: string | null,
): Promise<void> {
  const { error } = await supabase.from("bi_dashboard_versions").insert({
    dashboard_id: row.id,
    user_id: row.user_id,
    label: label?.trim() || null,
    name: row.name,
    widgets: row.widgets,
    layout: row.layout,
    filters: row.filters,
    theme: row.theme,
  });
  if (error) throw new Error(error.message);
  // Prune beyond the retention window (best effort — RLS scopes to owner).
  const { data } = await supabase
    .from("bi_dashboard_versions")
    .select("id")
    .eq("dashboard_id", row.id)
    .order("created_at", { ascending: false })
    .range(VERSION_KEEP, VERSION_KEEP + 49);
  if (data && data.length > 0) {
    await supabase
      .from("bi_dashboard_versions")
      .delete()
      .in(
        "id",
        data.map((d) => d.id),
      );
  }
}

/** Restore a version onto the dashboard (does not delete newer versions). */
export async function restoreDashboardVersion(v: BiVersionRow): Promise<void> {
  await updateDashboard(v.dashboard_id, {
    name: v.name,
    widgets: v.widgets,
    layout: v.layout,
    filters: v.filters,
    theme: v.theme,
  });
}
