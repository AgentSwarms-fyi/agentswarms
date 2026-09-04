// ML platform, milestone 5: a model published as an API. What is pinned here
// is the agreement that keeps the public routes honest — every route
// authenticates with the one helper and asks for the right scope, the app's
// server functions and the routes share one service (no private shortcut
// around the limits or the audit trail), the key format and hashing match
// the notebook precedent, the database attributes what a key started, and
// the docs name every endpoint that exists and none that does not.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ML_KEY_PREFIX,
  ML_KEY_SCOPES,
  generateMlApiKey,
  hashMlApiKey,
  looksLikeMlApiKey,
  mlKeyPrefix,
} from "@/utils/mlApiKeys";
import { TRAIN_PY } from "@/utils/ml/pyTrain";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const MIGRATION = "supabase/migrations/20260858000000_ml_api_keys.sql";

const ENDPOINTS: Record<string, { file: string; scope: string }> = {
  "/api/ml/models": { file: "ml.models.ts", scope: "read" },
  "/api/ml/train": { file: "ml.train.ts", scope: "train" },
  "/api/ml/train/status": { file: "ml.train.status.ts", scope: "read" },
  "/api/ml/predict": { file: "ml.predict.ts", scope: "predict" },
  "/api/ml/predict/batch": { file: "ml.predict.batch.ts", scope: "predict" },
  "/api/ml/predict/status": { file: "ml.predict.status.ts", scope: "read" },
  "/api/ml/models/register": { file: "ml.models.register.ts", scope: "train" },
};

describe("the key format", () => {
  it("is recognisable, long, and never stored in the clear", async () => {
    const key = generateMlApiKey();
    expect(key.startsWith(ML_KEY_PREFIX)).toBe(true);
    expect(key.length).toBe(ML_KEY_PREFIX.length + 32);
    expect(looksLikeMlApiKey(key)).toBe(true);
    expect(looksLikeMlApiKey("nbk_" + key.slice(4))).toBe(false);
    expect(looksLikeMlApiKey("mlk_short")).toBe(false);
    const h1 = await hashMlApiKey(key);
    const h2 = await hashMlApiKey(key);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain(key.slice(4, 12));
    expect(mlKeyPrefix(key)).toBe(key.slice(0, 10));
    expect(generateMlApiKey()).not.toBe(key);
  });

  it("names three scopes the database also names", () => {
    expect([...ML_KEY_SCOPES]).toEqual(["predict", "train", "read"]);
    const sql = rd(MIGRATION);
    expect(sql).toContain(
      "CHECK (scopes <@ ARRAY['predict', 'train', 'read']::text[] AND cardinality(scopes) >= 1)",
    );
  });
});

describe("the migration", () => {
  const sql = rd(MIGRATION);
  it("stores hashes, audits by trigger and attributes what a key started", () => {
    expect(sql).toContain("key_hash text NOT NULL UNIQUE");
    expect(sql).toContain("public.audit_row_change('ml_api_key')");
    expect(sql).toContain(
      "ALTER TABLE public.ml_training_jobs\n  ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES public.ml_api_keys(id) ON DELETE SET NULL;",
    );
    expect(sql).toContain(
      "ALTER TABLE public.ml_predictions\n  ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES public.ml_api_keys(id) ON DELETE SET NULL;",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS external boolean NOT NULL DEFAULT false");
    expect(sql).toContain("ON DELETE CASCADE");
  });
});

describe("the routes", () => {
  it("exist for every documented endpoint and ask for the right scope", () => {
    for (const [endpoint, { file, scope }] of Object.entries(ENDPOINTS)) {
      const p = path.join(REPO, "src/routes/api", file);
      expect(existsSync(p), file).toBe(true);
      const src = readFileSync(p, "utf8");
      expect(src).toContain(`createFileRoute("${endpoint}")`);
      expect(src).toContain(`await authenticateMlApiKey(request, "${scope}")`);
      expect(src).toContain("if (!auth.ok) return mlJson({ error: auth.error }, auth.status);");
      expect(src).toContain("OPTIONS: async () => mlOptions(),");
    }
  });

  it("answer 'not found' for another model's job or run, never 'forbidden'", () => {
    expect(rd("src/routes/api/ml.train.status.ts")).toContain(
      'if (!job || job.model_id !== auth.model.id) return mlJson({ error: "Job not found" }, 404);',
    );
    expect(rd("src/routes/api/ml.predict.status.ts")).toContain(
      "if (!row || row.model_id !== auth.model.id) {",
    );
  });

  it("cap direct rows, point large inputs at batch, and attribute runs to the key", () => {
    const predict = rd("src/routes/api/ml.predict.ts");
    expect(predict).toContain("if (rows.length > ML_ROWS_PREDICT_CAP) {");
    expect(predict).toContain("use /api/ml/predict/batch for a table");
    expect(predict).toContain('via: "api"');
    expect(predict).toContain(".update({ api_key_id: auth.key.id })");
    expect(rd("src/routes/api/ml.predict.batch.ts")).toContain("apiKeyId: auth.key.id,");
    expect(rd("src/routes/api/ml.train.ts")).toContain("apiKeyId: auth.key.id,");
  });
});

describe("the service", () => {
  const api = rd("src/utils/ml/api.server.ts");
  const fns = rd("src/utils/ml.functions.ts");

  it("authenticates by hash, checks scope, rate-limits per key and audits every denial", () => {
    expect(api).toContain("if (!looksLikeMlApiKey(raw)) return deny(");
    expect(api).toContain('.eq("key_hash", await hashMlApiKey(raw))');
    expect(api).toContain("if (!key.scopes.includes(scope)) {");
    expect(api).toContain("rateLimitedGlobal(`ml-api:${key.id}`, mlApiRateLimitPerMinute())");
    expect(api).toContain('envInt("ML_API_RATE_LIMIT_PER_MIN", 60)');
    expect(api).toContain('action: "ml.api_key.denied"');
    for (const reason of [
      "missing",
      "malformed",
      "unknown",
      "revoked",
      "expired",
      "scope",
      "rate_limited",
    ]) {
      expect(api).toContain(`deny("${reason}"`);
    }
  });

  it("is the one code path: the app's server functions call it too", () => {
    expect(fns).toContain("trainNewVersion(model, data, { userId })");
    expect(fns).toContain("startBatchPrediction({");
    for (const local of [
      "async function createAndTrainVersion(",
      "async function trainConfig(",
      "async function pickVersion(",
      "async function validatePrep(",
    ]) {
      expect(fns).not.toContain(local);
    }
    // The route service enforces the same ceilings the app does.
    expect(api).toContain("Math.min(input.max_rows ?? r.mlTrainMaxRows, r.mlTrainMaxRows)");
    expect(api).toContain("if (rows > r.mlPredictMaxRows) {");
    expect(api).toContain("Predictions can only be written to a lakehouse schema you own");
  });

  it("registers external versions under a contract inference can honour", () => {
    expect(api).toContain("external: true,");
    expect(api).toContain('action: "ml.version.register"');
    expect(api).toContain("artifact_sha256 must be the hex SHA-256 of the artifact bytes");
    expect(TRAIN_PY).toContain("if art.get('external'):");
    expect(TRAIN_PY).toContain("X = df[list(art['features'])]");
  });

  it("never exposes owner ids or artifact paths in a model summary", () => {
    const start = api.indexOf("export function modelSummary(");
    const body = api.slice(start, api.indexOf("export function jobSummary("));
    expect(body).not.toContain("user_id");
    expect(body).not.toContain("artifact_uri");
    expect(body).toContain("categories: e.categories?.slice(0, 50)");
  });
});

describe("the docs", () => {
  it("name every endpoint on the page and in the guide, and the rate-limit knob everywhere", () => {
    const page = rd("src/routes/docs.ml.tsx");
    const md = rd("docs/ML.md");
    for (const endpoint of Object.keys(ENDPOINTS)) {
      expect(page, endpoint).toContain(endpoint);
      expect(md, endpoint).toContain(endpoint);
    }
    for (const f of [
      ".env.example",
      "docs/SCALE_AND_LIMITS.md",
      "docs/ML.md",
      "src/routes/docs.ml.tsx",
    ]) {
      expect(rd(f), f).toContain("ML_API_RATE_LIMIT_PER_MIN");
    }
    // The API page no longer claims to be a single endpoint.
    expect(rd("src/routes/docs.api.tsx")).toContain("/docs/ml");
  });
});
