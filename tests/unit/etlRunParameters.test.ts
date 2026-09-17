// Run parameters reach the compiled program.
//
// They did not. `entrypoint(inputs)` received them, handed them to
// `_tick(inputs)`, and `_tick` never read the argument — there was no
// substitution anywhere in the ETL path. Meanwhile the dialog that sends them
// calls itself "the backfill door" and "the standard way to backfill a window
// or rerun one partition", and the documentation described backfills as
// parameterised runs. Re-running July 3-9 started a run, said "Run started",
// and read exactly what the pipeline always reads.
//
// The emitted helper is also exercised in Python, in etlRunParameters.spec-ish
// fashion below: compiling the right-looking text is not the same as the text
// behaving, and the first version returned "" for an explicitly null parameter
// while its own comment promised the default.
import { describe, expect, it } from "vitest";

import { compileGraph, hasParams, pyTemplate } from "@/utils/etl/codegen";

function graph(srcPath: string, filterExpr?: string) {
  const nodes: Record<string, unknown>[] = [
    {
      id: "n1",
      kind: "source",
      label: "src",
      config: { type: "object_storage", source_id: "s1", path: srcPath, format: "csv" },
    },
  ];
  const edges: Record<string, string>[] = [];
  if (filterExpr) {
    nodes.push({
      id: "n2",
      kind: "transform",
      label: "f",
      config: { type: "filter", expr: filterExpr },
    });
    edges.push({ from: "n1", to: "n2" });
  }
  nodes.push({
    id: "n3",
    kind: "target",
    label: "out",
    config: { type: "lakehouse", schema: "analytics", table: "t", write_mode: "append" },
  });
  edges.push({ from: filterExpr ? "n2" : "n1", to: "n3" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { nodes, edges } as any;
}

const codeOf = (g: unknown) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = compileGraph(g as any) as any;
  return String(out.code ?? out);
};

describe("a field carrying no parameter is untouched", () => {
  it("compiles to the same literal it always did", () => {
    // The overwhelming majority of nodes. If this changes, every existing
    // pipeline's program changes with it.
    expect(hasParams("landing/*.csv")).toBe(false);
    expect(pyTemplate("landing/*.csv")).toBe("'landing/*.csv'");
  });
});

describe("a field carrying a parameter compiles to a lookup", () => {
  it("splits the literal around the reference", () => {
    expect(pyTemplate("landing/{{params.day}}/*.csv")).toBe(
      "('landing/' + _param('day', '') + '/*.csv')",
    );
  });

  it("carries a default through the pipe form", () => {
    expect(pyTemplate("landing/{{params.day|2026-01-01}}/*.csv")).toContain(
      "_param('day', '2026-01-01')",
    );
  });

  it("escapes the surrounding literal rather than trusting it", () => {
    // A quote either side of a reference is the common case in SQL, and an
    // unescaped one would end the Python string early.
    const out = pyTemplate("d >= '{{params.start}}'");
    expect(out).toContain("\\'");
    expect(out).toContain("_param('start', '')");
  });

  it("handles several references in one field", () => {
    const out = pyTemplate("{{params.a}}-{{params.b}}");
    expect(out).toContain("_param('a', '')");
    expect(out).toContain("_param('b', '')");
  });
});

describe("the program can resolve one", () => {
  it("publishes the run's parameters where source functions can see them", () => {
    // Source functions are module-level, so a closure over `inputs` would not
    // reach them. The global is set once per tick.
    const code = codeOf(graph("landing/{{params.day}}/*.csv"));
    expect(code).toContain("_PARAMS = {}");
    expect(code).toMatch(/def _param\(name, default=''\):/);
    expect(code).toMatch(
      /def _tick\(inputs=None\):\s*\n\s*global _PARAMS\s*\n\s*_PARAMS = dict\(inputs or \{\}\)/,
    );
  });

  it("substitutes in a source path and in a transform expression", () => {
    const code = codeOf(
      graph("landing/{{params.day}}/*.csv", "region == '{{params.region|EMEA}}'"),
    );
    expect(code).toMatch(/path = \('landing\/' \+ _param\('day', ''\)/);
    expect(code).toMatch(/_param\('region', 'EMEA'\)/);
  });

  it("falls back for a key that is present but null", () => {
    // Verified by running the emitted helper: `.get(name, default)` returns
    // None for a key explicitly set to null, so the first version produced ""
    // while its own comment promised the default. A schedule passing
    // {"day": null} means "no value", not "the empty string".
    const code = codeOf(graph("landing/{{params.day|D}}/*.csv"));
    expect(code).toMatch(/v = _PARAMS\.get\(name\)/);
    expect(code).toMatch(/return str\(default\) if v is None else str\(v\)/);
    expect(code).not.toMatch(/_PARAMS\.get\(name, default\)/);
  });
});
