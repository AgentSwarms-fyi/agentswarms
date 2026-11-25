// Where a model is tracked on an MLflow server, and what each version's sync
// did (R534). Shared by the page and the server: the shapes stored in
// ml_models.tracking and ml_model_versions.tracking, their defaults, and the
// rules a name must meet before anything is sent.

export type ModelTracking = {
  /** An `integrations` row of type mlflow, owned by the model's owner. */
  integration_id: string;
  experiment: string;
  registered_model: string;
  /** The registered-model alias that follows the production version. */
  alias: string;
  enabled: boolean;
  /** The registered version the alias was last moved to, or null when taken away. */
  alias_version?: string | null;
  /** Why the alias could not be moved at the last promotion, until it is. */
  alias_error?: string;
  alias_failed_at?: string;
};

export type VersionTracking = {
  /** The tracking server's address when this was synced, for links. */
  server?: string;
  experiment_id?: string;
  run_id?: string;
  /** Parameters and metrics were logged to the run. */
  logged?: boolean;
  /** The model folder was uploaded as the run's `model` artifact. */
  artifacts?: boolean;
  registered_model?: string;
  registered_version?: string;
  synced_at?: string;
  /** Why the last sync did not finish; the run id above may still be reused. */
  error?: string;
  failed_at?: string;
  /** Something the person should know that is not a failure. */
  note?: string;
};

export const DEFAULT_ALIAS = "production";

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function parseModelTracking(v: unknown): ModelTracking | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const integration_id = str(o.integration_id);
  if (!/^[0-9a-f-]{36}$/i.test(integration_id)) return null;
  return {
    integration_id,
    experiment: str(o.experiment),
    registered_model: str(o.registered_model),
    alias: str(o.alias) || DEFAULT_ALIAS,
    enabled: o.enabled !== false,
    ...(typeof o.alias_version === "string" && /^\d{1,9}$/.test(o.alias_version)
      ? { alias_version: o.alias_version }
      : o.alias_version === null
        ? { alias_version: null }
        : {}),
    ...(str(o.alias_error) ? { alias_error: str(o.alias_error) } : {}),
    ...(str(o.alias_failed_at) ? { alias_failed_at: str(o.alias_failed_at) } : {}),
  };
}

export function parseVersionTracking(v: unknown): VersionTracking | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: VersionTracking = {};
  for (const k of [
    "server",
    "experiment_id",
    "run_id",
    "registered_model",
    "registered_version",
    "synced_at",
    "error",
    "failed_at",
    "note",
  ] as const) {
    if (typeof o[k] === "string" && o[k]) out[k] = o[k] as string;
  }
  if (o.logged === true) out.logged = true;
  if (o.artifacts === true) out.artifacts = true;
  return out;
}

/** A name as MLflow will take it: no slashes, colons, percent signs or control characters. */
function registryName(name: string): string {
  return (
    name
      .replace(/[/:%\p{Cc}]+/gu, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200) || "model"
  );
}

export function defaultExperiment(modelName: string): string {
  return `agentswarms/${modelName.replace(/\p{Cc}+/gu, " ").trim()}`.slice(0, 250);
}

export function defaultRegisteredModel(modelName: string): string {
  return registryName(modelName);
}

/** Why a tracking setting cannot be saved, or null when it can. */
export function trackingProblem(
  t: Pick<ModelTracking, "experiment" | "registered_model" | "alias">,
): string | null {
  const exp = t.experiment.trim();
  if (!exp) return "Name the MLflow experiment the runs go to.";
  if (exp.length > 250 || /\p{Cc}/u.test(exp)) {
    return "An experiment name has at most 250 characters and no control characters.";
  }
  const reg = t.registered_model.trim();
  if (!reg) return "Name the registered model the versions go to.";
  if (reg.length > 200 || /[/:%\p{Cc}]/u.test(reg)) {
    return "A registered model's name has at most 200 characters and no slash, colon or percent sign.";
  }
  const alias = t.alias.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(alias)) {
    return "An alias has letters, digits, hyphens and underscores only (at most 64).";
  }
  if (alias.toLowerCase() === "latest" || /^v\d+$/i.test(alias)) {
    return 'MLflow reserves "latest" and names like "v3" for itself. Choose another alias.';
  }
  return null;
}

// ── Links ─────────────────────────────────────────────────────────────────
// Built from checked parts only: the stored tracking is writable by the
// model's owner, and a link someone the model is shared with clicks must be
// an http(s) address with plain ids in it, never anything a browser runs.

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An http(s) origin and path, or null: never anything a browser would run. */
export function httpBase(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function runLink(t: VersionTracking | null): string | null {
  const base = httpBase(t?.server);
  if (!base || !t?.experiment_id || !t.run_id) return null;
  if (!ID.test(t.experiment_id) || !ID.test(t.run_id)) return null;
  return `${base}/#/experiments/${encodeURIComponent(t.experiment_id)}/runs/${encodeURIComponent(t.run_id)}`;
}
