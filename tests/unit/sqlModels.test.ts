// SQL models: the transformation layer's rules.
//
// What is pinned here is everything a build depends on being right — what a
// ref is, what order models build in, what happens downstream when one fails,
// and what each test asserts — each with the case it exists to refuse. Then
// the wiring: the migration, the sweep, the audit, the editor and the docs.
//
// Order is the whole feature. A layer that builds a fact before the staging
// table it reads is worse than no layer, because it produces an answer.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildPlan,
  buildStatus,
  descendantsOf,
  describeTest,
  extractRefs,
  modelTarget,
  quotedTarget,
  qi,
  refNames,
  renderSql,
  testSql,
  validateModelName,
  validateModelSql,
  validateTest,
  type SqlModel,
  type SqlModelTest,
} from "@/lib/sqlModels";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const model = (name: string, sql: string, over: Partial<SqlModel> = {}): SqlModel => ({
  id: name,
  name,
  schema_name: "analytics",
  sql,
  materialization: "table",
  tests: [],
  is_active: true,
  ...over,
});

describe("ref() names another model", () => {
  it("finds a ref in either quote, with any spacing", () => {
    expect(refNames("select * from ref('a') join ref(\"b\") on 1=1")).toEqual(["a", "b"]);
    expect(refNames("select * from ref ( 'a' )")).toEqual(["a"]);
    expect(refNames("SELECT * FROM REF('a')")).toEqual(["a"]);
  });

  it("reports each name once, in the order it first appears", () => {
    expect(refNames("select * from ref('b') union all select * from ref('a'), ref('b')")).toEqual([
      "b",
      "a",
    ]);
  });

  it("does not read a ref inside a comment", () => {
    // A dependency the query never reads imposes an order for no reason, and
    // in a loop it would refuse a project that is actually fine.
    expect(refNames("select 1 -- from ref('ghost')\n")).toEqual([]);
    expect(refNames("select 1 /* ref('ghost') */ from ref('real')")).toEqual(["real"]);
    // Mutation check: uncommented, the same text IS a dependency.
    expect(refNames("select 1 from ref('ghost')")).toEqual(["ghost"]);
  });

  it("does not read a ref inside a string literal", () => {
    expect(refNames("select 'ref(''ghost'')' as note from ref('real')")).toEqual(["real"]);
  });

  it("does not match a word that merely ends in ref", () => {
    expect(refNames("select preferred_ref('a')")).toEqual([]);
    expect(refNames("select xref('a')")).toEqual([]);
  });

  it("replaces each ref with the quoted table, leaving everything else alone", () => {
    const out = renderSql("select * from ref('a') -- keep ref('a') here\n", (n) =>
      n === "a" ? '"analytics"."a"' : null,
    );
    expect(out).toBe('select * from "analytics"."a" -- keep ref(\'a\') here\n');
  });

  it("names a missing model rather than letting the database complain", () => {
    expect(() => renderSql("select * from ref('gone')", () => null)).toThrow(/gone/);
  });

  it("quotes an identifier the way DuckDB expects, doubling an embedded quote", () => {
    expect(qi('we"ird')).toBe('"we""ird"');
    expect(quotedTarget({ schema_name: "a", name: "b" })).toBe('"a"."b"');
    expect(modelTarget({ schema_name: "a", name: "b" })).toBe("a.b");
  });

  it("keeps an offset that is correct even after an earlier replacement", () => {
    const sites = extractRefs("x ref('aa') y ref('b') z");
    expect(sites.map((s) => s.name)).toEqual(["aa", "b"]);
    // Splicing has to use these, so they must point at the ref text itself.
    expect("x ref('aa') y ref('b') z".slice(sites[1].start, sites[1].end)).toBe("ref('b')");
  });
});

describe("the build order", () => {
  const staging = model("stg_orders", "select * from raw.orders");
  const facts = model("fct_revenue", "select * from ref('stg_orders')");
  const marts = model("mart_daily", "select * from ref('fct_revenue'), ref('stg_orders')");

  it("builds a model only after everything it reads", () => {
    const { order } = buildPlan([marts, facts, staging]);
    expect(order.map((m) => m.name)).toEqual(["stg_orders", "fct_revenue", "mart_daily"]);
  });

  it("is stable, so two build logs of one project can be compared", () => {
    const a = model("a", "select 1");
    const b = model("b", "select 1");
    expect(buildPlan([b, a]).order.map((m) => m.name)).toEqual(["a", "b"]);
    expect(buildPlan([a, b]).order.map((m) => m.name)).toEqual(["a", "b"]);
  });

  it("restricted to a selection, still builds what that selection reads", () => {
    // dbt's `+model`: a fact rebuilt without its staging table leaves the two
    // disagreeing, which is the bug this layer exists to prevent.
    const { order } = buildPlan([marts, facts, staging], ["fct_revenue"]);
    expect(order.map((m) => m.name)).toEqual(["stg_orders", "fct_revenue"]);
    expect(order.map((m) => m.name)).not.toContain("mart_daily");
  });

  it("leaves a paused model out of the plan", () => {
    const paused = model("stg_orders", "select 1", { is_active: false });
    const { order } = buildPlan([paused, facts]);
    expect(order.map((m) => m.name)).toEqual(["fct_revenue"]);
    // Mutation check: active, it is planned and it comes first.
    expect(buildPlan([staging, facts]).order.map((m) => m.name)).toEqual([
      "stg_orders",
      "fct_revenue",
    ]);
  });

  it("refuses a circle by name rather than hanging", () => {
    const a = model("a", "select * from ref('b')");
    const b = model("b", "select * from ref('a')");
    expect(() => buildPlan([a, b])).toThrow(/circle/i);
    expect(() => buildPlan([a, b])).toThrow(/a/);
    // And when only part of the graph is selected.
    expect(() => buildPlan([a, b], ["a"])).toThrow(/circle/i);
  });

  it("refuses a model that reads itself", () => {
    expect(() => buildPlan([model("a", "select * from ref('a')")], ["a"])).toThrow(/circle/i);
  });

  it("records what each model in the plan waits for", () => {
    const { deps } = buildPlan([marts, facts, staging]);
    expect(deps.get("mart_daily")?.sort()).toEqual(["fct_revenue", "stg_orders"]);
    expect(deps.get("stg_orders")).toEqual([]);
  });
});

describe("a failure stops at the failure", () => {
  it("finds everything downstream of a broken model, however deep", () => {
    const deps = new Map([
      ["stg", []],
      ["fct", ["stg"]],
      ["mart", ["fct"]],
      ["unrelated", []],
    ]);
    const hit = descendantsOf(deps, "stg");
    expect([...hit].sort()).toEqual(["fct", "mart"]);
    // Mutation check: a model on another branch is untouched.
    expect(hit.has("unrelated")).toBe(false);
  });

  it("calls a build partial when some models built and some did not", () => {
    expect(buildStatus(["built", "built"])).toBe("success");
    expect(buildStatus(["failed", "skipped"])).toBe("error");
    expect(buildStatus(["built", "failed", "skipped"])).toBe("partial");
    expect(buildStatus([])).toBe("success");
  });
});

describe("what a test asserts", () => {
  const t = (over: Partial<SqlModelTest>): SqlModelTest => ({
    kind: "not_null",
    column: "amount",
    severity: "error",
    ...over,
  });

  it("counts the rows that fail, in every kind, so the runner has one path", () => {
    expect(testSql(t({}), "T")).toContain('"amount" IS NULL');
    expect(testSql(t({ kind: "unique" }), "T")).toContain("HAVING count(*) > 1");
    expect(testSql(t({ kind: "accepted_values", values: ["a", "b"] }), "T")).toContain(
      "NOT IN ('a', 'b')",
    );
    expect(testSql(t({ kind: "range", min: 0, max: 10 }), "T")).toContain(
      '"amount" < 0 OR "amount" > 10',
    );
    expect(testSql(t({ kind: "row_count_min", column: null, count: 5 }), "T")).toContain(
      "count(*) >= 5 THEN 0 ELSE 1",
    );
  });

  it("counts duplicated ROWS, not repeated values", () => {
    // "3 rows are duplicated" is what someone fixing the model needs.
    expect(testSql(t({ kind: "unique" }), "T")).toContain("sum(n)");
  });

  it("escapes a value that contains a quote", () => {
    const sql = testSql(t({ kind: "accepted_values", values: ["O'Brien"] }), "T");
    expect(sql).toContain("'O''Brien'");
  });

  it("ignores nulls in every test but not_null, which is what they are for", () => {
    for (const kind of ["unique", "accepted_values", "range"] as const) {
      const sql = testSql(t({ kind, values: ["a"], min: 0, max: 1 }), "T");
      expect(sql, kind).toContain("IS NOT NULL");
    }
  });

  it("describes itself in a sentence for the editor and the log", () => {
    expect(describeTest(t({}))).toBe("amount is never null");
    expect(describeTest(t({ kind: "range", min: 0, max: 10 }))).toBe("amount is between 0 and 10");
    expect(describeTest(t({ kind: "range", min: 0, max: null }))).toBe("amount is at least 0");
    expect(describeTest(t({ kind: "row_count_min", column: null, count: 5 }))).toBe(
      "the table has at least 5 rows",
    );
  });

  it("refuses a test that cannot mean anything", () => {
    expect(validateTest(t({ column: "" }))).toMatch(/column/i);
    expect(validateTest(t({ kind: "accepted_values", values: [] }))).toMatch(/accepted value/i);
    expect(validateTest(t({ kind: "range", min: null, max: null }))).toMatch(/minimum/i);
    expect(validateTest(t({ kind: "row_count_min", column: null, count: undefined }))).toMatch(
      /row count/i,
    );
    // Mutation check: the same tests, made valid, pass.
    expect(validateTest(t({}))).toBeNull();
    expect(validateTest(t({ kind: "accepted_values", values: ["a"] }))).toBeNull();
    expect(validateTest(t({ kind: "range", min: 0, max: null }))).toBeNull();
    expect(validateTest(t({ kind: "row_count_min", column: null, count: 0 }))).toBeNull();
  });
});

describe("what may be saved", () => {
  it("takes a name that can also be a table name, and refuses one that cannot", () => {
    expect(validateModelName("stg_orders")).toBeNull();
    expect(validateModelName("_x1")).toBeNull();
    expect(validateModelName("Stg Orders")).toMatch(/lower case/);
    expect(validateModelName("1st")).toMatch(/lower case/);
    expect(validateModelName('a"b')).toMatch(/lower case/);
    expect(validateModelName("")).toMatch(/name/);
  });

  it("insists a model is a SELECT", () => {
    expect(validateModelSql("select 1")).toBeNull();
    expect(validateModelSql("with a as (select 1) select * from a")).toBeNull();
    expect(validateModelSql("create table x as select 1")).toMatch(/SELECT/);
    expect(validateModelSql("delete from orders")).toMatch(/SELECT/);
    expect(validateModelSql("   ")).toMatch(/SELECT/);
  });
});

describe("the wiring", () => {
  const migration = rd("supabase/migrations/20260871000000_sql_models.sql");
  const runner = rd("src/utils/sqlModels/run.server.ts");
  const fns = rd("src/utils/sqlModels.functions.ts");

  it("owns its tables, with the name unique per owner", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.sql_models");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.sql_model_runs");
    // ref('orders') must mean one table, not whichever the resolver saw first.
    expect(migration).toContain("UNIQUE (user_id, name)");
    expect(migration).toContain("ALTER TABLE public.sql_models ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE public.sql_model_runs ENABLE ROW LEVEL SECURITY");
    // The database enforces the same name rule the editor does.
    expect(migration).toContain("name ~ '^[a-z_][a-z0-9_]{0,62}$'");
  });

  it("audits every change to a definition through the shared row trigger", () => {
    const trigger = migration.slice(migration.indexOf("CREATE TRIGGER audit_sql_models"));
    expect(trigger).toContain("audit_row_change('sql_model')");
    for (const col of ["sql", "schema_name", "materialization", "tests", "schedule", "is_active"]) {
      expect(trigger, col).toContain(col);
    }
  });

  it("lets a lakehouse-to-lakehouse edge exist without inventing a catalog source", () => {
    expect(migration).toContain("ALTER COLUMN source_id DROP NOT NULL");
    expect(runner).toContain('source_system: "sql_model"');
    expect(runner).toContain("source_id: null");
  });

  it("builds as the owner, re-checking access on every build", () => {
    expect(runner).toContain("accessibleSchemas(args.userId)");
    expect(runner).toContain("assertSchemasAllowed");
    // A definition edited into a write must never execute as one.
    expect(runner).toContain('classifyStatement(rendered).kind !== "select"');
    expect(runner).toContain("A model can only be built into a schema you own");
    expect(runner).toContain("Data-lake mounts are read-only");
  });

  it("writes each model in one commit, and switches shape without getting stuck", () => {
    expect(runner).toContain("CREATE OR REPLACE ${kind} ${target} AS ${body}");
    // CREATE OR REPLACE TABLE cannot replace a view, so changing the
    // materialization has to drop the other shape first.
    expect(runner).toContain('DROP ${kind === "TABLE" ? "VIEW" : "TABLE"} IF EXISTS');
  });

  it("skips a model whose upstream failed, and says which one", () => {
    expect(runner).toContain('outcome: "skipped"');
    expect(runner).toContain("blocked_by: root");
    // A failing error test fails the model, so the same skip applies.
    expect(runner).toContain('t.severity === "error" && t.status !== "pass"');
  });

  it("does not let a test that errored count as a pass", () => {
    const tests = runner.slice(runner.indexOf("async function runTests"));
    expect(tests).toContain('status: "error"');
  });

  it("claims a due model with a compare-and-set, like every other sweep", () => {
    expect(runner).toContain("processDueSqlModels");
    expect(runner).toContain('.is("next_run_at", null)');
    expect(runner).toContain('.eq("next_run_at", row.next_run_at)');
    // And it rides the one shared pass rather than a timer of its own.
    const cron = rd("src/utils/bi/refresh.server.ts");
    expect(cron).toContain("processDueSqlModels(force)");
    expect(cron).toContain("sql_model_builds");
  });

  it("refuses a cycle when a model is saved, not at the next build", () => {
    expect(fns).toContain("buildPlan([...others, candidate])");
  });

  it("refuses a target a materialized view already owns", () => {
    expect(fns).toContain("lakehouse_materialized_views");
    expect(fns).toContain("is already a materialized view");
  });

  it("keeps the table when the definition is deleted, and says what breaks", () => {
    const del = fns.slice(fns.indexOf("export const sqlModelDelete"));
    expect(del).not.toContain("DROP TABLE");
    expect(del).toContain("dependants");
  });

  it("audits a build and a pause", () => {
    expect(runner).toContain('action: "sql_model.build"');
    expect(fns).toContain('action: data.is_active ? "sql_model.resume" : "sql_model.pause"');
  });

  it("joins a build log's reason and its failing tests into one line", () => {
    // Two adjacent expressions rendered as "…failed: 1 row(s)row_count_min
    // failed (1)" with nothing between them, which is how this was caught,
    // from a real build in the running app.
    const page = rd("src/routes/_authenticated/sql-models.tsx");
    expect(page).toContain("function whyLine");
    expect(page).toContain('parts.join(" · ")');
    expect(page).toContain("{whyLine(m)}");
  });

  it("carries a built model to the layer that names its columns", () => {
    // The two layers composed on paper and never in anyone's hands: nothing
    // in the product pointed from one to the other.
    const page = rd("src/routes/_authenticated/sql-models.tsx");
    expect(page).toContain('to="/semantics"');
    expect(page).toContain("Define metrics on this");
    // Only once there is a table to describe.
    expect(page).toContain('selected.last_status === "built"');
    // The same door from where the tables actually live.
    expect(rd("src/routes/_authenticated/lakehouse.tsx")).toContain("Define metrics on this");

    const semantics = rd("src/routes/_authenticated/semantics.tsx");
    expect(semantics).toContain("validateSearch");
    expect(semantics).toContain("openOnLakehouseTable");
    // The lakehouse is reached as a warehouse connection, not a third kind.
    expect(semantics).toContain('source_kind: "warehouse"');
    expect(semantics).toContain('c.provider === "lakehouse"');
    // And the connection is offered rather than assumed: it is not
    // provisioned for anyone, so the first arrival would otherwise dead-end.
    expect(semantics).toContain("connectLakehouse");
    expect(semantics).toContain("Connect the lakehouse");
  });

  it("explains the division of labour in both guides, each pointing at the other", () => {
    const models = rd("docs/SQL_MODELS.md");
    const semantic = rd("docs/SEMANTIC_LAYER.md");
    expect(models).toContain("./SEMANTIC_LAYER.md");
    expect(semantic).toContain("./SQL_MODELS.md");
    expect(models).toContain("Define metrics on this");
    expect(semantic).toContain("Where a model's table comes from");
    // And the worked example runs the whole path rather than stopping at the
    // table, so the join is demonstrated and not only asserted.
    const e2e = rd("docs/END_TO_END_DATA_AND_AI.md");
    expect(e2e).toContain("Step 4a");
    expect(e2e).toContain("ref('stg_orders')");
    expect(e2e).toContain("Define metrics on this");
    // In-app too, where someone actually reads it.
    expect(rd("src/routes/docs.sql-models.tsx")).toContain('to="/docs/semantics"');
    expect(rd("src/routes/docs.semantics.tsx")).toContain('to="/docs/sql-models"');
  });

  it("is on the rail, in both the app and the docs, and documented in each", () => {
    expect(rd("src/lib/appNav.ts")).toContain('{ title: "SQL Models", url: "/sql-models"');
    expect(rd("scripts/check-docs.mjs")).toContain('"SQL Models"');
    expect(rd("src/components/docs/DocsShell.tsx")).toContain('to: "/docs/sql-models"');
    const page = rd("src/routes/docs.sql-models.tsx");
    expect(page).toContain("ref(");
    expect(page).toContain("skipped");
    const md = rd("docs/SQL_MODELS.md");
    expect(md).toContain("## Tests");
    expect(md).toContain("## Governance");
    expect(md).toContain("sql_model.build");
  });
});
