// Experiment tracking: the rules, with no database and no React in them.
//
// A run's params and metrics are flat maps of scalars. That is the whole data
// model, and it is a decision rather than an omission: a run whose parameters
// need a schema is a run nobody will compare with another one, and comparing
// runs is the entire point.
//
// The one wrinkle is the training curve. `log_metric("loss", v, step=7)` writes
// `loss@7` AND updates the bare `loss`, so a loop's history survives without
// giving up a single answer to "what did this run score". Everything here that
// looks like string surgery is about keeping those two apart: `loss@7` is a
// point on a curve, `loss` is the score, and a leaderboard that mixed them
// would rank steps against runs.

export type Scalar = string | number | boolean | null;
export type ScalarMap = Record<string, Scalar>;

/** How many runs one experiment may hold, so a runaway loop cannot fill a table. */
export const MAX_RUNS_PER_EXPERIMENT = 5000;

/**
 * How many named params or metrics one run may accumulate. A step writes a key,
 * which is the point — but a loop over 100k steps would put 100k keys in one
 * jsonb column, and a row nothing can render is not a record of anything.
 */
export const MAX_KEYS_PER_RUN = 2000;

/** The separator between a metric and the step it was measured at. */
export const STEP_SEP = "@";

export const isStepKey = (key: string): boolean => key.includes(STEP_SEP);

/** Read a value that arrived as jsonb as the flat map it is meant to be. */
export function asScalarMap(value: unknown): ScalarMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ScalarMap = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

/** The metric names a run is compared on: its scores, not its curve points. */
export function scoreKeys(metrics: unknown): string[] {
  return Object.entries(asScalarMap(metrics))
    .filter(([k, v]) => !isStepKey(k) && typeof v === "number")
    .map(([k]) => k);
}

/**
 * The metric columns for a table of runs, most widely recorded first — the
 * metric most runs have is the one they are being compared on.
 */
export function metricColumns(runs: { metrics: unknown }[], limit = 5): string[] {
  const seen = new Map<string, number>();
  for (const r of runs) {
    for (const k of scoreKeys(r.metrics)) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k]) => k);
}

/** One metric's curve, in step order. */
export function curveOf(metrics: unknown, key: string): { step: number; value: number }[] {
  const prefix = key + STEP_SEP;
  return Object.entries(asScalarMap(metrics))
    .filter(([k, v]) => k.startsWith(prefix) && typeof v === "number")
    .map(([k, v]) => ({ step: Number(k.slice(prefix.length)), value: v as number }))
    .filter((p) => Number.isFinite(p.step))
    .sort((a, b) => a.step - b.step);
}

/**
 * Which parameters actually differed across these runs. In a list of twenty,
 * the ones held constant are noise and the one that moved is the experiment —
 * so this is what the panel highlights.
 */
export function varyingParams(runs: { params: unknown }[]): Set<string> {
  const values = new Map<string, Set<string>>();
  for (const r of runs) {
    for (const [k, v] of Object.entries(asScalarMap(r.params))) {
      const set = values.get(k) ?? new Set<string>();
      set.add(JSON.stringify(v));
      values.set(k, set);
    }
  }
  // A parameter only one run recorded differed too: it was absent elsewhere.
  for (const [k, set] of values) {
    const present = runs.filter((r) => k in asScalarMap(r.params)).length;
    if (present < runs.length) set.add("__absent__");
  }
  return new Set([...values.entries()].filter(([, s]) => s.size > 1).map(([k]) => k));
}

/** Merge new entries over old, refusing rather than growing without bound. */
export function mergeCapped(
  existing: unknown,
  incoming: ScalarMap,
  what: string,
): { value: ScalarMap } | { error: string } {
  const merged: ScalarMap = { ...asScalarMap(existing), ...incoming };
  const keys = Object.keys(merged).length;
  if (keys > MAX_KEYS_PER_RUN) {
    return { error: `A run may hold ${MAX_KEYS_PER_RUN} ${what}; this would make ${keys}` };
  }
  return { value: merged };
}

/**
 * The metrics that travel with a promotion into the registry: the plain
 * numeric scores. A leaderboard that also held `loss@7` would be ranking a
 * step of one run against the final score of another.
 */
export function promotableMetrics(metrics: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(asScalarMap(metrics))) {
    if (isStepKey(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k.slice(0, 120)] = v;
  }
  return out;
}

export type RegistrableRun = {
  status: string;
  artifact_uri: string | null;
  artifact_sha256: string | null;
  registered_version_id: string | null;
};

/**
 * Whether this run can become a model version, and the artifact it would carry.
 *
 * Both artifact fields are required, not one: a version whose artifact nobody
 * can verify is not a version, and a URI with no digest is exactly that.
 */
export function checkRegistrable(
  run: RegistrableRun,
): { ok: true; artifactUri: string; artifactSha256: string } | { ok: false; error: string } {
  if (run.registered_version_id) {
    return { ok: false, error: "That run is already registered as a version" };
  }
  if (run.status === "running") return { ok: false, error: "That run has not finished yet" };
  if (!run.artifact_uri || !run.artifact_sha256) {
    return {
      ok: false,
      error:
        "That run did not record an artifact. Pass artifact_uri and artifact_sha256 to finish() to make a run registrable.",
    };
  }
  return { ok: true, artifactUri: run.artifact_uri, artifactSha256: run.artifact_sha256 };
}

/** Tasks a version trained elsewhere can serve; forecast and recommendation are the trainer's own. */
export const EXTERNAL_TASKS = ["classification", "regression", "clustering", "anomaly"] as const;
export type ExternalTask = (typeof EXTERNAL_TASKS)[number];

/**
 * The name an uploaded artifact is stored under: one path segment, the
 * characters a key can carry anywhere, and a joblib file unless the caller
 * said otherwise. A name that would climb out of the run's prefix cannot.
 */
export function artifactFileName(raw: string | null | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 120);
  return clean || "model.joblib";
}

/** The algorithm label a promoted run carries, when the run logged one. */
export function algorithmOf(params: unknown): string {
  const p = asScalarMap(params).algorithm;
  return typeof p === "string" && p.trim() ? p.trim().slice(0, 120) : "external";
}
