// The Data Prep "AI column" step: how it compiles to an ai_* call, what it
// refuses, and that the engines answer it as the user. Pure model first, then
// the wiring the pure model relies on.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPrepSql,
  effectiveOutputColumns,
  emptyPrepConfig,
  foldEligibility,
  incrementalEligibility,
  makeStep,
  PREP_STEP_KINDS,
  prepStepLabel,
  validatePrepConfig,
  type PrepFlowConfig,
  type PrepStep,
} from "@/lib/dataPrepCore";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const cols = [
  { name: "order_id", type: "integer" as const },
  { name: "region", type: "text" as const },
  { name: "plan", type: "text" as const },
  { name: "placed_at", type: "date" as const },
];

function flow(steps: PrepStep[]): PrepFlowConfig {
  return {
    ...emptyPrepConfig(),
    base: "revenue_facts",
    columns: cols.map((c) => ({
      key: `revenue_facts.${c.name}`,
      table: "revenue_facts",
      column: c.name,
      include: true,
      outputName: c.name,
      type: c.type,
    })),
    steps,
    sources: { revenue_facts: { kind: "lakehouse", schema: "analytics", table: "revenue_facts" } },
  } as PrepFlowConfig;
}

const ai = (over: Partial<Extract<PrepStep, { kind: "ai" }>>): PrepStep => ({
  id: "a1",
  kind: "ai",
  name: "zone",
  fn: "ai_classify",
  column: "region",
  detail: "americas, emea, apac",
  maxWords: null,
  model: "",
  ...over,
});

describe("the AI column step, as a step", () => {
  it("is offered, starts as a classify of the first text column, and labels itself by its output", () => {
    expect(PREP_STEP_KINDS.map((k) => k.kind)).toContain("ai");
    const s = makeStep("ai", cols);
    expect(s.kind).toBe("ai");
    if (s.kind !== "ai") return;
    expect(s.fn).toBe("ai_classify");
    expect(s.column).toBe("region");
    expect(prepStepLabel(s)).toBe("AI column: ai_label");
  });

  it("adds a text column, or a boolean one for a judgement", () => {
    const text = effectiveOutputColumns(flow([ai({})]));
    expect(text.find((c) => c.name === "zone")).toEqual({ name: "zone", type: "text" });
    const bool = effectiveOutputColumns(flow([ai({ fn: "ai_filter", detail: "is a company" })]));
    expect(bool.find((c) => c.name === "zone")).toEqual({ name: "zone", type: "boolean" });
  });
});

describe("what it compiles to", () => {
  it("classify, extract, translate and filter pass the column and the detail as a literal", () => {
    const sql = buildPrepSql(flow([ai({})]), { dialect: "duckdb" });
    expect(sql).toContain(`ai_classify("region", 'americas, emea, apac') AS "zone"`);
    const f = buildPrepSql(flow([ai({ fn: "ai_filter", detail: "it's a company" })]), {
      dialect: "duckdb",
    });
    // A quote in the detail is doubled, never left to break the statement.
    expect(f).toContain(`ai_filter("region", 'it''s a company') AS "zone"`);
  });

  it("sentiment takes only the column; summarize adds the word limit when set", () => {
    expect(
      buildPrepSql(flow([ai({ fn: "ai_sentiment", detail: "ignored" })]), { dialect: "duckdb" }),
    ).toContain(`ai_sentiment("region") AS "zone"`);
    expect(
      buildPrepSql(flow([ai({ fn: "ai_summarize", maxWords: 12 })]), { dialect: "duckdb" }),
    ).toContain(`ai_summarize("region", 12) AS "zone"`);
    expect(
      buildPrepSql(flow([ai({ fn: "ai_summarize", maxWords: null })]), { dialect: "duckdb" }),
    ).toContain(`ai_summarize("region") AS "zone"`);
  });

  it("a free prompt becomes a concat of literals and the named columns", () => {
    const sql = buildPrepSql(
      flow([ai({ fn: "ai_complete", detail: "Tagline for the {plan} plan in {region}" })]),
      { dialect: "duckdb" },
    );
    expect(sql).toContain(
      `ai_complete(concat('Tagline for the ', coalesce(CAST("plan" AS VARCHAR), ''), ' plan in ', coalesce(CAST("region" AS VARCHAR), ''))) AS "zone"`,
    );
    // No placeholder: a plain literal prompt.
    expect(
      buildPrepSql(flow([ai({ fn: "ai_complete", detail: "Say hi" })]), { dialect: "duckdb" }),
    ).toContain(`ai_complete('Say hi') AS "zone"`);
  });

  it("the model, when named, is the last argument", () => {
    const sql = buildPrepSql(flow([ai({ model: " openrouter/openai/gpt-4o-mini " })]), {
      dialect: "duckdb",
    });
    expect(sql).toContain(
      `ai_classify("region", 'americas, emea, apac', 'openrouter/openai/gpt-4o-mini') AS "zone"`,
    );
  });

  it("refuses every engine but DuckDB before a query is sent", () => {
    expect(() => buildPrepSql(flow([ai({})]))).toThrow(/DuckDB engine/);
    expect(() => buildPrepSql(flow([ai({})]), { dialect: "postgres" })).toThrow(
      /cannot be pushed down/,
    );
  });
});

describe("what it refuses, and what it allows", () => {
  it("needs an output name, a column it can see, and the detail its function takes", () => {
    expect(validatePrepConfig(flow([ai({ name: " " })]))).toEqual({
      ok: false,
      error: "Step 1: name the AI column.",
    });
    expect(validatePrepConfig(flow([ai({ name: "region" })]))).toMatchObject({ ok: false });
    expect(validatePrepConfig(flow([ai({ column: "nope" })]))).toEqual({
      ok: false,
      error: 'Step 1: column "nope" is not available here.',
    });
    expect(validatePrepConfig(flow([ai({ detail: "" })]))).toEqual({
      ok: false,
      error: "Step 1: labels (comma-separated) required.",
    });
    expect(validatePrepConfig(flow([ai({ fn: "ai_summarize", maxWords: 0 })]))).toEqual({
      ok: false,
      error: "Step 1: the word limit must be a positive number.",
    });
    expect(validatePrepConfig(flow([ai({ fn: "ai_sentiment", detail: "" })]))).toEqual({
      ok: true,
    });
  });

  it("a prompt must name columns that exist", () => {
    expect(
      validatePrepConfig(flow([ai({ fn: "ai_complete", detail: "Hello {customer}" })])),
    ).toEqual({ ok: false, error: 'Step 1: column "customer" is not available here.' });
    expect(validatePrepConfig(flow([ai({ fn: "ai_complete", detail: "Hello {plan}" })]))).toEqual({
      ok: true,
    });
    expect(validatePrepConfig(flow([ai({ fn: "ai_complete", detail: "  " })]))).toEqual({
      ok: false,
      error: "Step 1: write the prompt; {column} inserts a value.",
    });
  });

  it("never folds into a warehouse, but keeps incremental refresh", () => {
    expect(foldEligibility(flow([ai({})]), "postgres")).toEqual({
      foldable: false,
      stepIndex: 0,
      reason: "An AI column runs on the platform's model channel, not in the warehouse.",
    });
    const cfg = { ...flow([ai({})]), incremental: { column: "placed_at" } } as PrepFlowConfig;
    expect(incrementalEligibility(cfg).ok).toBe(true);
  });
});

describe("the engines answer it as the user", () => {
  it("the local DuckDB engine registers ai_* for the caller and the prep runner names them", () => {
    const duck = rd("src/utils/data/duckdb.server.ts");
    expect(duck).toContain("aiUserId?: string;");
    expect(duck.replace(/\s+/g, " ")).toContain(
      'import("@/utils/aiSql/run.server") ).runWithAiSql(connection, opts.aiUserId!, safeSql, execute,',
    );
    expect(duck).toContain('auditVia: "local_engine"');
    expect(rd("src/utils/data/localEngine.server.ts")).toContain("aiUserId: opts.aiUserId,");
    expect(rd("src/utils/bi/prep.server.ts")).toContain(
      "runLocalSqlDuckDB(sql, tables, { aiUserId: userId })",
    );
  });

  it("the prep tab offers the step with its own editor, and the docs list it", () => {
    const tab = rd("src/components/bi/DataPrepTab.tsx");
    expect(tab).toContain("ai: Sparkles,");
    expect(tab).toContain('{step.kind === "ai" && <AiStepEditor');
    expect(rd("src/routes/docs.data-prep.tsx")).toContain("AI column");
    expect(rd("src/routes/docs.ai-sql.tsx")).toContain('<H2 id="prep">In Data Prep</H2>');
  });
});
