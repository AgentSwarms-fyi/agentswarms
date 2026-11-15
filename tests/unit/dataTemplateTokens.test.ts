// The data-side insert menus (R496): ETL run parameters, semantic-layer
// columns/parameters/metrics, and IAM user attributes.
//
// A menu is only worth having if what it inserts is what the engine reads, so
// every test here feeds a picked token back through the real reader — the ETL
// compiler, the semantic compiler and file check, the row-filter validator —
// rather than comparing strings to themselves.
import { describe, expect, it } from "vitest";

import { etlColumnTokens, etlParamTokens, runParamsDraft } from "@/lib/etlParams";
import { addFilterValue, attributeFilterTokens } from "@/lib/iamAttributeTokens";
import { metricRefsIn, paramRefsIn } from "@/lib/semanticFileCheck";
import { semanticFragmentTokens } from "@/lib/semanticFieldTokens";
import { compileSemanticQuery, type SemanticModel } from "@/lib/semanticLayer";
import { USER_ATTR_TOKEN_RE } from "@/lib/semanticPolicy";
import {
  compileGraph,
  graphParamRefs,
  paramRefs,
  templatedFields,
  type EtlGraph,
  type EtlNode,
} from "@/utils/etl/codegen";

// ── ETL ─────────────────────────────────────────────────────────────────────

const target: EtlNode = {
  id: "n9",
  kind: "target",
  label: "out",
  config: { type: "lakehouse", schema: "analytics", table: "t", write_mode: "append" },
} as unknown as EtlNode;

/** A source → [transform] → target graph. */
function graph(source: Record<string, unknown>, transform?: Record<string, unknown>): EtlGraph {
  const nodes = [
    { id: "n1", kind: "source", label: "src", config: source },
    ...(transform ? [{ id: "n2", kind: "transform", label: "t", config: transform }] : []),
    target,
  ] as unknown as EtlNode[];
  const edges = transform
    ? [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n9" },
      ]
    : [{ id: "e1", from: "n1", to: "n9" }];
  return { nodes, edges };
}

const storage = (path: string) => ({
  type: "object_storage",
  source_id: "s1",
  path,
  format: "csv",
});
const code = (g: EtlGraph) => String(compileGraph(g));

describe("the ETL Parameter menu is offered exactly where a parameter resolves", () => {
  // The menu sits on the fields templatedFields() names. Each must compile a
  // picked `{{params.x}}` into a run-time lookup — and a field NOT named must
  // not, or the menu would be inserting text that reaches the program as-is.
  const ref = "{{params.zz_probe}}";
  const lookup = "_param('zz_probe'";

  it("a storage source's path", () => {
    const g = graph(storage(`raw/${ref}/*.csv`));
    expect(templatedFields(g.nodes[0])).toEqual([`raw/${ref}/*.csv`]);
    expect(code(g)).toContain(lookup);
  });

  it("an HTTP source's URL", () => {
    const g = graph({ type: "http_api", url: `https://api.example.com/x?d=${ref}` });
    expect(templatedFields(g.nodes[0])).toHaveLength(1);
    expect(code(g)).toContain(lookup);
  });

  it("a filter's condition", () => {
    const g = graph(storage("raw/a.csv"), { type: "filter", expr: `day == '${ref}'` });
    expect(templatedFields(g.nodes[1])).toHaveLength(1);
    expect(code(g)).toContain(lookup);
  });

  it("a SQL step's query", () => {
    const g = graph(storage("raw/a.csv"), {
      type: "sql",
      query: `SELECT * FROM t WHERE d = '${ref}'`,
    });
    expect(templatedFields(g.nodes[1])).toHaveLength(1);
    expect(code(g)).toContain(lookup);
  });

  it("NOT a derive expression, which keeps the characters as written", () => {
    const g = graph(storage("raw/a.csv"), { type: "derive", column: "c", expr: `x + ${ref}` });
    expect(templatedFields(g.nodes[1])).toEqual([]);
    expect(code(g)).not.toContain(lookup);
  });
});

describe("etlParamTokens", () => {
  const g = graph(storage("raw/{{params.day|2026-01-01}}/*.csv"), {
    type: "sql",
    query: "SELECT * FROM t WHERE r = '{{params.region}}' AND w = '{{params.week}}'",
  });

  it("lists the default parameters, then names the nodes read that the defaults do not set", () => {
    const tokens = etlParamTokens({ week: 7, "start-date": "x" }, g);
    expect(tokens.map((t) => [t.insert, t.group])).toEqual([
      ["{{params.week}}", "Pipeline parameters"],
      ["{{params.day}}", "Used in this pipeline"],
      ["{{params.region}}", "Used in this pipeline"],
    ]);
    expect(tokens[0].detail).toBe("Default: 7");
    expect(tokens[1].detail).toMatch(/falls back to "2026-01-01"/);
    expect(tokens[2].detail).toMatch(/empty unless a run sets it/);
  });

  it("does not offer a default key the compiler's grammar cannot reference", () => {
    // `{{params.start-date}}` never matches, so inserting it would read as a
    // parameter on screen and reach the program as literal text.
    const tokens = etlParamTokens({ "start-date": "2026-01-01" }, graph(storage("a.csv")));
    expect(tokens).toEqual([]);
  });

  it("every inserted token is read back as the parameter it names", () => {
    for (const t of etlParamTokens({ week: 7 }, g)) {
      expect(paramRefs(t.insert)).toEqual([{ name: t.label.replace(/^params\./, "") }]);
    }
  });
});

describe("graphParamRefs and Run with parameters", () => {
  it("collects every read name once, keeping a fallback written anywhere", () => {
    const g = graph(storage("raw/{{params.day}}/x.csv"), {
      type: "filter",
      expr: "d == '{{params.day|2026-01-01}}'",
    });
    expect([...graphParamRefs(g)]).toEqual([["day", "2026-01-01"]]);
  });

  it("opens on the names nodes read with no default and no fallback, as empty", () => {
    const reads = new Map<string, string | undefined>([
      ["region", undefined],
      ["day", "2026-01-01"],
      ["week", undefined],
    ]);
    // `day` is left out: two fields may give it different fallbacks, and
    // pinning one would change what the other reads.
    expect(runParamsDraft({ week: 3 }, reads)).toEqual({ week: 3, region: "" });
    expect(runParamsDraft(null, new Map())).toBeNull();
  });
});

describe("etlColumnTokens", () => {
  it("spells a column the way a pandas condition can read it", () => {
    const out = etlColumnTokens(["amount", "Unit Price", "in", "2024"], "pandas").map(
      (t) => t.insert,
    );
    expect(out).toEqual(["amount", "`Unit Price`", "`in`", "`2024`"]);
  });

  it("always quotes in SQL, escaping embedded quotes", () => {
    expect(etlColumnTokens(["order", 'a"b'], "sql").map((t) => t.insert)).toEqual([
      '"order"',
      '"a""b"',
    ]);
  });
});

// ── Semantic layer ──────────────────────────────────────────────────────────

describe("semanticFragmentTokens", () => {
  const parameters = [
    { name: "min_amount", type: "number" as const, default: 100 },
    { name: "bad-name", type: "string" as const, default: "x" },
  ];
  const metrics = [
    { name: "revenue", agg: "sum" as const },
    { name: "orders", agg: "count" as const },
    { name: "aov", agg: "derived" as const },
  ];

  it("offers columns and parameters to a dimension or metric", () => {
    const t = semanticFragmentTokens({
      kind: "dimension",
      columns: [{ name: "Order Date", type: "date" }],
      parameters,
      metrics,
    });
    expect(t.map((x) => [x.insert, x.group])).toEqual([
      ['"Order Date"', "Columns"],
      ["{{min_amount}}", "Parameters"],
    ]);
  });

  it("offers a derived formula the OTHER metrics, never itself", () => {
    const t = semanticFragmentTokens({
      kind: "derived",
      columns: [{ name: "amount" }],
      parameters,
      metrics,
      self: "aov",
    });
    expect(t.map((x) => x.insert)).toEqual(["{revenue}", "{orders}", "{{min_amount}}"]);
  });

  it("inserts tokens the file check reads as the right kind of reference", () => {
    const t = semanticFragmentTokens({ kind: "derived", columns: [], parameters, metrics });
    const formula = t.map((x) => x.insert).join(" + ");
    expect(metricRefsIn(formula)).toEqual(["revenue", "orders", "aov"]);
    expect(paramRefsIn(formula)).toEqual(["min_amount"]);
  });

  it("builds a model the compiler accepts, on every dialect", () => {
    const pick = (kind: "dimension" | "derived", label: string, self?: string) =>
      semanticFragmentTokens({
        kind,
        columns: [{ name: "Region" }, { name: "Amount" }],
        parameters: [{ name: "rate", type: "number", default: 0.1 }],
        metrics: [
          { name: "revenue", agg: "sum" },
          { name: "commission", agg: "derived" },
        ],
        self,
      }).find((x) => x.label === label)!.insert;
    const model = {
      name: "m",
      source: { kind: "data_table", table: "orders" },
      parameters: [{ name: "rate", type: "number", default: 0.1 }],
      dimensions: [{ name: "region", sql: pick("dimension", "Region"), type: "categorical" }],
      metrics: [
        { name: "revenue", agg: "sum", sql: pick("dimension", "Amount") },
        {
          name: "commission",
          agg: "derived",
          sql: `${pick("derived", "revenue", "commission")} * ${pick("derived", "rate", "commission")}`,
        },
      ],
    } as unknown as SemanticModel;
    for (const [dialect, region] of [
      ["postgres", '"Region"'],
      ["duckdb", '"Region"'],
      // MySQL reads "Region" as a STRING: the column must come out backticked.
      ["mysql", "`Region`"],
    ] as const) {
      const { sql } = compileSemanticQuery(
        model,
        { model: "m", dimensions: ["region"], metrics: ["commission"] },
        { dialect },
      );
      expect(sql).toContain(region);
      expect(sql).toContain("0.1");
      expect(sql).not.toContain("{{");
    }
  });

  it("spells a column holding a double quote so the re-quoter keeps it whole", () => {
    const [col] = semanticFragmentTokens({
      kind: "dimension",
      columns: [{ name: 'say "hi"' }],
      parameters: [],
      metrics: [],
    });
    const model = {
      name: "m",
      source: { kind: "data_table", table: "t" },
      dimensions: [{ name: "d", sql: col.insert, type: "categorical" }],
      metrics: [{ name: "n", agg: "count" }],
    } as unknown as SemanticModel;
    const q = { model: "m", dimensions: ["d"], metrics: ["n"] };
    expect(compileSemanticQuery(model, q, { dialect: "postgres" }).sql).toContain('"say ""hi"""');
    // The dialect that tells the spellings apart: `"say ""hi"""` re-quotes
    // for MySQL as three identifiers, `say `, `hi` and an empty one.
    expect(compileSemanticQuery(model, q, { dialect: "mysql" }).sql).toContain('`say "hi"`');
  });
});

// ── IAM ─────────────────────────────────────────────────────────────────────

describe("attributeFilterTokens", () => {
  const rows = [
    { user_id: "u1", key: "region", values: ["EMEA"] },
    { user_id: "u2", key: "region", values: ["APAC", "LATAM"] },
    { user_id: "u1", key: "cost_center", values: ["42"] },
  ];

  it("lists each key once, sorted, with who has it", () => {
    const t = attributeFilterTokens(rows);
    expect(t.map((x) => x.insert)).toEqual(["{{user.cost_center}}", "{{user.region}}"]);
    expect(t[1].detail).toBe("Set for 2 users: EMEA, APAC, LATAM");
  });

  it("inserts a value the row-filter validator accepts as an attribute token", () => {
    for (const t of attributeFilterTokens(rows))
      expect(USER_ATTR_TOKEN_RE.test(t.insert)).toBe(true);
  });
});

describe("addFilterValue", () => {
  it("adds a pick as its own comma-separated value", () => {
    expect(addFilterValue("", "{{user.region}}")).toBe("{{user.region}}");
    expect(addFilterValue("EMEA, APAC,", "{{user.region}}")).toBe("EMEA, APAC, {{user.region}}");
  });

  it("leaves the list alone when the value is already there", () => {
    expect(addFilterValue("{{user.region}}, EMEA", "{{user.region}}")).toBe(
      "{{user.region}}, EMEA",
    );
  });
});
