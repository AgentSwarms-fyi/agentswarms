// The metric catalog: every governed metric in one list, with the three things
// that decide whether someone should use it.
//
// A semantic layer's payoff is not that metrics exist — it is that a person
// looking for "revenue" can find the one everyone else uses, see whether it is
// trusted, and see whether it is current. Without that page the layer is a
// developer feature and the business keeps its spreadsheets.
//
// THE THREE SIGNALS, AND WHAT EACH ACTUALLY MEANS:
//
//   CERTIFICATION belongs to the MODEL, not the metric. A metric inside a
//   certified model was covered by that model's validation run; it was not
//   individually blessed. The wording says so, because "certified metric" is a
//   claim nobody made.
//
//   FRESHNESS is when the metric's underlying data last loaded — not when the
//   metric was recomputed, because it is a definition and is never computed
//   until someone asks. Saying "updated 2 minutes ago" about a formula would
//   be meaningless at best.
//
//   USAGE is what a scan of dashboards, agents and swarms found. It is
//   evidence of use, never proof of DISUSE: an analyst thread, an embed or
//   somebody's saved SQL can reference a metric without appearing here, so
//   nothing in this module ever says "unused". Deprecating a metric because a
//   page said "unused" is the failure this wording exists to prevent.
import type { SemanticMetric, SemanticStatus } from "@/lib/semanticLayer";

/**
 * A semantic model AS STORED, which is not the same shape as `SemanticModel`.
 *
 * The table keeps the source flat — `source_kind` / `source_table` /
 * `connection_id` — while the compiler's type nests it under `source`. This
 * module takes the ROW because that is what every caller actually holds; an
 * earlier version took `SemanticModel` and callers cast to it, which type-
 * checked and then silently read `undefined` for every source, so freshness
 * came back "unknown" for every metric in the workspace. A cast is not a
 * conversion.
 */
export type SemanticModelRow = {
  id?: string;
  user_id?: string | null;
  name: string;
  label?: string | null;
  status?: string | null;
  source_kind?: string | null;
  source_table?: string | null;
  metrics?: unknown;
};

/** One metric, flattened out of its model with the context it needs. */
export type CatalogMetric = {
  /** Model name — the compiler's identifier, and how usage is matched. */
  model: string;
  modelLabel?: string;
  modelId?: string;
  status: SemanticStatus;
  ownerId?: string;
  name: string;
  label?: string;
  description?: string;
  agg: SemanticMetric["agg"];
  format?: SemanticMetric["format"];
  synonyms: string[];
  /** A derived metric's formula references other metrics; worth surfacing. */
  formula?: string;
};

/**
 * Every metric across every model the caller can see.
 *
 * Sorted by label so the list reads alphabetically to a human rather than in
 * whatever order the models happened to load.
 */
export function flattenMetrics(models: SemanticModelRow[]): CatalogMetric[] {
  const out: CatalogMetric[] = [];
  for (const m of models ?? []) {
    const metrics = Array.isArray(m.metrics) ? (m.metrics as SemanticMetric[]) : [];
    for (const metric of metrics) {
      out.push({
        model: m.name,
        modelLabel: m.label ?? undefined,
        modelId: m.id,
        status: (m.status as SemanticStatus) ?? "draft",
        ownerId: m.user_id ?? undefined,
        name: metric.name,
        label: metric.label,
        description: metric.description,
        agg: metric.agg,
        format: metric.format,
        synonyms: metric.synonyms ?? [],
        formula: metric.agg === "derived" || metric.agg === "custom" ? metric.sql : undefined,
      });
    }
  }
  return out.sort((a, b) =>
    (a.label || a.name).localeCompare(b.label || b.name, undefined, { sensitivity: "base" }),
  );
}

/**
 * Match a search across the words a person would actually type.
 *
 * Synonyms are included because they exist precisely so someone can find
 * "bookings" when the metric is called `net_revenue` — a catalog that ignored
 * them would undo the reason for declaring them.
 */
export function matchesQuery(m: CatalogMetric, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [m.name, m.label, m.description, m.model, m.modelLabel, ...m.synonyms]
    .filter(Boolean)
    .some((s) => String(s).toLowerCase().includes(q));
}

/** Where a metric was found in use. */
export type MetricUsage = {
  dashboards: { id: string; name: string; widgets: string[] }[];
  /** Total references found across everything scanned. */
  total: number;
};

/**
 * Dashboards whose widgets ask for THIS metric.
 *
 * Model-level dependents already exist (lib/semanticDependents); this is the
 * metric-level question, which is the one a catalog row has to answer.
 */
export function metricUsageInDashboards(
  dashboards: Array<{ id: string; name: string; widgets: unknown }>,
  model: string,
  metric: string,
): MetricUsage {
  const out: MetricUsage["dashboards"] = [];
  for (const d of dashboards ?? []) {
    if (!Array.isArray(d.widgets)) continue;
    const hits: string[] = [];
    for (const w of d.widgets as Array<Record<string, unknown>>) {
      const source = w?.source as
        | { kind?: unknown; model?: unknown; metrics?: unknown }
        | undefined;
      if (source?.kind !== "semantic" || source.model !== model) continue;
      const metrics = Array.isArray(source.metrics) ? source.metrics.map(String) : [];
      if (!metrics.includes(metric)) continue;
      hits.push(String(w.title ?? w.id ?? "untitled widget"));
    }
    if (hits.length > 0) out.push({ id: d.id, name: d.name, widgets: hits });
  }
  return { dashboards: out, total: out.reduce((n, d) => n + d.widgets.length, 0) };
}

/**
 * How usage reads on the row.
 *
 * Never says "unused". It names WHAT WAS SEARCHED, so a reader can tell the
 * difference between "nothing uses this" and "nothing I looked at uses this" —
 * and those differ by an analyst thread, an embed, or a saved query.
 */
export function describeUsage(usage: MetricUsage): string {
  if (usage.total === 0)
    return "No dashboard widget references it (threads and embeds not scanned)";
  const d = usage.dashboards.length;
  return `${usage.total} widget${usage.total === 1 ? "" : "s"} across ${d} dashboard${d === 1 ? "" : "s"}`;
}

/**
 * Certification, worded as what it actually covers.
 *
 * "Certified" on a metric row would claim an individual review that never
 * happened; the model was validated, and the metric was in it.
 */
export function describeCertification(status: SemanticStatus): string {
  if (status === "certified") return "From a certified model — its model passed validation";
  if (status === "deprecated") return "From a DEPRECATED model — prefer a replacement";
  return "From a draft model — not yet validated";
}

/**
 * Freshness of the data behind a metric.
 *
 * `null` when nothing is known, and the caller must render that as "unknown"
 * rather than "never" — the two look identical on screen and mean opposite
 * things to someone deciding whether to trust a number.
 */
export function dataFreshness(
  model: string,
  models: SemanticModelRow[],
  tables: Array<{ name: string; data_loaded_at?: string | null }>,
): string | null {
  const m = (models ?? []).find((x) => x.name === model);
  // A warehouse model's table is refreshed by the warehouse on its own
  // schedule, which we do not observe. Null, and the caller says "unknown".
  if (!m || m.source_kind !== "data_table" || !m.source_table) return null;
  const want = m.source_table.toLowerCase();
  const t = (tables ?? []).find((x) => x.name?.toLowerCase() === want);
  return t?.data_loaded_at ?? null;
}

/** "3 days ago" — or null, which the caller must not print as "never". */
export function describeFreshness(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins || 1} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Counts for the catalog header — the shape of the layer at a glance. */
export function catalogSummary(metrics: CatalogMetric[]): {
  total: number;
  certified: number;
  draft: number;
  deprecated: number;
  models: number;
} {
  const models = new Set(metrics.map((m) => m.model));
  return {
    total: metrics.length,
    certified: metrics.filter((m) => m.status === "certified").length,
    draft: metrics.filter((m) => m.status === "draft").length,
    deprecated: metrics.filter((m) => m.status === "deprecated").length,
    models: models.size,
  };
}
