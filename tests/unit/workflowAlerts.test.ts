// Workflows that start when a model alerts (R544).
//
// The rules are pure and tested as such. The starter, the one write path and
// the file's name lookup run for real over an in-memory stand-in for the
// database; the runner is the only thing replaced, and its stand-in records a
// run the way the real one does, so "once per alert" is exercised end to end.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { TRIGGER_LABEL, normalizeTrigger } from "@/lib/runs";
import {
  ALERT_COOLDOWN_DEFAULT_HOURS,
  alertDecision,
  alertNoteLine,
  alertRunLine,
  alertTriggerLine,
  alertTriggerOf,
  answersAlert,
  cooldownWords,
  modelsInGraph,
  normaliseAlertTrigger,
  sameAlertTrigger,
  startedSentence,
  type AlertFacts,
} from "@/lib/workflowAlerts";
import {
  definitionChanges,
  definitionFromFile,
  parseWorkflowFile,
  toWorkflowFile,
  workflowFileText,
  type WorkflowDefinition,
} from "@/lib/workflowFile";
import { savedForm, type WorkflowGraph } from "@/lib/workflows";

const rd = (p: string) => readFileSync(p, "utf8");

// ── The stand-ins ────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  seq: 0,
  /** "Migration not applied": any read or write naming these columns errors. */
  missingColumns: new Set<string>(),
  /** Make the next read of this table throw, as a dropped connection does. */
  throwOn: null as string | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Q {
    filters: ((r: Record<string, unknown>) => boolean)[] = [];
    named: string[] = [];
    op: "select" | "update" | "insert" = "select";
    patch: Record<string, unknown> = {};
    rows: Record<string, unknown>[] = [];
    constructor(public table: string) {}
    select(cols?: string) {
      if (cols && cols !== "*") this.named.push(...cols.split(",").map((c) => c.trim()));
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    in(c: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[c]));
      return this;
    }
    is(c: string, v: null) {
      this.named.push(c);
      this.filters.push((r) => (r[c] ?? null) === v);
      return this;
    }
    not(c: string, _op: "is", v: null) {
      this.named.push(c);
      this.filters.push((r) => (r[c] ?? null) !== v);
      return this;
    }
    lt(c: string, v: string) {
      this.filters.push((r) => typeof r[c] === "string" && (r[c] as string) < v);
      return this;
    }
    contains(c: string, v: Record<string, unknown>) {
      this.named.push(c);
      this.filters.push((r) =>
        Object.entries(v).every(([k, x]) => (r[c] as Record<string, unknown>)?.[k] === x),
      );
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    update(p: Record<string, unknown>) {
      this.op = "update";
      this.patch = p;
      this.named.push(...Object.keys(p));
      return this;
    }
    insert(r: Record<string, unknown> | Record<string, unknown>[]) {
      this.op = "insert";
      this.rows = Array.isArray(r) ? r : [r];
      return this;
    }
    missing(): string | undefined {
      return this.named.find((c) => db.missingColumns.has(c));
    }
    exec(): Record<string, unknown>[] {
      const t = (db.tables[this.table] ??= []);
      if (this.op === "insert") {
        const made = this.rows.map((r) => ({ id: `row-${++db.seq}`, ...r }));
        t.push(...made);
        return made;
      }
      const hit = t.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") for (const r of hit) Object.assign(r, this.patch);
      return hit;
    }
    answer() {
      if (db.throwOn === this.table) {
        db.throwOn = null;
        throw new Error("connection reset");
      }
      const col = this.missing();
      if (col) {
        return {
          data: null,
          error: {
            message: `Could not find the '${col}' column of '${this.table}' in the schema cache`,
          },
        };
      }
      return null;
    }
    async maybeSingle() {
      return this.answer() ?? { data: this.exec()[0] ?? null, error: null };
    }
    async single() {
      const failed = this.answer();
      if (failed) return failed;
      const rows = this.exec();
      return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "none" } };
    }
    then(res: (v: unknown) => void, rej: (e: unknown) => void) {
      try {
        res(this.answer() ?? { data: this.exec(), error: null });
      } catch (e) {
        rej(e);
      }
    }
  }
  return { supabaseAdmin: { from: (t: string) => new Q(t) } };
});

const runner = vi.hoisted(() => ({ refuse: null as string | null }));
vi.mock("@/utils/workflows/run.server", () => ({
  nextWorkflowRunAt: () => "2026-12-01T00:00:00.000Z",
  // Records the run as the real runner does (trigger + trigger_detail), so a
  // second alert about the same prediction finds it.
  startWorkflowRun: vi.fn(
    async (w: { id: string; user_id: string }, trigger: string, opts: { triggerDetail?: Row }) => {
      if (runner.refuse) return { ok: false, error: runner.refuse };
      const id = `run-${++db.seq}`;
      (db.tables.workflow_runs ??= []).push({
        id,
        workflow_id: w.id,
        user_id: w.user_id,
        trigger,
        trigger_detail: opts.triggerDetail ?? null,
      });
      return { ok: true, runId: id };
    },
  ),
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));

const { alertStarts, startWorkflowsOnAlert } =
  await import("@/utils/workflows/alertTriggers.server");
const { applyWorkflowDefinition, resolveFileTargets, validateDefinition } =
  await import("@/utils/workflows/definition.server");
const { startWorkflowRun } = await import("@/utils/workflows/run.server");

// ── Fixtures ─────────────────────────────────────────────────────────────

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CHURN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRAUD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const V2 = "v2-production";
const NOW = new Date("2026-11-26T12:00:00.000Z");

const trigger = (over: Partial<Row> = {}) => ({
  models: [CHURN],
  events: ["drift"],
  cooldownHours: 24,
  ...over,
});

function seed() {
  db.tables = {
    ml_models: [
      { id: CHURN, user_id: OWNER, name: "churn", production_version_id: V2 },
      { id: FRAUD, user_id: OWNER, name: "fraud", production_version_id: null },
    ],
    workflows: [
      {
        id: "wf-retrain",
        user_id: OWNER,
        name: "Retrain churn",
        is_active: true,
        alert_trigger: trigger(),
        alert_started_at: null,
        alert_last: null,
      },
      {
        id: "wf-decay",
        user_id: OWNER,
        name: "Decay only",
        is_active: true,
        alert_trigger: trigger({ events: ["decay"] }),
        alert_started_at: null,
        alert_last: null,
      },
      {
        id: "wf-paused",
        user_id: OWNER,
        name: "Paused one",
        is_active: false,
        alert_trigger: trigger(),
        alert_started_at: null,
        alert_last: null,
      },
      {
        id: "wf-none",
        user_id: OWNER,
        name: "Answers nothing",
        is_active: true,
        alert_trigger: null,
      },
      // Someone else's workflow naming the owner's model: never looked up.
      {
        id: "wf-foreign",
        user_id: OTHER,
        name: "Not the owner's",
        is_active: true,
        alert_trigger: trigger(),
        alert_started_at: null,
        alert_last: null,
      },
    ],
    workflow_runs: [],
  };
}

const wf = (id: string) => db.tables.workflows.find((w) => w.id === id) as Row;
const drift = (over: Partial<Parameters<typeof startWorkflowsOnAlert>[0]> = {}) => ({
  event: "drift" as const,
  modelId: CHURN,
  predictionId: "pred-1",
  ranBy: OWNER,
  versionId: V2,
  score: 0.31,
  ...over,
});

beforeEach(() => {
  seed();
  db.seq = 0;
  db.missingColumns.clear();
  db.throwOn = null;
  runner.refuse = null;
  vi.mocked(startWorkflowRun).mockClear();
});

// ── The rules ────────────────────────────────────────────────────────────

describe("an alert trigger", () => {
  it("reads only a valid stored value, in one canonical form", () => {
    expect(
      alertTriggerOf({
        models: [FRAUD, CHURN, FRAUD],
        events: ["decay", "drift"],
        cooldownHours: 6,
      }),
    ).toEqual({ models: [CHURN, FRAUD], events: ["drift", "decay"], cooldownHours: 6 });
    for (const bad of [
      null,
      undefined,
      "x",
      { models: [], events: ["drift"], cooldownHours: 24 },
      { models: [CHURN], events: [], cooldownHours: 24 },
      { models: [CHURN], events: ["outage"], cooldownHours: 24 },
      { models: ["not-a-uuid"], events: ["drift"], cooldownHours: 24 },
      { models: [CHURN], events: ["drift"], cooldownHours: 0 },
      { models: [CHURN], events: ["drift"], cooldownHours: 721 },
    ]) {
      expect(alertTriggerOf(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(ALERT_COOLDOWN_DEFAULT_HOURS).toBe(24);
  });

  it("answers only its own models and alerts", () => {
    const t = alertTriggerOf(trigger());
    expect(answersAlert(t, CHURN, "drift")).toBe(true);
    expect(answersAlert(t, CHURN, "decay")).toBe(false);
    expect(answersAlert(t, FRAUD, "drift")).toBe(false);
    expect(answersAlert(null, CHURN, "drift")).toBe(false);
  });

  it("compares by meaning, not by order", () => {
    const a = normaliseAlertTrigger({
      models: [FRAUD, CHURN],
      events: ["decay", "drift"],
      cooldownHours: 24,
    });
    expect(
      sameAlertTrigger(a, {
        models: [CHURN, FRAUD],
        events: ["drift", "decay"],
        cooldownHours: 24,
      }),
    ).toBe(true);
    expect(sameAlertTrigger(a, null)).toBe(false);
    expect(sameAlertTrigger(null, null)).toBe(true);
  });

  it("offers the models the workflow's own steps work on", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "a", kind: "ml_schedule", label: "Retrain", targetId: "sched-1" },
        { id: "b", kind: "ml_promote", label: "Promote", targetId: FRAUD },
        { id: "c", kind: "ml_deploy", label: "Deploy", targetId: FRAUD },
        { id: "d", kind: "wait", label: "Wait", waitSeconds: 5 },
      ],
      edges: [],
    };
    expect(modelsInGraph(graph, [{ id: "sched-1", model_id: CHURN }])).toEqual([CHURN, FRAUD]);
  });
});

describe("whether an alert starts a run", () => {
  const facts = (over: Partial<AlertFacts> = {}): AlertFacts => ({
    event: "drift",
    active: true,
    ranByOwner: true,
    versionId: V2,
    productionVersionId: V2,
    alreadyStarted: false,
    ...over,
  });

  it("starts for the owner's own run, scored by production, the first time", () => {
    expect(alertDecision(facts())).toEqual({ start: true });
    // A model with no production pointer yet: the version cannot be "replaced".
    expect(alertDecision(facts({ productionVersionId: null }))).toEqual({ start: true });
  });

  it("never for a run someone the model is shared with started, and says so", () => {
    expect(alertDecision(facts({ ranByOwner: false }))).toEqual({
      start: false,
      reason: "the run was not yours: someone the model is shared with ran it",
    });
  });

  it("quietly skips what repeats daily: the same alert, or a version already replaced", () => {
    expect(alertDecision(facts({ alreadyStarted: true }))).toMatchObject({
      start: false,
      quiet: true,
    });
    expect(alertDecision(facts({ versionId: "v1-old" }))).toMatchObject({
      start: false,
      quiet: true,
      reason: "the rows were scored by a version that is no longer in production",
    });
  });

  it("does not start a paused workflow", () => {
    expect(alertDecision(facts({ active: false }))).toEqual({
      start: false,
      reason: "the workflow is paused",
    });
  });
});

describe("the words", () => {
  it("say what started a run, and what came of the last alert", () => {
    expect(alertRunLine({ event: "drift", model_name: "churn", score: 0.314 })).toBe(
      'Drift on "churn" (PSI 0.31)',
    );
    expect(alertRunLine({ event: "decay", model_name: "churn", score: 0.12 })).toBe(
      '"churn" scoring 12% worse than training',
    );
    expect(alertRunLine(null)).toBe("A model alert");
    expect(
      alertNoteLine({ at: "x", event: "drift", model_name: "churn", started: true, run_id: "r" }),
    ).toBe('drift on "churn" started a run');
    expect(
      alertNoteLine({
        at: "x",
        event: "decay",
        model_name: "churn",
        started: false,
        reason: "the workflow is paused",
      }),
    ).toBe('"churn" scoring worse than training did not start it: the workflow is paused');
  });

  it("say which alerts a workflow answers, and how long it waits", () => {
    const names = new Map([
      [CHURN, "churn"],
      [FRAUD, "fraud"],
    ]);
    expect(alertTriggerLine(alertTriggerOf(trigger()), (id) => names.get(id))).toBe(
      'When "churn" drifts',
    );
    expect(
      alertTriggerLine(
        alertTriggerOf(trigger({ models: [CHURN, FRAUD], events: ["drift", "decay"] })),
        (id) => names.get(id),
      ),
    ).toBe('When "churn" or "fraud" drifts or scores worse than training');
    expect(alertTriggerLine(null, () => undefined)).toBe("");
    expect(cooldownWords(1)).toBe("1 hour");
    expect(cooldownWords(24)).toBe("24 hours");
    expect(cooldownWords(168)).toBe("7 days");
    expect(startedSentence([])).toBe("");
    expect(startedSentence(["Retrain churn"])).toBe(' Started "Retrain churn".');
    expect(startedSentence(["A", "B"])).toBe(' Started 2 workflows: "A", "B".');
  });

  it("call an alert-started run what it is in the shared run vocabulary", () => {
    expect(normalizeTrigger("alert")).toBe("alert");
    expect(TRIGGER_LABEL.alert).toBe("On a model alert");
  });
});

// ── The file ─────────────────────────────────────────────────────────────

const baseDef = (over: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  name: "Retrain churn",
  description: null,
  schedule: "manual",
  cronExpr: null,
  timezone: null,
  overlap: "skip",
  notifyOn: "failure",
  timeoutMinutes: 720,
  graph: {
    nodes: [{ id: "n1", kind: "wait", label: "Wait", waitSeconds: 5 }],
    edges: [],
    params: [],
  },
  ...over,
});

describe("the workflow file", () => {
  it("writes nothing new for a workflow that answers no alerts (old files stay identical)", () => {
    const before = workflowFileText(toWorkflowFile(baseDef()));
    expect(before).not.toContain("onAlert");
    expect(workflowFileText(toWorkflowFile(baseDef({ alertTrigger: null })))).toBe(before);
  });

  it("writes the trigger with each model's name, and reads it back", () => {
    const def = baseDef({
      alertTrigger: { models: [FRAUD, CHURN], events: ["decay", "drift"], cooldownHours: 12 },
    });
    const text = workflowFileText(toWorkflowFile(def, {}, { [CHURN]: "churn", [FRAUD]: "fraud" }));
    const parsed = parseWorkflowFile(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.onAlert).toEqual({
      models: [
        { id: CHURN, name: "churn" },
        { id: FRAUD, name: "fraud" },
      ],
      events: ["drift", "decay"],
      cooldownHours: 12,
    });
    expect(definitionFromFile(parsed.file).alertTrigger).toEqual({
      models: [CHURN, FRAUD],
      events: ["drift", "decay"],
      cooldownHours: 12,
    });
    // Written twice, the same bytes.
    expect(workflowFileText(parsed.file)).toBe(text);
  });

  it("reads a file without one as none, so a pull switches it off", () => {
    const parsed = parseWorkflowFile(workflowFileText(toWorkflowFile(baseDef())));
    expect(parsed.ok && definitionFromFile(parsed.file).alertTrigger).toBeNull();
  });

  it("refuses a malformed trigger with where it is", () => {
    const file = JSON.parse(workflowFileText(toWorkflowFile(baseDef())));
    file.onAlert = { models: [], events: ["drift"], cooldownHours: 24 };
    expect(parseWorkflowFile(JSON.stringify(file))).toMatchObject({
      ok: false,
      error: expect.stringContaining("onAlert.models"),
    });
  });

  it("names the change in an update's preview, and in the editor's unsaved check", () => {
    const off = baseDef({ alertTrigger: null });
    const on = baseDef({ alertTrigger: { models: [CHURN], events: ["drift"], cooldownHours: 24 } });
    expect(definitionChanges(off, on).settings).toContain("model alerts");
    expect(definitionChanges(on, on).settings).not.toContain("model alerts");
    // Read before the migration (undefined) compares as none.
    expect(definitionChanges(baseDef(), off).settings).not.toContain("model alerts");
    const s = {
      name: "x",
      schedule: "manual",
      cronExpr: "",
      timezone: "",
      overlap: "skip",
      notifyOn: "failure",
      timeoutMinutes: 720,
      isActive: true,
    };
    const g: WorkflowGraph = { nodes: [], edges: [] };
    expect(savedForm({ ...s, alertTrigger: null }, g)).not.toBe(
      savedForm({ ...s, alertTrigger: on.alertTrigger }, g),
    );
  });
});

// ── The starter, over the stand-in database ─────────────────────────────

describe("an alert starting the owner's workflows", () => {
  it("starts each workflow that answers it, and only those", async () => {
    const started = await startWorkflowsOnAlert(drift(), NOW);
    expect(started).toEqual([{ workflowId: "wf-retrain", name: "Retrain churn", runId: "run-1" }]);
    const call = vi.mocked(startWorkflowRun).mock.calls[0];
    expect(call[1]).toBe("alert");
    expect(call[2]).toEqual({
      triggerDetail: {
        event: "drift",
        model_id: CHURN,
        model_name: "churn",
        prediction_id: "pred-1",
        score: 0.31,
      },
    });
    expect(wf("wf-retrain").alert_started_at).toBe(NOW.toISOString());
    expect(wf("wf-retrain").alert_last).toMatchObject({ started: true, run_id: "run-1" });
    // Paused: noted, not started. Decay-only and someone else's: untouched.
    expect(wf("wf-paused").alert_last).toMatchObject({
      started: false,
      reason: "the workflow is paused",
    });
    expect(wf("wf-decay").alert_last).toBeNull();
    expect(wf("wf-foreign").alert_last).toBeNull();
    expect(wf("wf-foreign").alert_started_at).toBeNull();
  });

  it("starts a workflow once per alert, however often it is re-measured", async () => {
    await startWorkflowsOnAlert(drift(), NOW);
    const noted = wf("wf-retrain").alert_last;
    // Two days on, past the wait: the same prediction run starts nothing more.
    const later = new Date(NOW.getTime() + 48 * 3_600_000);
    expect(await startWorkflowsOnAlert(drift(), later)).toEqual([]);
    expect(startWorkflowRun).toHaveBeenCalledTimes(1);
    // Quiet: the note still says what the alert did.
    expect(wf("wf-retrain").alert_last).toEqual(noted);
  });

  it("waits between alert starts, then starts again", async () => {
    await startWorkflowsOnAlert(drift(), NOW);
    const soon = new Date(NOW.getTime() + 3 * 3_600_000);
    expect(await startWorkflowsOnAlert(drift({ predictionId: "pred-2" }), soon)).toEqual([]);
    expect(wf("wf-retrain").alert_last).toMatchObject({
      started: false,
      reason: "an alert started it less than 24 hours ago",
    });
    const dayOn = new Date(NOW.getTime() + 25 * 3_600_000);
    const again = await startWorkflowsOnAlert(drift({ predictionId: "pred-3" }), dayOn);
    expect(again.map((s) => s.workflowId)).toEqual(["wf-retrain"]);
    expect(wf("wf-retrain").alert_started_at).toBe(dayOn.toISOString());
  });

  it("starts one run when two alerts land together", async () => {
    const [a, b] = await Promise.all([
      startWorkflowsOnAlert(drift({ predictionId: "pred-a" }), NOW),
      startWorkflowsOnAlert(drift({ predictionId: "pred-b" }), NOW),
    ]);
    expect([...a, ...b].filter((s) => s.workflowId === "wf-retrain")).toHaveLength(1);
  });

  it("does not spend the owner's compute on a run someone else started", async () => {
    expect(await startWorkflowsOnAlert(drift({ ranBy: OTHER }), NOW)).toEqual([]);
    expect(wf("wf-retrain").alert_last).toMatchObject({
      started: false,
      reason: "the run was not yours: someone the model is shared with ran it",
    });
  });

  it("ignores an alert about a version no longer in production", async () => {
    expect(await startWorkflowsOnAlert(drift({ versionId: "v1-old" }), NOW)).toEqual([]);
    expect(wf("wf-retrain").alert_last).toBeNull();
  });

  it("answers the accuracy alert too", async () => {
    const started = await startWorkflowsOnAlert({ ...drift(), event: "decay", score: 0.12 }, NOW);
    expect(started.map((s) => s.workflowId)).toEqual(["wf-decay"]);
  });

  it("gives the wait back when the run could not start", async () => {
    runner.refuse = "This workflow is already running";
    expect(await startWorkflowsOnAlert(drift(), NOW)).toEqual([]);
    expect(wf("wf-retrain").alert_started_at).toBeNull();
    expect(wf("wf-retrain").alert_last).toMatchObject({
      started: false,
      reason: "this workflow is already running",
    });
    runner.refuse = null;
    const soon = new Date(NOW.getTime() + 60_000);
    expect((await startWorkflowsOnAlert(drift({ predictionId: "pred-2" }), soon)).length).toBe(1);
  });

  it("starts nothing, and fails nothing, before the migration", async () => {
    db.missingColumns.add("alert_trigger");
    expect(await startWorkflowsOnAlert(drift(), NOW)).toEqual([]);
  });

  it("never throws into the alert's own path", async () => {
    db.throwOn = "ml_models";
    await expect(alertStarts(drift())).resolves.toEqual([]);
  });
});

// ── The one write path ───────────────────────────────────────────────────

describe("saving and reading a trigger", () => {
  beforeEach(() => {
    db.tables.workflows.push({
      id: "wf-edit",
      user_id: OWNER,
      name: "Edit me",
      schedule: "manual",
      updated_at: "2026-11-26T00:00:00.000Z",
      alert_trigger: null,
    });
  });
  const save = (def: WorkflowDefinition) =>
    applyWorkflowDefinition(OWNER, "wf-edit", def, { overwrite: true });

  it("saves the owner's own models, in canonical form", async () => {
    const res = await save(
      baseDef({ alertTrigger: { models: [FRAUD, CHURN], events: ["decay"], cooldownHours: 6 } }),
    );
    expect(res.ok).toBe(true);
    expect(wf("wf-edit").alert_trigger).toEqual({
      models: [CHURN, FRAUD],
      events: ["decay"],
      cooldownHours: 6,
    });
  });

  it("refuses a model that is not the owner's", async () => {
    db.tables.ml_models.push({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      user_id: OTHER,
      name: "theirs",
    });
    expect(
      await validateDefinition(
        OWNER,
        baseDef({
          alertTrigger: {
            models: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
            events: ["drift"],
            cooldownHours: 24,
          },
        }),
        "wf-edit",
      ),
    ).toBe("Starting on a model alert names a model that is gone, or is not yours.");
  });

  it("before the migration: every other save still works, and switching it on says why not", async () => {
    db.missingColumns.add("alert_trigger");
    const plain = await save(baseDef({ name: "Renamed", alertTrigger: null }));
    expect(plain.ok).toBe(true);
    expect(wf("wf-edit").name).toBe("Renamed");
    const on = await save(
      baseDef({ alertTrigger: { models: [CHURN], events: ["drift"], cooldownHours: 24 } }),
    );
    expect(on).toMatchObject({
      ok: false,
      error: expect.stringContaining("migration 20261206000000"),
    });
  });

  it("leaves the stored trigger alone when the definition does not say (undefined)", async () => {
    wf("wf-edit").alert_trigger = trigger();
    expect((await save(baseDef())).ok).toBe(true);
    expect(wf("wf-edit").alert_trigger).toEqual(trigger());
  });
});

describe("a file's models, found in another workspace by name", () => {
  const fileWith = (models: { id: string; name?: string }[]) => {
    const parsed = parseWorkflowFile(
      JSON.stringify({
        ...toWorkflowFile(baseDef()),
        onAlert: { models, events: ["drift"], cooldownHours: 24 },
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.file;
  };
  const elsewhere = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  it("keeps an id that is the reader's own, and swaps one that is not for its namesake", async () => {
    const res = await resolveFileTargets(OWNER, fileWith([{ id: elsewhere, name: "churn" }]));
    expect(res).toMatchObject({ ok: true, renamed: 1 });
    expect(res.ok && res.def.alertTrigger?.models).toEqual([CHURN]);
    const own = await resolveFileTargets(OWNER, fileWith([{ id: CHURN, name: "churn" }]));
    expect(own).toMatchObject({ ok: true, renamed: 0 });
  });

  it("refuses, saying why, when the name finds nothing, finds two, or is not given", async () => {
    expect(await resolveFileTargets(OWNER, fileWith([{ id: elsewhere, name: "nope" }]))).toEqual({
      ok: false,
      error: 'Starting on a model alert needs the model "nope", and you have none by that name',
    });
    db.tables.ml_models.push({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      user_id: OWNER,
      name: "churn",
    });
    expect(
      await resolveFileTargets(OWNER, fileWith([{ id: elsewhere, name: "churn" }])),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("you have 2 by that name"),
    });
    expect(await resolveFileTargets(OWNER, fileWith([{ id: elsewhere }]))).toMatchObject({
      ok: false,
      error: expect.stringContaining("the file does not say its name"),
    });
  });
});

// ── Where the alerts are raised, and what the migration holds ────────────

describe("the wiring", () => {
  it("asks for starts on drift with the run's own user and version", () => {
    const src = rd("src/utils/ml/predict.server.ts");
    expect(src).toMatch(
      /alertStarts\(\{\s*event: "drift",\s*modelId: model\.id,\s*predictionId: id,\s*ranBy: row\.user_id,\s*versionId: row\.version_id \?\? null,/,
    );
    expect(src).toContain("startedSentence(started.map((s) => s.name))");
  });

  it("asks for starts on decay as the scored run's user, not the measurer", () => {
    const src = rd("src/utils/ml/evaluate.server.ts");
    expect(src).toMatch(
      /alertStarts\(\{\s*event: "decay",\s*modelId: model\.id,\s*predictionId,\s*ranBy: prediction\.user_id,\s*versionId: prediction\.version_id \?\? null,/,
    );
  });

  it("looks up only the model owner's workflows", () => {
    const src = rd("src/utils/workflows/alertTriggers.server.ts");
    expect(src).toMatch(
      /\.from\("workflows"\)\s*\.select\("\*"\)[\s\S]{0,200}\.eq\("user_id", model\.user_id\)/,
    );
  });

  it("adds what it needs and nothing else", () => {
    const sql = rd("supabase/migrations/20261206000000_workflow_alert_triggers.sql");
    for (const col of [
      "alert_trigger jsonb",
      "alert_started_at timestamptz",
      "alert_last jsonb",
      "trigger_detail jsonb",
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    expect(sql).toContain(
      "CHECK (trigger IN ('manual', 'schedule', 'api', 'workflow', 'rerun', 'alert'))",
    );
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN)|RENAME/);
    // Which alerts start a workflow decides when work runs, as a cron
    // expression does, so the row-change audit watches it (and not the two
    // bookkeeping columns).
    expect(sql).toContain(
      "UPDATE OF name, graph, schedule, is_active, cron_expr, timezone, alert_trigger",
    );
    expect(sql).toContain("FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('workflow');");
  });

  it("reads runs with what started them, and without it before the migration", () => {
    const src = rd("src/utils/workflows.functions.ts");
    expect(src).toContain("const first = await read(`${RUN_COLUMNS}, trigger_detail`);");
    expect(src).toContain(
      "if (first.error && /trigger_detail/.test(first.error.message)) return read(RUN_COLUMNS);",
    );
  });

  it("shows the owner what acts on a model's alerts, and a grantee nothing", () => {
    const page = rd("src/routes/_authenticated/ml_.$modelId.tsx");
    expect(page).toContain(
      "{!shared ? <AlertPipelinesCard token={token} modelId={model.id} /> : null}",
    );
  });
});
