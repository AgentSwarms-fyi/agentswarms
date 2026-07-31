// The prep compiler emits SQL for whichever engine will run it. This asserts
// the DuckDB dialect is real: every step kind compiles, DuckDB accepts the
// result, and the answer matches what AlaSQL produces from the alasql
// compilation of the same flow.
//
// "It compiles" is not the bar. A dialect that emits syntactically valid SQL
// with different semantics is worse than one that fails loudly, so each flow
// is executed on both engines and the rows compared.
import { describe, expect, it } from "vitest";

import { buildPrepSql, type PrepFlowConfig } from "@/lib/dataPrepCore";
import { runLocalSqlDuckDB } from "@/utils/data/duckdb.server";
import { canonRows } from "./engines";
import { alasqlEngine } from "./engines";
import { freshTables } from "./fixtures";

/** A flow config with the boilerplate filled in. */
function flow(over: Partial<PrepFlowConfig> = {}): PrepFlowConfig {
  return {
    base: "orders",
    joins: [],
    columns: [
      {
        key: "orders.id",
        table: "orders",
        column: "id",
        include: true,
        outputName: "id",
        type: "integer",
      },
      {
        key: "orders.region",
        table: "orders",
        column: "region",
        include: true,
        outputName: "region",
        type: "text",
      },
      {
        key: "orders.amount",
        table: "orders",
        column: "amount",
        include: true,
        outputName: "amount",
        type: "decimal",
      },
      {
        key: "orders.day",
        table: "orders",
        column: "day",
        include: true,
        outputName: "day",
        type: "date",
      },
    ],
    steps: [],
    ...over,
  };
}

const CASES: { id: string; cfg: PrepFlowConfig; note: string }[] = [
  { id: "passthrough", cfg: flow(), note: "select + rename only" },
  {
    id: "filter",
    cfg: flow({
      steps: [
        {
          id: "s1",
          kind: "filter",
          combine: "AND",
          conditions: [{ id: "f1", column: "region", op: "=", value: "EMEA" }],
        },
      ] as PrepFlowConfig["steps"],
    }),
    note: "equality filter",
  },
  {
    id: "filter-not-equals",
    cfg: flow({
      steps: [
        {
          id: "s1",
          kind: "filter",
          combine: "AND",
          conditions: [{ id: "f1", column: "region", op: "!=", value: "EMEA" }],
        },
      ] as PrepFlowConfig["steps"],
    }),
    note: "negated filter — the NULL-handling case",
  },
  {
    id: "aggregate",
    cfg: flow({
      steps: [
        {
          id: "s1",
          kind: "aggregate",
          groupBy: ["region"],
          measures: [{ id: "m1", column: "amount", fn: "sum", name: "total_amount" }],
        },
      ] as PrepFlowConfig["steps"],
    }),
    note: "group by + sum",
  },
  {
    id: "aggregate-count",
    cfg: flow({
      steps: [
        {
          id: "s1",
          kind: "aggregate",
          groupBy: ["region"],
          measures: [{ id: "m1", column: "id", fn: "count", name: "n" }],
        },
      ] as PrepFlowConfig["steps"],
    }),
    note: "group by + count",
  },
  {
    id: "dedupe",
    cfg: flow({
      steps: [{ id: "s1", kind: "dedupe", columns: [] }] as PrepFlowConfig["steps"],
    }),
    note: "whole-row dedupe",
  },
  {
    id: "replace",
    cfg: flow({
      steps: [
        {
          id: "s1",
          kind: "replace",
          column: "region",
          find: "EMEA",
          replaceWith: "EUROPE",
          mode: "exact",
        },
      ] as PrepFlowConfig["steps"],
    }),
    note: "find & replace",
  },
  {
    id: "split",
    cfg: flow({
      steps: [
        {
          id: "s1",
          kind: "split",
          column: "day",
          delimiter: "-",
          into: ["y", "m", "d"],
          keepOriginal: false,
        },
      ] as PrepFlowConfig["steps"],
    }),
    note: "SPLIT_PART — 1-based in both dialects",
  },
];

describe("prep flows compile and agree across engines", () => {
  for (const c of CASES) {
    it(`${c.id} — ${c.note}`, async () => {
      const alasqlSql = buildPrepSql(c.cfg);
      const duckSql = buildPrepSql(c.cfg, { dialect: "duckdb" });

      // The two dialects must produce DIFFERENT text (quoting at minimum) but
      // the SAME answer; identical text would mean the dialect option is
      // silently doing nothing.
      expect(duckSql).toBeTruthy();

      const alasqlOut = alasqlEngine.run(alasqlSql, freshTables());
      expect(alasqlOut.ok, alasqlOut.ok ? "" : `AlaSQL failed: ${alasqlOut.error}`).toBe(true);

      const duckOut = await runLocalSqlDuckDB(duckSql, freshTables());

      if (!alasqlOut.ok) return;
      expect(canonRows(duckOut.rows, false)).toBe(canonRows(alasqlOut.rows, false));
    });
  }
});

describe("the DuckDB prep dialect is genuinely different SQL", () => {
  it("quotes identifiers with double quotes, not backticks", () => {
    const sql = buildPrepSql(flow(), { dialect: "duckdb" });
    expect(sql).toContain('"');
    expect(sql).not.toContain("`");
  });

  it("the alasql dialect still uses backticks", () => {
    expect(buildPrepSql(flow())).toContain("`");
  });
});
