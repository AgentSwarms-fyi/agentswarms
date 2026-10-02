// The seam between a notebook and the registry: the artifact a run saved
// through the platform, and the version it becomes.
//
// A kernel never holds the lake bucket's credentials — user code runs there —
// so the bytes come to the app with the session token and the app writes
// them beside the trainer's own artifacts, computing the digest itself. What
// the registry then verifies before loading is a digest the platform took,
// not one the caller reported. Registration reuses the external-version path
// end to end: same contract, same audit row, same promotion rules.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  EXTERNAL_TASKS,
  algorithmOf,
  artifactFileName,
  checkRegistrable,
  promotableMetrics,
  type ExternalTask,
} from "@/lib/experiments";
import { auditEvent } from "@/utils/audit.server";
import { accessibleSchemas, lakehouseConfig } from "@/utils/lakehouse/core.server";
import { s3PutObject, type S3Target } from "@/utils/lakehouse/presign.server";
import { registerExternalVersion } from "@/utils/ml/api.server";
import type { MlModelRow } from "@/utils/ml/access.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";

type Fail = { ok: false; error: string; status: number };

/** The lake bucket as a signing target, from the same settings the engine attaches with. */
export function lakeTarget(): { target: S3Target; bucket: string; dataUrl: string } | null {
  const cfg = lakehouseConfig();
  if (!cfg) return null;
  const m = /^s3a?:\/\/([^/]+)/.exec(cfg.dataUrl);
  if (!m) return null;
  return {
    bucket: m[1],
    dataUrl: cfg.dataUrl,
    target: {
      endpoint: cfg.s3.endpoint,
      region: cfg.s3.region || "us-east-1",
      useSsl: cfg.s3.useSsl,
      urlStyle: cfg.s3.urlStyle === "path" ? "path" : "vhost",
      bucket: m[1],
      accessKeyId: cfg.s3.keyId,
      secretAccessKey: cfg.s3.secret,
    },
  };
}

/** Where a run's artifact lives: beside the trainer's, under the run's own id. */
export function experimentArtifactKey(runId: string, name: string): string {
  return `ml-artifacts/experiments/${runId}/${artifactFileName(name)}`;
}

/**
 * Store the bytes a run uploaded and record them on the run. The caller
 * states the digest it expects; the app hashes what actually arrived and
 * refuses a mismatch rather than recording a digest nothing will verify.
 */
export async function putExperimentArtifact(args: {
  userId: string;
  runId: string;
  name: string;
  body: Buffer;
  claimedSha256: string | null;
}): Promise<
  | { ok: true; artifact_uri: string; artifact_sha256: string; bytes: number; max_bytes: number }
  | Fail
> {
  const lake = lakeTarget();
  if (!lake) return { ok: false, error: "The lakehouse is not configured", status: 503 };
  const { data: run } = await supabaseAdmin
    .from("ml_experiment_runs")
    .select("id, status")
    .eq("id", args.runId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (!run) return { ok: false, error: "Run not found", status: 404 };
  if (run.status !== "running") {
    return { ok: false, error: `That run already ${run.status}`, status: 409 };
  }
  const limits = await getPlatformResources();
  const maxBytes = limits.mlArtifactMaxMb * 1024 * 1024;
  if (args.body.length === 0) return { ok: false, error: "The artifact is empty", status: 400 };
  if (args.body.length > maxBytes) {
    return {
      ok: false,
      error: `The artifact is ${Math.round(args.body.length / 1048576)} MB, above the ${limits.mlArtifactMaxMb} MB limit (Admin → Developer runtime → Machine learning, or ML_ARTIFACT_MAX_MB)`,
      status: 413,
    };
  }
  const key = experimentArtifactKey(args.runId, args.name);
  const put = await s3PutObject(lake.target, key, args.body);
  if (args.claimedSha256 && args.claimedSha256.toLowerCase() !== put.sha256) {
    return {
      ok: false,
      error: `The bytes received hash to ${put.sha256.slice(0, 12)}…, not the ${args.claimedSha256.slice(0, 12)}… the client computed — the upload was corrupted in transit; try again`,
      status: 400,
    };
  }
  const uri = `s3://${lake.bucket}/${key}`;
  const { error } = await supabaseAdmin
    .from("ml_experiment_runs")
    .update({ artifact_uri: uri, artifact_sha256: put.sha256, artifact_bytes: put.bytes })
    .eq("id", args.runId)
    .eq("user_id", args.userId);
  if (error) return { ok: false, error: error.message, status: 400 };
  return {
    ok: true,
    artifact_uri: uri,
    artifact_sha256: put.sha256,
    bytes: put.bytes,
    max_bytes: maxBytes,
  };
}

export type FeatureSchemaEntry = {
  name: string;
  dtype: "numeric" | "categorical" | "boolean" | "datetime" | "text";
  role: "feature" | "target" | "dropped";
  categories?: string[];
};

export type RegisterRunInput = {
  userId: string;
  runId: string;
  /** The model by id, or by name — created under the caller when the name is new. */
  model: { id: string } | { name: string };
  task?: string;
  /** Required to create a model: the lakehouse table the training data came from. */
  source?: { schema: string; table: string };
  target_column?: string;
  description?: string;
  algorithm?: string;
  feature_schema?: FeatureSchemaEntry[];
  classes?: string[];
  metrics?: Record<string, number | null>;
  promote?: boolean;
  /** Who is registering: the notebook client, the API, or the panel. */
  via: "notebook" | "api" | "ui";
};

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * A finished run with an artifact becomes a version of a model — an existing
 * one, or one created here so a notebook can register in a single call. The
 * model's own path does the rest: registerExternalVersion checks the URI and
 * digest, writes the registry's audit row, and leaves the version a
 * candidate unless promotion was asked for.
 */
export async function registerRunAsVersion(input: RegisterRunInput): Promise<
  | {
      ok: true;
      model_id: string;
      model_name: string;
      created_model: boolean;
      version_id: string;
      version: number;
    }
  | Fail
> {
  const { data: run } = await supabaseAdmin
    .from("ml_experiment_runs")
    .select(
      "id, name, experiment_id, params, metrics, artifact_uri, artifact_sha256, registered_version_id, status, started_at",
    )
    .eq("id", input.runId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (!run) return { ok: false, error: "Run not found", status: 404 };
  // Registering is the end of a run, so a run still open is closed here
  // rather than refused: the notebook that trained the model is the one
  // calling, and asking it to say "finish" first would only add a step.
  if (run.status === "running") {
    const finishedAt = new Date();
    await supabaseAdmin
      .from("ml_experiment_runs")
      .update({
        status: "finished",
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - new Date(run.started_at).getTime(),
      })
      .eq("id", run.id)
      .eq("user_id", input.userId);
    run.status = "finished";
  }
  const registrable = checkRegistrable(run);
  if (!registrable.ok) return { ok: false, error: registrable.error, status: 409 };

  let model: MlModelRow | null = null;
  let created = false;
  if ("id" in input.model) {
    const { data } = await supabaseAdmin
      .from("ml_models")
      .select("*")
      .eq("id", input.model.id)
      .maybeSingle();
    model = (data as MlModelRow | null) ?? null;
    if (!model) return { ok: false, error: "Model not found", status: 404 };
  } else {
    const name = input.model.name.trim();
    if (!name || name.length > 120) {
      return { ok: false, error: "A model name is 1 to 120 characters", status: 400 };
    }
    const { data } = await supabaseAdmin
      .from("ml_models")
      .select("*")
      .eq("user_id", input.userId)
      .eq("name", name)
      .maybeSingle();
    model = (data as MlModelRow | null) ?? null;
    if (!model) {
      const made = await createModelForRun(input, name);
      if (!made.ok) return made;
      model = made.model;
      created = true;
    }
  }
  if (model.user_id !== input.userId) {
    // Registering a version changes what a model serves. Read access
    // through a share is not enough to do that.
    return { ok: false, error: "Only the model's owner can register a version", status: 403 };
  }
  if (input.task && input.task !== model.task) {
    return {
      ok: false,
      error: `Model "${model.name}" is a ${model.task} model; this run says ${input.task}`,
      status: 409,
    };
  }
  if (!(EXTERNAL_TASKS as readonly string[]).includes(model.task)) {
    return {
      ok: false,
      error: `External versions are supported for ${EXTERNAL_TASKS.join(", ")} models, not ${model.task}`,
      status: 409,
    };
  }

  const done = await registerExternalVersion(
    model,
    {
      artifact_uri: registrable.artifactUri,
      artifact_sha256: registrable.artifactSha256,
      algorithm: input.algorithm?.trim() || algorithmOf(run.params),
      // Only the plain numeric metrics travel: `loss@7` is a point on a
      // curve, and a leaderboard mixing those with scores would rank steps.
      metrics: input.metrics ?? promotableMetrics(run.metrics),
      feature_schema: input.feature_schema,
      classes: input.classes,
      promote: input.promote,
    },
    { userId: input.userId, apiKeyId: null },
  );
  if (!done.ok) return { ok: false, error: done.error, status: 409 };

  await supabaseAdmin
    .from("ml_experiment_runs")
    .update({ registered_version_id: done.versionId })
    .eq("id", run.id);

  auditEvent({
    userId: input.userId,
    action: "ml.experiment.promote",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    detail: {
      run_id: run.id,
      run_name: run.name,
      experiment_id: run.experiment_id,
      version: done.version,
      version_id: done.versionId,
      via: input.via,
      created_model: created || undefined,
    },
  });
  return {
    ok: true,
    model_id: model.id,
    model_name: model.name,
    created_model: created,
    version_id: done.versionId,
    version: done.version,
  };
}

/**
 * A model made for a run: the task the artifact serves, the lakehouse table
 * its data came from (checked as the caller, the way the wizard checks it),
 * and the target for the tasks that predict one.
 */
async function createModelForRun(
  input: RegisterRunInput,
  name: string,
): Promise<{ ok: true; model: MlModelRow } | Fail> {
  const task = input.task as ExternalTask | undefined;
  if (!task || !(EXTERNAL_TASKS as readonly string[]).includes(task)) {
    return {
      ok: false,
      error: `Creating model "${name}" needs a task: one of ${EXTERNAL_TASKS.join(", ")}`,
      status: 400,
    };
  }
  const source = input.source;
  if (!source || !SCHEMA_NAME.test(source.schema) || !TABLE_NAME.test(source.table)) {
    return {
      ok: false,
      error: `Creating model "${name}" needs source={"schema": …, "table": …} — the lakehouse table the training data came from`,
      status: 400,
    };
  }
  const allowed = await accessibleSchemas(input.userId);
  if (!allowed.some((s) => s.name === source.schema)) {
    return {
      ok: false,
      error: `No access to lakehouse schema "${source.schema}" — it doesn't exist, or nobody shared it with you`,
      status: 403,
    };
  }
  const needsTarget = task === "classification" || task === "regression";
  const target = input.target_column?.trim() || null;
  if (needsTarget && !target) {
    return {
      ok: false,
      error: `Creating a ${task} model needs target_column — the column the model predicts`,
      status: 400,
    };
  }
  const features = (input.feature_schema ?? [])
    .filter((f) => f.role === "feature")
    .map((f) => f.name);
  const { data, error } = await supabaseAdmin
    .from("ml_models")
    .insert({
      user_id: input.userId,
      name,
      description: input.description?.trim().slice(0, 2000) || null,
      task,
      source: { kind: "lakehouse", schema: source.schema, table: source.table } as Json,
      target_column: needsTarget ? target : null,
      feature_columns: features.length ? features : null,
      prep: {} as Json,
      period: "auto",
    })
    .select("*")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not create the model", status: 400 };
  }
  auditEvent({
    userId: input.userId,
    action: "ml.model.create",
    resourceType: "ml_model",
    resourceId: data.id,
    resourceName: name,
    detail: { task, source, via: input.via, from_run: input.runId },
  });
  return { ok: true, model: data as MlModelRow };
}
