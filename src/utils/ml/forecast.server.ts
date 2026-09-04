// Registry forecast models as BI can use them.
//
// A forecast version stores the points it projected when it trained. BI
// widgets that attach a version carry those points inside their chart spec
// (so the chart, the scheduled refresh and the alert evaluator all read the
// same numbers without a sandbox), and a dashboard refresh brings them up to
// date from the registry as the dashboard's OWNER — a viewer never widens
// what the owner may see.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { forecastVersionId, type ForecastSetting } from "@/lib/mlForecast";
import { accessibleModelIds } from "./access.server";
import type { MlForecastPoint, MlHistoryPoint } from "./types";

export type MlForecastVersionOption = {
  id: string;
  model_id: string;
  model_name: string;
  version: number;
  label: string;
  horizon: number | null;
  trained_at: string | null;
  target_column: string;
  time_column: string | null;
  points: MlForecastPoint[];
  history: MlHistoryPoint[];
  shared: boolean;
};

type StoredForecast = { points?: MlForecastPoint[]; history?: MlHistoryPoint[] } | null;

/** Every ready forecast version the user may use, newest first. */
export async function listForecastVersionsForUser(
  userId: string,
): Promise<MlForecastVersionOption[]> {
  const { own, shared } = await accessibleModelIds(userId);
  const ids = [...own, ...shared];
  if (!ids.length) return [];
  const { data: models } = await supabaseAdmin
    .from("ml_models")
    .select("id, name, task, horizon, target_column, time_column")
    .in("id", ids)
    .eq("task", "forecast");
  if (!models?.length) return [];
  const byId = new Map(models.map((m) => [m.id, m]));
  const { data: versions } = await supabaseAdmin
    .from("ml_model_versions")
    .select("id, model_id, version, trained_at, forecast, stage")
    .in(
      "model_id",
      models.map((m) => m.id),
    )
    .eq("status", "ready")
    .neq("stage", "archived")
    .order("trained_at", { ascending: false });
  return (versions ?? []).flatMap((v) => {
    const m = byId.get(v.model_id);
    const f = v.forecast as StoredForecast;
    if (!m || !f?.points?.length) return [];
    return [
      {
        id: v.id,
        model_id: m.id,
        model_name: m.name,
        version: v.version,
        label: `${m.name} · v${v.version}${v.stage === "production" ? " (production)" : ""}`,
        horizon: m.horizon,
        trained_at: v.trained_at,
        target_column: m.target_column,
        time_column: m.time_column,
        points: f.points,
        history: f.history ?? [],
        shared: !own.has(m.id),
      },
    ];
  });
}

/** One version's projection, if the user may use its model. */
export async function forecastPointsForUser(
  versionId: string,
  userId: string,
): Promise<{ points: MlForecastPoint[]; trained_at: string | null; model: string } | null> {
  const { data: v } = await supabaseAdmin
    .from("ml_model_versions")
    .select("id, model_id, version, trained_at, forecast, status")
    .eq("id", versionId)
    .maybeSingle();
  if (!v || v.status !== "ready") return null;
  const { own, shared } = await accessibleModelIds(userId);
  if (!own.has(v.model_id) && !shared.has(v.model_id)) return null;
  const { data: m } = await supabaseAdmin
    .from("ml_models")
    .select("name")
    .eq("id", v.model_id)
    .maybeSingle();
  const f = v.forecast as StoredForecast;
  if (!f?.points?.length) return null;
  return {
    points: f.points,
    trained_at: v.trained_at,
    model: `${m?.name ?? "model"} · v${v.version}`,
  };
}

/**
 * Refresh the projected points every widget carries for an attached version,
 * as the dashboard's owner. Widgets whose version is gone or no longer
 * accessible keep their last points and are flagged stale, so a chart never
 * silently becomes a straight line.
 */
export async function syncForecastVersions(
  widgets: Array<{ chart?: unknown }>,
  ownerId: string,
): Promise<number> {
  let updated = 0;
  for (const w of widgets) {
    const chart = w.chart as { forecast?: ForecastSetting } | undefined;
    const versionId = forecastVersionId(chart?.forecast);
    if (!chart || !versionId || typeof chart.forecast !== "object") continue;
    const fresh = await forecastPointsForUser(versionId, ownerId);
    if (fresh) {
      chart.forecast = {
        ...chart.forecast,
        points: fresh.points,
        trainedAt: fresh.trained_at ?? undefined,
        model: fresh.model,
      };
      updated += 1;
    } else {
      (chart.forecast as { stale?: boolean }).stale = true;
    }
  }
  return updated;
}

/** Helper for callers holding a Json-typed widgets array. */
export function widgetsWithCharts(widgets: Json): Array<{ chart?: unknown }> {
  return Array.isArray(widgets) ? (widgets as Array<{ chart?: unknown }>) : [];
}
