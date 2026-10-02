// A node nobody finished configuring is refused by name.
//
// Found by leaving one picker untouched. A Platform dataset node was added,
// its "Choose a dataset" select never opened, and the graph SAVED and RAN. It
// died inside the sandbox with
//
//   requests.exceptions.HTTPError: 404 Client Error: for url:
//   http://agentswarms:8080/api/notebook/runtime/source
//
// — the app's own internal API, named as though it were the problem, with
// nothing tying it back to the node or the empty field. The reader's next move
// is to go looking at the runtime.
//
// Targets have been refused by name for as long as they have gone through
// `pyIdent` ("Lakehouse table must be a valid identifier … got ''") and the
// bucket check ("Node \"Reconciled\" has no bucket selected"). Sources got it
// only where a field happened to pass through one of those: a lakehouse source
// in query mode, a CDC table, an HTTP TARGET's url, a database node's
// connection (refused by `resolveRunEnv`, by name, at run start). The rest
// reached the sandbox and failed there, each in the vocabulary of whatever
// library got there first.
//
// The steps in between had the same shape of problem, so they are checked
// here too — but only where an empty field makes the step IMPOSSIBLE.
// `df.query('')` is "expr cannot be an empty string"; `groupby([])` is "No
// group keys passed!"; a join with no right keys is "len(right_on) must equal
// len(left_on)". A rename with no pairs, a dedupe with no columns and a fill
// with no columns all have a defined meaning and are left alone: refusing them
// would be inventing a rule rather than reporting one.
//
// Both engines are covered by one set of checks: compileSparkGraph runs
// compileGraph as a validation pass, explicitly so that "every refusal the
// pandas compiler makes stands here too".
import { describe, expect, it } from "vitest";

import { compileGraph, type EtlGraph } from "@/utils/etl/codegen";
import { compileSparkGraph } from "@/utils/etl/sparkCodegen";

/** source → lakehouse target, so only the source's config is in question. */
function graphWith(config: Record<string, unknown>): EtlGraph {
  return {
    nodes: [
      { id: "n1", kind: "source", label: "unfinished", config },
      {
        id: "n2",
        kind: "target",
        label: "out",
        config: { type: "lakehouse", schema: "analytics", table: "t", write_mode: "replace" },
      },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2" }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const CASES: [string, Record<string, unknown>, RegExp][] = [
  // The one that was found live.
  ["platform_dataset", { type: "platform_dataset", table_id: "" }, /has no dataset picked/],
  [
    "object_storage",
    { type: "object_storage", path: "", format: "csv" },
    /has no file or folder picked/,
  ],
  ["http_api", { type: "http_api", url: "" }, /needs a URL/],
  ["python", { type: "python", code: "   " }, /has no code/],
  [
    "lakehouse (table mode)",
    { type: "lakehouse", mode: "table", schema: "analytics", table: "" },
    /has no lakehouse table picked/,
  ],
  [
    "database (table mode)",
    { type: "database", mode: "table", connection_id: "c1", table: "" },
    /has no table picked/,
  ],
  [
    "database (query mode)",
    { type: "database", mode: "query", connection_id: "c1", query: "" },
    /has no query/,
  ],
];

describe("an unfinished source is refused at compile", () => {
  for (const [name, config, message] of CASES) {
    it(`${name}: names the node and the field`, () => {
      expect(() => compileGraph(graphWith(config))).toThrow(message);
      // …and names the NODE, so a ten-step graph says which one.
      expect(() => compileGraph(graphWith(config))).toThrow(/Source "unfinished"/);
    });
  }

  it("says the same thing on the Spark engine", () => {
    // Not a second list of rules: compileSparkGraph validates through
    // compileGraph first, and this is what makes that worth relying on.
    expect(() => compileSparkGraph(graphWith({ type: "platform_dataset", table_id: "" }))).toThrow(
      /Source "unfinished" has no dataset picked/,
    );
  });
});

describe("a configured source still compiles", () => {
  // The refusals must not fire on the ordinary case — the node matrix covers
  // all 52 shapes, and these are the four whose fields are new checks.
  const ok: [string, Record<string, unknown>][] = [
    ["platform_dataset", { type: "platform_dataset", table_id: "abc", table_name: "orders" }],
    ["object_storage", { type: "object_storage", path: "raw/orders/*.csv", format: "csv" }],
    ["http_api", { type: "http_api", url: "https://example.com/items" }],
    ["python", { type: "python", code: "return pd.DataFrame({'a': [1]})" }],
    ["lakehouse", { type: "lakehouse", mode: "table", schema: "analytics", table: "facts" }],
    // `connection_id` here is incidental: a missing connection is refused by
    // `resolveRunEnv` at run start, by name, for sources and targets alike —
    // this file is about the fields only the COMPILER can judge.
    ["database", { type: "database", mode: "table", connection_id: "c1", table: "public.orders" }],
  ];
  for (const [name, config] of ok) {
    it(`${name} compiles`, () => {
      expect(() => compileGraph(graphWith(config))).not.toThrow();
    });
  }

  it("leaves a stream source to its own validator", () => {
    // Streams already refuse in their own words (brokers, topic, security
    // mode), and duplicating half of that here would give two messages for
    // one mistake.
    expect(() =>
      compileGraph(
        graphWith({
          type: "kafka",
          brokers: "redpanda-test.local:9092",
          topic: "orders_stream",
          format: "json",
          start: "earliest",
          max_messages: 100,
          idle_ms: 1000,
          security: "plaintext",
        }),
      ),
    ).not.toThrow();
  });
});

// ── The steps in between ────────────────────────────────────────────────────

/** source → transform → target, so only the transform's config is in question. */
function withTransform(config: Record<string, unknown>): EtlGraph {
  return {
    nodes: [
      {
        id: "n1",
        kind: "source",
        label: "in",
        config: { type: "lakehouse", mode: "table", schema: "analytics", table: "facts" },
      },
      { id: "n2", kind: "transform", label: "half-done", config },
      {
        id: "n3",
        kind: "target",
        label: "out",
        config: { type: "lakehouse", schema: "analytics", table: "t", write_mode: "replace" },
      },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2" },
      { id: "e2", from: "n2", to: "n3" },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const TRANSFORMS: [string, Record<string, unknown>, RegExp][] = [
  ["filter", { type: "filter", expr: "  " }, /has no filter expression/],
  ["select", { type: "select", columns: [] }, /has no columns selected/],
  ["derive (no name)", { type: "derive", column: "", expr: "a + 1" }, /has no column name/],
  ["derive (no expression)", { type: "derive", column: "net", expr: "" }, /has no expression/],
  ["sort", { type: "sort", by: [] }, /has no columns to sort by/],
  [
    "aggregate (no group-by)",
    { type: "aggregate", group_by: [], aggs: [{ column: "amount", fn: "sum", as: "total" }] },
    /has no group-by columns/,
  ],
  [
    "aggregate (no aggregations)",
    { type: "aggregate", group_by: ["country"], aggs: [] },
    /has no aggregations/,
  ],
  ["sql", { type: "sql", query: "" }, /has no query/],
];

describe("an unfinished transform is refused at compile", () => {
  for (const [name, config, message] of TRANSFORMS) {
    it(`${name}: names the node and the field`, () => {
      expect(() => compileGraph(withTransform(config))).toThrow(message);
      expect(() => compileGraph(withTransform(config))).toThrow(/Transform "half-done"/);
    });
  }

  it("a join with a key on one side only is refused", () => {
    // Two inputs, so it needs its own graph — and this is the shape somebody
    // actually leaves behind: the left keys picked, the right ones forgotten.
    const g = {
      nodes: [
        {
          id: "n1",
          kind: "source",
          label: "a",
          config: { type: "lakehouse", mode: "table", schema: "analytics", table: "facts" },
        },
        {
          id: "n2",
          kind: "source",
          label: "b",
          config: { type: "lakehouse", mode: "table", schema: "analytics", table: "dim" },
        },
        {
          id: "n3",
          kind: "transform",
          label: "half-done",
          config: { type: "join", how: "inner", left_on: ["id"], right_on: [] },
        },
        {
          id: "n4",
          kind: "target",
          label: "out",
          config: { type: "lakehouse", schema: "analytics", table: "t", write_mode: "replace" },
        },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n3" },
        { id: "e2", from: "n2", to: "n3" },
        { id: "e3", from: "n3", to: "n4" },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(() => compileGraph(g)).toThrow(/Transform "half-done" needs a key column on both sides/);
  });
});

describe("a transform whose empty field MEANS something still compiles", () => {
  const ok: [string, Record<string, unknown>][] = [
    ["rename with no pairs (a no-op)", { type: "rename", mapping: {} }],
    ["dedupe over every column", { type: "dedupe", columns: [] }],
    ["fill nulls across every column", { type: "fill_nulls", value: "0", columns: [] }],
    ["drop nulls across every column", { type: "drop_nulls", columns: [] }],
    ["python with code", { type: "python", code: "return df" }],
  ];
  for (const [name, config] of ok) {
    it(`${name} compiles`, () => {
      expect(() => compileGraph(withTransform(config))).not.toThrow();
    });
  }
});
