// JOURNEY: define a governed metric -> run it -> chart it -> reopen the
// dashboard and see the numbers.
//
// Why this file exists
// --------------------
// Every unit in this flow had tests and the flow was still broken four separate
// times, each found by a person clicking through the product rather than by the
// suite:
//
//   1. a saved semantic model stored backtick-quoted SQL and would not compile
//      for DuckDB at all
//   2. the same bug again in a filtered measure's CASE WHEN condition
//   3. "Add to dashboard" wrote the page-1 MIRROR and not `pages`, so the
//      widget vanished and was later erased
//   4. widgets are stored WITHOUT their rows (they live in bi_widget_results),
//      so a widget can survive the round trip and still render empty
//
// Units passed because each one is correct in isolation. The defects lived in
// the SEAMS. So this test chains the REAL production functions, in the order
// the product calls them, and asserts on what a user would actually see.
//
// Nothing here may re-implement production logic. If a step needs a helper that
// only exists inside a component or a server handler, extract it — a copy would
// pass while the product breaks, which is exactly how these bugs survived.

import { afterEach, describe, expect, it } from "vitest";

import {
  appendWidgetToPages,
  makeEmptyPage,
  mergePagesResults,
  parseLayout,
  parsePages,
  parseWidgets,
  snapshotRows,
  stripPagesData,
  widgetFromSemantic,
  type BiPage,
  type BiWidget,
  type Json,
  type WidgetResultRow,
} from "@/lib/biDashboards";
import { compileSemanticQuery, type SemanticModel } from "@/lib/semanticLayer";
import { runLocalSelect, type LocalEngineTable } from "@/utils/data/localEngine.server";

/** A model exactly as the /semantics screen saves it for a local dataset:
 *  identifiers quoted the way "Generate with AI" is told to quote them. */
const model: SemanticModel = {
  name: "saas",
  source: { kind: "data_table", table: "saas_sales" },
  dimensions: [
    { name: "country", sql: "`Country`", type: "categorical" },
    { name: "order_date", sql: "`Order Date`", type: "time" },
  ],
  metrics: [
    { name: "total_discount", agg: "sum", sql: "`Discount`" },
    {
      name: "big_discount",
      agg: "sum",
      sql: "`Discount`",
      filters: ["`Discount` > 5"],
    },
  ],
};

const table: LocalEngineTable = {
  name: "saas_sales",
  columns: [
    { name: "Country", type: "string" },
    { name: "Order Date", type: "string" },
    { name: "Discount", type: "number" },
  ],
  rows: [
    { Country: "US", "Order Date": "2026-03-04", Discount: 10 },
    { Country: "US", "Order Date": "2026-03-19", Discount: 4 },
    { Country: "UK", "Order Date": "2026-04-02", Discount: 7 },
  ],
};

/**
 * Run SQL through the REAL production entry point with a given engine selected.
 *
 * runLocalSelect dispatches on LOCAL_ENGINE, so driving it through the env is
 * what a deployment actually does — and it puts the dispatch itself under test
 * rather than calling an engine directly and assuming routing works.
 */
async function runOn(engine: "alasql" | "duckdb", sql: string) {
  const previous = process.env.LOCAL_ENGINE;
  // Both engines are named EXPLICITLY. Neither is "whatever the default is" —
  // when the default flipped to DuckDB, an unset variable stopped meaning
  // AlaSQL, and a harness that leaned on that would silently have run the same
  // engine twice. The res.engine assertion below is what catches it.
  process.env.LOCAL_ENGINE = engine;
  try {
    const res = await runLocalSelect(sql, [table]);
    // The engine that answered must be the one asked for; otherwise every
    // assertion below is measuring the wrong thing.
    expect(res.engine).toBe(engine);
    return res;
  } finally {
    if (previous === undefined) delete process.env.LOCAL_ENGINE;
    else process.env.LOCAL_ENGINE = previous;
  }
}

/** The two engines a deployment can be running. A journey that works on one and
 *  not the other is the class of bug that started all this. */
const ENGINES = [
  { dialect: "alasql" as const, run: (sql: string) => runOn("alasql", sql) },
  { dialect: "duckdb" as const, run: (sql: string) => runOn("duckdb", sql) },
];

/**
 * WHICH ENGINE A DEPLOYMENT GETS WHEN IT CONFIGURES NOTHING.
 *
 * This is a seam test, not a flag test. `duckdbEnabled()` has its own unit
 * tests, but when the default flipped from AlaSQL to DuckDB those were the ONLY
 * thing in the whole suite that failed — every other test either names its
 * engine or does not care, so nothing asserted what a real query does on a
 * fresh install. That is the shape of a claim the product makes and the suite
 * does not check.
 *
 * It runs a real query through the real entry point with the variable unset,
 * which is what a fresh `.env` looks like.
 */
describe("the engine a fresh deployment gets", () => {
  const previous = process.env.LOCAL_ENGINE;
  afterEach(() => {
    if (previous === undefined) delete process.env.LOCAL_ENGINE;
    else process.env.LOCAL_ENGINE = previous;
  });

  it("is DuckDB when LOCAL_ENGINE is unset", async () => {
    delete process.env.LOCAL_ENGINE;
    const res = await runLocalSelect(`SELECT COUNT(*) AS n FROM ${table.name}`, [table]);
    expect(res.engine).toBe("duckdb");
    // Not a mock: it answered the question too.
    expect(Number(res.rows[0].n)).toBe(table.rows.length);
  });

  it("is DuckDB when LOCAL_ENGINE holds a value nobody recognises", async () => {
    // A typo must not silently downgrade a deployment to the weaker engine.
    process.env.LOCAL_ENGINE = "duckdbb";
    const res = await runLocalSelect(`SELECT COUNT(*) AS n FROM ${table.name}`, [table]);
    expect(res.engine).toBe("duckdb");
  });

  it("is AlaSQL only when explicitly asked for", async () => {
    process.env.LOCAL_ENGINE = "alasql";
    const res = await runLocalSelect(`SELECT COUNT(*) AS n FROM ${table.name}`, [table]);
    expect(res.engine).toBe("alasql");
  });
});

/**
 * Persist a dashboard the way the app does, then load it the way the app does.
 *
 * This is the step that matters: `updateDashboard` STRIPS row snapshots out of
 * the document (they live in bi_widget_results), so anything that survives here
 * with its data intact does so because the results were stored and merged back
 * — not because the rows happened to still be in memory.
 */
function roundTrip(pages: BiPage[], results: WidgetResultRow[]): BiPage[] {
  const storedPages = stripPagesData(pages as unknown as Json) as Json;
  const reread = parsePages(storedPages, [], []);
  return mergePagesResults(reread as unknown as Json, results) as unknown as BiPage[];
}

/** What syncWidgetResults writes to bi_widget_results for a widget. */
function resultRowFor(w: BiWidget): WidgetResultRow {
  return {
    widget_id: w.id,
    columns: (w.columns ?? []) as unknown as Json,
    rows: (w.rows ?? []) as unknown as Json,
    truncated: false,
    refreshed_at: w.refreshed_at ?? new Date().toISOString(),
  };
}

describe.each(ENGINES)("journey on $dialect", ({ dialect, run }) => {
  it("metric + dimension survives all the way to a reopened dashboard", async () => {
    // 1. Compile the governed query the runner would send.
    const compiled = compileSemanticQuery(
      model,
      {
        model: "saas",
        metrics: ["total_discount"],
        dimensions: ["country"],
        orderBy: [{ field: "country", dir: "asc" }],
        limit: 100,
      },
      { dialect },
    );

    // 2. Execute it on the engine this deployment actually runs.
    const result = await run(compiled.sql);
    expect(result.rows).toEqual([
      { country: "UK", total_discount: 7 },
      { country: "US", total_discount: 14 },
    ]);

    // 3. Chart it, exactly as AddMetricToDashboardDialog does.
    const widget = widgetFromSemantic({
      title: "Discount by country",
      model: "saas",
      metrics: ["total_discount"],
      dimensions: ["country"],
      chartType: "bar",
      columns: compiled.columns,
      rows: snapshotRows(result.rows),
      sql: compiled.sql,
    });

    // 4. Add it to a dashboard that already has content (the case that broke —
    //    an empty dashboard hides the bug behind parsePages' fallback).
    const existing = widgetFromSemantic({
      title: "Already here",
      model: "saas",
      metrics: ["total_discount"],
      dimensions: ["country"],
      chartType: "table",
      columns: compiled.columns,
      rows: [],
      sql: compiled.sql,
    });
    const saved = appendWidgetToPages([makeEmptyPage("Page 1")], existing);
    const added = appendWidgetToPages(saved.pages, widget);

    // 5. Save and reopen.
    const loaded = roundTrip(added.pages, [resultRowFor(widget), resultRowFor(existing)]);

    // 6. What the user sees.
    const titles = loaded[0].widgets.map((w) => w.title);
    expect(titles).toContain("Discount by country");
    expect(titles).toContain("Already here");

    const reloaded = loaded[0].widgets.find((w) => w.id === widget.id);
    expect(reloaded, "the widget must exist after a reload").toBeDefined();
    // The whole point: it renders NUMBERS, not an empty chart.
    expect(reloaded!.rows).toEqual([
      { country: "UK", total_discount: 7 },
      { country: "US", total_discount: 14 },
    ]);
    // And it must still be placed on the grid.
    expect(added.layout.some((l) => l.i === widget.id)).toBe(true);
  });

  it("a filtered measure survives the same journey", async () => {
    const compiled = compileSemanticQuery(
      model,
      {
        model: "saas",
        metrics: ["big_discount"],
        dimensions: ["country"],
        orderBy: [{ field: "country", dir: "asc" }],
      },
      { dialect },
    );
    const result = await run(compiled.sql);
    // Only discounts above 5 are counted: UK 7, US 10 (the 4 is excluded).
    expect(result.rows).toEqual([
      { country: "UK", big_discount: 7 },
      { country: "US", big_discount: 10 },
    ]);

    const widget = widgetFromSemantic({
      title: "Big discounts",
      model: "saas",
      metrics: ["big_discount"],
      dimensions: ["country"],
      chartType: "bar",
      columns: compiled.columns,
      rows: snapshotRows(result.rows),
      sql: compiled.sql,
    });
    const added = appendWidgetToPages([makeEmptyPage("Page 1")], widget);
    const loaded = roundTrip(added.pages, [resultRowFor(widget)]);

    expect(loaded[0].widgets[0].rows).toEqual(result.rows);
  });

  it("a time grain survives the same journey", async () => {
    // truncateExpr wraps the stored fragment, so this is where a dialect-specific
    // fragment does the most damage.
    const compiled = compileSemanticQuery(
      model,
      {
        model: "saas",
        metrics: ["total_discount"],
        dimensions: ["order_date"],
        grains: { order_date: "month" },
        orderBy: [{ field: "order_date", dir: "asc" }],
      },
      { dialect },
    );
    const result = await run(compiled.sql);
    expect(result.rows).toHaveLength(2);

    const widget = widgetFromSemantic({
      title: "Discount by month",
      model: "saas",
      metrics: ["total_discount"],
      dimensions: ["order_date"],
      grains: { order_date: "month" },
      chartType: "line",
      columns: compiled.columns,
      rows: snapshotRows(result.rows),
      sql: compiled.sql,
    });
    const added = appendWidgetToPages([makeEmptyPage("Page 1")], widget);
    const loaded = roundTrip(added.pages, [resultRowFor(widget)]);

    expect(loaded[0].widgets[0].rows).toEqual(result.rows);
  });
});

/**
 * A period-over-period widget, all the way to a reopened dashboard.
 *
 * DuckDB only — AlaSQL has no CTEs or date arithmetic and the compiler refuses
 * rather than emitting something it cannot run.
 *
 * The seam under test is the WIDGET SOURCE. A dashboard widget stores its
 * governed query and refresh RECOMPILES from that, so a `compare` that fails to
 * survive the round trip gives the worst possible outcome: the chart keeps its
 * comparison columns from the snapshot and silently loses them at the next
 * scheduled refresh. Nothing errors; the numbers just stop being there.
 */
describe("a period-over-period widget", () => {
  it("keeps its comparison through save and reopen", async () => {
    const q = {
      model: "saas",
      metrics: ["total_discount"],
      dimensions: ["order_date"],
      grains: { order_date: "month" as const },
      orderBy: [{ field: "order_date", dir: "asc" as const }],
      compare: "prior_period" as const,
    };
    const compiled = compileSemanticQuery(model, q, { dialect: "duckdb" });
    const result = await runOn("duckdb", compiled.sql);

    expect(compiled.columns).toEqual([
      "order_date",
      "total_discount",
      "total_discount_prev",
      "total_discount_change",
      "total_discount_pct_change",
    ]);
    // March is 10 + 4 = 14 with nothing before it; April is 7, down 7 on March.
    const april = result.rows.find((r) => String(r.order_date).startsWith("2026-04"))!;
    expect(Number(april.total_discount)).toBe(7);
    expect(Number(april.total_discount_prev)).toBe(14);
    expect(Number(april.total_discount_change)).toBe(-7);
    expect(Number(april.total_discount_pct_change)).toBeCloseTo(-0.5, 10);

    const march = result.rows.find((r) => String(r.order_date).startsWith("2026-03"))!;
    expect(march.total_discount_prev).toBeNull();

    const widget = widgetFromSemantic({
      title: "Discount month on month",
      model: "saas",
      metrics: ["total_discount"],
      dimensions: ["order_date"],
      grains: { order_date: "month" },
      compare: "prior_period",
      chartType: "line",
      columns: compiled.columns,
      rows: snapshotRows(result.rows),
      sql: compiled.sql,
    });
    const added = appendWidgetToPages([makeEmptyPage("Page 1")], widget);
    const loaded = roundTrip(added.pages, [resultRowFor(widget)]);

    const reloaded = loaded[0].widgets.find((w) => w.id === widget.id);
    expect(reloaded, "the widget must exist after a reload").toBeDefined();
    expect(reloaded!.rows).toEqual(result.rows);

    // THE ACTUAL SEAM: the stored source must still say `prior_period`, because
    // that is the only thing refresh has to go on.
    const source = reloaded!.source as { kind: string; compare?: string; grains?: unknown };
    expect(source.kind).toBe("semantic");
    expect(source.compare).toBe("prior_period");
    expect(source.grains).toEqual({ order_date: "month" });

    // And recompiling from the stored source reproduces the same query — which
    // is exactly what the scheduled refresh does.
    const recompiled = compileSemanticQuery(
      model,
      {
        model: "saas",
        metrics: ["total_discount"],
        dimensions: ["order_date"],
        grains: source.grains as { order_date: "month" },
        compare: source.compare as "prior_period",
      },
      { dialect: "duckdb" },
    );
    expect(recompiled.columns).toEqual(compiled.columns);
  });

  it("is refused on AlaSQL rather than answered wrongly", () => {
    expect(() =>
      compileSemanticQuery(
        model,
        {
          model: "saas",
          metrics: ["total_discount"],
          dimensions: ["order_date"],
          grains: { order_date: "month" },
          compare: "yoy",
        },
        { dialect: "alasql" },
      ),
    ).toThrow(/AlaSQL/i);
  });
});

describe("journey regressions the suite must never lose", () => {
  it("a widget stored WITHOUT its results reloads empty — why sync must run first", () => {
    // appendWidgetToDashboard calls syncWidgetResults BEFORE updateDashboard.
    // If that order is ever reversed or dropped, this is what the user gets.
    const widget = widgetFromSemantic({
      title: "No results stored",
      model: "saas",
      metrics: ["total_discount"],
      dimensions: ["country"],
      chartType: "bar",
      columns: ["country", "total_discount"],
      rows: [{ country: "US", total_discount: 14 }],
      sql: "SELECT 1",
    });
    const added = appendWidgetToPages([makeEmptyPage("Page 1")], widget);

    const loaded = roundTrip(added.pages, []); // nothing written to bi_widget_results

    expect(loaded[0].widgets[0].rows).toEqual([]);
  });

  it("both engines answer the journey identically", async () => {
    // A deployment that flips LOCAL_ENGINE must not see different numbers on a
    // dashboard it already had.
    const q = {
      model: "saas",
      metrics: ["total_discount"],
      dimensions: ["country"],
      orderBy: [{ field: "country", dir: "asc" as const }],
    };
    const viaAlasql = await runOn(
      "alasql",
      compileSemanticQuery(model, q, { dialect: "alasql" }).sql,
    );
    const viaDuckdb = await runOn(
      "duckdb",
      compileSemanticQuery(model, q, { dialect: "duckdb" }).sql,
    );
    expect(viaDuckdb.rows).toEqual(viaAlasql.rows);
  });

  it("the mirror stays equal to page 1 through the round trip", () => {
    // Their drifting apart is what silently destroyed a widget.
    const w = widgetFromSemantic({
      title: "Mirror check",
      model: "saas",
      metrics: ["total_discount"],
      dimensions: ["country"],
      chartType: "bar",
      columns: ["country", "total_discount"],
      rows: [],
      sql: "SELECT 1",
    });
    const out = appendWidgetToPages([makeEmptyPage("Page 1")], w);
    const rereadMirror = parseWidgets(out.widgets as unknown as Json);
    const rereadPages = parsePages(
      out.pages as unknown as Json,
      rereadMirror,
      parseLayout(out.layout as unknown as Json, rereadMirror),
    );
    expect(rereadPages[0].widgets.map((x) => x.id)).toEqual(rereadMirror.map((x) => x.id));
  });
});
