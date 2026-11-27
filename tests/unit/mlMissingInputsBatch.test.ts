// A finished batch run counts the inputs that arrived empty (R549).
//
// The real finalizePrediction runs over an in-memory table, with the
// trainer's result as the sandbox returns it: the verdict is kept on the run,
// a table run tells the owner and is audited, an online request is left to
// the hourly check, and nothing is started either way.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, unknown>[]> }));

function from(table: string) {
  const rows = () => (db.tables[table] ??= []);
  let op: "select" | "update" = "select";
  let patch: Row = {};
  const filters: ((r: Row) => boolean)[] = [];
  let single = false;
  const run = async () => {
    const out = rows().filter((r) => filters.every((f) => f(r)));
    if (op === "update") for (const r of out) Object.assign(r, patch);
    const snap = out.map((r) => ({ ...r }));
    return single ? { data: snap[0] ?? null, error: null } : { data: snap, error: null };
  };
  const b = {
    select: () => b,
    update: (p: Row) => ((op = "update"), (patch = p), b),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    maybeSingle: () => ((single = true), b),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(run).then(res, rej),
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from } }));
vi.mock("@/utils/notebookRuntime/service.server", () => ({
  startSession: async () => ({}),
  stopSession: async () => undefined,
  refreshSession: async (s: unknown) => s,
}));
vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getPlatformResources: async () => ({ mlDriftAlertPsi: 0.25, mlPredictMaxRows: 1_000_000 }),
}));
vi.mock("@/utils/lakehouse/core.server", () => ({}));
vi.mock("@/utils/notebookRuntime/egressApply.server", () => ({
  ensurePlatformEgress: async () => ({}),
}));
vi.mock("@/utils/etl/service.server", () => ({
  etlPrelude: () => "",
  scrubSecrets: (s: string) => s,
}));
vi.mock("@/utils/provenance/decision.server", () => ({ beginDecision: () => {} }));
vi.mock("@/utils/ml/train.server", () => ({
  mlErrorMessage: (e: unknown) => String(e),
  mlTrainingEnv: async () => ({ secretValues: [] }),
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/utils/notify.server", () => ({ notifyUser: vi.fn(async () => undefined) }));
vi.mock("@/utils/workflows/alertTriggers.server", () => ({ alertStarts: vi.fn(async () => []) }));

const { finalizePrediction } = await import("@/utils/ml/predict.server");
const { auditEvent } = await import("@/utils/audit.server");
const { notifyUser } = await import("@/utils/notify.server");
const { alertStarts } = await import("@/utils/workflows/alertTriggers.server");

const STATS = {
  income: { kind: "numeric", edges: [0, 50, 100], props: [0.5, 0.5], n: 950, missing: 0.05 },
  region: { kind: "categorical", props: { eu: 0.6, us: 0.4 }, other: 0, n: 1000, missing: 0 },
  tenure: { kind: "numeric", edges: [0, 1, 2], props: [0.5, 0.5], n: 1000, missing: 0 },
};

function seed(opts: { kind?: "batch" | "rows"; stats?: unknown } = {}) {
  db.tables = {
    ml_predictions: [
      {
        id: "pred-0001-abcd",
        model_id: "model-1",
        version_id: "v-1",
        user_id: "owner-1",
        status: "running",
        kind: opts.kind ?? "batch",
        via: "ui",
        decision_id: null,
        input:
          (opts.kind ?? "batch") === "rows"
            ? { kind: "rows", count: 400 }
            : { kind: "lakehouse", schema: "sales", table: "accounts" },
        output: null,
        result: null,
      },
    ],
    ml_models: [{ id: "model-1", user_id: "owner-1", name: "churn" }],
    ml_model_versions: [
      { id: "v-1", version: 2, feature_stats: "stats" in opts ? opts.stats : STATS },
    ],
  };
}

/** What the trainer returns, with how often each feature arrived empty. */
function result(missing: unknown) {
  return {
    ok: true,
    mode: "predict",
    row_count: 400,
    total_input_rows: 400,
    output: null,
    columns: ["prediction"],
    sample: [],
    digest_columns: ["prediction"],
    digest_rows: [],
    drift: { score: 0.04, features: { income: 0.04 }, rows: 400 },
    missing,
  };
}

const stored = () => (db.tables.ml_predictions[0].result as Row).missing;
const actions = () =>
  vi.mocked(auditEvent).mock.calls.map(([e]) => (e as { action: string }).action);

beforeEach(() => {
  vi.mocked(auditEvent).mockClear();
  vi.mocked(notifyUser).mockClear();
  vi.mocked(alertStarts).mockClear();
});

describe("a finished batch run", () => {
  it("keeps the verdict, tells the owner, audits it, and starts nothing", async () => {
    seed();
    // income empty in 30% (5% in training), region in all of it, tenure 4%.
    await finalizePrediction("pred-0001-abcd", {
      status: "succeeded",
      result: result({ rows: 400, rates: { income: 0.3, region: 1, tenure: 0.04 } }),
    });
    expect(db.tables.ml_predictions[0].status).toBe("succeeded");
    expect(stored()).toEqual([
      { feature: "region", rate: 1, training: 0 },
      { feature: "income", rate: 0.3, training: 0.05 },
    ]);
    expect(actions()).toEqual(["ml.predict_query", "ml.inputs.missing"]);
    expect(vi.mocked(auditEvent).mock.calls[1][0]).toMatchObject({
      resourceId: "model-1",
      detail: { source: "batch", prediction_id: "pred-0001-abcd", rows: 400 },
    });
    const note = vi.mocked(notifyUser).mock.calls[0][1] as {
      title: string;
      body: string;
      link: string;
    };
    expect(note.title).toBe('Inputs missing on "churn": 2 features');
    expect(note.body).toContain(
      "In the rows scored by run pred-000 from sales.accounts, region empty in 100% of rows (0% in training)",
    );
    expect(note.body).toContain("Retraining will not fix this");
    expect(note.link).toBe("/ml/model-1?tab=predictions");
    expect(alertStarts).not.toHaveBeenCalled();
  });

  it("keeps [] when nothing rose, and says nothing", async () => {
    seed();
    await finalizePrediction("pred-0001-abcd", {
      status: "succeeded",
      result: result({ rows: 400, rates: { income: 0.08 } }),
    });
    expect(stored()).toEqual([]);
    expect(actions()).toEqual(["ml.predict_query"]);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("an online request keeps its verdict, and leaves the telling to the hourly check", async () => {
    seed({ kind: "rows" });
    await finalizePrediction("pred-0001-abcd", {
      status: "succeeded",
      result: result({ rows: 400, rates: { region: 1 } }),
    });
    expect(stored()).toEqual([{ feature: "region", rate: 1, training: 0 }]);
    expect(actions()).toEqual(["ml.predict_query"]);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("null when it cannot say: too few rows, no training distribution, or an older program", async () => {
    seed();
    await finalizePrediction("pred-0001-abcd", {
      status: "succeeded",
      result: result({ rows: 99, rates: { region: 1 } }),
    });
    expect(stored()).toBeNull();

    seed({ stats: null });
    await finalizePrediction("pred-0001-abcd", {
      status: "succeeded",
      result: result({ rows: 400, rates: { region: 1 } }),
    });
    expect(stored()).toBeNull();

    seed();
    await finalizePrediction("pred-0001-abcd", { status: "succeeded", result: result(undefined) });
    expect(stored()).toBeNull();
    expect(notifyUser).not.toHaveBeenCalled();
  });
});
