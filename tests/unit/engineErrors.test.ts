// Engine diagnostics, translated.
//
// The message that prompted this, seen by a user running a saved semantic
// model: "Catalog Error: Scalar Function with name `__postfix does not exist!
// Did you mean "!__postfix"?" — the real cause was a backtick-quoted column.
// Nothing in that text says so and the suggestion is nonsense, so the reader
// reasonably concludes they have hit an internal bug.
//
// Two properties matter and pull against each other: say something USEFUL when
// the failure is recognised, and say NOTHING EXTRA when it is not. A confident
// wrong explanation sends someone down the wrong path, which is worse than the
// raw text.

import { describe, expect, it } from "vitest";

import { explainEngineError, explainEngineFailure } from "@/lib/engineErrors";

describe("explainEngineError", () => {
  it("names backtick quoting for the error the user actually saw", () => {
    const raw =
      'Catalog Error: Scalar Function with name `__postfix does not exist! Did you mean "!__postfix"?';
    const out = explainEngineError(raw, "duckdb");
    expect(out).toMatch(/backtick/i);
    expect(out).toMatch(/double quotes/i);
  });

  it("explains a DuckDB parser error mentioning a backtick", () => {
    const out = explainEngineError('Parser Error: syntax error at or near "`"', "duckdb");
    expect(out).toMatch(/backtick/i);
  });

  it("surfaces the AlaSQL reserved-word trap on a parse failure", () => {
    // A real product limitation nobody can guess: `AS total` does not parse.
    const out = explainEngineError("Error: Parse error on line 1: unexpected TOTAL", "alasql");
    expect(out).toMatch(/reserved word/i);
    expect(out).toContain("total");
  });

  it("does not offer the AlaSQL advice when DuckDB is the engine", () => {
    // Engine-specific rules must not fire for the other engine.
    const out = explainEngineError("Conversion Error: could not convert", "duckdb");
    expect(out).not.toMatch(/reserved word/i);
  });

  it("explains a missing table and a missing column", () => {
    expect(explainEngineError('Table with name "sales" does not exist', "duckdb")).toMatch(
      /no table called "sales"/i,
    );
    expect(explainEngineError('Referenced column "Regionn" not found', "duckdb")).toMatch(
      /column "Regionn" does not exist/i,
    );
  });

  it("explains a type conversion failure in terms of inferred columns", () => {
    const out = explainEngineError("Conversion Error: could not convert string to INT32", "duckdb");
    expect(out).toMatch(/inferred/i);
  });

  it("explains running out of memory, with the knob to change", () => {
    const out = explainEngineError("Out of Memory Error: failed to allocate", "duckdb");
    expect(out).toContain("LOCAL_ENGINE_MEMORY_MB");
  });

  it("ALWAYS keeps the engine's own words", () => {
    // An operator reading logs needs the original; a friendlier message that
    // discards it just trades one unhelpful string for another.
    const raw = 'Parser Error: syntax error at or near "`"';
    expect(explainEngineError(raw, "duckdb")).toContain(raw);
  });

  it("returns an unrecognised message unchanged rather than guessing", () => {
    const raw = "Something entirely unexpected happened in the storage layer";
    expect(explainEngineError(raw, "duckdb")).toBe(raw);
  });

  it("handles an empty message without producing an empty error", () => {
    expect(explainEngineError("", "alasql")).toMatch(/gave no reason/i);
    expect(explainEngineError("   ", "duckdb")).toMatch(/gave no reason/i);
  });
});

describe("explainEngineFailure", () => {
  it("wraps a caught Error and keeps its stack for debugging", () => {
    const original = new Error('Parser Error: syntax error at or near "`"');
    const wrapped = explainEngineFailure(original, "duckdb");
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toMatch(/backtick/i);
    expect(wrapped.stack).toBe(original.stack);
  });

  it("copes with a thrown value that is not an Error", () => {
    expect(explainEngineFailure("plain string failure", "alasql").message).toContain(
      "plain string failure",
    );
  });
});
