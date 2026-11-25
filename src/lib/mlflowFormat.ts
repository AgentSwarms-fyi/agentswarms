// MLflow model format (R533): what an exported model folder holds, and what
// an imported one may be. Pure; the I/O is src/utils/ml/mlflow.server.ts.
//
// An MLflow model is a folder with an `MLmodel` file (YAML) naming its
// flavors, its input signature and its environment. Anything that reads that
// format (MLflow's own registry and `mlflow.pyfunc.load_model`, model servers
// with an MLflow runtime, pipelines built on it) can then load the model.
//
// EXPORT writes the `python_function` flavor with a loader module of our own
// (`agentswarms_mlflow`), which runs the SAME scoring program the platform
// runs: one scoring implementation, whoever calls it. The artifact is the
// version's own file, its digest checked on the way out and again on load.
//
// IMPORT takes a scikit-learn model (the `sklearn` flavor, or
// `python_function` loading through `mlflow.sklearn`) or one this platform
// exported. Nothing here unpickles anything: the file is opened in a sandbox.
import yaml from "js-yaml";

export const MLFLOW_LOADER_MODULE = "agentswarms_mlflow";
export const MLFLOW_PROGRAM_MODULE = "agentswarms_program";
export const MLFLOW_DATA_FILE = "model.joblib";
export const MLFLOW_CONFIG_FILE = "agentswarms.json";
/** The Python the runtime image runs (docker/notebook-runtime/Dockerfile). */
export const MLFLOW_PYTHON_VERSION = "3.12";

/** Tasks that score rows, and so have something to export or import. */
export { MLFLOW_TASKS } from "./mlflowTasks";

type SchemaField = { name: string; dtype: string; role: string };

/** A column's type as MLflow's column signature names it. */
export function mlflowColType(dtype: string): "double" | "string" | "boolean" | "datetime" {
  switch (dtype) {
    case "numeric":
      return "double";
    case "boolean":
      return "boolean";
    case "datetime":
      return "datetime";
    default:
      return "string";
  }
}

/** And back: a signature column's type as this platform's feature dtype. */
export function dtypeFromMlflow(type: string): "numeric" | "categorical" | "boolean" | "datetime" {
  switch (type) {
    case "double":
    case "float":
    case "long":
    case "integer":
      return "numeric";
    case "boolean":
      return "boolean";
    case "datetime":
      return "datetime";
    default:
      return "categorical";
  }
}

/**
 * The input signature: the feature columns, in order, none required, because
 * the scoring program fills a missing column the way training did.
 */
export function signatureInputs(schema: SchemaField[]): string {
  return JSON.stringify(
    schema
      .filter((f) => f.role === "feature")
      .map((f) => ({ type: mlflowColType(f.dtype), name: f.name, required: false })),
  );
}

/** The library versions a version was trained with, when it recorded them. */
export type TrainedRuntime = Partial<
  Record<"python" | "scikit-learn" | "lightgbm" | "numpy" | "pandas" | "joblib" | "scipy", string>
>;

/** Lower bounds when a version did not record what it was trained with. */
export const RUNTIME_FLOORS: Record<string, string> = {
  "scikit-learn": ">=1.4",
  lightgbm: ">=4.0",
  numpy: "",
  pandas: "",
  joblib: ">=1.3",
  scipy: ">=1.11",
};

const VERSION_RE = /^\d+(\.\d+){0,3}([a-z]+\d*)?$/i;

/**
 * requirements.txt for an exported model. Pinned exactly to what the version
 * was trained with when it recorded that (a pickled pipeline loads reliably
 * only under the scikit-learn that wrote it); otherwise the runtime image's
 * floors, and `exact` false so the export can say so.
 */
export function requirementsFor(runtime: TrainedRuntime | null | undefined): {
  text: string;
  exact: boolean;
} {
  const lines: string[] = [];
  let exact = Boolean(runtime && Object.keys(runtime).length > 0);
  for (const [pkg, floor] of Object.entries(RUNTIME_FLOORS)) {
    const v = runtime?.[pkg as keyof TrainedRuntime];
    if (v && VERSION_RE.test(v)) lines.push(`${pkg}==${v}`);
    else {
      exact = false;
      lines.push(`${pkg}${floor}`);
    }
  }
  return { text: lines.join("\n") + "\n", exact };
}

export function pythonEnvYaml(python: string): string {
  return yaml.dump(
    {
      python,
      build_dependencies: ["pip"],
      dependencies: ["-r requirements.txt"],
    },
    { lineWidth: -1 },
  );
}

export function condaYaml(python: string, requirements: string): string {
  return yaml.dump(
    {
      name: "mlflow-env",
      channels: ["conda-forge"],
      dependencies: [
        `python=${python}`,
        "pip",
        { pip: requirements.trim().split("\n").filter(Boolean) },
      ],
    },
    { lineWidth: -1 },
  );
}

export type MlmodelArgs = {
  modelUuid: string;
  createdAt: Date;
  python: string;
  schema: SchemaField[];
  metadata: Record<string, string | number | boolean | string[] | null>;
  /**
   * A classifier's decision line, as the version holds it when exported. It
   * becomes the signature's params, so MLflow passes it to predict and a
   * caller can move it. MLflow drops params a signature does not declare
   * (measured, 3.18), so without these the line could not be moved at all.
   */
  decision?: { threshold: number | null; positiveLabel: string | null } | null;
};

/** The signature's params: the decision line, for a classifier. */
export function signatureParams(decision: MlmodelArgs["decision"]): string | null {
  if (!decision) return null;
  return JSON.stringify([
    { name: "decision_threshold", type: "double", default: decision.threshold, shape: null },
    { name: "positive_label", type: "string", default: decision.positiveLabel, shape: null },
  ]);
}

/** The `MLmodel` file of an exported model. */
export function mlmodelYaml(a: MlmodelArgs): string {
  const t = a.createdAt.toISOString().replace("T", " ").replace("Z", "");
  return yaml.dump(
    {
      artifact_path: "model",
      flavors: {
        python_function: {
          loader_module: MLFLOW_LOADER_MODULE,
          code: "code",
          data: MLFLOW_DATA_FILE,
          env: { conda: "conda.yaml", virtualenv: "python_env.yaml" },
          python_version: a.python,
        },
      },
      model_uuid: a.modelUuid,
      utc_time_created: t,
      signature: {
        inputs: signatureInputs(a.schema),
        outputs: null,
        params: signatureParams(a.decision),
      },
      metadata: a.metadata,
    },
    { lineWidth: -1, noRefs: true },
  );
}

// ── Import ───────────────────────────────────────────────────────────────

export type ImportPlan =
  | {
      kind: "sklearn";
      /** The pickled estimator, relative to the model folder. */
      modelFile: string;
      serialization: "pickle" | "cloudpickle";
      sklearnVersion: string | null;
      /** From the signature; null when it has none (the sandbox reads the estimator's). */
      features: { name: string; dtype: string }[] | null;
      flavor: string;
    }
  | {
      kind: "agentswarms";
      modelFile: string;
      features: { name: string; dtype: string }[] | null;
      metadata: Record<string, unknown>;
      /** The decision line its signature declares, which is what MLflow applies. */
      decision: { threshold: number; positiveLabel: string | null } | null;
      flavor: string;
    };

/**
 * The decision line a signature's params declare, held to the same bounds as
 * setting one in the app (0–1, a label of at most 200 characters). Read from
 * the params rather than the metadata because the params default is what
 * MLflow passes to predict: if someone moved the line in the file, this is
 * the line the model answers at there.
 */
export function signatureDecision(
  signature: unknown,
): { threshold: number; positiveLabel: string | null } | null {
  const raw = (signature as { params?: unknown } | null)?.params;
  let params: unknown = raw;
  if (typeof raw === "string") {
    try {
      params = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(params)) return null;
  const byName = new Map(
    params
      .filter((p): p is { name: string; default?: unknown } => !!p && typeof p.name === "string")
      .map((p) => [p.name, p.default]),
  );
  const t = byName.get("decision_threshold");
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) return null;
  const l = byName.get("positive_label");
  const label = typeof l === "string" && l.trim() && l.trim().length <= 200 ? l.trim() : null;
  return { threshold: t, positiveLabel: label };
}

const SAFE_PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._\-/]{1,200}$/;

/** A file named inside MLmodel, if it is a plain path inside the folder. */
export function safeModelPath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const clean = p.replace(/^\.\/+/, "");
  return SAFE_PATH.test(clean) && !clean.includes("//") ? clean : null;
}

function signatureFeatures(sig: unknown): { name: string; dtype: string }[] | null | "tensor" {
  const inputs = (sig as { inputs?: unknown } | null)?.inputs;
  if (inputs == null) return null;
  let cols: unknown;
  try {
    cols = typeof inputs === "string" ? JSON.parse(inputs) : inputs;
  } catch {
    return null;
  }
  if (!Array.isArray(cols) || cols.length === 0) return null;
  const out: { name: string; dtype: string }[] = [];
  for (const c of cols as { type?: unknown; name?: unknown }[]) {
    if (c?.type === "tensor") return "tensor";
    if (typeof c?.name !== "string" || !c.name) return null;
    out.push({ name: c.name.slice(0, 128), dtype: dtypeFromMlflow(String(c.type ?? "string")) });
  }
  return out.slice(0, 1000);
}

/**
 * What an `MLmodel` file says, and whether this platform can take it.
 * Refuses in words, naming the flavor, rather than importing something it
 * cannot score.
 */
export function readMlmodel(
  text: string,
): { ok: true; plan: ImportPlan } | { ok: false; error: string } {
  let doc: unknown;
  try {
    // CORE_SCHEMA: plain scalars, maps and lists; no tags that build objects.
    doc = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  } catch (e) {
    return {
      ok: false,
      error: `The MLmodel file is not valid YAML: ${(e as Error).message.split("\n")[0]}`,
    };
  }
  const flavors = (doc as { flavors?: Record<string, Record<string, unknown>> } | null)?.flavors;
  if (!flavors || typeof flavors !== "object") {
    return { ok: false, error: "The MLmodel file names no flavors, so it is not an MLflow model." };
  }
  const features = signatureFeatures((doc as { signature?: unknown }).signature);
  if (features === "tensor") {
    return {
      ok: false,
      error:
        "This model's signature takes tensors. Import takes models whose input is named columns (a table).",
    };
  }
  const pyfunc = flavors.python_function;
  if (pyfunc?.loader_module === MLFLOW_LOADER_MODULE) {
    const file = safeModelPath(pyfunc.data);
    if (!file)
      return { ok: false, error: "The model's data path is not a plain file inside the folder." };
    return {
      ok: true,
      plan: {
        kind: "agentswarms",
        modelFile: file,
        features,
        metadata: ((doc as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<
          string,
          unknown
        >,
        decision: signatureDecision((doc as { signature?: unknown }).signature),
        flavor: "python_function (AgentSwarms)",
      },
    };
  }
  const sk = flavors.sklearn;
  const viaPyfunc = pyfunc?.loader_module === "mlflow.sklearn";
  if (sk || viaPyfunc) {
    const file = safeModelPath(sk?.pickled_model ?? pyfunc?.model_path);
    if (!file)
      return {
        ok: false,
        error: "The model's pickled file is not a plain file inside the folder.",
      };
    const ser = String(sk?.serialization_format ?? "cloudpickle");
    if (ser !== "pickle" && ser !== "cloudpickle") {
      return {
        ok: false,
        error: `This model is saved as "${ser}". Import takes pickle or cloudpickle; save it again with mlflow.sklearn and serialization_format="cloudpickle".`,
      };
    }
    return {
      ok: true,
      plan: {
        kind: "sklearn",
        modelFile: file,
        serialization: ser,
        sklearnVersion: typeof sk?.sklearn_version === "string" ? sk.sklearn_version : null,
        features,
        flavor: "sklearn",
      },
    };
  }
  const names = Object.keys(flavors).filter((f) => f !== "python_function");
  const named =
    names.length > 0
      ? names.join(", ")
      : `python_function (${String(pyfunc?.loader_module ?? "custom")})`;
  return {
    ok: false,
    error: `This model's flavor is ${named}. Import takes scikit-learn models (logged with mlflow.sklearn) and models exported from AgentSwarms.`,
  };
}
