// Where a model's data comes from and where its answers go (R527).
//
// Nothing new is tracked: a model already records the table it trains on and
// its preparation's SQL, a batch prediction records what it read and wrote, a
// dashboard chart records the version whose forecast it draws, an agent
// records the models it may predict with, and a pipeline records the
// schedules it starts. This reads those facts into one picture, for the
// model's page and for the catalog entry of each table involved.
//
// Pure: the server and the catalog read the rows; this decides what they mean.
import { allDashboardWidgets } from "@/lib/biDashboards";
import { forecastVersionId, type ForecastSetting } from "@/lib/mlForecast";
import { extractTableRefs } from "@/lib/sqlRefs";

export type TableRef = { schema: string; table: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** `{schema, table}` from a stored source/input/output, or null. */
export function tableOf(v: unknown): TableRef | null {
  if (!isObj(v)) return null;
  const schema = typeof v.schema === "string" ? v.schema.trim() : "";
  const table = typeof v.table === "string" ? v.table.trim() : "";
  return schema && table ? { schema, table } : null;
}

export const tableName = (t: TableRef) => `${t.schema}.${t.table}`;

/**
 * The tables training reads: the model's source, and any other table its
 * preparation's SQL joins in. A preparation names tables the way SQL does,
 * so a bare name is read in the source's schema.
 */
export function modelReads(model: {
  source: unknown;
  prep?: unknown;
}): Array<{ table: string; via: "source" | "preparation" }> {
  const src = tableOf(model.source);
  const out: Array<{ table: string; via: "source" | "preparation" }> = [];
  if (src) out.push({ table: tableName(src), via: "source" });
  const sql = isObj(model.prep) && typeof model.prep.sql === "string" ? model.prep.sql : "";
  if (sql.trim()) {
    for (const ref of extractTableRefs(sql)) {
      const parts = ref.split(".");
      const name =
        parts.length >= 2 ? parts.slice(-2).join(".") : src ? `${src.schema}.${ref}` : ref;
      if (!out.some((r) => r.table.toLowerCase() === name.toLowerCase())) {
        out.push({ table: name, via: "preparation" });
      }
    }
  }
  return out;
}

export type PredictionRow = {
  model_id: string;
  status: string;
  input: unknown;
  output: unknown;
  finished_at: string | null;
};

/** The tables batch predictions wrote, most recent first, with how often. */
export function predictionWrites(
  rows: PredictionRow[],
): Array<{ table: string; from: string | null; runs: number; last_at: string | null }> {
  const by = new Map<
    string,
    { table: string; from: string | null; runs: number; last_at: string | null }
  >();
  for (const r of rows) {
    if (r.status !== "succeeded") continue;
    const out = tableOf(r.output);
    if (!out) continue;
    const name = tableName(out);
    const input = tableOf(r.input);
    const cur = by.get(name.toLowerCase()) ?? {
      table: name,
      from: input ? tableName(input) : null,
      runs: 0,
      last_at: null,
    };
    cur.runs += 1;
    if (r.finished_at && (!cur.last_at || r.finished_at > cur.last_at)) {
      cur.last_at = r.finished_at;
      if (input) cur.from = tableName(input);
    }
    by.set(name.toLowerCase(), cur);
  }
  return [...by.values()].sort((a, b) => ((a.last_at ?? "") < (b.last_at ?? "") ? 1 : -1));
}

/** Dashboards with a chart drawing one of these versions' forecasts. */
export function dashboardsDrawing(
  dashboards: Array<{ id: string; name: string; widgets: unknown; pages?: unknown }>,
  versionIds: Set<string>,
): Array<{ id: string; name: string; charts: string[] }> {
  const out: Array<{ id: string; name: string; charts: string[] }> = [];
  for (const d of dashboards) {
    const charts: string[] = [];
    for (const w of allDashboardWidgets(d)) {
      if (!isObj(w)) continue;
      const chart = isObj(w.chart) ? w.chart : null;
      const vid = forecastVersionId(chart?.forecast as ForecastSetting | undefined);
      if (vid && versionIds.has(vid)) {
        charts.push(typeof w.title === "string" && w.title.trim() ? w.title : "a chart");
      }
    }
    if (charts.length) out.push({ id: d.id, name: d.name, charts });
  }
  return out;
}

/**
 * Agents that may predict with this model: the prediction tool turned on,
 * and either this model on its list or no list at all (which means every
 * model its owner can use).
 */
export function agentsUsing(
  agents: Array<{ id: string; name: string; tools: unknown }>,
  modelName: string,
): Array<{ id: string; name: string; anyModel: boolean }> {
  const out: Array<{ id: string; name: string; anyModel: boolean }> = [];
  for (const a of agents) {
    const t = isObj(a.tools) ? a.tools : {};
    const on = isObj(t.builtInTools) && t.builtInTools.ml_predict === true;
    if (!on) continue;
    const cfg =
      isObj(t.toolConfigs) && isObj(t.toolConfigs.ml_predict) ? t.toolConfigs.ml_predict : {};
    const names = Array.isArray(cfg.model_names) ? cfg.model_names : null;
    if (names === null) out.push({ id: a.id, name: a.name, anyModel: true });
    else if (names.some((n) => typeof n === "string" && n.trim() === modelName)) {
      out.push({ id: a.id, name: a.name, anyModel: false });
    }
  }
  return out;
}

/** Pipelines that start one of these schedules when they finish. */
export function pipelinesStarting(
  pipelines: Array<{ id: string; name: string; chain_ml_schedules: string[] | null }>,
  scheduleIds: Set<string>,
): Array<{ id: string; name: string }> {
  return pipelines
    .filter((p) => (p.chain_ml_schedules ?? []).some((s) => scheduleIds.has(s)))
    .map((p) => ({ id: p.id, name: p.name }));
}

export type MlModelLineage = {
  reads: Array<{ table: string; via: "source" | "preparation" }>;
  writes: Array<{ table: string; from: string | null; runs: number; last_at: string | null }>;
  dashboards: Array<{ id: string; name: string; charts: string[] }>;
  agents: Array<{ id: string; name: string; anyModel: boolean }>;
  schedules: Array<{ id: string; name: string; kind: string; is_active: boolean }>;
  pipelines: Array<{ id: string; name: string }>;
};

/** What a catalog entry says about the models that use its table. */
export type MlTableUse = {
  modelId: string;
  modelName: string;
  /** "trains on it", "scored by it", "predictions written here". */
  detail: string;
  /** For a table predictions were written to: the table they were made from. */
  derivedFrom?: string;
};

/** Every table a set of models touches, and how. Keyed by lower-case schema.table. */
export function mlTableUses(
  models: Array<{ id: string; name: string; source: unknown; prep?: unknown }>,
  predictions: PredictionRow[],
): Map<string, MlTableUse[]> {
  const out = new Map<string, MlTableUse[]>();
  const add = (table: string, use: MlTableUse) => {
    const k = table.toLowerCase();
    const list = out.get(k) ?? [];
    const same = list.find((u) => u.modelId === use.modelId && u.detail === use.detail);
    if (!same) list.push(use);
    out.set(k, list);
  };
  const byId = new Map(models.map((m) => [m.id, m]));
  for (const m of models) {
    for (const r of modelReads(m)) {
      add(r.table, { modelId: m.id, modelName: m.name, detail: "trains on it" });
    }
  }
  const rowsByModel = new Map<string, PredictionRow[]>();
  for (const p of predictions) {
    if (!byId.has(p.model_id)) continue;
    rowsByModel.set(p.model_id, [...(rowsByModel.get(p.model_id) ?? []), p]);
  }
  for (const [modelId, rows] of rowsByModel) {
    const m = byId.get(modelId)!;
    for (const w of predictionWrites(rows)) {
      if (w.from) add(w.from, { modelId, modelName: m.name, detail: "scored by it" });
      add(w.table, {
        modelId,
        modelName: m.name,
        detail: "predictions written here",
        ...(w.from ? { derivedFrom: w.from } : {}),
      });
    }
  }
  return out;
}
