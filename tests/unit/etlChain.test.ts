// Chaining beyond pipelines: what a pipeline's success starts, how the two
// columns are read, and that the finaliser and the editor read them the same
// way.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  chainTargetsOf,
  describeChain,
  hasChainTargets,
  validateChainTargets,
} from "@/lib/etlChain";

const rd = (p: string) => readFileSync(resolve(p), "utf8");

describe("chainTargetsOf — three states for models, one for schedules", () => {
  it("null builds nothing, an empty list builds everything, names build those", () => {
    expect(chainTargetsOf({ chain_sql_models: null, chain_ml_schedules: [] })).toEqual({
      sqlModels: null,
      mlSchedules: [],
    });
    expect(chainTargetsOf({ chain_sql_models: [], chain_ml_schedules: [] }).sqlModels).toEqual([]);
    expect(
      chainTargetsOf({ chain_sql_models: ["fct_orders", "dim_customer"], chain_ml_schedules: [] })
        .sqlModels,
    ).toEqual(["fct_orders", "dim_customer"]);
  });

  it("tolerates a row with neither column, and dedupes what it is given", () => {
    expect(chainTargetsOf({})).toEqual({ sqlModels: null, mlSchedules: [] });
    expect(
      chainTargetsOf({ chain_sql_models: [" a ", "a", ""], chain_ml_schedules: ["x", "x"] }),
    ).toEqual({ sqlModels: ["a"], mlSchedules: ["x"] });
  });

  it("hasChainTargets is true for 'every model' even though the list is empty", () => {
    expect(hasChainTargets({ sqlModels: null, mlSchedules: [] })).toBe(false);
    expect(hasChainTargets({ sqlModels: [], mlSchedules: [] })).toBe(true);
    expect(hasChainTargets({ sqlModels: null, mlSchedules: ["s"] })).toBe(true);
  });
});

describe("validateChainTargets — only what the owner has", () => {
  const known = { modelNames: ["stg", "fct"], scheduleIds: ["s1"] };
  it("accepts the owner's own models and schedules, and 'everything'", () => {
    expect(validateChainTargets({ sqlModels: ["fct"], mlSchedules: ["s1"] }, known)).toBeNull();
    expect(validateChainTargets({ sqlModels: [], mlSchedules: [] }, known)).toBeNull();
    expect(validateChainTargets({ sqlModels: null, mlSchedules: [] }, known)).toBeNull();
  });
  it("names the model that does not exist", () => {
    expect(validateChainTargets({ sqlModels: ["fct", "mart"], mlSchedules: [] }, known)).toMatch(
      /No SQL model named "mart"/,
    );
  });
  it("refuses a schedule that is not the owner's", () => {
    expect(validateChainTargets({ sqlModels: null, mlSchedules: ["s9"] }, known)).toMatch(
      /ML schedules no longer exists, or is not yours/,
    );
  });
});

describe("describeChain — the sentence on the pipeline card", () => {
  it("says what will happen, in words", () => {
    expect(describeChain({ sqlModels: null, mlSchedules: [] })).toBeNull();
    expect(describeChain({ sqlModels: [], mlSchedules: [] })).toBe("then builds every SQL model");
    expect(describeChain({ sqlModels: ["a"], mlSchedules: ["s"] })).toBe(
      "then builds 1 SQL model and runs 1 ML schedule",
    );
    expect(describeChain({ sqlModels: ["a", "b"], mlSchedules: ["s", "t"] })).toBe(
      "then builds 2 SQL models and runs 2 ML schedules",
    );
  });
});

describe("the finaliser, the save path and the editor agree", () => {
  it("a succeeded run builds the models and runs the schedules, as the owner, marked 'chain'", () => {
    const svc = rd("src/utils/etl/service.server.ts");
    expect(svc).toContain("chainTargetsOf(pipeline)");
    expect(svc).toContain('trigger: "chain"');
    expect(svc).toContain('runMlSchedule(s, "chain")');
    // The chain runs only from the success path, after the terminal claim.
    expect(svc.indexOf("chainTargetsOf(pipeline)")).toBeGreaterThan(
      svc.indexOf('.update({ status: "succeeded"'),
    );
  });

  it("the save path validates against the owner's models and schedules", () => {
    const fns = rd("src/utils/etl.functions.ts");
    expect(fns).toContain("validateChainTargets(");
    expect(fns).toContain("chain_sql_models: z.array(z.string().trim().min(1).max(63))");
    expect(fns).toContain("chain_ml_schedules: z.array(z.string().uuid())");
  });

  it("the run list accepts the new trigger", () => {
    expect(rd("src/utils/sqlModels/run.server.ts")).toContain(
      '"manual" | "schedule" | "api" | "chain"',
    );
    expect(rd("supabase/migrations/20260882000000_etl_chain_targets.sql")).toContain(
      "CHECK (trigger IN ('manual', 'schedule', 'api', 'chain'))",
    );
  });

  it("the editor saves both columns and shows the chain on the card", () => {
    const ui = rd("src/routes/_authenticated/etl.tsx");
    expect(ui).toContain("chain_sql_models: p.chain_sql_models");
    expect(ui).toContain("chain_ml_schedules: p.chain_ml_schedules");
    expect(ui).toContain("describeChain(");
  });
});
