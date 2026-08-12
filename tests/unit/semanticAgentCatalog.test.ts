// Tier-3: what the AGENT sees, and how honestly.
//
// The failure this tier closes: descriptions were authored, validated,
// stored — and then discarded by the catalog; the agent got `region:
// categorical` and guessed `region = "Europe"` (zero rows, no error); a
// 60-region result was reported as "50 row(s)" with no marker. Every test
// here pins one of those honesty properties.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  compileSemanticQuery,
  formatSemanticCatalog,
  resolveFieldName,
  sampleValuesSql,
  type SemanticModel,
} from "@/lib/semanticLayer";
import { sampleDimensionValues, SAMPLE_VALUES_CAP, type ExecRows } from "@/lib/semanticMeasure";
import { renderMetricResult } from "@/utils/tools/metric.server";
import { governedLinesFor, type GovernedModelRow } from "@/lib/biAgent";
import { runLocalSqlDuckDB, type DuckTable } from "@/utils/data/duckdb.server";

const orders: DuckTable = {
  name: "orders",
  columns: [
    { name: "order_id", type: "string" },
    { name: "region", type: "string" },
    { name: "note", type: "string" },
    { name: "amount", type: "number" },
  ],
  rows: [
    { order_id: "A", region: "EMEA", note: "alpha", amount: 100 },
    { order_id: "B", region: "EMEA", note: "beta", amount: 50 },
    { order_id: "C", region: "APAC", note: null, amount: 70 },
    { order_id: "D", region: "AMER", note: "gamma", amount: 30 },
    { order_id: "E", region: "AMER", note: "delta", amount: 10 },
    { order_id: "F", region: "AMER", note: "epsilon", amount: 20 },
    { order_id: "G", region: "AMER", note: "zeta", amount: 5 },
    { order_id: "H", region: "AMER", note: "eta", amount: 6 },
    { order_id: "I", region: "AMER", note: "theta", amount: 7 },
    { order_id: "J", region: "AMER", note: "iota", amount: 8 },
  ],
};

const model: SemanticModel = {
  name: "orders_model",
  source: { kind: "data_table", table: "orders" },
  primaryKey: "order_id",
  dimensions: [
    {
      name: "region",
      sql: "region",
      type: "categorical",
      label: "Region",
      description: "Sales region; EMEA excludes UK after 2024",
      synonyms: ["area", "territory"],
      values: ["AMER", "APAC", "EMEA"],
    },
    { name: "order_id", sql: "order_id", type: "categorical" },
    { name: "note", sql: "note", type: "categorical" },
  ],
  metrics: [
    {
      name: "revenue",
      agg: "sum",
      sql: "amount",
      format: "currency",
      description: "Excludes refunds and internal test orders",
      synonyms: ["turnover", "GMV"],
    },
    { name: "orders_n", agg: "count_distinct", sql: "order_id", synonyms: ["order count"] },
  ],
};

const exec: ExecRows = async (sql) => (await runLocalSqlDuckDB(sql, [orders])).rows;

describe("the catalog carries what the owner wrote", () => {
  const text = formatSemanticCatalog([model]);

  it("descriptions reach the agent", () => {
    expect(text).toContain("Excludes refunds and internal test orders");
    expect(text).toContain("EMEA excludes UK after 2024");
  });

  it("each metric shows its governed formula, so a sum is not mistaken for an avg", () => {
    expect(text).toMatch(/revenue.*= SUM\(amount\).*\[currency\]/);
    expect(text).toMatch(/orders_n.*= COUNT\(DISTINCT order_id\)/);
  });

  it("synonyms are advertised", () => {
    expect(text).toMatch(/revenue.*aka: turnover, GMV/);
    expect(text).toMatch(/region.*aka: area, territory/);
  });

  it("sampled values are shown, pipe-separated", () => {
    expect(text).toMatch(/region.*values: AMER\|APAC\|EMEA/);
  });

  it("free text is clipped — the catalog rides in the system prompt", () => {
    const long = {
      ...model,
      metrics: [{ ...model.metrics[0], description: "x".repeat(500) }],
    };
    const t = formatSemanticCatalog([long]);
    expect(t).toContain("x".repeat(119) + "…");
    expect(t).not.toContain("x".repeat(200));
  });

  it("a malformed derived metric loses its formula, not its listing", () => {
    const broken: SemanticModel = {
      ...model,
      metrics: [{ name: "bad", agg: "derived", sql: "{missing_ref}" }],
    };
    const t = formatSemanticCatalog([broken]);
    expect(t).toMatch(/- bad/);
    expect(t).not.toMatch(/= .*missing_ref/);
  });
});

describe("resolveFieldName — the business vocabulary works", () => {
  it("exact names pass through untouched", () => {
    expect(resolveFieldName(model, "revenue")).toEqual({ name: "revenue" });
  });

  it("case-insensitive name match resolves silently", () => {
    expect(resolveFieldName(model, "REVENUE")).toEqual({ name: "revenue" });
  });

  it("a synonym resolves with a disclosed note", () => {
    expect(resolveFieldName(model, "turnover")).toEqual({
      name: "revenue",
      note: '"turnover" resolved to "revenue" via synonym',
    });
    expect(resolveFieldName(model, "Territory").name).toBe("region");
  });

  it("an ambiguous synonym refuses rather than guessing", () => {
    const ambiguous: SemanticModel = {
      ...model,
      metrics: [
        { name: "gross", agg: "sum", sql: "amount", synonyms: ["sales"] },
        { name: "net", agg: "sum", sql: "amount", synonyms: ["sales"] },
      ],
    };
    expect(() => resolveFieldName(ambiguous, "sales")).toThrow(/synonym of 2 fields.*gross, net/s);
  });

  it("an unknown name returns unchanged — the compiler owns the refusal", () => {
    expect(resolveFieldName(model, "nonsense")).toEqual({ name: "nonsense" });
  });
});

describe("compiler refusals name the alternatives", () => {
  it("unknown metric lists what exists", () => {
    expect(() =>
      compileSemanticQuery(model, { model: "m", metrics: ["nope"] }, { dialect: "duckdb" }),
    ).toThrow(/Unknown metric "nope" \(available: revenue, orders_n\)/);
  });

  it("unknown dimension lists what exists", () => {
    expect(() =>
      compileSemanticQuery(
        model,
        { model: "m", metrics: ["revenue"], dimensions: ["nope"] },
        { dialect: "duckdb" },
      ),
    ).toThrow(/Unknown dimension "nope" \(available: region, order_id, note\)/);
  });
});

describe("sampleDimensionValues — measured, never partial", () => {
  it("samples a low-cardinality dimension, sorted, from the real engine", async () => {
    const out = await sampleDimensionValues(exec, model, "duckdb");
    expect(out.region).toEqual(["AMER", "APAC", "EMEA"]);
  });

  it("a dimension with more distinct values than the cap gets NOTHING", async () => {
    // 9 distinct notes (null excluded) > cap of 8 — a partial list would read
    // as complete, so none is stored.
    const out = await sampleDimensionValues(exec, model, "duckdb");
    expect(SAMPLE_VALUES_CAP).toBe(8);
    expect(out.note).toBeUndefined();
  });

  it("order_id has 10 distinct values — also omitted", async () => {
    const out = await sampleDimensionValues(exec, model, "duckdb");
    expect(out.order_id).toBeUndefined();
  });

  it("only CATEGORICAL dimensions are sampled", async () => {
    const timeModel: SemanticModel = {
      ...model,
      dimensions: [{ name: "region", sql: "region", type: "time" }],
    };
    const out = await sampleDimensionValues(exec, timeModel, "duckdb");
    expect(out).toEqual({});
  });

  it("NULL never appears as a value", async () => {
    const sql = sampleValuesSql(model, "note", "duckdb", SAMPLE_VALUES_CAP);
    expect(sql).toMatch(/WHERE .*note.* IS NOT NULL/);
  });

  it("the probe asks for cap+1 so 'exactly cap' and 'more' are distinguishable", () => {
    expect(sampleValuesSql(model, "region", "duckdb", 8)).toMatch(/LIMIT 9$/);
  });

  it("a broken dimension is skipped silently — the field probe owns that failure", async () => {
    const broken: SemanticModel = {
      ...model,
      dimensions: [
        { name: "region", sql: "region", type: "categorical" },
        { name: "bad", sql: "no_such_column", type: "categorical" },
      ],
    };
    const out = await sampleDimensionValues(exec, broken, "duckdb");
    expect(out.region).toEqual(["AMER", "APAC", "EMEA"]);
    expect(out.bad).toBeUndefined();
  });
});

describe("renderMetricResult — the truncation sentence is a truth claim", () => {
  const base = { model: "m", sql: "SELECT 1" };
  const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

  it("more rows than the cap says PARTIAL, loudly", () => {
    const text = renderMetricResult({ ...base, rows: rowsOf(51) }, 50);
    expect(text).toMatch(/first 50 row\(s\) of a LARGER result/);
    expect(text).toMatch(/say the list is partial/);
    // And actually returns only 50 rows.
    expect((text.match(/"i":/g) ?? []).length).toBe(50);
  });

  it("exactly the cap is NOT marked partial", () => {
    const text = renderMetricResult({ ...base, rows: rowsOf(50) }, 50);
    expect(text).toMatch(/50 row\(s\):/);
    expect(text).not.toMatch(/LARGER result/);
  });

  it("synonym resolutions and share restrictions are disclosed to the agent", () => {
    const text = renderMetricResult(
      {
        ...base,
        rows: rowsOf(1),
        resolution_notes: ['"turnover" resolved to "revenue" via synonym'],
        access_note: "rows limited to region ∈ [APAC]",
      },
      50,
    );
    expect(text).toMatch(/note: "turnover" resolved to "revenue" via synonym\./);
    expect(text).toMatch(/restricted share — rows limited to region ∈ \[APAC\]/);
  });
});

describe("governedLinesFor — the BI analyst's governed context", () => {
  const mkRow = (over: Partial<GovernedModelRow>): GovernedModelRow => ({
    name: "m",
    label: null,
    source_kind: "data_table",
    source_table: "orders",
    dimensions: [],
    metrics: [{ name: "revenue", agg: "sum", sql: "amount" }],
    ...over,
  });
  const datasets = [{ name: "ANALYTICS.ORDERS", columns: [] }] as never;

  it("WAREHOUSE-backed models now contribute — the old kind filter dropped them", () => {
    const lines = governedLinesFor(datasets, [
      mkRow({ source_kind: "warehouse", source_table: "ANALYTICS.ORDERS" }),
    ]);
    expect(lines.join("\n")).toMatch(/MODEL m over TABLE ANALYTICS\.ORDERS:/);
    expect(lines.join("\n")).toMatch(/revenue = SUM\(amount\)/);
  });

  it("metric descriptions ride along", () => {
    const lines = governedLinesFor([{ name: "orders", columns: [] }] as never, [
      mkRow({
        metrics: [{ name: "revenue", agg: "sum", sql: "amount", description: "net of refunds" }],
      }),
    ]);
    expect(lines.join("\n")).toMatch(/revenue = SUM\(amount\).*-- net of refunds/);
  });

  it("field caps DISCLOSE what they dropped", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `m${i}`,
      agg: "sum" as const,
      sql: "amount",
    }));
    const lines = governedLinesFor([{ name: "orders", columns: [] }] as never, [
      mkRow({ metrics: many }),
    ]);
    expect(lines.join("\n")).toMatch(/… 4 more metric\(s\) not shown/);
  });

  it("the model cap DISCLOSES what it dropped", () => {
    const rows = Array.from({ length: 10 }, (_, i) => mkRow({ name: `model_${i}` }));
    const lines = governedLinesFor([{ name: "orders", columns: [] }] as never, rows);
    expect(lines.join("\n")).toMatch(/… 2 more governed model\(s\) not shown/);
  });
});

describe("wiring (source guards)", () => {
  const query = readFileSync("src/utils/semantic/query.server.ts", "utf8");
  const metric = readFileSync("src/utils/tools/metric.server.ts", "utf8");

  it("synonym resolution happens INSIDE runSemanticQuery, before policy and compile", () => {
    expect(query).toMatch(/const r = resolveFieldName\(model, n\);/);
    expect(query).toMatch(/metrics: \(query\.metrics \?\? \[\]\)\.map\(mapName\)/);
    expect(query).toMatch(
      /filters: \(query\.filters \?\? \[\]\)\.map\(\(f\) => \(\{ \.\.\.f, field: mapName\(f\.field\) \}\)\)/,
    );
    // Resolution must precede the policy block, so a synonym of a masked
    // field is still refused by name.
    expect(query.indexOf("resolveFieldName")).toBeLessThan(
      query.indexOf("policyIsRestrictive(policy)"),
    );
  });

  it("metric_query fetches ONE PAST the cap so truncation is detectable", () => {
    expect(metric).toMatch(/maxRows: RESULT_ROW_CAP \+ 1,/);
    expect(metric).toMatch(/return renderMetricResult\(res, RESULT_ROW_CAP\);/);
  });

  it("agent chat maps the metric_query toggle into enabled tools", () => {
    // Found from the UI: the builder saved builtInTools.metric_query, but the
    // chat route's toggle→tool mapping omitted it, so a fully configured
    // agent silently never received the tool and improvised raw SQL instead.
    const chat = readFileSync("src/routes/api/chat.ts", "utf8");
    expect(chat).toMatch(/if \(t\.metric_query\) out\.push\("metric_query"\);/);
  });
});
