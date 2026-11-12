// R468: rolling the app back one release is safe only while migrations expand
// the schema. deploy/ci/migrations/schema-compat.mjs decides what breaks the
// previous release; deploy/ci/supabase-image/run.sh --upgrade-from runs it on
// a real upgrade (CI: .github/workflows/migrations.yml). These pin its rules,
// and the one rule every new migration meets before CI ever runs: a DROP
// TABLE, DROP COLUMN or RENAME says what it contracts.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  compareSchemas,
  contractingStatements,
  contractsIn,
  judge,
  typeWidens,
} from "../../deploy/ci/migrations/schema-compat.mjs";

type Rel = { name: string; kind: string };
type Col = { relation: string; name: string; type: string; notNull: boolean; hasDefault: boolean };
type Fn = { name: string; args: string; returns: string };
type En = { type: string; label: string };
type Snap = { relations: Rel[]; columns: Col[]; functions: Fn[]; enums: En[] };

const col = (
  relation: string,
  name: string,
  type = "text",
  notNull = false,
  hasDefault = false,
): Col => ({
  relation,
  name,
  type,
  notNull,
  hasDefault,
});

function base(): Snap {
  return {
    relations: [
      { name: "runs", kind: "r" },
      { name: "run_summary", kind: "v" },
    ],
    columns: [
      col("runs", "id", "uuid", true, true),
      col("runs", "cost_usd", "real"),
      col("runs", "label", "character varying(50)"),
      col("runs", "note", "text"),
      col("run_summary", "id", "uuid"),
      col("run_summary", "total", "numeric"),
    ],
    functions: [{ name: "run_stats", args: "p_user uuid", returns: "TABLE(n bigint)" }],
    enums: [
      { type: "run_status", label: "running" },
      { type: "run_status", label: "done" },
    ],
  };
}

const subjects = (before: Snap, after: Snap) =>
  compareSchemas(before, after).map((f: { subject: string }) => f.subject);

describe("what the previous release can run on", () => {
  it("an unchanged schema, or one that only adds, breaks nothing", () => {
    expect(compareSchemas(base(), base())).toEqual([]);
    const after = base();
    after.relations.push({ name: "new_table", kind: "r" });
    after.columns.push(col("new_table", "id", "uuid", true, false)); // a new table may require anything
    after.columns.push(col("runs", "extra", "jsonb")); // nullable: old inserts leave it null
    after.columns.push(col("runs", "flag", "boolean", true, true)); // NOT NULL with a default
    after.functions.push({
      name: "run_stats",
      args: "p_user uuid, p_days integer",
      returns: "TABLE(n bigint)",
    });
    after.enums.push({ type: "run_status", label: "cancelled" });
    expect(compareSchemas(base(), after)).toEqual([]);
  });

  it("a removed table, view or column breaks it", () => {
    const after = base();
    after.relations = after.relations.filter((r) => r.name !== "run_summary");
    after.columns = after.columns.filter((c) => c.relation !== "run_summary" && c.name !== "note");
    expect(subjects(base(), after)).toEqual(["public.run_summary", "public.runs.note"]);
  });

  it("a table that became a view breaks writes", () => {
    const after = base();
    after.relations[0] = { name: "runs", kind: "v" };
    expect(compareSchemas(base(), after)[0].problem).toMatch(/was a table, now a view/);
  });

  it("a type may widen but not narrow or change", () => {
    const widened = base();
    widened.columns[1] = col("runs", "cost_usd", "numeric"); // 20261006140000 did exactly this
    widened.columns[2] = col("runs", "label", "text");
    expect(compareSchemas(base(), widened)).toEqual([]);

    const narrowed = base();
    narrowed.columns[2] = col("runs", "label", "character varying(20)");
    narrowed.columns[3] = col("runs", "note", "jsonb");
    expect(subjects(base(), narrowed)).toEqual(["public.runs.label", "public.runs.note"]);
  });

  it("NOT NULL without a default, old or new, breaks the older release's inserts", () => {
    const after = base();
    after.columns[3] = col("runs", "note", "text", true, false);
    after.columns.push(col("runs", "owner", "uuid", true, false));
    const found = compareSchemas(base(), after);
    expect(found.map((f: { subject: string }) => f.subject)).toEqual([
      "public.runs.note",
      "public.runs.owner",
    ]);
    expect(found[0].problem).toMatch(/became NOT NULL/);
    expect(found[1].problem).toMatch(/new column is NOT NULL/);

    const withDefault = base();
    withDefault.columns[3] = col("runs", "note", "text", true, true);
    expect(compareSchemas(base(), withDefault)).toEqual([]);
  });

  it("a function whose arguments or result changed, or that is gone, breaks its callers", () => {
    const args = base();
    args.functions = [
      { name: "run_stats", args: "p_user uuid, p_days integer", returns: "TABLE(n bigint)" },
    ];
    expect(subjects(base(), args)).toEqual(["public.run_stats(p_user uuid)"]);
    const result = base();
    result.functions = [{ name: "run_stats", args: "p_user uuid", returns: "SETOF runs" }];
    expect(compareSchemas(base(), result)[0].problem).toMatch(
      /returned TABLE\(n bigint\), now SETOF runs/,
    );
  });

  it("a removed enum value breaks rows and code that use it", () => {
    const after = base();
    after.enums = after.enums.filter((e) => e.label !== "done");
    expect(compareSchemas(base(), after)).toEqual([
      { subject: "public.run_status", problem: "enum value 'done' removed" },
    ]);
  });
});

describe("type widening", () => {
  it.each([
    ["integer", "bigint", true],
    ["bigint", "integer", false],
    ["real", "numeric", true],
    ["real", "double precision", true],
    ["numeric", "real", false],
    ["numeric(10,2)", "numeric(12,2)", true],
    ["numeric(10,2)", "numeric(10,4)", false], // two fewer digits before the point
    ["numeric(10,2)", "numeric", true],
    ["character varying(50)", "character varying(80)", true],
    ["character varying(50)", "text", true],
    ["character varying(50)", "character varying(10)", false],
    ["text", "character varying(50)", false],
    ["integer[]", "bigint[]", true],
    ["integer[]", "bigint", false],
    ["json", "jsonb", false],
    ["timestamp with time zone", "timestamp without time zone", false],
  ])("%s -> %s: %s", (from, to, ok) => {
    expect(typeWidens(from, to)).toBe(ok);
  });
});

describe("deliberate contractions", () => {
  it("a contract line in a new migration allows exactly what it names", () => {
    const sql =
      "-- contract: public.runs.note (no release that can be rolled back to reads it)\nALTER TABLE runs DROP COLUMN note;";
    const tokens = contractsIn(sql);
    expect(tokens).toEqual(["public.runs.note"]);
    const after = base();
    after.columns = after.columns.filter((c) => c.name !== "note" && c.name !== "label");
    const { breaks, allowed } = judge(
      compareSchemas(base(), after),
      tokens.map((token: string) => ({ token, file: "x.sql" })),
    );
    expect(allowed.map((a: { subject: string }) => a.subject)).toEqual(["public.runs.note"]);
    expect(breaks.map((b: { subject: string }) => b.subject)).toEqual(["public.runs.label"]);
  });

  it("a table's contract covers its columns, a function's every signature, and not a lookalike", () => {
    const covers = (token: string, subject: string) =>
      judge([{ subject, problem: "" }], [{ token, file: "x" }]).allowed.length === 1;
    expect(covers("public.runs", "public.runs.note")).toBe(true);
    expect(covers("public.run_stats", "public.run_stats(p_user uuid)")).toBe(true);
    expect(covers("public.run", "public.runs")).toBe(false);
    expect(covers("public.run", "public.run_stats(p_user uuid)")).toBe(false);
  });
});

describe("statements that always contract", () => {
  it("finds DROP TABLE, DROP COLUMN and RENAME, not in comments, not policies or functions", () => {
    const sql = [
      "-- DROP TABLE old_runs; was considered",
      "/* ALTER TABLE x DROP COLUMN y; */",
      "DROP POLICY IF EXISTS p ON runs;",
      "DROP FUNCTION IF EXISTS run_stats(uuid);",
      "DROP VIEW IF EXISTS run_summary;",
      "DROP TABLE IF EXISTS public.legacy;",
      "ALTER TABLE runs DROP COLUMN note;",
      "ALTER TABLE runs RENAME COLUMN label TO title;",
      "ALTER TABLE runs RENAME TO swarm_runs;",
    ].join("\n");
    expect(contractingStatements(sql)).toEqual([
      { statement: "DROP TABLE", line: 6 },
      { statement: "DROP COLUMN", line: 7 },
      { statement: "RENAME ... TO", line: 8 },
      { statement: "RENAME TO", line: 9 },
    ]);
  });

  // Everything up to R467 is released and grandfathered. From R468 on, a
  // migration that drops or renames says what it contracts, so the upgrade
  // check can tell a deliberate contraction from an accident.
  const FIRST_UNDER_RULE = "20261113000001";
  const DIR = "supabase/migrations";
  const ruled = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql") && f.split("_")[0] >= FIRST_UNDER_RULE)
    .sort();

  it("every new migration that drops or renames names what it contracts", () => {
    const missing: string[] = [];
    for (const f of ruled) {
      const sql = readFileSync(`${DIR}/${f}`, "utf8");
      const found = contractingStatements(sql);
      if (found.length > 0 && contractsIn(sql).length === 0) {
        missing.push(
          `${f}: ${found.map((s: { statement: string; line: number }) => `${s.statement} (line ${s.line})`).join(", ")}`,
        );
      }
    }
    expect(missing, "add a `-- contract: public.<object>` line naming what it removes").toEqual([]);
  });
});

describe("the CI legs", () => {
  const rd = (p: string) => readFileSync(p, "utf8");
  const pins = (s: string) =>
    ["GOTRUE", "STORAGE", "REST"].map((k) => new RegExp(`^${k}=(\\S+)$`, "m").exec(s)?.[1]);

  it("the Supabase-image and RDS-like checks run the same GoTrue, storage-api and PostgREST", () => {
    const a = pins(rd("deploy/ci/supabase-image/run.sh"));
    expect(a.every(Boolean)).toBe(true);
    expect(a).toEqual(pins(rd("deploy/ci/rds-like/run.sh")));
  });

  it("the upgrade check compares snapshots and passes the new migrations' contract lines", () => {
    const run = rd("deploy/ci/supabase-image/run.sh");
    expect(run).toContain('sql <"deploy/ci/migrations/schema-snapshot.sql"');
    expect(run).toContain(
      'node deploy/ci/migrations/schema-compat.mjs "${NEW_FILES[@]+"${NEW_FILES[@]}"}"',
    );
    expect(run).toMatch(
      /fail "expected exactly the \$\{#NEW_FILES\[@\]\} new migrations to apply"/,
    );
  });

  it("the workflow runs every leg, the upgrade from the latest release tag", () => {
    const wf = rd(".github/workflows/migrations.yml");
    expect(wf).toContain("bash deploy/ci/rds-like/run.sh");
    expect(wf).toMatch(/RDS_BYPASSRLS: \$\{\{ matrix\.bypassrls \}\}/);
    expect(wf).toContain("bash deploy/ci/supabase-image/run.sh\n");
    expect(wf).toContain('bash deploy/ci/supabase-image/run.sh --upgrade-from "$FROM"');
    expect(wf).toContain("fetch-depth: 0");
  });

  const bash = spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
  it.skipIf(!bash)("bash -n accepts the scripts R468 added", () => {
    const r = spawnSync("bash", ["-n", "deploy/ci/supabase-image/run.sh"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
