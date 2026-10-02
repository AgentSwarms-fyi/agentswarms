// SQL models built for real, by the real scheduler, against a running
// instance and a real lakehouse.
//
// The unit tests decide the ORDER a plan should have. Only this can show that
// the order is what actually ran, that a model reads the table its upstream
// wrote in the same build, and that a failing test really does stop the
// downstream model instead of rebuilding it from data known to be wrong.
//
// It does not force the sweep. Two models are made due and the instance's own
// 60-second scheduler pass picks them up, which is the path a real schedule
// takes — forcing would also force every other schedule on the instance.
//
// CLEANUP: the model rows, the build rows and the lineage edges are removed in
// an afterAll. The two LAKEHOUSE TABLES a build necessarily writes are real
// objects and are named `itest_stg_<run>` / `itest_fct_<run>`; dropping a
// lakehouse table needs a server-side connection this process cannot open, so
// they are left for the operator to drop from the Lakehouse page. They are
// named so they are obvious.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admin, hasSupabase } from "./setup";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:8080";
const RUN = Math.random().toString(36).slice(2, 7);
const STG = `itest_stg_${RUN}`;
const FCT = `itest_fct_${RUN}`;

/** The scheduler ticks every 60s; give it two, plus the build itself. */
const WAIT_MS = 170_000;

async function appIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

type BuildRow = {
  id: string;
  status: string;
  models: {
    name: string;
    outcome: string;
    rows: number | null;
    error?: string;
    blocked_by?: string;
    tests: { kind: string; status: string; failing: number }[];
  }[];
  error: string | null;
};

describe.skipIf(!hasSupabase)("SQL model builds", () => {
  let up = false;
  let userId: string | null = null;
  let schema: string | null = null;
  let stgId: string | null = null;
  let fctId: string | null = null;
  const seenRuns = new Set<string>();

  /** Make the fact due and wait for the sweep to produce a build we have not seen. */
  async function sweepAndWait(): Promise<BuildRow | null> {
    await admin()
      .from("sql_models")
      .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", fctId as string);
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      const { data } = await admin()
        .from("sql_model_runs")
        .select("id, status, models, error")
        .eq("user_id", userId as string)
        .neq("status", "running")
        .order("started_at", { ascending: false })
        .limit(5);
      const fresh = (data ?? []).find((r) => !seenRuns.has(r.id));
      if (fresh) {
        seenRuns.add(fresh.id);
        return fresh as unknown as BuildRow;
      }
    }
    return null;
  }

  beforeAll(async () => {
    up = await appIsUp();
    if (!up) return;

    // A schema its owner can actually write. A mount is read-only and a model
    // built into one is refused, which is a different test.
    const { data: schemas } = await admin()
      .from("lakehouse_schemas")
      .select("name, user_id, lake_source_id, iceberg_catalog_id")
      .is("lake_source_id", null)
      .is("iceberg_catalog_id", null)
      .limit(1);
    const own = schemas?.[0];
    if (!own) return;
    userId = own.user_id;
    schema = own.name;

    // A staging model with a NULL in one column, so a not_null test on it has
    // something real to catch later in this file.
    const { data: stg } = await admin()
      .from("sql_models")
      .insert({
        user_id: userId,
        name: STG,
        schema_name: schema,
        sql: "select * from (values (1, 'a'), (2, 'b'), (3, NULL)) as t(id, grp)",
        materialization: "table",
        schedule: "manual",
        tests: [],
      })
      .select("id")
      .maybeSingle();
    stgId = stg?.id ?? null;

    const { data: fct } = await admin()
      .from("sql_models")
      .insert({
        user_id: userId,
        name: FCT,
        schema_name: schema,
        sql: `select grp, count(*) as n from ref('${STG}') group by 1`,
        materialization: "table",
        schedule: "hourly",
        tests: [],
      })
      .select("id")
      .maybeSingle();
    fctId = fct?.id ?? null;
  });

  afterAll(async () => {
    for (const id of [fctId, stgId]) {
      if (id) await admin().from("sql_models").delete().eq("id", id);
    }
    if (userId) {
      await admin()
        .from("sql_model_runs")
        .delete()
        .in("id", [...seenRuns]);
      // Only this run's edges: another model's lineage is not ours to remove.
      await admin()
        .from("catalog_lineage")
        .delete()
        .eq("user_id", userId)
        .like("downstream_fqn", `%${RUN}%`);
    }
  });

  it(
    "builds the upstream first, and the downstream reads what it wrote",
    async () => {
      if (!up || !fctId) return;
      const run = await sweepAndWait();
      expect(run, "the scheduler produced no build").toBeTruthy();
      if (!run) return;
      expect(run.status, run.error ?? "").toBe("success");

      const names = run.models.map((m) => m.name);
      // The fact was the model that was DUE; the staging table is in the build
      // because the fact reads it, and it is first because the fact reads it.
      expect(names).toEqual([STG, FCT]);
      const stg = run.models.find((m) => m.name === STG);
      const fct = run.models.find((m) => m.name === FCT);
      expect(stg?.outcome).toBe("built");
      expect(stg?.rows).toBe(3);
      expect(fct?.outcome).toBe("built");
      // Three rows over two distinct groups plus the null one: the fact could
      // only have this shape by reading the table the staging model wrote.
      expect(fct?.rows).toBe(3);
    },
    WAIT_MS + 30_000,
  );

  it(
    "fails the model whose test fails, and skips everything downstream",
    async () => {
      if (!up || !stgId || !fctId) return;
      // grp has a NULL, so this test fails — and at error severity, which is
      // the setting that says "do not build anything on top of this".
      await admin()
        .from("sql_models")
        .update({
          tests: [{ kind: "not_null", column: "grp", severity: "error" }],
        })
        .eq("id", stgId);

      const run = await sweepAndWait();
      expect(run, "the scheduler produced no second build").toBeTruthy();
      if (!run) return;
      expect(run.status).toBe("error");

      const stg = run.models.find((m) => m.name === STG);
      const fct = run.models.find((m) => m.name === FCT);
      expect(stg?.outcome).toBe("failed");
      expect(stg?.tests?.[0]?.status).toBe("fail");
      expect(stg?.tests?.[0]?.failing).toBe(1);
      // The whole point: not rebuilt from data we already know is wrong.
      expect(fct?.outcome).toBe("skipped");
      expect(fct?.blocked_by).toBe(STG);
      expect(fct?.rows).toBeNull();
    },
    WAIT_MS + 30_000,
  );

  it("records the model-to-model edge where lineage is read", async () => {
    if (!up || !userId || !schema) return;
    const { data } = await admin()
      .from("catalog_lineage")
      .select("upstream_fqn, downstream_fqn, source_system, source_id")
      .eq("user_id", userId)
      .eq("downstream_fqn", `${schema}.${FCT}`);
    const edge = data?.[0];
    expect(edge, "no lineage edge was written").toBeTruthy();
    expect(edge?.upstream_fqn).toBe(`${schema}.${STG}`);
    expect(edge?.source_system).toBe("sql_model");
    // A lakehouse-to-lakehouse edge has no catalog source, and says so rather
    // than borrowing an unrelated one to satisfy a constraint.
    expect(edge?.source_id).toBeNull();
  });

  it("audits each build under the owner, with what happened to each model", async () => {
    if (!up || !userId) return;
    const { data } = await admin()
      .from("audit_events")
      .select("action, detail")
      .eq("user_id", userId)
      .eq("action", "sql_model.build")
      .order("created_at", { ascending: false })
      .limit(10);
    const rows = (data ?? []).map((e) => e.detail as Record<string, unknown>);
    const ours = rows.filter((d) => JSON.stringify(d.models ?? []).includes(RUN));
    expect(ours.length, "no sql_model.build audit row named this run").toBeGreaterThanOrEqual(1);
    const latest = ours[0];
    expect(latest.trigger).toBe("schedule");
    expect(Number(latest.skipped ?? 0) + Number(latest.failed ?? 0)).toBeGreaterThan(0);
  });
});
