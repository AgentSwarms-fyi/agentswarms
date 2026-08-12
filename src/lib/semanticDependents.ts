// Who depends on a semantic model?
//
// Metric-backed widgets re-run against the CURRENT definition on every
// refresh — that is the semantic layer's whole point, and exactly why editing
// a model needs an answer to "what moves if I change this?" BEFORE the edit.
// These scanners are pure functions over the stored jsonb shapes; the server
// fn feeds them real rows, tests feed them fixtures of the same shapes.
import type { Json } from "@/integrations/supabase/types";

export type WidgetDependent = { dashboardId: string; dashboardName: string; widgets: string[] };
export type NamedDependent = { id: string; name: string };

/** Dashboards whose widgets run a governed query against `modelName`. */
export function scanDashboardsForModel(
  dashboards: Array<{ id: string; name: string; widgets: Json }>,
  modelName: string,
): WidgetDependent[] {
  const out: WidgetDependent[] = [];
  for (const d of dashboards) {
    if (!Array.isArray(d.widgets)) continue;
    const hits: string[] = [];
    for (const w of d.widgets as Array<Record<string, unknown>>) {
      const source = w?.source as { kind?: unknown; model?: unknown } | undefined;
      if (source?.kind === "semantic" && source.model === modelName) {
        hits.push(String(w.title ?? w.id ?? "untitled widget"));
      }
    }
    if (hits.length > 0) out.push({ dashboardId: d.id, dashboardName: d.name, widgets: hits });
  }
  return out;
}

/**
 * Does this config jsonb allow-list `modelName` for metric_query?
 *
 * Two storage shapes exist and both are scanned by deep walk rather than by
 * pinned paths: agents store `…toolConfigs.metric_query.model_names`
 * (translated to `metric_model_names` at assembly time), swarm nodes store
 * `…tool_configs.metric_model_names` directly. A walk survives the next
 * nesting change; a pinned path silently reports "no dependents" — the worst
 * possible answer from a safety feature.
 */
export function configReferencesModel(config: Json, modelName: string): boolean {
  const seen = new Set<unknown>();
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some(walk);
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (
        (key === "metric_model_names" || key === "model_names") &&
        Array.isArray(value) &&
        value.includes(modelName)
      ) {
        // `model_names` is only the metric allow-list inside a metric_query
        // block; a bare `model_names` elsewhere must not count.
        if (key === "metric_model_names") return true;
        // key === "model_names": accept only under a metric_query parent —
        // handled by the caller's recursion below.
      }
      if (key === "metric_query" && value && typeof value === "object") {
        const names = (value as Record<string, unknown>).model_names;
        if (Array.isArray(names) && names.includes(modelName)) return true;
      }
      if (walk(value)) return true;
    }
    return false;
  };
  return walk(config);
}

/** Agents whose tool config allow-lists `modelName`. */
export function scanAgentsForModel(
  agents: Array<{ id: string; name: string; tools: Json }>,
  modelName: string,
): NamedDependent[] {
  return agents
    .filter((a) => configReferencesModel(a.tools, modelName))
    .map((a) => ({ id: a.id, name: a.name }));
}

/** Swarms with a node whose tool config allow-lists `modelName` (draft or published graph). */
export function scanSwarmsForModel(
  swarms: Array<{ id: string; name: string; nodes: Json; published_nodes?: Json | null }>,
  modelName: string,
): NamedDependent[] {
  return swarms
    .filter(
      (s) =>
        configReferencesModel(s.nodes, modelName) ||
        configReferencesModel(s.published_nodes ?? null, modelName),
    )
    .map((s) => ({ id: s.id, name: s.name }));
}
