// Drift on live traffic (R545).
//
// The formula is the batch path's own `_drift`, and the fixture is that
// function's output on awkward rows, generated in the sandbox image by
// tests/fixtures/trafficDriftParity.gen.py. Measuring the rows a request at a
// time and summing must give exactly what measuring them at once gives.
//
// The recording, the window and the hourly check run for real over an
// in-memory stand-in for the database; the audit, the notification and the
// workflow starter (R544, tested on its own) are the stand-ins.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  TRAFFIC_MIN_ROWS,
  categoryText,
  driftBand,
  featureStatsOf,
  mergeProfiles,
  numericValue,
  profileOf,
  profileRows,
  topFeaturesLine,
  trafficAlertKey,
  trafficDrift,
  type FeatureStats,
  type TrafficDrift,
} from "@/lib/mlTraffic";

const rd = (p: string) => readFileSync(p, "utf8");

const fixture = JSON.parse(rd("tests/fixtures/trafficDriftParity.json")) as {
  cases: { stats: unknown; rows: Record<string, unknown>[]; expected: TrafficDrift }[];
};

function expectSame(got: TrafficDrift | null, want: TrafficDrift) {
  expect(got).not.toBeNull();
  if (!got) return;
  expect(got.rows).toBe(want.rows);
  // The same features, in the same order (highest first)…
  expect(Object.keys(got.features)).toEqual(Object.keys(want.features));
  // …and the same numbers, to the four places both round to.
  for (const [k, v] of Object.entries(want.features)) {
    expect(got.features[k], k).toBeCloseTo(v, 4);
  }
  expect(got.score).toBeCloseTo(want.score, 4);
}

describe("the batch path's formula, on live traffic", () => {
  for (const [i, c] of fixture.cases.entries()) {
    const stats = featureStatsOf(c.stats) as FeatureStats;

    it(`case ${i + 1}: matches _drift on the same rows`, () => {
      expectSame(trafficDrift(stats, profileRows(stats, c.rows)), c.expected);
    });

    it(`case ${i + 1}: a request at a time, summed, is the same as all at once`, () => {
      const summed = c.rows
        .map((r) => profileRows(stats, [r]))
        .reduce((a, b) => mergeProfiles(a, b));
      expectSame(trafficDrift(stats, summed), c.expected);
    });
  }

  it("was generated from the program the sandbox runs, not written by hand", () => {
    const gen = rd("tests/fixtures/trafficDriftParity.gen.py");
    expect(gen).toContain('_drift = cut("def _drift(stats, df):")["_drift"]');
    expect(gen).toContain("df = pd.DataFrame(json.loads(json.dumps(rows)))");
    // And the batch path still builds its frame that way.
    expect(rd("src/utils/ml/pyTrain.ts")).toContain("df = pd.DataFrame(inp['rows'])");
  });
});

describe("reading a value as pandas does", () => {
  it("as a number: numbers, booleans, numeric text; nothing else", () => {
    expect(numericValue(12.5)).toBe(12.5);
    expect(numericValue(true)).toBe(1);
    expect(numericValue(false)).toBe(0);
    expect(numericValue(" 7 ")).toBe(7);
    expect(numericValue("1e3")).toBe(1000);
    for (const v of [null, undefined, "n/a", "", "12abc", {}, [], Number.NaN, Infinity]) {
      expect(numericValue(v), String(v)).toBeNull();
    }
  });

  it("as a category: text as it is, True/False as Python spells them", () => {
    expect(categoryText("pro")).toBe("pro");
    expect(categoryText(true)).toBe("True");
    expect(categoryText(7)).toBe("7");
    expect(categoryText(null)).toBeNull();
    expect(categoryText(undefined)).toBeNull();
  });
});

describe("what is kept of a request", () => {
  const stats = featureStatsOf(fixture.cases[0].stats) as FeatureStats;

  it("only counts against the training bins: no value a caller sent", () => {
    const sent = [
      { amount: 4321.987, plan: "acme-secret-plan", region: "zz-hidden", tenure: "31337" },
    ];
    const kept = JSON.stringify(profileRows(stats, sent));
    for (const v of ["4321", "acme-secret-plan", "zz-hidden", "31337"]) {
      expect(kept, v).not.toContain(v);
    }
    // Every count is a whole number, and every feature named is a training feature.
    const p = profileRows(stats, sent);
    for (const [name, counts] of Object.entries(p.f)) {
      expect(Object.keys(stats)).toContain(name);
      expect(counts.every((c) => Number.isInteger(c) && c >= 0)).toBe(true);
    }
  });

  it("knows a feature that was sent empty from one that was never sent", () => {
    const p = profileRows(stats, [{ plan: null }]);
    expect(p.f.plan).toEqual([0, 0, 0, 0]);
    expect(p.f.amount).toBeUndefined();
  });

  it("reads back only a profile, and merges only bins of the same shape", () => {
    expect(profileOf({ v: 1, rows: 2, f: { a: [1, 1] } })).not.toBeNull();
    for (const bad of [null, {}, { v: 2, rows: 1, f: {} }, { v: 1, rows: 1, f: { a: ["x"] } }]) {
      expect(profileOf(bad), JSON.stringify(bad)).toBeNull();
    }
    const merged = mergeProfiles(
      { v: 1, rows: 1, f: { a: [1, 0], b: [1] } },
      { v: 1, rows: 2, f: { a: [0, 2], b: [1, 1], c: [3] } },
    );
    expect(merged).toEqual({ v: 1, rows: 3, f: { a: [1, 2], b: [1], c: [3] } });
  });

  it("reads only stats of the stored shape", () => {
    expect(featureStatsOf(null)).toBeNull();
    expect(featureStatsOf({ x: { kind: "numeric", edges: [1], props: [] } })).toBeNull();
    expect(featureStatsOf({ x: { kind: "categorical", props: { a: "no" } } })).toBeNull();
  });
});

describe("the words", () => {
  it("bands as a run's Drift badge does", () => {
    expect(driftBand(0.05)).toBe("stable");
    expect(driftBand(0.1)).toBe("moderate");
    expect(driftBand(0.25)).toBe("high");
    expect(
      topFeaturesLine({ score: 2, features: { a: 2.04, b: 1.3, c: 0.9, d: 0.1 }, rows: 1 }),
    ).toBe("a 2.04, b 1.30, c 0.90");
    expect(trafficAlertKey("v1", new Date("2026-11-26T23:59:00Z"))).toBe("traffic:v1:2026-11-26");
  });
});

// ── The server, over a stand-in database ────────────────────────────────

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  missing: new Set<string>(),
  /** "table.column" a migration has not added yet (PGRST204 on write or read). */
  noColumn: new Set<string>(),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Q {
    filters: ((r: Record<string, unknown>) => boolean)[] = [];
    op: "select" | "update" | "upsert" = "select";
    patch: Record<string, unknown> = {};
    alias: [string, string, string][] = [];
    head = false;
    from = 0;
    to = Infinity;
    desc: string | null = null;
    cap = Infinity;
    constructor(public table: string) {}
    cols: string[] = [];
    select(cols?: string, opts?: { head?: boolean }) {
      if (opts?.head) this.head = true;
      if (this.op === "select") this.cols = (cols ?? "").split(",").map((x) => x.trim());
      for (const c of (cols ?? "").split(",").map((x) => x.trim())) {
        const m = /^(\w+):(\w+)->(\w+)$/.exec(c);
        if (m) this.alias.push([m[1], m[2], m[3]]);
      }
      return this;
    }
    get(r: Record<string, unknown>, c: string) {
      const m = /^(\w+)->(\w+)$/.exec(c);
      return m ? (r[m[1]] as Record<string, unknown> | null)?.[m[2]] : r[c];
    }
    eq(c: string, v: unknown) {
      this.filters.push((r) => this.get(r, c) === v);
      return this;
    }
    in(c: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(this.get(r, c)));
      return this;
    }
    gte(c: string, v: string) {
      this.filters.push((r) => String(this.get(r, c)) >= v);
      return this;
    }
    lt(c: string, v: string) {
      this.filters.push((r) => typeof r[c] === "string" && (r[c] as string) < v);
      return this;
    }
    is(c: string, v: null) {
      this.filters.push((r) => (this.get(r, c) ?? null) === v);
      return this;
    }
    not(c: string, _op: "is", v: null) {
      this.filters.push((r) => (this.get(r, c) ?? null) !== v);
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
    update(p: Record<string, unknown>) {
      this.op = "update";
      this.patch = p;
      return this;
    }
    conflict = ["version_id"];
    upsert(r: Record<string, unknown>, o?: { onConflict?: string }) {
      this.op = "upsert";
      this.patch = r;
      if (o?.onConflict) this.conflict = o.onConflict.split(",");
      return this;
    }
    exec() {
      const t = (db.tables[this.table] ??= []);
      if (this.op === "upsert") {
        const i = t.findIndex((x) => this.conflict.every((k) => x[k] === this.patch[k]));
        if (i >= 0) t[i] = { ...t[i], ...this.patch };
        else t.push({ alerted_at: null, ...this.patch });
        return [this.patch];
      }
      let hit = t.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        for (const r of hit) Object.assign(r, this.patch);
        return hit;
      }
      if (this.desc) {
        const k = this.desc;
        hit = [...hit].sort((a, b) => String(b[k]).localeCompare(String(a[k])));
      }
      hit = hit.slice(this.from, Math.min(this.to + 1, this.from + this.cap));
      return hit.map((r) => {
        const out = { ...r };
        for (const [name, col, key] of this.alias) {
          out[name] = (r[col] as Record<string, unknown> | null)?.[key] ?? null;
        }
        return out;
      });
    }
    result() {
      const named = this.op === "select" ? this.cols : Object.keys(this.patch);
      const absent = named.find((c) => db.noColumn.has(`${this.table}.${c}`));
      if (absent) {
        return {
          data: null,
          count: null,
          error: {
            code: "PGRST204",
            message: `Could not find the '${absent}' column of '${this.table}' in the schema cache`,
          },
        };
      }
      if (db.missing.has(this.table)) {
        return {
          data: null,
          count: null,
          error: { message: `Could not find the table 'public.${this.table}' in the schema cache` },
        };
      }
      const rows = this.exec();
      return this.head
        ? { data: null, count: rows.length, error: null }
        : { data: rows, count: rows.length, error: null };
    }
    async maybeSingle() {
      const r = this.result();
      return { ...r, data: (r.data as unknown[] | null)?.[0] ?? null };
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
  getPlatformResources: async () => ({ mlDriftAlertPsi: 0.25 }),
}));

const { recordTrafficProfile, liveTraffic, runTrafficDriftChecks } =
  await import("@/utils/ml/traffic.server");
const { auditEvent } = await import("@/utils/audit.server");
const { notifyUser } = await import("@/utils/notify.server");
const { alertStarts } = await import("@/utils/workflows/alertTriggers.server");

const OWNER = "11111111-1111-4111-8111-111111111111";
const GRANTEE = "22222222-2222-4222-8222-222222222222";
const MODEL = { id: "model-1", user_id: OWNER, name: "churn" };
const NOW = new Date("2026-11-26T12:00:00.000Z");
const STATS = fixture.cases[0].stats;
const ROWS = fixture.cases[0].rows;
const EXPECTED = fixture.cases[0].expected;

/** One request per fixture row, as the app records them: counts only. */
function requests(
  opts: { owner?: (i: number) => boolean; model?: string; ageHours?: number } = {},
) {
  const stats = featureStatsOf(STATS) as FeatureStats;
  return ROWS.map((r, i) => ({
    id: `p-${opts.model ?? "m"}-${opts.ageHours ?? 0}-${i}`,
    model_id: opts.model ?? MODEL.id,
    version_id: "v-prod",
    user_id: (opts.owner ?? (() => true))(i) ? OWNER : GRANTEE,
    kind: "rows",
    status: "succeeded",
    created_at: new Date(NOW.getTime() - (opts.ageHours ?? 1) * 3_600_000 - i * 1000).toISOString(),
    input: { kind: "rows", count: 1, profile: profileRows(stats, [r]) },
  }));
}

function seed(reqs: Row[]) {
  db.missing.clear();
  db.noColumn.clear();
  db.tables = {
    ml_models: [{ ...MODEL, updated_at: "2026-11-26T00:00:00Z", production_version_id: "v-prod" }],
    ml_model_versions: [{ id: "v-prod", version: 3, feature_stats: STATS }],
    ml_predictions: reqs,
    ml_traffic_checks: [],
    ml_traffic_daily: [],
  };
}

beforeEach(() => {
  vi.mocked(auditEvent).mockClear();
  vi.mocked(notifyUser).mockClear();
  vi.mocked(alertStarts).mockClear();
});

describe("recording a request", () => {
  it("keeps the counts on the request's own row, beside what was there", async () => {
    seed([
      {
        id: "p-new",
        model_id: MODEL.id,
        version_id: "v-prod",
        user_id: OWNER,
        kind: "rows",
        status: "succeeded",
        input: { kind: "rows", count: 2, served: "warm" },
      },
    ]);
    await recordTrafficProfile("p-new", [ROWS[1], ROWS[2]]);
    const input = db.tables.ml_predictions[0].input as Row;
    expect(input).toMatchObject({ kind: "rows", count: 2, served: "warm" });
    expect(profileOf(input.profile)).toMatchObject({ v: 1, rows: 2 });
  });

  it("leaves a batch run alone, and never throws", async () => {
    seed([{ id: "p-batch", model_id: MODEL.id, version_id: "v-prod", kind: "batch", input: {} }]);
    await recordTrafficProfile("p-batch", [ROWS[1]]);
    expect(db.tables.ml_predictions[0].input).toEqual({});
    db.missing.add("ml_predictions");
    await expect(recordTrafficProfile("p-batch", [ROWS[1]])).resolves.toBeUndefined();
  });
});

describe("a day of live traffic", () => {
  it("measures the version's requests together, exactly as one batch of those rows", async () => {
    seed(requests());
    const [t] = await liveTraffic(MODEL, NOW);
    expect(t).toMatchObject({ versionId: "v-prod", requests: 260, rows: 260, ownerRows: 260 });
    expectSame(t.drift, EXPECTED);
  });

  it("reads only this model's requests from the last 24 hours", async () => {
    seed([...requests(), ...requests({ ageHours: 30 }), ...requests({ model: "model-2" })]);
    const [t] = await liveTraffic(MODEL, NOW);
    expect(t.requests).toBe(260);
  });

  it("says nothing below the minimum, only how many rows so far", async () => {
    seed(requests().slice(0, TRAFFIC_MIN_ROWS - 1));
    const [t] = await liveTraffic(MODEL, NOW);
    expect(t.rows).toBe(TRAFFIC_MIN_ROWS - 1);
    expect(t.drift).toBeNull();
  });

  it("measures the owner's own requests apart from everyone's", async () => {
    seed(requests({ owner: (i) => i % 2 === 0 }));
    const [t] = await liveTraffic(MODEL, NOW);
    expect(t.rows).toBe(260);
    expect(t.ownerRows).toBe(130);
    expect(t.ownerDrift).toBeNull();
  });
});

describe("the hourly check", () => {
  it("records the verdict, alerts the owner, and asks the workflows", async () => {
    seed(requests());
    // Two alerts: the drift, and (R549) the two features no request sent.
    expect(await runTrafficDriftChecks(NOW)).toEqual({ checked: 1, alerted: 2 });
    expect(db.tables.ml_traffic_checks[0]).toMatchObject({
      version_id: "v-prod",
      model_id: MODEL.id,
      user_id: OWNER,
      requests: 260,
      row_count: 260,
      owner_row_count: 260,
      alerted_at: NOW.toISOString(),
    });
    expect(vi.mocked(auditEvent).mock.calls[0][0]).toMatchObject({
      action: "ml.drift.alert",
      detail: { source: "traffic", rows: 260, threshold: 0.25 },
    });
    expect(vi.mocked(alertStarts).mock.calls[0][0]).toEqual({
      event: "drift",
      modelId: MODEL.id,
      predictionId: "traffic:v-prod:2026-11-26",
      ranBy: OWNER,
      versionId: "v-prod",
      score: EXPECTED.score,
    });
    const note = vi.mocked(notifyUser).mock.calls[0][1] as { title: string; body: string };
    expect(note.title).toBe(`Drift on "churn" live traffic: PSI ${EXPECTED.score.toFixed(2)}`);
    expect(note.body).toContain("(260 rows)");
    expect(note.body).toContain('Started "Retrain churn".');
  });

  it("alerts once a day, not once an hour", async () => {
    seed(requests());
    await runTrafficDriftChecks(NOW);
    const hourLater = new Date(NOW.getTime() + 3_600_000);
    expect(await runTrafficDriftChecks(hourLater)).toEqual({ checked: 1, alerted: 0 });
    expect(auditEvent).toHaveBeenCalledTimes(2);
    // A day on, still drifting: once more. The missing-inputs alert keeps its
    // own clock, so it is not raised again with it (R549).
    db.tables.ml_traffic_checks[0].alerted_at = new Date(
      NOW.getTime() - 25 * 3_600_000,
    ).toISOString();
    expect((await runTrafficDriftChecks(NOW)).alerted).toBe(1);
    expect(vi.mocked(auditEvent).mock.calls[2][0]).toMatchObject({ action: "ml.drift.alert" });
  });

  it("tells the owner, but starts none of their work, when only others' requests drifted", async () => {
    seed(requests({ owner: (i) => i % 2 === 0 }));
    expect((await runTrafficDriftChecks(NOW)).alerted).toBe(2);
    expect(alertStarts).not.toHaveBeenCalled();
    expect((vi.mocked(notifyUser).mock.calls[0][1] as { body: string }).body).toContain(
      "Consider retraining.",
    );
  });

  it("before the migration: measures nothing it cannot record, and alerts nobody", async () => {
    seed(requests());
    db.missing.add("ml_traffic_checks");
    expect(await runTrafficDriftChecks(NOW)).toEqual({ checked: 1, alerted: 0 });
    expect(auditEvent).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("does not alert below the threshold", async () => {
    // The training distribution itself, as traffic: no drift.
    const stats = featureStatsOf(STATS) as FeatureStats;
    const calm = Array.from({ length: 250 }, (_, i) => ({
      id: `calm-${i}`,
      model_id: MODEL.id,
      version_id: "v-prod",
      user_id: OWNER,
      kind: "rows",
      status: "succeeded",
      created_at: new Date(NOW.getTime() - 3_600_000 - i * 1000).toISOString(),
      input: {
        profile: profileRows(stats, [
          {
            amount: (i % 10) * 10 + 5,
            tenure: [0.5, 1.5, 1.5, 3, 3, 3, 6, 6, 12, 1.2][i % 10],
            plan: ["basic", "basic", "basic", "basic", "basic", "pro", "pro", "pro", "team", "x"][
              i % 10
            ],
            region: i % 5 < 3 ? "eu" : "us",
            // Every training feature sent, as training had them: nothing missing.
            absent: i % 2,
            sparse: (i + 1) % 2,
          },
        ]),
      },
    }));
    seed(calm);
    expect(await runTrafficDriftChecks(NOW)).toEqual({ checked: 1, alerted: 0 });
    expect(db.tables.ml_traffic_checks[0].score as number).toBeLessThan(0.25);
    expect(db.tables.ml_traffic_checks[0].missing).toEqual([]);
  });
});

describe("the day's verdict, kept for the history (R548)", () => {
  it("keeps one row per version per day, the day's last check", async () => {
    seed(requests());
    await runTrafficDriftChecks(NOW);
    expect(db.tables.ml_traffic_daily).toEqual([
      expect.objectContaining({
        version_id: "v-prod",
        day: "2026-11-26",
        model_id: MODEL.id,
        user_id: OWNER,
        requests: 260,
        row_count: 260,
        score: EXPECTED.score,
      }),
    ]);
    // An hour on, the same day: replaced, not added.
    const later = new Date(NOW.getTime() + 3_600_000);
    await runTrafficDriftChecks(later);
    expect(db.tables.ml_traffic_daily).toHaveLength(1);
    expect(db.tables.ml_traffic_daily[0].checked_at).toBe(later.toISOString());
    // The next day: a second row.
    const tomorrow = new Date(NOW.getTime() + 13 * 3_600_000);
    await runTrafficDriftChecks(tomorrow);
    expect(db.tables.ml_traffic_daily.map((r) => r.day)).toEqual(["2026-11-26", "2026-11-27"]);
  });

  it("before its migration: no history, and the check and its alert go on", async () => {
    seed(requests());
    db.missing.add("ml_traffic_daily");
    expect(await runTrafficDriftChecks(NOW)).toEqual({ checked: 1, alerted: 2 });
    expect(db.tables.ml_traffic_checks).toHaveLength(1);
  });
});

describe("the wiring", () => {
  it("records every online request after it is answered, without waiting", () => {
    const src = rd("src/utils/ml/predict.server.ts");
    expect(src).toMatch(
      /export async function predictRowsSync\(args: RowsArgs\)[\s\S]{0,400}const res = await scoreRowsSync\(args\);[\s\S]{0,300}void import\("\.\/traffic\.server"\)\s*\.then\(\(m\) => m\.recordTrafficProfile\(predictionId, args\.rows\)\)/,
    );
  });

  it("checks hourly on the platform clock", () => {
    const src = rd("src/utils/bi/refresh.server.ts");
    expect(src).toMatch(
      /if \(force \|\| new Date\(\)\.getMinutes\(\) < 2\) \{\s*await step\(\s*"ml-traffic",/,
    );
  });

  it("shows live traffic to the model's owner only", () => {
    const fns = rd("src/utils/mlConsole.functions.ts");
    const fn = fns.slice(fns.indexOf("export const mlLiveTraffic"));
    expect(fn).toMatch(/\.eq\("id", data\.modelId\)\s*\.eq\("user_id", userId\)/);
    expect(rd("src/routes/_authenticated/ml_.$modelId.tsx")).toContain(
      "{!shared ? <LiveTrafficCard token={token} modelId={model.id} /> : null}",
    );
  });

  it("adds a table the owner can only read", () => {
    const sql = rd("supabase/migrations/20261207000000_ml_traffic_checks.sql");
    expect(sql).toContain("ALTER TABLE public.ml_traffic_checks ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("FOR SELECT");
    expect(sql).not.toMatch(/FOR (ALL|INSERT|UPDATE|DELETE)/);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN)|RENAME/);
  });
});

describe("found from the UI in R545", () => {
  it("says why a version's traffic cannot be measured, instead of 'no requests'", () => {
    // A version trained before drift was recorded keeps no counts, and the
    // card said there had been no online requests for a model that had just
    // answered one.
    const fns = rd("src/utils/mlConsole.functions.ts");
    expect(fns).toContain('.select("id, version, has_stats:feature_stats")');
    expect(fns).toMatch(
      /productionUnmeasured:\s*production && !production\.has_stats \? \(production\.version \?\? null\) : null,/,
    );
    const card = rd("src/components/ml/LiveTrafficCard.tsx");
    expect(card).toMatch(
      /view\.productionUnmeasured !== null \?[\s\S]{0,400}holds no record of how its[\s\S]{0,300}: view\.versions\.length === 0 \?/,
    );
  });
});

// ── Inputs that stop arriving (R549) ────────────────────────────────────

/** The fixture's stats with training missing rates, as a version trained since R549 holds. */
const STATS_WITH_RATES = Object.fromEntries(
  Object.entries(STATS as Record<string, Row>).map(([k, v]) => [
    k,
    { ...v, missing: { amount: 0.05, tenure: 0, plan: 0, region: 0, absent: 0.95, sparse: 0 }[k] },
  ]),
);

describe("inputs that stop arriving (R549)", () => {
  it("names a feature no request sent, tells the owner once a day, and starts nothing", async () => {
    seed(requests());
    await runTrafficDriftChecks(NOW);
    // Trained before rates were recorded: named only when it all but stopped.
    expect(db.tables.ml_traffic_checks[0].missing).toEqual([
      { feature: "absent", rate: 1, training: null },
      { feature: "sparse", rate: 0.9769, training: null },
    ]);
    const missing = vi
      .mocked(auditEvent)
      .mock.calls.find(([e]) => (e as { action: string }).action === "ml.inputs.missing")?.[0] as
      { detail: Row } | undefined;
    expect(missing?.detail).toMatchObject({ source: "traffic", version_id: "v-prod", rows: 260 });
    const note = vi.mocked(notifyUser).mock.calls[1][1] as { title: string; body: string };
    expect(note.title).toBe('Inputs missing on "churn" live traffic: 2 features');
    expect(note.body).toContain("absent empty in 100% of rows (not recorded at training)");
    expect(note.body).toContain("Retraining will not fix this");
    // Only the drift asked the workflows.
    expect(vi.mocked(alertStarts).mock.calls.map(([a]) => a.event)).toEqual(["drift"]);

    vi.mocked(auditEvent).mockClear();
    await runTrafficDriftChecks(new Date(NOW.getTime() + 3_600_000));
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it("with training's own rates: flagged on the rise, not on the rate", async () => {
    // Its own version: a version's stats are read once per process.
    seed(requests().map((r) => ({ ...r, version_id: "v-rates" })));
    db.tables.ml_model_versions.push({
      id: "v-rates",
      version: 4,
      feature_stats: STATS_WITH_RATES,
    });
    const [t] = await liveTraffic(MODEL, NOW);
    // amount 5% now and 5% in training, tenure up 7.7 points, absent up 5:
    // none named. The rest rose by ten points or more, largest rise first.
    expect(t.missing).toEqual([
      { feature: "sparse", rate: 0.9769, training: 0 },
      { feature: "region", rate: 0.2, training: 0 },
      { feature: "plan", rate: 0.1192, training: 0 },
    ]);
  });

  it("a version with enough rows to count, too few for drift, is checked", async () => {
    seed(requests().slice(0, 150));
    expect(await runTrafficDriftChecks(NOW)).toEqual({ checked: 1, alerted: 1 });
    expect(db.tables.ml_traffic_checks[0]).toMatchObject({ score: null, row_count: 150 });
    expect(vi.mocked(auditEvent).mock.calls.map(([e]) => (e as { action: string }).action)).toEqual(
      ["ml.inputs.missing"],
    );
  });

  it("below its minimum: not checked at all", async () => {
    seed(requests().slice(0, 99));
    expect(await runTrafficDriftChecks(NOW)).toEqual({ checked: 0, alerted: 0 });
    expect(db.tables.ml_traffic_checks).toEqual([]);
  });

  it("before migration 20261209000000: the drift check and its alert go on as they were", async () => {
    seed(requests());
    db.noColumn.add("ml_traffic_checks.missing");
    db.noColumn.add("ml_traffic_checks.missing_alerted_at");
    expect(await runTrafficDriftChecks(NOW)).toEqual({ checked: 1, alerted: 1 });
    expect(db.tables.ml_traffic_checks[0]).toMatchObject({
      version_id: "v-prod",
      score: EXPECTED.score,
    });
    expect(db.tables.ml_traffic_checks[0]).not.toHaveProperty("missing");
    expect(vi.mocked(auditEvent).mock.calls.map(([e]) => (e as { action: string }).action)).toEqual(
      ["ml.drift.alert"],
    );
  });
});
