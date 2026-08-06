// BI dashboards ("BI projects") — widget model, grid layout math, and
// Supabase CRUD. Dashboards are a 12-column grid of widgets; each chart
// widget stores its SQL, its source (local AlaSQL datasets or an external
// warehouse connection), and a capped snapshot of the last result so shared
// and published dashboards render without touching the owner's data sources.
import type { CSSProperties } from "react";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import type { BiTurn, ChartSpec } from "@/lib/biAgent";
import { isAggregatableChart } from "@/lib/biAggregate";
import type { ComparePeriod, SemanticFilter, TimeGrain } from "@/lib/semanticLayer";

export const GRID_COLS = 12;

/** Fallback when nothing is configured. */
export const WIDGET_ROW_CAP_DEFAULT = 500;
/** Refuse absurd values rather than letting one widget carry a million rows. */
export const WIDGET_ROW_CAP_MAX = 100_000;

/**
 * Rows kept in a widget's snapshot.
 *
 * A snapshot is what shared links, public embeds and offline views render, and
 * it lives inside the dashboard row as JSONB — so this trades storage and load
 * time against how much raw data a browser-side sum can see. For an aggregated
 * widget (`agg_pushdown`, the default where the chart type allows it) 500 rows
 * is already far more than any readable chart needs. For a widget that sums RAW
 * rows, the cap is a correctness limit: hit it and the total is partial, which
 * is why such widgets get `truncated`.
 *
 * Set `VITE_BI_SNAPSHOT_ROWS_CAP` to raise it. One knob, read the same way on
 * both sides: this module runs in the browser (widgets are created there) and
 * on the server (scheduled refresh), and two constants that could disagree is
 * exactly how this codebase has been bitten before.
 */
export function widgetRowCap(): number {
  // Written as the canonical `import.meta.env.VITE_*` form on purpose: the
  // production build substitutes it by LITERAL TEXT MATCH (see envDefine in
  // vite.config.ts), so `env?.VITE_…` would silently never be replaced — and
  // the knob would work in dev and do nothing in the shipped image.
  const raw = import.meta.env.VITE_BI_SNAPSHOT_ROWS_CAP as string | undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return WIDGET_ROW_CAP_DEFAULT;
  return Math.min(Math.trunc(n), WIDGET_ROW_CAP_MAX);
}

export type BiWidgetSource =
  | { kind: "local" }
  | { kind: "warehouse"; connection_id: string; connection_name: string; provider: string }
  // Governed semantic-layer metric: the widget stores the metric query, and
  // refresh re-runs it against the CURRENT model definition.
  | {
      kind: "semantic";
      model: string;
      metrics: string[];
      dimensions?: string[];
      filters?: SemanticFilter[];
      /** Per-time-dimension rollup (e.g. { order_date: "month" }). */
      grains?: Record<string, TimeGrain>;
      /**
       * Period-over-period comparison, if the query had one.
       *
       * It has to be stored with the rest of the query: refresh recompiles from
       * this source, so a comparison left out here would quietly disappear on
       * the widget's next scheduled refresh — the chart keeps its columns and
       * loses its numbers.
       */
      compare?: ComparePeriod;
    };

/** Content of an image widget: an uploaded data-URI OR an external URL. */
export type BiImage = {
  /** data:image/... (uploaded) or an http(s) URL (e.g. a public S3 object). */
  src: string;
  /** How the image fills its card. Defaults to "contain". */
  fit?: "contain" | "cover";
  alt?: string;
  /** Optional link the image opens when clicked. */
  href?: string;
};

export type BiWidget = {
  id: string;
  kind: "chart" | "text" | "image";
  title: string;
  // chart widgets
  source?: BiWidgetSource;
  sql?: string;
  chart?: ChartSpec;
  columns?: string[];
  rows?: Record<string, unknown>[];
  /**
   * Data mode (warehouse-backed widgets): "import" renders the cached `rows`
   * snapshot (SPICE-like, fast, sampled); "direct" re-runs `sql` live against
   * the warehouse at view time for the full current truth. Default "import".
   * Public embeds/shares always render the snapshot regardless.
   */
  query_mode?: "import" | "direct";
  /**
   * Aggregate in SQL (GROUP BY on the category fields) instead of fetching raw
   * rows and summing the capped snapshot in the browser.
   *
   * Opt-in per widget, and deliberately NOT retro-enabled: switching it on can
   * change the number an existing widget displays, because that number was a
   * partial sum of however many rows fitted under the cap. New widgets default
   * to on; existing ones surface `truncated` instead so the owner can see the
   * problem and choose. See src/lib/biAggregate.ts.
   */
  agg_pushdown?: boolean;
  /**
   * Incremental refresh: re-query only rows whose `column` value falls inside
   * the last `days`, and keep the prior snapshot's rows outside that window.
   *
   * Whole time buckets are recomputed rather than partial aggregates merged,
   * which is what keeps every aggregate type correct (avg and count_distinct
   * cannot be merged from partials). The assumption the owner signs up for is
   * the standard one: history outside the window is immutable. A late-arriving
   * edit to an old row will not be seen until a full refresh.
   */
  incremental?: { column: string; days: number };
  /** Last refresh filled the snapshot to the row cap — totals may be partial. */
  truncated?: boolean;
  narrative?: string;
  /** Per-widget appearance (accent colour + card surface). */
  theme?: BiWidgetTheme;
  refreshed_at?: string;
  // text widgets (markdown)
  text?: string;
  // image widgets
  image?: BiImage;
};

// ── Public-surface sanitisation ──────────────────────────────────────────────
// A dashboard served to an ANONYMOUS viewer (embed iframe or published share
// link) needs enough to RENDER, not the query behind the render. `sql` is the
// raw query — internal table/column names, joins, filter values — and a
// warehouse `source` carries connection_id / connection_name / provider.
// Neither is used by the renderer (it draws from `rows` + `chart`), and both
// surfaces are world-readable by design, so allow-list the render fields.
const PUBLIC_WIDGET_FIELDS = [
  "id",
  "kind",
  "title",
  "chart",
  "columns",
  "rows",
  "narrative",
  "theme",
  "refreshed_at",
  "text",
  "image",
] as const;

export function sanitizePublicWidgets(widgets: unknown): Record<string, unknown>[] {
  if (!Array.isArray(widgets)) return [];
  return (widgets as Record<string, unknown>[]).map((w) => {
    const safe: Record<string, unknown> = {};
    for (const f of PUBLIC_WIDGET_FIELDS) {
      if (w[f] !== undefined) safe[f] = w[f];
    }
    return safe;
  });
}

/** Pages carry their own widget arrays, so they need the same treatment. */
export function sanitizePublicPages(pages: unknown): unknown {
  if (!Array.isArray(pages)) return pages;
  return (pages as Record<string, unknown>[]).map((p) => ({
    ...p,
    widgets: sanitizePublicWidgets(p.widgets),
  }));
}

export type BiLayoutItem = { i: string; x: number; y: number; w: number; h: number };

export type BiDashboardRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  widgets: Json;
  layout: Json;
  /** Ordered pages ({ id, name, widgets, layout }[]). Source of truth for the
   *  dashboard's content; top-level widgets/layout mirror page 1. */
  pages: Json;
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
  /** Optional placement: a shared workspace and/or a folder within it (or a
   *  personal folder when workspace_id is null). Both null = personal + ungrouped. */
  workspace_id: string | null;
  folder_id: string | null;
  /** Optimistic-concurrency counter — bumped on every editor content save. */
  version: number;
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
    // No filter at all = a deliberately unrestricted grant, and one of those
    // makes every narrower grant moot. ONLY null/undefined counts as absent:
    // any other value is a filter that is present and unreadable, which falls
    // through to the unsatisfiable case below. (`typeof null === "object"`, so
    // the null check has to come first either way.)
    if (rf == null) return null;
    const column = typeof rf.column === "string" ? rf.column.trim() : "";
    const values = Array.isArray(rf.values)
      ? rf.values.map((v) => String(v)).filter((s) => s !== "")
      : [];
    // A filter that is PRESENT but unusable is a different thing, and reading
    // it as "unrestricted" would let a malformed row widen access. An empty
    // values list is the unsatisfiable filter both consumers already fail
    // closed on: applyRowFilters keeps no row, buildDirectQuerySql emits
    // WHERE 1=0. Unreachable through iamCreateGrant, which requires a non-empty
    // column and at least one value — but enforcement should not depend on the
    // writer having been careful.
    filters.push(column ? { column, values } : { column: "", values: [] });
  }
  return filters;
}

/**
 * The columns a viewer may NOT see, given every grant that applies to them.
 *
 * Union-of-access semantics, like the rest of IAM: a column is hidden only
 * when EVERY applicable grant hides it — one unrestricted grant (directly or
 * via any group) makes the whole dashboard visible, so masks on other grants
 * change nothing. Matching is case-insensitive because SQL result columns
 * arrive in whatever case the dialect produced.
 */
export function intersectColumnMasks(masks: unknown[]): string[] {
  let acc: Set<string> | null = null;
  for (const m of masks) {
    const mask = Array.isArray(m)
      ? m.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
      : [];
    if (mask.length === 0) return [];
    const set = new Set<string>(mask);
    if (acc === null) {
      acc = set;
    } else {
      const next = new Set<string>();
      for (const c of acc) if (set.has(c)) next.add(c);
      acc = next;
    }
    if (acc.size === 0) return [];
  }
  return acc ? [...acc] : [];
}

/** Drop masked columns from a result — both the column list and every row. */
export function applyColumnMask(
  columns: string[],
  rows: Record<string, unknown>[],
  mask: string[],
): { columns: string[]; rows: Record<string, unknown>[] } {
  if (mask.length === 0) return { columns, rows };
  const hidden = new Set(mask.map((c) => c.toLowerCase()));
  const keptColumns = columns.filter((c) => !hidden.has(c.toLowerCase()));
  const keptRows = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!hidden.has(k.toLowerCase())) out[k] = v;
    }
    return out;
  });
  return { columns: keptColumns, rows: keptRows };
}

/** applyColumnMask across a widgets array (pure; non-chart widgets untouched). */
export function maskWidgets(widgets: unknown, mask: string[]): unknown {
  if (!Array.isArray(widgets) || mask.length === 0) return widgets;
  return widgets.map((w) => {
    if (!w || typeof w !== "object" || (w as BiWidget).kind !== "chart") return w;
    const widget = w as BiWidget;
    const masked = applyColumnMask(
      widget.columns ?? [],
      Array.isArray(widget.rows) ? widget.rows : [],
      mask,
    );
    return { ...widget, columns: masked.columns, rows: masked.rows };
  });
}

/**
 * Apply mandatory grant row filters to a snapshot. A row passes when it
 * satisfies ANY grant's filter (union of scopes) — grants are additive, so
 * holding two must never admit fewer rows than holding either alone.
 *
 * FAILS CLOSED on a row that does not carry the filter column. This used to
 * pass such rows, reasoning that "a filter only constrains rows that actually
 * carry its column". That is backwards: the typical widget aggregates the
 * filter column away — `SELECT product, sum(revenue) FROM sales GROUP BY
 * product` has no `region` in its output — so a grantee restricted to EMEA
 * was handed the GLOBAL total, by the path that renders every public embed
 * and share link. A filter that cannot be checked has not been satisfied.
 *
 * Matches buildDirectQuerySql, which answers the same case with `WHERE 1=0`.
 * The remedy for an empty widget is to project the filter column, not to
 * assume the rows were fine.
 */
export function applyRowFilters(
  rows: Record<string, unknown>[],
  filters: BiRowFilter[] | null,
): Record<string, unknown>[] {
  if (!filters || filters.length === 0 || rows.length === 0) return rows;
  return rows.filter((r) => filters.some((f) => f.values.includes(String(r[f.column] ?? ""))));
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
  if (widget.kind === "image") return { w: 4, h: 4 };
  const t = widget.chart?.type;
  if (t === "wordcloud") return { w: 5, h: 5 };
  if (t === "kpi") return { w: 3, h: 3 };
  if (t === "gauge") return { w: 4, h: 4 };
  if (t === "map" || t === "bubblemap") return { w: 8, h: 6 };
  if (t === "matrix") return { w: 8, h: 6 };
  if (t === "sankey") return { w: 8, h: 6 };
  if (t === "ontology") return { w: 12, h: 8 };
  if (t === "radar" || t === "nightingale") return { w: 5, h: 5 };
  return { w: 6, h: 6 };
}

export function addWidgetToLayout(
  layout: BiLayoutItem[],
  widget: BiWidget,
  sizeOverride?: { w: number; h: number },
): BiLayoutItem[] {
  const { w, h } = sizeOverride ?? defaultWidgetSize(widget);
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

// ── Multi-page dashboards ────────────────────────────────────────────────────
// A dashboard is an ordered list of pages, each with its own widgets + layout.
// The dashboard-level theme and filters stay global (shared across pages).
export type BiPage = {
  id: string;
  name: string;
  widgets: BiWidget[];
  layout: BiLayoutItem[];
};

/**
 * Parse the `pages` column. Backward-compatible: dashboards saved before
 * multi-page support (empty/absent `pages`) collapse to a single "Page 1"
 * built from the top-level widgets/layout the caller already parsed.
 */
export function parsePages(
  rawPages: Json | undefined,
  fallbackWidgets: BiWidget[],
  fallbackLayout: BiLayoutItem[],
): BiPage[] {
  if (Array.isArray(rawPages) && rawPages.length > 0) {
    const pages: BiPage[] = [];
    for (const p of rawPages as unknown[]) {
      if (!p || typeof p !== "object") continue;
      const obj = p as { id?: unknown; name?: unknown; widgets?: Json; layout?: Json };
      const widgets = parseWidgets((obj.widgets ?? []) as Json);
      pages.push({
        id: typeof obj.id === "string" && obj.id ? obj.id : crypto.randomUUID(),
        name:
          typeof obj.name === "string" && obj.name.trim() ? obj.name : `Page ${pages.length + 1}`,
        widgets,
        layout: parseLayout((obj.layout ?? []) as Json, widgets),
      });
    }
    if (pages.length > 0) return pages;
  }
  return [
    { id: crypto.randomUUID(), name: "Page 1", widgets: fallbackWidgets, layout: fallbackLayout },
  ];
}

export function makeEmptyPage(name: string): BiPage {
  return { id: crypto.randomUUID(), name, widgets: [], layout: [] };
}

export function snapshotRows(
  rows: Record<string, unknown>[],
  cap: number = widgetRowCap(),
): Record<string, unknown>[] {
  return rows.slice(0, Math.max(1, cap));
}

/** Build a chart widget from a finished BI-agent turn. */
export function widgetFromBiTurn(
  turn: BiTurn,
  source: BiWidgetSource,
  rowCap: number = widgetRowCap(),
): BiWidget | null {
  if (!turn.sql || !turn.result || turn.status !== "done") return null;
  return {
    id: crypto.randomUUID(),
    kind: "chart",
    title: turn.question,
    source,
    sql: turn.sql,
    chart: turn.chart ?? { type: "table" },
    columns: turn.result.columns,
    rows: snapshotRows(turn.result.rows, rowCap),
    narrative: turn.narrative,
    // Same default as builder-created widgets: aggregate in SQL when the chart
    // type supports it, so an AI-added widget starts with complete totals.
    agg_pushdown: isAggregatableChart(turn.chart ?? undefined),
    refreshed_at: new Date().toISOString(),
  };
}

export type SemanticChartType = "table" | "bar" | "line" | "area" | "kpi" | "pie";

/** Build a dashboard widget backed by a governed semantic metric query. */
export function widgetFromSemantic(args: {
  title: string;
  model: string;
  metrics: string[];
  dimensions: string[];
  filters?: SemanticFilter[];
  grains?: Record<string, TimeGrain>;
  compare?: ComparePeriod;
  chartType: SemanticChartType;
  columns: string[];
  rows: Record<string, unknown>[];
  sql: string;
}): BiWidget {
  const dim0 = args.dimensions[0] ?? args.columns[0];
  const dim1 = args.dimensions[1];
  const met0 = args.metrics[0] ?? args.columns[args.dimensions.length] ?? args.columns[0];
  let chart: ChartSpec;
  switch (args.chartType) {
    case "kpi":
      chart = { type: "kpi", valueField: met0 };
      break;
    case "pie":
      chart = { type: "pie", nameField: dim0, valueField: met0 };
      break;
    case "bar":
    case "line":
    case "area":
      chart = {
        type: args.chartType,
        xField: dim0,
        yField: met0,
        ...(dim1 ? { seriesField: dim1 } : {}),
      };
      break;
    default:
      chart = { type: "table" };
  }
  return {
    id: crypto.randomUUID(),
    kind: "chart",
    title: args.title,
    source: {
      kind: "semantic",
      model: args.model,
      metrics: args.metrics,
      dimensions: args.dimensions,
      filters: args.filters,
      grains: args.grains,
      compare: args.compare,
    },
    sql: args.sql,
    chart,
    columns: args.columns,
    rows: snapshotRows(args.rows),
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
  if (data) {
    // Hydrate row snapshots from the results store. Failure is non-fatal: the
    // document's own (possibly older or empty) rows still render, which beats
    // failing the whole load over the data sidecar.
    try {
      const results = await fetchWidgetResults(id);
      if (results.length > 0) {
        data.widgets = mergeWidgetResults(data.widgets, results) as Json;
        data.pages = mergePagesResults(data.pages, results) as Json;
      }
    } catch {
      /* fall back to document rows */
    }
  }
  return (data as BiDashboardRow | null) ?? null;
}

// ── Widget results: data split out of the dashboard document ───────────────
// The document stores the DEFINITION (sql, chart, layout, columns, metadata);
// row snapshots live in bi_widget_results, one row per (dashboard, widget).
// Readers merge them back in; writers strip them out. Everything falls back to
// rows still embedded in the document, so dashboards written before the split
// (and sample seeds, and promoted copies) keep rendering with no backfill.

export type WidgetResultRow = {
  widget_id: string;
  columns: Json;
  rows: Json;
  truncated: boolean;
  refreshed_at: string;
};

/**
 * Remove row snapshots from a widgets array (pure).
 *
 * Keeps `columns` — the filter UI, drill-through and the aggregation-pushdown
 * validator all read them — and keeps `refreshed_at`/`truncated` so staleness
 * comparisons work without the data present. Ontology widgets carry their map
 * in the chart spec and have empty rows anyway.
 */
export function stripWidgetData(widgets: unknown): unknown {
  if (!Array.isArray(widgets)) return widgets;
  return widgets.map((w) => {
    if (!w || typeof w !== "object" || (w as BiWidget).kind !== "chart") return w;
    const { rows: _rows, ...rest } = w as Record<string, unknown>;
    return { ...rest, rows: [] };
  });
}

/** stripWidgetData across the `pages` mirror (each page embeds its own widgets). */
export function stripPagesData(pages: unknown): unknown {
  if (!Array.isArray(pages)) return pages;
  return (pages as Record<string, unknown>[]).map((p) =>
    p && typeof p === "object" ? { ...p, widgets: stripWidgetData(p.widgets) } : p,
  );
}

/**
 * Merge stored results into a widgets array (pure).
 *
 * A result wins when the widget has no rows of its own, or when the result is
 * at least as fresh as the widget's — so a builder preview the user just ran
 * (newer refreshed_at, rows in memory) is never overwritten by an older stored
 * snapshot, while a scheduled refresh that ran after the document was saved
 * shows up without a reload.
 */
export function mergeWidgetResults(widgets: unknown, results: WidgetResultRow[]): unknown {
  if (!Array.isArray(widgets) || results.length === 0) return widgets;
  const byId = new Map(results.map((r) => [r.widget_id, r]));
  return widgets.map((w) => {
    if (!w || typeof w !== "object" || (w as BiWidget).kind !== "chart") return w;
    const widget = w as Record<string, unknown>;
    const r = byId.get(String(widget.id));
    if (!r || !Array.isArray(r.rows)) return w;
    const widgetRows = Array.isArray(widget.rows) ? (widget.rows as unknown[]) : [];
    const widgetAt = typeof widget.refreshed_at === "string" ? widget.refreshed_at : "";
    if (widgetRows.length > 0 && widgetAt > r.refreshed_at) return w;
    return {
      ...widget,
      columns: Array.isArray(r.columns) ? r.columns : widget.columns,
      rows: r.rows,
      truncated: r.truncated,
      refreshed_at: r.refreshed_at,
    };
  });
}

/** mergeWidgetResults across the `pages` mirror. */
export function mergePagesResults(pages: unknown, results: WidgetResultRow[]): unknown {
  if (!Array.isArray(pages) || results.length === 0) return pages;
  return (pages as Record<string, unknown>[]).map((p) =>
    p && typeof p === "object" ? { ...p, widgets: mergeWidgetResults(p.widgets, results) } : p,
  );
}

// ── Incremental refresh (pure) ──────────────────────────────────────────────

export const INCREMENTAL_MAX_DAYS = 3650;

/**
 * Decide whether a widget can refresh incrementally, and against what cutoff.
 *
 * Returns the ISO date (YYYY-MM-DD) marking the window start, or null for
 * "do a full refresh" — which is the answer whenever anything is off: no
 * config, no prior snapshot to keep rows from, the column missing from the
 * last result, or prior values that don't parse as dates (a date comparison
 * against a non-date column would silently filter wrongly; full refresh is
 * always correct).
 */
export function incrementalCutoffIso(
  cfg: { column?: string; days?: number } | undefined,
  priorRows: Record<string, unknown>[],
  priorColumns: string[],
  now: number = Date.now(),
): { column: string; fromIso: string } | null {
  if (!cfg || typeof cfg.column !== "string" || !cfg.column.trim()) return null;
  const days = Number(cfg.days);
  if (!Number.isInteger(days) || days < 1 || days > INCREMENTAL_MAX_DAYS) return null;
  if (priorRows.length === 0) return null;
  // Resolve to the RESULT's own spelling and return that: the SQL filter, the
  // row lookup during the merge, and this check must all agree on one name, or
  // a case difference would pass validation here and then read `undefined`
  // from every row downstream.
  const column = priorColumns.find((c) => c.toLowerCase() === cfg.column!.trim().toLowerCase());
  if (!column) return null;
  // The column must actually hold dates. Sample rather than scan: any single
  // parseable value proves the shape; all-unparseable means it isn't a date.
  const sample = priorRows.slice(0, 25);
  if (!sample.some((r) => Number.isFinite(Date.parse(String(r[column] ?? ""))))) return null;
  return { column, fromIso: new Date(now - days * 86_400_000).toISOString().slice(0, 10) };
}

/**
 * Merge an incremental result: prior rows strictly BEFORE the cutoff, then the
 * freshly queried rows (which the SQL already restricted to >= cutoff).
 *
 * Prior rows whose date does not parse are kept: the SQL comparison excluded
 * such rows from the fresh set (NULL/garbage never satisfies >=), so keeping
 * them cannot duplicate — but dropping them would silently lose data.
 */
export function mergeIncrementalRows(
  priorRows: Record<string, unknown>[],
  freshRows: Record<string, unknown>[],
  column: string,
  cutoffIso: string,
): Record<string, unknown>[] {
  const cutoff = Date.parse(cutoffIso);
  const kept = priorRows.filter((r) => {
    const t = Date.parse(String(r[column] ?? ""));
    return !Number.isFinite(t) || t < cutoff;
  });
  return [...kept, ...freshRows];
}

/** Load a dashboard's stored widget results (owner or grantee, via RLS). */
export async function fetchWidgetResults(dashboardId: string): Promise<WidgetResultRow[]> {
  const { data, error } = await supabase
    .from("bi_widget_results")
    .select("widget_id, columns, rows, truncated, refreshed_at")
    .eq("dashboard_id", dashboardId);
  if (error) throw new Error(error.message);
  return (data ?? []) as WidgetResultRow[];
}

// Last refreshed_at synced per widget, so autosaves (which fire on every
// debounced edit) only upload row snapshots that actually changed.
const syncedResultAt = new Map<string, string>();

/**
 * Persist the in-memory row snapshots of chart widgets (owner only — RLS
 * refuses anyone else). Best-effort by design: a failed sync leaves the stored
 * result stale, which the next refresh or save repairs; it must never block or
 * fail the document save it accompanies.
 */
export async function syncWidgetResults(dashboardId: string, widgets: BiWidget[]): Promise<void> {
  const dirty = widgets.filter(
    (w) =>
      w.kind === "chart" &&
      Array.isArray(w.rows) &&
      w.rows.length > 0 &&
      syncedResultAt.get(`${dashboardId}:${w.id}`) !== (w.refreshed_at ?? ""),
  );
  if (dirty.length === 0) return;
  // getSession reads the local token — no network round trip per autosave.
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user.id;
  if (!userId) return;
  const { error } = await supabase.from("bi_widget_results").upsert(
    dirty.map((w) => ({
      dashboard_id: dashboardId,
      widget_id: w.id,
      user_id: userId,
      columns: (w.columns ?? []) as unknown as Json,
      rows: (w.rows ?? []) as unknown as Json,
      truncated: Boolean(w.truncated),
      refreshed_at: w.refreshed_at ?? new Date().toISOString(),
    })),
    { onConflict: "dashboard_id,widget_id" },
  );
  if (error) throw new Error(error.message);
  for (const w of dirty) syncedResultAt.set(`${dashboardId}:${w.id}`, w.refreshed_at ?? "");
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

/** Thrown when an optimistic-concurrency save loses to a concurrent write. */
export class DashboardConflictError extends Error {
  constructor() {
    super("This dashboard was changed in another session.");
    this.name = "DashboardConflictError";
  }
}

export async function updateDashboard(
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    widgets: Json;
    layout: Json;
    pages: Json;
    filters: Json;
    theme: Json;
    published: boolean;
    public_slug: string | null;
    published_at: string | null;
    workspace_id: string | null;
    folder_id: string | null;
  }>,
  opts?: { expectedVersion?: number },
): Promise<number | null> {
  // Row snapshots never enter the document, whoever calls this. Data lives in
  // bi_widget_results (see syncWidgetResults); the document stores definitions
  // plus small metadata. Stripping here, at the single write chokepoint, means
  // no future caller can quietly reintroduce document bloat.
  if (patch.widgets !== undefined)
    patch = { ...patch, widgets: stripWidgetData(patch.widgets) as Json };
  if (patch.pages !== undefined) patch = { ...patch, pages: stripPagesData(patch.pages) as Json };

  // Optimistic concurrency: only the editor's content saves pass an
  // expectedVersion. The update is guarded on the version it loaded and bumps
  // it atomically; zero rows back means someone else saved first — reject
  // instead of clobbering. Callers without a version keep last-write-wins,
  // which is correct for one-shot writes (publish, move, rename from lists).
  if (opts && typeof opts.expectedVersion === "number") {
    const expected = opts.expectedVersion;
    const { data, error } = await supabase
      .from("bi_dashboards")
      .update({ ...patch, version: expected + 1 })
      .eq("id", id)
      .eq("version", expected)
      .select("version")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new DashboardConflictError();
    return (data as { version: number }).version;
  }
  const { error } = await supabase.from("bi_dashboards").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
  return null;
}

export async function deleteDashboard(id: string): Promise<void> {
  const { error } = await supabase.from("bi_dashboards").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Re-reads and re-applies on a version conflict; bounded so a hot dashboard
 *  cannot spin forever. */
const APPEND_MAX_ATTEMPTS = 4;

/** Append a widget to a dashboard (used by "Add to dashboard" on /data-sql). */
/**
 * Place a widget on page 1 and return the three fields a dashboard write must
 * keep consistent: the updated `pages`, plus the top-level `widgets`/`layout`
 * that mirror page 1.
 *
 * Pure, and separate from the write, so the invariant can be tested without a
 * database — it was violated for as long as it was untested.
 */
export function appendWidgetToPages(
  pages: BiPage[],
  widget: BiWidget,
): { widgets: BiWidget[]; layout: BiLayoutItem[]; pages: BiPage[] } {
  const target = pages[0] ?? makeEmptyPage("Page 1");
  const widgets = [...target.widgets, widget];
  const layout = addWidgetToLayout(target.layout, widget);
  const next = pages.length > 0 ? [...pages] : [target];
  next[0] = { ...target, widgets, layout };
  return { widgets, layout, pages: next };
}

export async function appendWidgetToDashboard(
  dashboardId: string,
  widget: BiWidget,
): Promise<void> {
  // Read-modify-write over the whole dashboard document, so it is guarded by
  // the row version and RETRIED on conflict. Unguarded, adding a widget while
  // the dashboard was open in the builder overwrote whatever that session had
  // saved. Failing outright instead would be no better: "someone had it open"
  // is ordinary, and the caller has nothing useful to do with the error — so
  // re-read the current document and re-apply the append to it.
  for (let attempt = 1; ; attempt++) {
    const row = await getDashboard(dashboardId);
    if (!row) throw new Error("Dashboard not found");

    // `pages` is the source of truth; top-level widgets/layout only MIRROR
    // page 1 (see BiDashboardRow). Writing the mirror alone made the widget
    // invisible on any dashboard that had ever been saved with pages —
    // parsePages returns the stored pages and ignores the top level entirely —
    // and the builder's next save rebuilt the mirror from pages, silently
    // discarding it for good.
    const mirrorWidgets = parseWidgets(row.widgets);
    const pages = parsePages(row.pages, mirrorWidgets, parseLayout(row.layout, mirrorWidgets));
    const { widgets, layout, pages: nextPages } = appendWidgetToPages(pages, widget);

    // Store the data FIRST: updateDashboard strips rows from the document, so
    // without this the new widget would render empty until its first refresh.
    await syncWidgetResults(dashboardId, [widget]).catch(() => {});
    try {
      await updateDashboard(
        dashboardId,
        {
          widgets: widgets as unknown as Json,
          layout: layout as unknown as Json,
          pages: nextPages as unknown as Json,
        },
        { expectedVersion: row.version },
      );
      return;
    } catch (e) {
      if (e instanceof DashboardConflictError && attempt < APPEND_MAX_ATTEMPTS) continue;
      throw e;
    }
  }
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
  pages: Json;
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
    .select("id, dashboard_id, label, name, widgets, layout, pages, filters, theme, created_at")
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
    // Versions store the DEFINITION, not the data. Data is not versioned — it
    // is whatever the source says now — so keeping row snapshots here only
    // multiplied storage by the retention window. On restore, widgets hydrate
    // from the current bi_widget_results like any other load.
    widgets: stripWidgetData(row.widgets) as Json,
    layout: row.layout,
    pages: stripPagesData(row.pages) as Json,
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
    pages: v.pages,
    filters: v.filters,
    theme: v.theme,
  });
}
