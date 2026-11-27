// What actually happened to an online prediction (R551).
//
// The rules (parsing a report, what the model answered, the metric) are pure
// and tested first; the metric is held to scikit-learn's own numbers through
// the batch path's fixture. Then the report, the evaluation and the hourly
// pass run for real over an in-memory stand-in for the database.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { classificationMetrics, type MlClassCount } from "@/lib/mlEvaluation";
import {
  MAX_OUTCOMES_PER_CALL,
  ONLINE_MIN_ANSWERS,
  onlineAlertKey,
  onlineMetrics,
  onlineTask,
  parseOutcomes,
  predictedAt,
  rowsAnswered,
} from "@/lib/mlOnlineOutcomes";

const rd = (p: string) => readFileSync(p, "utf8");
const codeOnly = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const PID = "0f0e0d0c-0b0a-4909-8807-060504030201";

describe("a report, checked", () => {
  it("rows of that request, with what happened", () => {
    expect(
      parseOutcomes(
        {
          prediction_id: PID,
          outcomes: [
            { row: 1, actual: "pro" },
            { row: 0, actual: true },
          ],
        },
        "classification",
        2,
      ),
    ).toEqual({
      ok: true,
      predictionId: PID,
      outcomes: [
        { row: 1, actual: "pro" },
        // A label is text as Python spells it, as the trainer's classes are.
        { row: 0, actual: "True" },
      ],
    });
  });

  it("a request of one row may leave the row out", () => {
    const r = parseOutcomes({ prediction_id: PID, outcomes: [{ actual: 3 }] }, "regression", 1);
    expect(r).toMatchObject({ ok: true, outcomes: [{ row: 0, actual: "3" }] });
  });

  it("refuses what it cannot measure, and says why", () => {
    const bad: [unknown, string][] = [
      [{ prediction_id: "nope", outcomes: [{ row: 0, actual: "a" }] }, "prediction_id"],
      [{ prediction_id: PID, outcomes: [] }, "non-empty"],
      [{ prediction_id: PID, outcomes: [{ row: 2, actual: "a" }] }, "0 to 1"],
      [{ prediction_id: PID, outcomes: [{ row: 1.5, actual: "a" }] }, "0 to 1"],
      [{ prediction_id: PID, outcomes: [{ actual: "a" }] }, "0 to 1"],
      [
        {
          prediction_id: PID,
          outcomes: [
            { row: 0, actual: "a" },
            { row: 0, actual: "b" },
          ],
        },
        "twice",
      ],
      [{ prediction_id: PID, outcomes: [{ row: 0, actual: null }] }, "label"],
      [{ prediction_id: PID, outcomes: [{ row: 0, actual: "x".repeat(501) }] }, "longer"],
    ];
    for (const [body, says] of bad) {
      const r = parseOutcomes(body, "classification", 2);
      expect(r.ok, JSON.stringify(body).slice(0, 80)).toBe(false);
      expect((r as { error: string }).error).toContain(says);
    }
    expect(
      parseOutcomes(
        { prediction_id: PID, outcomes: [{ row: 0, actual: "lots" }] },
        "regression",
        1,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("number") });
    const many = Array.from({ length: MAX_OUTCOMES_PER_CALL + 1 }, (_, i) => ({
      row: i,
      actual: "a",
    }));
    expect(parseOutcomes({ prediction_id: PID, outcomes: many }, "classification", 500).ok).toBe(
      false,
    );
  });

  it("only a classification or a regression has an answer to check", () => {
    expect(onlineTask("classification")).toBe("classification");
    expect(onlineTask("regression")).toBe("regression");
    for (const t of ["forecast", "clustering", "anomaly", "recommendation"]) {
      expect(onlineTask(t)).toBeNull();
    }
  });
});

describe("what the model answered, from the request's own record", () => {
  const result = {
    columns: ["plan_hint", "prediction", "probability"],
    sample: [
      ["x", "pro", 0.8],
      ["y", 12.5, 0.6],
    ],
  };

  it("the prediction column of that row", () => {
    expect(predictedAt(result, 0)).toBe("pro");
    expect(predictedAt(result, 1)).toBe("12.5");
    expect(rowsAnswered(result)).toBe(2);
  });

  it("nothing for a row it did not keep, or a result of another shape", () => {
    expect(predictedAt(result, 2)).toBeNull();
    expect(predictedAt({ columns: ["x"], sample: [["a"]] }, 0)).toBeNull();
    expect(predictedAt(null, 0)).toBeNull();
    expect(rowsAnswered(null)).toBe(0);
  });
});

describe("the same metric as a batch run", () => {
  const ORACLE = JSON.parse(rd("tests/fixtures/sklearnMetrics.json")) as {
    classification: { counts: MlClassCount[]; f1_macro: number; accuracy: number }[];
  };

  it("the answers one by one give scikit-learn's own f1_macro, case for case", () => {
    expect(ORACLE.classification.length).toBeGreaterThan(3);
    for (const c of ORACLE.classification) {
      const pairs = c.counts.flatMap((k) =>
        Array.from({ length: k.n }, () => ({ predicted: k.predicted, actual: k.actual })),
      );
      const m = onlineMetrics("classification", pairs);
      expect(m?.primary).toBeCloseTo(c.f1_macro, 12);
      expect(m?.extra.accuracy).toBeCloseTo(c.accuracy, 12);
      expect(m).toEqual(classificationMetrics(c.counts));
    }
  });

  it("a regression's RMSE and MAE, by hand; a pair that is not two numbers is left out", () => {
    const m = onlineMetrics("regression", [
      { predicted: "10", actual: "12" },
      { predicted: "5", actual: "4" },
      { predicted: "x", actual: "4" },
    ]);
    expect(m?.matched).toBe(2);
    expect(m?.primary_name).toBe("rmse");
    expect(m?.primary).toBeCloseTo(Math.sqrt((4 + 1) / 2), 12);
    expect(m?.extra.mae).toBeCloseTo(1.5, 12);
    expect(onlineMetrics("regression", [{ predicted: "a", actual: "b" }])).toBeNull();
    expect(onlineMetrics("classification", [])).toBeNull();
  });

  it("a day's key per version", () => {
    expect(onlineAlertKey("v1", new Date("2026-11-27T23:00:00Z"))).toBe("online:v1:2026-11-27");
  });
});

// ── The server, over a stand-in database ────────────────────────────────

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  missing: new Set<string>(),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Q {
    filters: ((r: Record<string, unknown>) => boolean)[] = [];
    op: "select" | "insert" | "upsert" = "select";
    rows: Record<string, unknown>[] = [];
    conflict: string[] = [];
    head = false;
    from = 0;
    to = Infinity;
    cap = Infinity;
    desc: string | null = null;
    one = false;
    constructor(public table: string) {}
    select(_c?: string, o?: { head?: boolean }) {
      if (o?.head) this.head = true;
      return this;
    }
    insert(r: Record<string, unknown>) {
      this.op = "insert";
      this.rows = [r];
      return this;
    }
    upsert(r: Record<string, unknown>[], o?: { onConflict?: string }) {
      this.op = "upsert";
      this.rows = r;
      this.conflict = (o?.onConflict ?? "").split(",");
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    gte(c: string, v: string) {
      this.filters.push((r) => String(r[c]) >= v);
      return this;
    }
    order(c: string, o?: { ascending?: boolean }) {
      if (o?.ascending === false) this.desc = c;
      return this;
    }
    limit(n: number) {
      this.cap = n;
      return this;
    }
    range(a: number, b: number) {
      this.from = a;
      this.to = b;
      return this;
    }
    maybeSingle() {
      this.one = true;
      return this;
    }
    single() {
      this.one = true;
      return this;
    }
    result() {
      if (db.missing.has(this.table)) {
        return {
          data: null,
          count: null,
          error: { message: `relation "public.${this.table}" does not exist` },
        };
      }
      const t = (db.tables[this.table] ??= []);
      if (this.op === "insert") {
        const r = { id: `${this.table}-${t.length + 1}`, ...this.rows[0] };
        t.push(r);
        return { data: this.one ? r : [r], error: null };
      }
      if (this.op === "upsert") {
        for (const r of this.rows) {
          const i = t.findIndex((x) => this.conflict.every((k) => x[k] === r[k]));
          if (i >= 0) t[i] = { ...t[i], ...r };
          else t.push({ ...r });
        }
        return { data: null, error: null };
      }
      let hit = t.filter((r) => this.filters.every((f) => f(r)));
      if (this.desc) {
        const k = this.desc;
        hit = [...hit].sort((a, b) => String(b[k]).localeCompare(String(a[k])));
      }
      // An exact count is of every matching row, as PostgREST's is, not the page.
      const total = hit.length;
      hit = hit.slice(this.from, Math.min(this.to + 1, this.from + this.cap));
      if (this.head) return { data: null, count: total, error: null };
      return { data: this.one ? (hit[0] ?? null) : hit, count: total, error: null };
    }
    then(res: (v: unknown) => void) {
      res(this.result());
    }
  }
  return { supabaseAdmin: { from: (t: string) => new Q(t) } };
});
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/utils/notify.server", () => ({ notifyUser: vi.fn(async () => undefined) }));
vi.mock("@/utils/workflows/alertTriggers.server", () => ({
  alertStarts: vi.fn(async () => [{ workflowId: "wf-1", name: "Retrain churn", runId: "r1" }]),
}));
vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getPlatformResources: async () => ({ mlDecayAlertRatio: 0.1, mlEvaluationsPerSweep: 20 }),
}));

const { recordOutcomes, evaluateOnline, runOnlineEvaluations } =
  await import("@/utils/ml/outcomes.server");
const { auditEvent } = await import("@/utils/audit.server");
const { notifyUser } = await import("@/utils/notify.server");
const { alertStarts } = await import("@/utils/workflows/alertTriggers.server");

const OWNER = "11111111-1111-4111-8111-111111111111";
const GRANTEE = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-27T12:00:00.000Z");
const MODEL = {
  id: "m1",
  user_id: OWNER,
  name: "churn",
  task: "classification",
  production_version_id: "v1",
} as never;
const KEY = { id: "k1", user_id: OWNER };

function seed(answers: Row[] = []) {
  db.missing.clear();
  db.tables = {
    ml_models: [{ ...(MODEL as object) }],
    ml_model_versions: [{ id: "v1", version: 3, metrics: { f1_macro: 0.9 } }],
    ml_predictions: [
      {
        id: PID,
        model_id: "m1",
        version_id: "v1",
        api_key_id: "k1",
        kind: "rows",
        status: "succeeded",
        row_count: 2,
        created_at: "2026-11-27T10:00:00.000Z",
        result: {
          columns: ["plan_hint", "prediction", "probability"],
          sample: [
            ["x", "pro", 0.8],
            ["y", "basic", 0.6],
          ],
        },
      },
    ],
    ml_outcomes: answers,
    ml_evaluations: [],
  };
}

/** n answers: half right (pro/pro), half wrong (pro/basic) — macro F1 1/3 against 0.9. */
function answers(n: number, by: string, at = "2026-11-27T11:00:00.000Z"): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    prediction_id: `p-${by}-${i}`,
    row_index: 0,
    model_id: "m1",
    version_id: "v1",
    user_id: OWNER,
    reported_by: by,
    predicted: "pro",
    actual: i % 2 ? "pro" : "basic",
    received_at: at,
  }));
}

beforeEach(() => {
  vi.mocked(auditEvent).mockClear();
  vi.mocked(notifyUser).mockClear();
  vi.mocked(alertStarts).mockClear();
});

describe("a report", () => {
  it("records what happened beside what the model answered then, and audits it", async () => {
    seed();
    const r = await recordOutcomes({
      key: KEY,
      model: MODEL,
      body: { prediction_id: PID, outcomes: [{ row: 1, actual: "pro" }] },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ prediction_id: PID, recorded: 1 });
    expect(db.tables.ml_outcomes).toEqual([
      expect.objectContaining({
        prediction_id: PID,
        row_index: 1,
        version_id: "v1",
        user_id: OWNER,
        api_key_id: "k1",
        reported_by: OWNER,
        // From the request's record, not the caller.
        predicted: "basic",
        actual: "pro",
      }),
    ]);
    expect(vi.mocked(auditEvent).mock.calls[0][0]).toMatchObject({
      action: "ml.outcome.report",
      detail: { prediction_id: PID, key_id: "k1", rows: 1 },
    });
  });

  it("reported again, the later answer replaces the earlier", async () => {
    seed();
    const body = (actual: string) => ({ prediction_id: PID, outcomes: [{ row: 0, actual }] });
    await recordOutcomes({ key: KEY, model: MODEL, body: body("basic") });
    await recordOutcomes({ key: KEY, model: MODEL, body: body("pro") });
    expect(db.tables.ml_outcomes).toHaveLength(1);
    expect(db.tables.ml_outcomes[0].actual).toBe("pro");
  });

  it("only by the key that asked, for that model's own online request: 404 either way", async () => {
    for (const [change, key] of [
      [{}, { id: "k2", user_id: OWNER }],
      [{ model_id: "m2" }, KEY],
      [{ kind: "batch" }, KEY],
    ] as [Row, typeof KEY][]) {
      seed();
      Object.assign(db.tables.ml_predictions[0], change);
      const r = await recordOutcomes({
        key,
        model: MODEL,
        body: { prediction_id: PID, outcomes: [{ row: 0, actual: "pro" }] },
      });
      expect(r.status, JSON.stringify(change)).toBe(404);
      expect(db.tables.ml_outcomes).toEqual([]);
    }
  });

  it("not before it was answered, not for a row it did not have, not for a forecast", async () => {
    seed();
    db.tables.ml_predictions[0].status = "running";
    const body = { prediction_id: PID, outcomes: [{ row: 0, actual: "pro" }] };
    expect((await recordOutcomes({ key: KEY, model: MODEL, body })).status).toBe(409);
    seed();
    expect(
      (
        await recordOutcomes({
          key: KEY,
          model: MODEL,
          body: { prediction_id: PID, outcomes: [{ row: 5, actual: "pro" }] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await recordOutcomes({
          key: KEY,
          model: { ...(MODEL as object), task: "forecast" } as never,
          body,
        })
      ).status,
    ).toBe(400);
  });

  it("before its migration: 503, naming it", async () => {
    seed();
    db.missing.add("ml_outcomes");
    const r = await recordOutcomes({
      key: KEY,
      model: MODEL,
      body: { prediction_id: PID, outcomes: [{ row: 0, actual: "pro" }] },
    });
    expect(r.status).toBe(503);
    expect(String(r.body.error)).toContain("20261211000000");
  });
});

describe("measuring a version's answers", () => {
  it(`says nothing below ${ONLINE_MIN_ANSWERS} answers, only how many so far`, async () => {
    seed(answers(ONLINE_MIN_ANSWERS - 1, OWNER));
    const r = await evaluateOnline(MODEL, "v1", OWNER, "ui", NOW);
    expect(r).toMatchObject({ ok: false, answers: ONLINE_MIN_ANSWERS - 1 });
    expect(db.tables.ml_evaluations).toEqual([]);
    // And at exactly the floor, a verdict.
    seed(answers(ONLINE_MIN_ANSWERS, OWNER));
    expect((await evaluateOnline(MODEL, "v1", OWNER, "ui", NOW)).ok).toBe(true);
  });

  it("records it as an online evaluation, tells the owner, and starts the owner's pipeline", async () => {
    seed(answers(60, OWNER));
    const r = await evaluateOnline(MODEL, "v1", OWNER, "schedule", NOW);
    expect(r.ok).toBe(true);
    expect(db.tables.ml_evaluations[0]).toMatchObject({
      source: "online",
      prediction_id: null,
      window_days: 30,
      metric_name: "f1_macro",
      baseline_value: 0.9,
      verdict: "degraded",
      matched_rows: 60,
      // More answers than rows counted online in the window: never below.
      scored_rows: 60,
      created_at: NOW.toISOString(),
    });
    expect(db.tables.ml_evaluations[0].metric_value as number).toBeCloseTo(1 / 3, 10);
    expect(vi.mocked(auditEvent).mock.calls.map(([e]) => (e as { action: string }).action)).toEqual(
      ["ml.evaluate", "ml.decay.alert"],
    );
    expect(vi.mocked(alertStarts).mock.calls[0][0]).toMatchObject({
      event: "decay",
      modelId: "m1",
      predictionId: "online:v1:2026-11-27",
      ranBy: OWNER,
      versionId: "v1",
    });
    const note = vi.mocked(notifyUser).mock.calls[0][1] as { title: string; body: string };
    expect(note.title).toContain("answering online worse than it trained");
    expect(note.body).toContain('Started "Retrain churn".');
  });

  it("answers reported through someone else's key tell the owner and start nothing", async () => {
    seed(answers(60, GRANTEE));
    const r = await evaluateOnline(MODEL, "v1", OWNER, "schedule", NOW);
    expect(r.ok).toBe(true);
    expect(alertStarts).not.toHaveBeenCalled();
    expect((vi.mocked(notifyUser).mock.calls[0][1] as { body: string }).body).toContain(
      "Retraining is the usual answer.",
    );
  });

  it("only the window's answers count", async () => {
    seed(answers(60, OWNER, "2026-10-01T00:00:00.000Z"));
    expect(await evaluateOnline(MODEL, "v1", OWNER, "ui", NOW)).toMatchObject({
      ok: false,
      answers: 0,
    });
  });
});

describe("the hourly pass", () => {
  it("measures a version with new answers, then not again the same day", async () => {
    seed(answers(60, OWNER));
    expect(await runOnlineEvaluations(NOW)).toEqual({ evaluated: 1, alerted: 1 });
    expect(await runOnlineEvaluations(new Date(NOW.getTime() + 3_600_000))).toEqual({
      evaluated: 0,
      alerted: 0,
    });
    // New answers the same day wait for the day: once a day is once a day.
    db.tables.ml_outcomes.push({
      ...answers(1, OWNER)[0],
      prediction_id: "p-same-day",
      received_at: new Date(NOW.getTime() + 2 * 3_600_000).toISOString(),
    });
    expect((await runOnlineEvaluations(new Date(NOW.getTime() + 3 * 3_600_000))).evaluated).toBe(0);
  });

  it("a day on, only if answers arrived since", async () => {
    seed(answers(60, OWNER));
    await runOnlineEvaluations(NOW);
    const dayOn = new Date(NOW.getTime() + 25 * 3_600_000);
    expect((await runOnlineEvaluations(dayOn)).evaluated).toBe(0);
    db.tables.ml_outcomes.push({
      ...answers(1, OWNER)[0],
      prediction_id: "p-new",
      received_at: new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
    });
    expect((await runOnlineEvaluations(dayOn)).evaluated).toBe(1);
  });

  it("before its migration: measures nothing, and does not fail", async () => {
    seed();
    db.missing.add("ml_outcomes");
    expect(await runOnlineEvaluations(NOW)).toEqual({ evaluated: 0, alerted: 0 });
  });
});

describe("found in the UI test", () => {
  it("before the migration the count is unknown, not 0", async () => {
    // A HEAD count against a table that is not there answered 204 with no
    // error and no count, and the card said "0 answers reported".
    const { onlineAnswerCount } = await import("@/utils/ml/outcomes.server");
    seed(answers(3, OWNER));
    expect(await onlineAnswerCount("v1", NOW)).toBe(3);
    db.missing.add("ml_outcomes");
    expect(await onlineAnswerCount("v1", NOW)).toBeNull();
    const fn = codeOnly(rd("src/utils/ml/outcomes.server.ts"));
    const body = fn.slice(fn.indexOf("export async function onlineAnswerCount"));
    expect(body).not.toContain("head: true");
    expect(body).toContain("return error || count === null ? null : count;");
  });

  it("the example keeps its line breaks", () => {
    // One backslash before a newline is a line continuation in a template
    // literal; the example printed on one line with none.
    const panel = rd("src/components/ml/AccuracyPanel.tsx");
    expect(panel).toContain("/api/ml/outcomes \\\\\n");
    expect(panel).not.toMatch(/\/api\/ml\/outcomes \\\n/);
  });
});

describe("wired where it has to be", () => {
  it("the public route takes reports with the predict scope", () => {
    const route = codeOnly(rd("src/routes/api/ml.outcomes.ts"));
    expect(route).toContain('createFileRoute("/api/ml/outcomes")');
    expect(route).toContain('authenticateMlApiKey(request, "predict")');
  });

  it("the hourly pass runs beside the live-traffic check", () => {
    const sweep = codeOnly(rd("src/utils/bi/refresh.server.ts"));
    const gate = sweep.indexOf("new Date().getMinutes() < 2", sweep.indexOf('"ml-traffic"') - 400);
    expect(gate).toBeGreaterThan(0);
    expect(sweep.indexOf('"ml-online"')).toBeGreaterThan(sweep.indexOf('"ml-traffic"'));
    expect(sweep).toContain("m.runOnlineEvaluations()");
  });

  it("the Accuracy tab says where each evaluation came from, and shows the owner the answers", () => {
    const panel = rd("src/components/ml/AccuracyPanel.tsx");
    expect(panel).toContain('r.source === "online"');
    expect(panel).toContain("<OnlineCard");
    expect(panel).toContain("/api/ml/outcomes");
  });

  it("its migration: a table the owner reads, and online evaluations without a run", () => {
    const sql = rd("supabase/migrations/20261211000000_ml_online_outcomes.sql");
    expect(sql).toContain("PRIMARY KEY (prediction_id, row_index)");
    expect(sql).toContain("USING (user_id = auth.uid())");
    expect(sql).toContain("ALTER COLUMN prediction_id DROP NOT NULL");
    expect(sql).toContain("CHECK (source = 'online' OR prediction_id IS NOT NULL)");
    expect(sql).not.toMatch(/\bDROP TABLE\b|\bDROP COLUMN\b|\bRENAME\b/i);
  });
});
