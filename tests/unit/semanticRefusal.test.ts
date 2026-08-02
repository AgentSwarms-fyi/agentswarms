// What the semantic compiler REFUSES.
//
// The layer's security claim is that an AI-authored query picks NAMES and
// never writes SQL, so every name it does not recognise has to be rejected.
// The compiler was consistent about that for metrics, dimensions, filter
// fields, grains, comparisons and the source table — and inconsistent for
// exactly one input, ORDER BY, which silently dropped unknown fields.
//
// That is the worst shape a bug takes in a BI tool: "top 10 customers by
// revenue" with a renamed or mistyped order field drops the ORDER BY and
// returns an ARBITRARY ten rows, still labelled "top 10". Nothing errors and
// the number on the dashboard is wrong in a way nobody can see. The file
// already states the rule it broke — "Refused, not degraded" — in its own
// comment about AlaSQL comparisons.
//
// Also pinned here: LIMIT. `Math.max(1, Math.min(NaN, MAX))` is NaN, so a
// limit that did not parse reached the database as the literal `LIMIT NaN`.
import { describe, expect, it } from "vitest";

import { compileSemanticQuery, type SemanticModel, type SemanticQuery } from "@/lib/semanticLayer";

const model = {
  id: "m",
  name: "sales",
  source: { kind: "data_table", table: "orders" },
  dimensions: [
    { name: "region", sql: "region", type: "categorical" },
    { name: "created", sql: "created_at", type: "time" },
  ],
  metrics: [
    { name: "revenue", agg: "sum", sql: "amount" },
    { name: "orders", agg: "count" },
  ],
  joins: [],
} as unknown as SemanticModel;

const compile = (q: Partial<SemanticQuery>) =>
  compileSemanticQuery(model, { model: "m", metrics: ["revenue"], ...q } as SemanticQuery, "duckdb")
    .sql;

describe("ORDER BY refuses a field the query does not return", () => {
  it("orders by a real output column", () => {
    expect(compile({ orderBy: [{ field: "revenue", dir: "desc" }] })).toContain(
      'ORDER BY "revenue" DESC',
    );
  });

  it("REFUSES an unknown field instead of dropping it", () => {
    // The silent version returned rows in engine order under a "top N" label.
    expect(() => compile({ orderBy: [{ field: "revenu", dir: "desc" }], limit: 10 })).toThrow(
      /Order references "revenu"/,
    );
  });

  it("refuses a field that exists on the MODEL but is not selected", () => {
    // `region` is a real dimension, just not in this query's results — SQL
    // could not order by it either, and guessing would answer a different
    // question.
    expect(() => compile({ metrics: ["revenue"], orderBy: [{ field: "region" }] })).toThrow(
      /this query does not return/,
    );
  });

  it("names what IS available, so the caller can correct itself", () => {
    // These errors go back to a model as tool output; "unknown field" alone
    // gives it nothing to retry with.
    expect(() => compile({ dimensions: ["region"], orderBy: [{ field: "nope" }] })).toThrow(
      /available: .*region.*revenue|available: .*revenue.*region/,
    );
  });

  it("is consistent with how an unknown FILTER field behaves", () => {
    // Both are unknown names in the same query shape; they must agree.
    const order = () => compile({ orderBy: [{ field: "ghost" }] });
    const filter = () => compile({ filters: [{ field: "ghost", op: "=", value: 1 }] });
    expect(order).toThrow();
    expect(filter).toThrow();
  });
});

describe("LIMIT never reaches the database malformed", () => {
  it("clamps to the supported range", () => {
    expect(compile({ limit: 10 })).toMatch(/LIMIT 10$/);
    expect(compile({ limit: -1 })).toMatch(/LIMIT 1$/);
    expect(compile({ limit: 0 })).toMatch(/LIMIT 1$/);
    expect(compile({ limit: 1e9 })).toMatch(/LIMIT 10000$/);
  });

  it("defaults when absent", () => {
    expect(compile({})).toMatch(/LIMIT 1000$/);
  });

  it("floors a fractional limit rather than emitting LIMIT 2.7", () => {
    // Postgres rejects a non-integer LIMIT outright.
    expect(compile({ limit: 2.7 })).toMatch(/LIMIT 2$/);
  });

  it("REFUSES a limit that is not a number instead of emitting LIMIT NaN", () => {
    for (const bad of [NaN, Infinity, "ten", "10; DROP TABLE users", {}, []]) {
      expect(() => compile({ limit: bad as unknown as number }), `limit=${String(bad)}`).toThrow(
        /Limit must be a finite number/,
      );
    }
  });

  it("still accepts a numeric string, which an AI-authored query may send", () => {
    expect(compile({ limit: "50" as unknown as number })).toMatch(/LIMIT 50$/);
  });
});

describe("the refusals that already worked stay working", () => {
  // Regression cover for the properties the ORDER BY change must not weaken.
  it("rejects unknown metrics and dimensions", () => {
    expect(() => compile({ metrics: ["nope"] })).toThrow(/Unknown metric/);
    expect(() => compile({ dimensions: ["nope"] })).toThrow(/Unknown dimension/);
  });

  it("rejects an unsafe source table", () => {
    const bad = { ...model, source: { kind: "data_table", table: "orders; DROP TABLE users" } };
    expect(() =>
      compileSemanticQuery(
        bad as unknown as SemanticModel,
        { model: "m", metrics: ["revenue"] } as SemanticQuery,
        "duckdb",
      ),
    ).toThrow(/Unsafe source table/);
  });

  it("escapes a filter value rather than interpolating it", () => {
    const sql = compile({
      filters: [{ field: "region", op: "=", value: "x'; DROP TABLE users--" }],
    });
    // The quote is doubled, so the payload stays inside the literal.
    expect(sql).toContain("'x''; DROP TABLE users--'");
  });

  it("escapes LIKE metacharacters with a dialect-neutral escape char", () => {
    const sql = compile({ filters: [{ field: "region", op: "contains", value: "100%_x" }] });
    expect(sql).toContain("ESCAPE '~'");
    expect(sql).toContain("~%");
    expect(sql).toContain("~_");
  });
});
