// A governed query that stopped at its cap must say so, everywhere it lands.
//
// FOUND FROM THE UI. total_sales by order_id on saas_sales — 9,994 groups —
// and the Semantics page said "100 row(s)". The runner fetched AT its cap and
// could not tell a result of exactly cap rows from one of more, so every
// consumer presented the prefix as the whole: the preview's count, a dashboard
// widget re-run to 100 rows with no Partial badge, an analyst step written as
// `capped: false`. The runner now fetches one past the cap and reports it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_LIMIT, MAX_LIMIT, semanticFetchPlan, semanticTrim } from "@/lib/semanticLayer";

const rd = (p: string) => readFileSync(p, "utf8");
const runner = rd("src/utils/semantic/query.server.ts");
const fns = rd("src/utils/semantic.functions.ts");
const page = rd("src/routes/_authenticated/semantics.tsx");
const dash = rd("src/routes/_authenticated/bi_.$dashboardId.tsx");
const analystLib = rd("src/lib/aiAnalyst.ts");
const analystUi = rd("src/routes/_authenticated/ai-analyst.tsx");
const analystSrv = rd("src/utils/analyst/run.server.ts");
const refresh = rd("src/utils/bi/refresh.server.ts");

describe("semanticFetchPlan", () => {
  it("fetches one row past the cap, so exactly-cap and more-than-cap differ", () => {
    expect(semanticFetchPlan(100, undefined)).toEqual({ cap: 100, fetch: 101 });
    expect(semanticFetchPlan(undefined, 1000)).toEqual({ cap: 1000, fetch: 1001 });
  });

  it("caps at the smaller of the query's limit and the caller's budget", () => {
    expect(semanticFetchPlan(100, 1000).cap).toBe(100);
    expect(semanticFetchPlan(5000, 1000).cap).toBe(1000);
  });

  it("falls back to the default limit when neither is given", () => {
    expect(semanticFetchPlan(undefined, undefined)).toEqual({
      cap: DEFAULT_LIMIT,
      fetch: DEFAULT_LIMIT + 1,
    });
  });

  it("keeps the fetch inside MAX_LIMIT, which the compiler clamps to", () => {
    // A fetch the compiler clamped back to the cap would make the extra row
    // impossible to see, and the cap silently undetectable.
    const p = semanticFetchPlan(MAX_LIMIT, MAX_LIMIT);
    expect(p.fetch).toBeLessThanOrEqual(MAX_LIMIT);
    expect(p.fetch).toBe(p.cap + 1);
  });

  it("ignores a nonsense limit rather than fetching nothing", () => {
    expect(semanticFetchPlan(0, undefined).cap).toBe(DEFAULT_LIMIT);
    expect(semanticFetchPlan(Number.NaN, -5).cap).toBe(DEFAULT_LIMIT);
    expect(semanticFetchPlan(2.9, undefined)).toEqual({ cap: 2, fetch: 3 });
  });
});

describe("semanticTrim", () => {
  it("returns the rows untouched when they fit", () => {
    const rows = [1, 2, 3];
    expect(semanticTrim(rows, 3)).toEqual({ rows, truncated: false });
    expect(semanticTrim([], 3)).toEqual({ rows: [], truncated: false });
  });

  it("cuts at the cap and says so when the extra row came back", () => {
    expect(semanticTrim([1, 2, 3, 4], 3)).toEqual({ rows: [1, 2, 3], truncated: true });
  });
});

describe("the runner is the one chokepoint", () => {
  it("plans the fetch from the query's limit and the caller's budget, once, before either engine", () => {
    const i = runner.indexOf("const plan = semanticFetchPlan(query.limit, opts.maxRows);");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(runner.indexOf('if (model.source.kind === "warehouse")'));
    expect(runner).toContain("query = { ...query, limit: plan.fetch };");
  });

  it("executes with the fetch and returns rows cut at the cap, on both engines", () => {
    expect(runner).toContain("executeWarehouseQuery(conn.config, compiled.sql, plan.fetch, {");
    expect(runner).not.toContain("opts.maxRows ?? 1000");
    expect((runner.match(/const cut = semanticTrim\(res\.rows, plan\.cap\);/g) ?? []).length).toBe(
      2,
    );
    expect(
      (runner.match(/rows: cut\.rows,\s*truncated: cut\.truncated,\s*cap: plan\.cap,/g) ?? [])
        .length,
    ).toBe(2);
    expect(runner).toMatch(/truncated: boolean;\s*\/\*\*[^*]*\*\/\s*cap: number;/);
  });

  it("passes the verdict through the preview server function", () => {
    expect(fns).toMatch(/truncated: res\.truncated,\s*cap: res\.cap,/);
  });
});

describe("every consumer says when the list is partial", () => {
  it("the Semantics page preview names the cut instead of counting the prefix", () => {
    expect(page).toContain("first ${result.rows.length} rows of a larger result");
    expect(page).not.toMatch(/>\s*\{result\.rows\.length\} row\(s\)\s*</);
  });

  it("the dashboard's parameter re-run keeps the widget's cap and stores the verdict", () => {
    const block = dash.slice(
      dash.indexOf("const res = (await runSemanticFn({"),
      dash.indexOf("setParamsWidget(null);"),
    );
    expect(block).toContain("limit: widgetRowCap(),");
    expect(block).not.toContain("limit: 100,");
    expect(block).toContain("truncated: res.truncated ?? false,");
  });

  it("the analyst's governed step no longer claims completeness it cannot know", () => {
    const step = analystLib.slice(analystLib.indexOf("const governedResult: QueryResult = {"));
    expect(step).toContain("capped: res.truncated === true,");
    expect(step.slice(0, 1200)).not.toContain("capped: false,");
    expect(step).toContain(
      "Partial: the governed model returned the first ${res.rows.length} groups of a larger",
    );
    expect(analystLib).toMatch(
      /access_note\?: string;\s*\/\*\*[^*]*\*\/\s*truncated\?: boolean;\s*\}>;/,
    );
    // Both runners hand the verdict over — the browser's and the server's.
    expect(analystUi).toContain("truncated: res.truncated,");
    expect(analystSrv).toContain("truncated: res.truncated,");
  });

  it("the scheduled refresh trusts the runner's verdict over a row-count guess", () => {
    expect(refresh).toContain(
      "result = { columns: r.columns, rows: r.rows, truncated: r.truncated };",
    );
    expect(refresh).toContain(
      "w.truncated = result.truncated ?? result.rows.length >= WIDGET_ROW_CAP;",
    );
    expect(refresh).toMatch(
      /merged\.length > WIDGET_ROW_CAP \|\|\s*\(result\.truncated \?\? result\.rows\.length >= WIDGET_ROW_CAP\)/,
    );
  });
});
