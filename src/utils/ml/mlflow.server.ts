// MLflow import and export (R533): the I/O around src/lib/mlflowFormat.ts.
//
// EXPORT builds the model folder here, in the app, and runs no Python: the
// files are text this platform wrote (MLmodel, the loader, the scoring
// program, the environment) and the version's own artifact, its digest
// checked against the registry before it goes into the zip.
//
// IMPORT never unpickles in the app. The app reads only the MLmodel YAML and
// the archive's listing; the pickled file is staged in the lake and opened in
// a sandbox by the training program's import mode, which checks it and
// writes the version's artifact (train.server.ts runs it as a job).
import { createHash, randomUUID } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

import {
  MLFLOW_CONFIG_FILE,
  MLFLOW_DATA_FILE,
  MLFLOW_LOADER_MODULE,
  MLFLOW_PROGRAM_MODULE,
  MLFLOW_PYTHON_VERSION,
  MLFLOW_TASKS,
  condaYaml,
  mlflowColType,
  mlmodelYaml,
  pythonEnvYaml,
  readMlmodel,
  requirementsFor,
  type TrainedRuntime,
} from "@/lib/mlflowFormat";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { loadModelForUser, type MlModelRow, type MlVersionRow } from "./access.server";
import { MLFLOW_LOADER_PY } from "./mlflowLoader";
import type { MlImportConfig, MlImportSource, MlTrainConfig } from "./types";
import { TRAIN_PY } from "./pyTrain";

type Fail = { ok: false; status: number; error: string };

/** A file name for the download: the model's name, made safe, and the version. */
export function exportFolderName(modelName: string, version: number): string {
  const slug =
    modelName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "model";
  return `${slug}-v${version}`;
}

/** A version's artifact bytes from the lake, checked against its recorded digest. */
export async function readVersionArtifact(
  version: Pick<MlVersionRow, "artifact_uri" | "artifact_sha256">,
): Promise<{ ok: true; bytes: Buffer } | Fail> {
  if (!version.artifact_uri || !version.artifact_sha256) {
    return { ok: false, status: 409, error: "That version has no artifact." };
  }
  const { lakeTarget } = await import("@/utils/ml/experimentArtifacts.server");
  const lake = await lakeTarget();
  if (!lake)
    return { ok: false, status: 503, error: "This server has no lakehouse storage set up." };
  const { presignS3 } = await import("@/utils/lakehouse/presign.server");
  const { artifactKeyOf } = await import("@/utils/ml/lakeManifest");
  const url = presignS3({
    target: lake.target,
    key: artifactKeyOf(version.artifact_uri),
    method: "GET",
    expiresSeconds: 300,
    which: "app",
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) {
    return {
      ok: false,
      status: 502,
      error: `Could not read the model's artifact (${res.status}).`,
    };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== version.artifact_sha256.toLowerCase()) {
    return {
      ok: false,
      status: 409,
      error: `The stored artifact does not match the digest the registry recorded (${version.artifact_sha256.slice(0, 12)} recorded, ${sha.slice(0, 12)} stored), so it was not exported.`,
    };
  }
  return { ok: true, bytes };
}

/**
 * One version of a model as an MLflow model folder, zipped.
 *
 * Owner only: the artifact is the model itself, and a person a model is
 * shared with may score with it but has never been able to take it away.
 */
export async function exportMlflowZip(args: {
  userId: string;
  modelId: string;
  versionId: string;
}): Promise<{ ok: true; bytes: Uint8Array; filename: string } | Fail> {
  let model;
  try {
    ({ model } = await loadModelForUser(args.modelId, args.userId, { write: true }));
  } catch {
    return { ok: false, status: 404, error: "Model not found" };
  }
  if (!(MLFLOW_TASKS as readonly string[]).includes(model.task)) {
    return {
      ok: false,
      status: 400,
      error: `A ${model.task} model is answered from what it stored, not by a model that scores rows, so there is nothing to export in the MLflow format.`,
    };
  }
  const { data: version } = await supabaseAdmin
    .from("ml_model_versions")
    .select("*")
    .eq("id", args.versionId)
    .eq("model_id", model.id)
    .maybeSingle();
  if (!version || version.status !== "ready") {
    return { ok: false, status: 404, error: "That version is not ready to export." };
  }
  const built = await buildMlflowFolder(model, version);
  if (!built.ok) return built;
  const { folder, files: rel, exact } = built;
  const files: Zippable = {};
  for (const [path, bytes] of Object.entries(rel)) {
    // The artifact is already compressed by joblib: stored, not deflated again.
    files[`${folder}/${path}`] = path === MLFLOW_DATA_FILE ? [bytes, { level: 0 }] : bytes;
  }
  const bytes = zipSync(files, { level: 6, mtime: built.createdAt });

  auditEvent({
    userId: args.userId,
    action: "ml.export",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    detail: {
      format: "mlflow",
      version: version.version,
      version_id: version.id,
      artifact_sha256: version.artifact_sha256,
      library_versions_recorded: exact,
    },
  });
  return { ok: true, bytes, filename: `${folder}-mlflow.zip` };
}

/**
 * The files of one version's MLflow model folder, by path inside the folder.
 *
 * No access check: the caller has one. The zip download checks the person is
 * the owner; the tracking sync (mlflowTracking.server.ts) runs for the owner,
 * toward the owner's own tracking server.
 */
export async function buildMlflowFolder(
  model: Pick<MlModelRow, "id" | "name" | "task" | "target_column" | "user_id">,
  version: MlVersionRow,
): Promise<
  | {
      ok: true;
      folder: string;
      files: Record<string, Uint8Array>;
      exact: boolean;
      createdAt: Date;
    }
  | Fail
> {
  const art = await readVersionArtifact(version);
  if (!art.ok) return art;

  // The config the scoring program reads: the same one a warm scorer loads.
  const { mlScoreBundleFor } = await import("./serve.server");
  const bundle = await mlScoreBundleFor(
    { model_id: model.id, version_id: version.id },
    model.user_id,
    { standalone: true },
  );
  if ("error" in bundle) return { ok: false, status: 409, error: bundle.error };

  const runtime = ((version.config as { runtime?: TrainedRuntime | null } | null)?.runtime ??
    null) as TrainedRuntime | null;
  const req = requirementsFor(runtime, { algorithm: version.algorithm });
  const python =
    runtime?.python && /^\d+\.\d+(\.\d+)?$/.test(runtime.python)
      ? runtime.python
      : MLFLOW_PYTHON_VERSION;
  const schema = (Array.isArray(version.feature_schema) ? version.feature_schema : []) as {
    name: string;
    dtype: string;
    role: string;
  }[];
  const now = new Date();
  const folder = exportFolderName(model.name, version.version);
  // THE DECISION LINE GOES WITH IT. The app applies the version's threshold
  // per request (it is a setting, not part of the artifact), so the scorer's
  // config never holds it, and an export built from that config alone
  // answered at argmax where the app answered at the owner's line: found by
  // the UI test, on a model whose line is 0.3.
  const decision =
    model.task === "classification"
      ? {
          threshold: version.decision_threshold ?? null,
          positiveLabel: version.positive_label ?? null,
        }
      : null;
  const mlmodel = mlmodelYaml({
    modelUuid: randomUUID().replace(/-/g, ""),
    createdAt: now,
    python,
    schema,
    decision,
    metadata: {
      source: "agentswarms",
      model_id: model.id,
      model_name: model.name,
      version: version.version,
      task: model.task,
      algorithm: version.algorithm ?? null,
      target_column: model.target_column ?? null,
      artifact_sha256: version.artifact_sha256,
      exported_at: now.toISOString(),
      library_versions: req.exact ? "as trained" : "not recorded; the runtime image's minimums",
      ...(decision?.threshold != null
        ? { decision_threshold: decision.threshold, positive_label: decision.positiveLabel }
        : {}),
    },
  });
  // MLflow checks inputs against the signature, and under pandas 3 it refuses
  // date STRINGS for a datetime column (text columns are no longer `object`).
  // Measured with MLflow 3.18 + pandas 3.1, so the README says what to pass.
  const dateCols = schema
    .filter((f) => f.role === "feature" && mlflowColType(f.dtype) === "datetime")
    .map((f) => f.name);
  const readme = [
    `# ${model.name}, version ${version.version}`,
    "",
    "An MLflow model exported from AgentSwarms. It scores rows through the same program",
    "AgentSwarms runs, so a row gets the same answer here as there.",
    "",
    "```python",
    "import mlflow.pyfunc, pandas as pd",
    `model = mlflow.pyfunc.load_model("${folder}")`,
    "rows = pd.DataFrame([...])  # the columns in MLmodel's signature",
    ...dateCols.map(
      (c) => `rows[${JSON.stringify(c)}] = pd.to_datetime(rows[${JSON.stringify(c)}])`,
    ),
    "model.predict(rows)",
    "```",
    "",
    ...(dateCols.length
      ? [
          `Date columns (${dateCols.join(", ")}) take datetimes, as above: MLflow's input check refuses date text.`,
          "",
        ]
      : []),
    ...(decision?.threshold != null
      ? [
          `It answers ${decision.positiveLabel != null ? JSON.stringify(decision.positiveLabel) : "the second class"} when that class's probability is at least ${decision.threshold}, the line this version had when exported. Move it per call: \`model.predict(rows, params={"decision_threshold": 0.5})\`.`,
          "",
        ]
      : decision
        ? [
            'It answers the most probable class. To answer a class at a chosen line instead: `model.predict(rows, params={"decision_threshold": 0.3, "positive_label": "<class>"})`.',
            "",
          ]
        : []),
    req.exact
      ? "requirements.txt pins the library versions this version was trained with."
      : "This version was trained before AgentSwarms recorded library versions, so requirements.txt gives the runtime image's minimums. A pickled scikit-learn pipeline loads reliably under the release that wrote it: if loading warns or fails, install the scikit-learn release current when the version was trained.",
    "",
    `The artifact (${MLFLOW_DATA_FILE}) is checked against its SHA-256 (${version.artifact_sha256}) when it loads.`,
    "",
  ].join("\n");

  const files: Record<string, Uint8Array> = {
    MLmodel: strToU8(mlmodel),
    "README.md": strToU8(readme),
    "requirements.txt": strToU8(req.text),
    "python_env.yaml": strToU8(pythonEnvYaml(python)),
    "conda.yaml": strToU8(condaYaml(python, req.text)),
    [MLFLOW_DATA_FILE]: new Uint8Array(art.bytes),
    [`code/${MLFLOW_LOADER_MODULE}.py`]: strToU8(MLFLOW_LOADER_PY),
    [`code/${MLFLOW_PROGRAM_MODULE}.py`]: strToU8(TRAIN_PY),
    [`code/${MLFLOW_CONFIG_FILE}`]: strToU8(
      JSON.stringify(
        decision
          ? {
              ...bundle.config,
              decision_threshold: decision.threshold,
              positive_label: decision.positiveLabel,
            }
          : bundle.config,
        null,
        2,
      ),
    ),
  };
  return { ok: true, folder, files, exact: req.exact, createdAt: now };
}

// ── Import ────────────────────────────────────────────────────────────────

/** The most an imported MLflow model may weigh, zipped (ML_IMPORT_MAX_MB). */
export function importMaxBytes(): number {
  const mb = Number(process.env.ML_IMPORT_MAX_MB);
  return (Number.isFinite(mb) && mb >= 1 && mb <= 4096 ? Math.floor(mb) : 500) * 1024 * 1024;
}

/** MLmodel is YAML of a few kilobytes; one much larger is not an MLmodel. */
const MLMODEL_MAX_BYTES = 1024 * 1024;

export type ZipEntry = { name: string; size: number };

/** The archive's entries and their declared sizes, without inflating any. */
export function zipListing(bytes: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];
  unzipSync(bytes, {
    filter: (f) => {
      entries.push({ name: f.name, size: f.originalSize });
      return false;
    },
  });
  return entries;
}

/**
 * One entry's bytes. fflate inflates into a buffer of the DECLARED size and
 * never grows it, so an entry that lies about its size (a zip bomb) comes out
 * cut to that size rather than filling memory: measured, 5 MB declared as
 * 1,000 bytes came out as 1,000 bytes, no error. A model cut short is staged
 * as what it is and fails to load in the sandbox. The length check catches
 * an entry that inflates to LESS than it declares.
 */
export function zipEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array | null {
  const out = unzipSync(bytes, { filter: (f) => f.name === entry.name });
  const data = out[entry.name];
  return data && data.length === entry.size ? data : null;
}

/**
 * Why a file said to be skops is not one, or null when it is (R536). A skops
 * file is a zip whose schema.json describes the objects and whose arrays are
 * .npy entries; a pickle renamed model.skops is not, and is refused here
 * before anything is staged. Only the listing is read: the sandbox, where
 * skops itself checks every type, is what opens it.
 */
export function skopsArchiveProblem(file: Uint8Array): string | null {
  let entries: ZipEntry[];
  try {
    entries = zipListing(file);
  } catch {
    return "MLmodel says the model is saved as skops, but its file is not a skops archive.";
  }
  if (!entries.some((e) => e.name === "schema.json")) {
    return "MLmodel says the model is saved as skops, but its file has no schema.json, so it is not a skops archive.";
  }
  return null;
}

/** Where the MLmodel file is: at the top, or in the one folder the zip holds. */
export function findMlmodel(entries: ZipEntry[]): ZipEntry | null {
  const found = entries
    .filter((e) => e.name === "MLmodel" || e.name.endsWith("/MLmodel"))
    .sort((a, b) => a.name.split("/").length - b.name.split("/").length);
  return found[0] ?? null;
}

/**
 * Bring an MLflow model in as the next version of a model (R533).
 *
 * The app reads the zip's listing and the MLmodel file, and opens nothing
 * else: the model file is staged in the lake under the model's own prefix,
 * and the version's job opens it in a sandbox. Owner only, as training is.
 */
export async function importMlflowZip(args: {
  userId: string;
  modelId: string;
  bytes: Uint8Array;
  fileName: string;
  /** Set when the model was taken from an MLflow server (R535). */
  source?: MlImportSource;
}): Promise<{ ok: true; versionId: string; version: number; jobId: string } | Fail> {
  let model;
  try {
    ({ model } = await loadModelForUser(args.modelId, args.userId, { write: true }));
  } catch {
    return { ok: false, status: 404, error: "Model not found" };
  }
  if (!(MLFLOW_TASKS as readonly string[]).includes(model.task)) {
    return {
      ok: false,
      status: 400,
      error: `A ${model.task} model cannot take an imported model. Import into a classification, regression, clustering or anomaly model.`,
    };
  }
  const cap = importMaxBytes();
  const mb = (n: number) => Math.round(n / 1048576);
  if (args.bytes.length > cap) {
    return {
      ok: false,
      status: 413,
      error: `The zip is ${mb(args.bytes.length)} MB, above the ${mb(cap)} MB import limit (ML_IMPORT_MAX_MB).`,
    };
  }
  let entries: ZipEntry[];
  try {
    entries = zipListing(args.bytes);
  } catch {
    return {
      ok: false,
      status: 400,
      error: "That file is not a zip. Zip the folder MLflow saved the model in, and upload that.",
    };
  }
  const mlmodelEntry = findMlmodel(entries);
  if (!mlmodelEntry) {
    return {
      ok: false,
      status: 400,
      error:
        "The zip has no MLmodel file. Zip the folder MLflow saved the model in (the one holding MLmodel).",
    };
  }
  if (mlmodelEntry.size > MLMODEL_MAX_BYTES) {
    return { ok: false, status: 400, error: "The MLmodel file is too large to be one." };
  }
  const mlmodelBytes = zipEntry(args.bytes, mlmodelEntry);
  if (!mlmodelBytes)
    return { ok: false, status: 400, error: "The MLmodel file in the zip is damaged." };
  const read = readMlmodel(strFromU8(mlmodelBytes));
  if (!read.ok) return { ok: false, status: 400, error: read.error };
  const plan = read.plan;
  const base = mlmodelEntry.name.slice(0, mlmodelEntry.name.length - "MLmodel".length);
  const fileEntry = entries.find((e) => e.name === base + plan.modelFile);
  if (!fileEntry) {
    return {
      ok: false,
      status: 400,
      error: `MLmodel names ${plan.modelFile}, which is not in the zip.`,
    };
  }
  if (fileEntry.size > cap) {
    return {
      ok: false,
      status: 413,
      error: `The model file is above the ${mb(cap)} MB import limit (ML_IMPORT_MAX_MB).`,
    };
  }
  const file = zipEntry(args.bytes, fileEntry);
  if (!file) return { ok: false, status: 400, error: `${plan.modelFile} in the zip is damaged.` };
  if (plan.kind === "sklearn" && plan.serialization === "skops") {
    const problem = skopsArchiveProblem(file);
    if (problem) return { ok: false, status: 400, error: problem };
  }
  const sha256 = createHash("sha256").update(file).digest("hex");

  // Staged under the model's own prefix; only this import's job may read it
  // (its lake manifest names this key and no other).
  const { lakeTarget } = await import("@/utils/ml/experimentArtifacts.server");
  const lake = await lakeTarget();
  if (!lake)
    return { ok: false, status: 503, error: "This server has no lakehouse storage set up." };
  const { s3PutObject } = await import("@/utils/lakehouse/presign.server");
  const { lakeObjectKmsKey } = await import("@/utils/lakehouse/customerKeyFiles.server");
  const fileName = plan.modelFile.split("/").pop() || "model.pkl";
  const key = `ml-artifacts/${model.id}/imports/${randomUUID()}/${fileName}`;
  try {
    await s3PutObject(lake.target, key, Buffer.from(file), {
      kmsKeyId: await lakeObjectKmsKey(model.user_id),
    });
  } catch (e) {
    return {
      ok: false,
      status: 502,
      error: `Could not stage the model file: ${(e as Error).message}`,
    };
  }

  const { data: last } = await supabaseAdmin
    .from("ml_model_versions")
    .select("version")
    .eq("model_id", model.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = (last?.version ?? 0) + 1;
  const imp: MlImportConfig = {
    format: "mlflow",
    kind: plan.kind,
    flavor: plan.flavor,
    uri: `s3://${lake.bucket}/${key}`,
    sha256,
    features: plan.features,
    file_name: args.fileName.slice(0, 200),
    ...(args.source ? { source: args.source } : {}),
    ...(plan.kind === "sklearn"
      ? {
          serialization: plan.serialization,
          sklearn_version: plan.sklearnVersion,
          ...(plan.serialization === "skops" ? { skops_asked: plan.skopsAsked } : {}),
        }
      : {}),
  };
  const { createAndTrainVersion } = await import("./api.server");
  const config = {
    time_budget_minutes: 10,
    max_rows: 0,
    validation_fraction: 0.2,
    tuning: "none",
    prep: {},
    import: imp,
  } as unknown as MlTrainConfig;
  const started = await createAndTrainVersion(model, config, version, {
    trigger: "import",
    external: true,
  });
  if (!started.ok) return { ok: false, status: 409, error: started.error };
  // AN EXPORT'S OWN DECISION LINE COMES BACK WITH IT. The app never copies a
  // line between versions (their probabilities may not mean the same thing),
  // but this is not that: the artifact is the one the line was set for, and
  // the file declares the line as what it answers at. Without it, a version
  // exported and imported again answered at argmax where the original
  // answered at 0.3 (found by the UI test). Only for a classifier, and the
  // owner can move or clear it like any other line.
  const decision =
    plan.kind === "agentswarms" && model.task === "classification" ? plan.decision : null;
  if (decision) {
    const { error } = await supabaseAdmin
      .from("ml_model_versions")
      .update({ decision_threshold: decision.threshold, positive_label: decision.positiveLabel })
      .eq("id", started.versionId);
    if (error) {
      console.warn(
        `[ml] import v${version}: the decision line in the file could not be set: ${error.message}`,
      );
    }
  }
  auditEvent({
    userId: args.userId,
    action: "ml.import.started",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    detail: {
      format: "mlflow",
      flavor: plan.flavor,
      ...(plan.kind === "sklearn" ? { serialization: plan.serialization } : {}),
      version,
      version_id: started.versionId,
      file_sha256: sha256,
      file_name: imp.file_name,
      ...(args.source ? { from_server: args.source } : {}),
      ...(decision
        ? { decision_threshold: decision.threshold, positive_label: decision.positiveLabel }
        : {}),
    },
  });
  return { ok: true, versionId: started.versionId, version, jobId: started.jobId };
}
