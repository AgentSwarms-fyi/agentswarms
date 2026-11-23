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

import { ML_COUNT_METRICS } from "@/utils/ml/types";

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

// ── A model's own training, beside the runs (R527) ───────────────────────────
//
// Training here and logging a run from a notebook used to land in two places:
// versions on the model page, runs under Experiments, compared nowhere. Every
// version a model trained is now also read as a run, at read time, from the
// version itself: no copy to write or keep in step, and every version ever
// trained is there, not only those trained after this shipped. A model with
// an experiment linked to it shows its versions inside that experiment; any
// other model that trained shows as its own experiment, `model:<id>`.

/** The id of the experiment a model's own training shows as. */
export const MODEL_EXPERIMENT = "model:";
export const isModelExperiment = (id: string): boolean => id.startsWith(MODEL_EXPERIMENT);
/** The id a version has as a run. */
export const VERSION_RUN = "version:";

/** Metrics that count something rather than score it, so are no column to compare on. */
const NOT_A_SCORE = ML_COUNT_METRICS;

export type TrainedVersion = {
  id: string;
  model_id: string;
  version: number;
  status: string;
  stage: string;
  algorithm: string | null;
  metrics: unknown;
  config: unknown;
  training_rows: number | null;
  warnings: unknown;
  external: boolean | null;
  created_at: string;
  trained_at: string | null;
  /** The training job behind it: what started it, and why it failed. */
  job?: { trigger: string | null; error: string | null } | null;
};

/** What started a training, when it was not someone pressing Train. */
const STARTED_BY: Record<string, string> = {
  schedule: "scheduled",
  api: "API",
  approval: "proposed in chat",
};

export type VersionRun = {
  id: string;
  name: string;
  status: "running" | "finished" | "failed";
  params: ScalarMap;
  metrics: ScalarMap;
  tags: string[];
  notes: null;
  /** "platform": trained here. "registered": brought in from elsewhere. */
  source: "platform" | "registered";
  session_id: null;
  artifact_uri: null;
  artifact_sha256: null;
  registered_version_id: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  version: { id: string; model_id: string; number: number; stage: string };
};

/** A model version as a row beside the runs: its settings, its scores, how long it took. */
export function versionAsRun(v: TrainedVersion): VersionRun {
  const cfg = asScalarMap(v.config);
  const params: ScalarMap = {};
  if (v.algorithm) params.algorithm = v.algorithm;
  for (const k of ["tuning", "max_rows", "time_budget_minutes", "validation_fraction"]) {
    if (cfg[k] !== undefined && cfg[k] !== null) params[k] = cfg[k];
  }
  if (typeof v.training_rows === "number") params.training_rows = v.training_rows;
  const metrics: ScalarMap = {};
  for (const [k, val] of Object.entries(asScalarMap(v.metrics))) {
    if (typeof val === "number" && Number.isFinite(val) && !NOT_A_SCORE.has(k)) metrics[k] = val;
  }
  const status = v.status === "training" ? "running" : v.status === "ready" ? "finished" : "failed";
  const warnings = Array.isArray(v.warnings)
    ? v.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const started = Date.parse(v.created_at);
  const finished = v.trained_at ? Date.parse(v.trained_at) : NaN;
  return {
    id: `${VERSION_RUN}${v.id}`,
    name: `v${v.version}${v.algorithm ? ` · ${v.algorithm}` : ""}`,
    status,
    params,
    metrics,
    tags: [
      v.stage,
      ...(v.job?.trigger && STARTED_BY[v.job.trigger] ? [STARTED_BY[v.job.trigger]] : []),
    ],
    notes: null,
    source: v.external ? "registered" : "platform",
    session_id: null,
    artifact_uri: null,
    artifact_sha256: null,
    registered_version_id: v.id,
    error:
      v.status === "cancelled"
        ? "Cancelled before it finished."
        : v.status === "failed"
          ? v.job?.error?.trim().slice(0, 600) || warnings[0] || "Training failed."
          : null,
    started_at: v.created_at,
    finished_at: v.trained_at,
    duration_ms:
      Number.isFinite(started) && Number.isFinite(finished) && finished >= started
        ? finished - started
        : null,
    version: { id: v.id, model_id: v.model_id, number: v.version, stage: v.stage },
  };
}

/**
 * The runs of one experiment with its model's versions beside them, newest
 * first. A version a run was registered as is that run already, so it is not
 * shown twice.
 */
export function withVersionRuns<
  R extends { started_at: string; registered_version_id: string | null },
>(runs: R[], versions: TrainedVersion[]): Array<R | VersionRun> {
  const registered = new Set(runs.map((r) => r.registered_version_id).filter(Boolean));
  const extra = versions.filter((v) => !registered.has(v.id)).map(versionAsRun);
  return [...runs, ...extra].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}
