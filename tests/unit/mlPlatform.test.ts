// ML platform, milestone 1: registry + training. What is pinned here is the
// wiring that would fail silently — a job whose bundle the source route does
// not recognise, a result callback that finalises ETL runs but not training
// jobs, a grant type the UI offers but the database rejects, a token that
// expires under a two-hour job — plus the trainer program itself, which is
// checked for Python syntax with the interpreter when one is installed.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { ML_JOB_KEY, ML_PRIMARY_METRIC, ML_TASKS, mlJobStashOf } from "@/utils/ml/types";
import { TRAIN_PY } from "@/utils/ml/pyTrain";
import { mlArtifactUri, mlErrorMessage, ML_REQUIREMENTS } from "@/utils/ml/train.server";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const MIGRATION = "supabase/migrations/20260854000000_ml_platform.sql";

describe("job stash", () => {
  it("recognises a training session and nothing else", () => {
    expect(mlJobStashOf({ [ML_JOB_KEY]: { job_id: "abc" } })).toEqual({
      job_id: "abc",
      kind: "train",
    });
    expect(mlJobStashOf({ __etl_preview: { pipeline_id: "p", node_id: "n" } })).toBeNull();
    expect(mlJobStashOf({ [ML_JOB_KEY]: { job_id: "" } })).toBeNull();
    expect(mlJobStashOf(null)).toBeNull();
    expect(mlJobStashOf("x")).toBeNull();
  });
});

describe("artifact location", () => {
  it("lives beside the lake data path, never inside it", () => {
    const uri = mlArtifactUri("s3://lakehouse/main", "m1", 3);
    expect(uri).toBe("s3://lakehouse/ml-artifacts/m1/v3/model.joblib");
    expect(uri.startsWith("s3://lakehouse/main")).toBe(false);
  });
  it("refuses a non-s3 data url", () => {
    expect(() => mlArtifactUri("gs://x/y", "m", 1)).toThrow();
  });
});

describe("the trainer program", () => {
  it("cannot break the template literal that carries it", () => {
    expect(TRAIN_PY).not.toContain("`");
    expect(TRAIN_PY).not.toContain("$" + "{");
  });

  it("defines the entry point and every stage the server relies on", () => {
    for (const fn of [
      "def entrypoint(inputs):",
      "def _read_frame(con, cfg):",
      "def _train_tabular(df, cfg, warnings_):",
      "def _train_forecast(df, cfg, warnings_):",
      "def _upload(blob):",
      "def _expand_datetimes(X, dt_cols):",
    ]) {
      expect(TRAIN_PY).toContain(fn);
    }
    // The winner is reported under the same metric names the UI labels.
    for (const task of ML_TASKS) expect(TRAIN_PY).toContain(`'${ML_PRIMARY_METRIC[task]}'`);
    // Artifacts are hashed before the URI travels back.
    expect(TRAIN_PY).toContain("hashlib.sha256(blob).hexdigest()");
    expect(TRAIN_PY).toContain("os.environ['ML_ARTIFACT_URI']");
    // Sampling above the row limit is declared, and forecasting refuses to sample.
    expect(TRAIN_PY).toContain("USING SAMPLE reservoir(");
    expect(TRAIN_PY).toContain("'training_sampled': bool(sampled)");
  });

  it("never pickles a class it defined itself", () => {
    // A class defined in the exec'd namespace pickles by reference to a module
    // that does not exist at load time; the program must only use functions.
    expect(TRAIN_PY).not.toMatch(/^class /m);
  });

  it("is valid Python (checked with the interpreter when available)", () => {
    const probe = spawnSync("python", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) return; // no interpreter on this machine; syntax is covered by the live run
    const dir = mkdtempSync(path.join(tmpdir(), "ml-train-"));
    const file = path.join(dir, "train.py");
    writeFileSync(file, TRAIN_PY + "\n_ML_CONFIG = {}\n");
    const r = spawnSync(
      "python",
      ["-c", "import ast, sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", file],
      { encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("requirements are baked into the image and repeated for older ones", () => {
  it("lists the same packages in both places", () => {
    const req = rd("docker/notebook-runtime/requirements.txt");
    for (const r of ML_REQUIREMENTS) {
      const name = r.split(">=")[0];
      expect(req).toContain(name);
    }
    // LightGBM needs the OpenMP runtime; python:3.12-slim does not ship it.
    expect(rd("docker/notebook-runtime/Dockerfile")).toContain("libgomp1");
  });
});

describe("the runtime carries a training job end to end", () => {
  const source = rd("src/routes/api/notebook.runtime.source.ts");
  const result = rd("src/routes/api/notebook.runtime.result.ts");
  const service = rd("src/utils/notebookRuntime/service.server.ts");
  const token = rd("src/utils/notebookRuntime/token.server.ts");
  const schedule = rd("src/utils/etl/schedule.server.ts");

  it("source route serves the program and the env by the job stash", () => {
    expect(source).toContain("mlJobStashOf(session?.inputs)");
    expect(source).toContain("m.mlEnvFor(stash, claims.sub)");
    expect(source).toContain("m.mlBundleFor(stash, claims.sub)");
    // ML dispatch happens before the MCP/notebook fallbacks.
    expect(source.indexOf("mlJobStashOf")).toBeLessThan(source.indexOf("session?.mcp_app_id"));
  });

  it("result route streams partial logs and finalises the job", () => {
    expect(result).toContain('.select("etl_run_id, inputs")');
    expect(result).toContain("appendMlPartialLogs(mlStash.job_id");
    expect(result).toContain("finalizeMlJob(mlStash.job_id");
  });

  it("a batch token lives as long as its session, not one hour", () => {
    expect(token).toContain("86_400");
    expect(token).not.toContain("?? 900, 3600)");
    expect(service).toContain("ttlSeconds: maxMin * 60,");
    expect(service).not.toContain("Math.min(maxMin * 60, 3600)");
  });

  it("training may size its own sandbox", () => {
    expect(service).toContain("memLimitMb?: number;");
    expect(service).toContain("maxMinutes?: number;");
    expect(rd("src/utils/ml/train.server.ts")).toContain("memLimitMb: limits.mlTrainMemLimitMb");
  });

  it("makes the egress proxy admit the lake endpoint before any sandbox starts", () => {
    // Found live: squid denied the MinIO host with a 403 that DuckDB called an
    // authentication failure, because the allow-list only reached the proxy
    // when an admin saved the runtime settings.
    expect(rd("src/utils/ml/train.server.ts")).toContain("await ensurePlatformEgress()");
    expect(rd("src/utils/etl/service.server.ts")).toContain("ensurePlatformEgress()");
    const egress = rd("src/utils/notebookRuntime/egressApply.server.ts");
    expect(egress).toContain("export async function ensurePlatformEgress");
    // No write and no proxy restart when the files already match.
    expect(egress).toContain("return { applied: true, hosts: all.length };");
  });

  it("translates the proxy's 403 into an explanation instead of a credential hunt", () => {
    const raw =
      "_duckdb.HTTPException: HTTP Error: HTTP GET error reading 'http://192.168.1.85:19000/lakehouse/main/a/b.parquet' in region '' (HTTP 403 Forbidden)\n\nAuthentication Failure - this is usually caused by invalid or missing credentials.";
    const msg = mlErrorMessage(raw);
    expect(msg).toContain("egress proxy refused the lake endpoint http://192.168.1.85:19000");
    expect(msg).toContain("credentials are fine");
    expect(msg).toContain("Authentication Failure"); // the raw tail is kept
    expect(mlErrorMessage("ValueError: nope")).toBe("ValueError: nope");
  });

  it("orphaned jobs are swept with the ETL runs", () => {
    expect(schedule).toContain("reconcileOrphanedMlJobs()");
  });
});

describe("governance", () => {
  const migration = rd(MIGRATION);

  it("adds the grant type to the FULL constraint list", () => {
    const list = migration.slice(
      migration.indexOf("iam_resource_grants_resource_type_check\n  CHECK"),
    );
    for (const t of [
      "knowledge_base",
      "data_table",
      "secret",
      "bi_dashboard",
      "semantic_model",
      "catalog_source",
      "integration",
      "provider_credential",
      "warehouse_connection",
      "saas_connection",
      "ai_analyst",
      "lakehouse_schema",
      "ml_model",
    ]) {
      expect(list).toContain(`'${t}'`);
    }
  });

  it("is offered, accepted and resolved everywhere grant types are listed", () => {
    expect(rd("src/utils/iam.functions.ts")).toContain('"ml_model",\n        ]),');
    expect(rd("src/utils/iam.functions.ts")).toContain('resource_type: "ml_model" as const');
    expect(rd("src/utils/iam.functions.ts")).toContain("mlModelById.get(g.resource_id)");
    expect(rd("src/utils/iam.server.ts")).toContain('| "ml_model"');
    expect(rd("src/routes/_authenticated/admin.iam.tsx")).toContain('{ value: "ml_model", label:');
    expect(rd("src/utils/ml/access.server.ts")).toContain(
      'resolveGrantedResourceIds(supabaseAdmin, userId, "ml_model")',
    );
  });

  it("shares are read-only: SELECT policies only, owner policies untouched", () => {
    const shared =
      migration.match(/CREATE POLICY "Shared ML [^"]+"\s+ON public\.\w+ FOR (\w+)/g) ?? [];
    expect(shared.length).toBe(3);
    for (const p of shared) expect(p.endsWith("FOR SELECT")).toBe(true);
    expect(migration).toContain("has_resource_access('ml_model', id, auth.uid())");
    expect(migration).toContain("has_resource_access('ml_model', model_id, auth.uid())");
  });

  it("model CRUD is audited by trigger, and promotion changes are in the WHEN clause", () => {
    expect(migration).toContain("audit_row_change('ml_model')");
    expect(migration).toContain(
      "OLD.production_version_id IS DISTINCT FROM NEW.production_version_id",
    );
  });

  it("training runs and predictions are decision kinds", () => {
    expect(migration).toContain("'ml_training', 'ml_prediction'");
    const kinds = rd("src/utils/provenance/decision.server.ts");
    expect(kinds).toContain('"ml_training"');
    expect(kinds).toContain('"ml_prediction"');
    const train = rd("src/utils/ml/train.server.ts");
    expect(train).toContain('const TRAINING_DECISION_KIND: DecisionKind = "ml_training";');
    expect(train).toContain("kind: TRAINING_DECISION_KIND,");
    expect(train).toContain("lakehouseSnapshotId()");
  });

  it("every explicit audit action follows the dotted convention", () => {
    const train = rd("src/utils/ml/train.server.ts") + rd("src/utils/ml.functions.ts");
    const actions = [...train.matchAll(/action: "([^"]+)"/g)].map((m) => m[1]);
    expect(actions.length).toBeGreaterThanOrEqual(5);
    for (const a of actions) expect(a).toMatch(/^ml\.[a-z_]+(\.[a-z_]+)?$/);
    expect(actions).toContain("ml.train.start");
    expect(actions).toContain("ml.train.succeeded");
    expect(actions).toContain("ml.train.failed");
    expect(actions).toContain("ml.version.promote");
  });
});

describe("limits are settings, not constants", () => {
  const config = rd("src/utils/notebookRuntime/config.server.ts");
  const ENV = [
    "ML_TRAIN_MAX_ROWS",
    "ML_TRAIN_TIME_BUDGET_MINUTES",
    "ML_TRAIN_MEM_LIMIT_MB",
    "ML_MAX_CONCURRENT_TRAININGS_PER_USER",
    "ML_PREDICT_MAX_ROWS",
  ];

  it("each limit resolves settings row -> env -> default", () => {
    for (const name of ENV) {
      expect(config).toContain(`envInt("${name}")`);
      const col = name.toLowerCase();
      expect(config).toContain(`positive(data?.${col})`);
      expect(rd(MIGRATION)).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
  });

  it("is documented where operators look, and editable in the admin page", () => {
    const env = rd(".env.example");
    const docs = rd("docs/SCALE_AND_LIMITS.md");
    for (const name of ENV) {
      expect(env).toContain(name);
      expect(docs).toContain(name);
    }
    const tab = rd("src/components/admin/RuntimeTab.tsx");
    for (const name of ENV) expect(tab).toContain(name.toLowerCase());
  });

  it("profiling checks schema access itself, because SUMMARIZE bypasses the guard's extraction", () => {
    const fns = rd("src/utils/ml.functions.ts");
    const profile = fns.slice(
      fns.indexOf("export const mlProfileSource"),
      fns.indexOf("const createSchema"),
    );
    expect(profile.indexOf("accessibleSchemas(userId)")).toBeGreaterThan(0);
    expect(profile.indexOf("accessibleSchemas(userId)")).toBeLessThan(
      profile.indexOf("SUMMARIZE SELECT"),
    );
  });

  it("the wizard cannot exceed the operator's row limit", () => {
    expect(rd("src/utils/ml.functions.ts")).toContain(
      "Math.min(input.max_rows ?? lim.train_max_rows, lim.train_max_rows)",
    );
  });
});

describe("the ML area is reachable", () => {
  it("has its routes, nav entry and docs-checker entry", () => {
    const routes = readdirSync(path.join(REPO, "src/routes/_authenticated"));
    expect(routes).toContain("ml.tsx");
    expect(routes).toContain("ml_.new.tsx");
    expect(routes).toContain("ml_.$modelId.tsx");
    expect(rd("src/lib/appNav.ts")).toContain('url: "/ml"');
    expect(rd("scripts/check-docs.mjs")).toContain('"ML Models"');
  });

  it("destructive actions go through the app dialog", () => {
    const detail = rd("src/routes/_authenticated/ml_.$modelId.tsx");
    expect(detail).toContain('actionLabel: "Delete model"');
    expect(detail).toContain("await confirmAsk(");
    expect(detail).not.toMatch(/\bwindow\.confirm\(/);
  });
});
