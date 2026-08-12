// Answer provenance: what the SOURCES panel claims must be what grounded the
// answer.
//
// FOUND FROM THE UI. A governed metric_query answer showed FIVE knowledge-base
// documents as its sources and no data source at all. Root cause: metric_query
// returns structured TEXT, and extractToolSources parsed every result as JSON
// — so the governed call contributed nothing, and buildSources, seeing zero
// tool sources, fell back to listing every auto-RAG KB document. One root
// cause, two lies: the real source hidden, five unused ones shown.
//
// The metric_query fixture here is produced by the REAL renderMetricResult,
// so the parser and the format cannot drift apart silently.
import { describe, expect, it } from "vitest";

import {
  buildSources,
  extractToolSources,
  metricQuerySources,
  type Source,
} from "@/utils/tools/sources";
import { renderMetricResult } from "@/utils/tools/metric.server";

const args = JSON.stringify({ model: "saas_sales_model", metrics: ["total_sales"] });
const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ region: `r${i}`, v: i }));

const okResult = renderMetricResult(
  {
    model: "saas_sales_model",
    sql: 'SELECT "Region" AS "region", SUM("Sales") AS "total_sales" FROM saas_sales GROUP BY "Region" LIMIT 1000',
    rows: rowsOf(3),
  },
  50,
);

describe("metric_query results become DATA sources", () => {
  it("a governed answer cites the metric, the model and the compiled SQL", () => {
    const sources = extractToolSources("metric_query", args, okResult);
    expect(sources).toEqual([
      {
        kind: "table",
        title: "total_sales",
        detail: "Governed metric · saas_sales_model · 3 rows",
        snippet: expect.stringContaining('SELECT "Region"'),
        tool: "metric_query",
      },
    ]);
  });

  it("a truncated result is cited as PARTIAL, matching what the agent was told", () => {
    const truncated = renderMetricResult(
      { model: "saas_sales_model", sql: "SELECT 1", rows: rowsOf(51) },
      50,
    );
    const [s] = extractToolSources("metric_query", args, truncated);
    expect(s.detail).toBe("Governed metric · saas_sales_model · first 50 rows of a larger result");
  });

  it("notes (synonym resolution, restricted share) do not break the parse", () => {
    const noted = renderMetricResult(
      {
        model: "saas_sales_model",
        sql: "SELECT 1",
        rows: rowsOf(1),
        resolution_notes: ['"turnover" resolved to "total_sales" via synonym'],
        access_note: "rows limited to region ∈ [APAC]",
      },
      50,
    );
    const [s] = extractToolSources("metric_query", args, noted);
    expect(s).toMatchObject({ kind: "table", title: "total_sales" });
  });

  it("a refusal or failure grounds nothing", () => {
    expect(
      extractToolSources("metric_query", args, 'Error: "x" is not enabled for this agent.'),
    ).toEqual([]);
    expect(extractToolSources("metric_query", args, "metric_query failed: boom")).toEqual([]);
    expect(metricQuerySources(args, "garbage with no fields", "metric_query")).toEqual([]);
    // A failure whose upstream error ECHOES request context must still ground
    // nothing — this is what the explicit failure prefix guard is for; the
    // structural model:/sql: check alone would happily parse this.
    expect(
      extractToolSources(
        "metric_query",
        args,
        "metric_query failed: upstream 500 while running\nmodel: saas_sales_model\nsql: SELECT 1\n1 row(s):\n[{}]",
      ),
    ).toEqual([]);
  });

  it("sql_query's JSON path is untouched", () => {
    const sources = extractToolSources(
      "sql_query",
      JSON.stringify({ sql: "SELECT * FROM saas_sales" }),
      JSON.stringify({ sql: "SELECT * FROM saas_sales", row_count: 12 }),
    );
    expect(sources).toEqual([
      expect.objectContaining({ kind: "table", title: "saas_sales", detail: "12 rows" }),
    ]);
  });
});

describe("buildSources — the exact bug from the screenshot", () => {
  const kbDocs: Source[] = [1, 2, 3, 4, 5].map((i) => ({
    index: i,
    kind: "kb",
    title: `0${i}_How_to.md`,
    detail: "AgentSwarms — How-To Guide",
  }));

  it("UNCITED auto-RAG docs are dropped once the governed source exists", () => {
    const toolSources = extractToolSources("metric_query", args, okResult);
    const final = buildSources(kbDocs, toolSources, "Here's turnover by region: …");
    expect(final.map((s) => s.kind)).toEqual(["table"]);
    expect(final[0].title).toBe("total_sales");
  });

  it("docs the answer actually cites by [n] are kept alongside the metric", () => {
    const toolSources = extractToolSources("metric_query", args, okResult);
    const final = buildSources(kbDocs, toolSources, "Per the guide [2], turnover is …");
    expect(final.map((s) => `${s.kind}:${s.index}`)).toEqual(["kb:2", "table:3"]);
  });

  it("with no tool sources at all, auto-RAG docs still show (nothing else grounded it)", () => {
    const final = buildSources(kbDocs, [], "From what I know…");
    expect(final).toHaveLength(5);
  });
});
