// A batch prediction written over a table it did not make.
//
// FOUND IN R104, from R101's sweep. The sandbox writes the scored rows with
// CREATE OR REPLACE TABLE <output>, and starting a batch asked only whether
// the output schema was yours. Driven: `CREATE TABLE analytics.r104_keep AS
// SELECT 104 AS id, 'not a prediction' AS note` → ML → "revenue_facts plan
// classifier" → Predictions → Batch prediction ("Scores every row of a
// lakehouse table and writes a new table you own") → input
// analytics.revenue_facts, output analytics.r104_keep → Predict. The job
// succeeded with 836 rows, and a query for `note` then failed: "Referenced
// column "note" not found", with `net_usd, order_id, proba_enterprise, …` in
// its place.
//
// Run here with the catalog, the prediction history and the sandbox start
// faked, so the test sees whether a job would have started.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  tableExists: false,
  existsThrows: null as string | null,
  prior: [] as { id: string }[],
  priorErr: null as { message: string } | null,
  filters: [] as [string, unknown][],
  started: 0,
};

// Which tables Sheets holds has its own suite (lakehouseSheetGuard.test.ts);
// here none is, unless a test says so.
const held = { why: null as string | null, asked: [] as unknown[] };
vi.mock("@/utils/sheets/owned.server", () => ({
  sheetOwnedRefusal: async (tables: unknown[]) => {
    held.asked.push(...tables);
    return held.why;
  },
}));

vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/rateLimit.server", () => ({
  envInt: () => 0,
  rateLimitedGlobal: async () => false,
}));
vi.mock("@/utils/requestMeta.server", () => ({
  clientIp: () => null,
  clientUserAgent: () => null,
}));
vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getPlatformResources: async () => ({ mlPredictMaxRows: 1_000_000 }),
}));
vi.mock("@/utils/ml/train.server", () => ({ startTrainingJob: async () => ({ ok: true }) }));
vi.mock("@/utils/ml/predict.server", () => ({
  ML_EXPLAIN_BATCH_MAX_ROWS: 10_000,
  ML_ROWS_PREDICT_CAP: 1_000,
  startPrediction: async () => {
    state.started++;
    return { ok: true, predictionId: "p-1" };
  },
}));
vi.mock("@/utils/lakehouse/core.server", () => ({
  accessibleSchemas: async () => [
    { name: "analytics", user_id: "owner", lake_source_id: null, iceberg_catalog_id: null },
  ],
  lakehouseTableExists: async () => {
    if (state.existsThrows) throw new Error(state.existsThrows);
    return state.tableExists;
  },
  runLakehouseStatement: async () => ({ rows: [[836]], columns: [] }),
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const chain = () => {
    const b: any = {
      select: () => b,
      eq: (col: string, v: unknown) => {
        state.filters.push([col, v]);
        return b;
      },
      limit: async () => ({ data: state.prior, error: state.priorErr }),
      update: () => ({ eq: async () => ({ error: null }) }),
    };
    return b;
  };
  return { supabaseAdmin: { from: () => chain() } };
});

const { startBatchPrediction } = await import("@/utils/ml/api.server");

const run = (over: Partial<{ output: { schema: string; table: string }; where: string }> = {}) =>
  startBatchPrediction({
    userId: "owner",
    model: { id: "m-1" } as never,
    version: { id: "v-1" } as never,
    input: { schema: "analytics", table: "revenue_facts", where: over.where },
    output: over.output ?? { schema: "analytics", table: "r104_keep" },
    via: "ui",
  });

beforeEach(() => {
  state.tableExists = false;
  state.existsThrows = null;
  state.prior = [];
  state.priorErr = null;
  state.filters = [];
  state.started = 0;
  held.why = null;
  held.asked = [];
});

describe("a table a Sheets table sheet holds (R128)", () => {
  it("is refused before anything else, even where an earlier prediction wrote it", async () => {
    // What a daily schedule allows (R104), after the table was dropped and
    // the name taken by an upload.
    state.tableExists = true;
    state.prior = [{ id: "p-0" }];
    held.why = 'analytics.r104_keep holds the rows of the sheet "Orders"';
    const res = await run();
    expect(res).toEqual({ ok: false, error: held.why });
    expect(held.asked).toEqual([{ schema: "analytics", table: "r104_keep" }]);
    expect(state.filters).not.toContainEqual(["status", "succeeded"]);
    expect(state.started).toBe(0);
  });
});

describe("a table no prediction wrote is not replaced", () => {
  it("refuses, naming the table and why", async () => {
    // The whole bug: this started, and the table became predictions.
    state.tableExists = true;
    const res = await run();
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(
      /analytics\.r104_keep already exists, and no prediction of yours wrote it/,
    );
    expect(state.started).toBe(0);
  });

  it("asks the history about this user's SUCCEEDED writes to this exact table", async () => {
    state.tableExists = true;
    await run();
    expect(state.filters).toEqual(
      expect.arrayContaining([
        ["user_id", "owner"],
        ["status", "succeeded"],
        ["output->>schema", "analytics"],
        ["output->>table", "r104_keep"],
      ]),
    );
  });

  it("refuses when it cannot tell what wrote the table", async () => {
    state.tableExists = true;
    state.priorErr = { message: "connection reset" };
    const res = await run();
    expect((res as { error: string }).error).toMatch(
      /Could not check what wrote analytics\.r104_keep/,
    );
    expect(state.started).toBe(0);
  });

  it("refuses when it cannot tell whether the table exists", async () => {
    state.existsThrows = "engine unreachable";
    const res = await run();
    expect((res as { error: string }).error).toMatch(
      /Could not check whether analytics\.r104_keep is free/,
    );
    expect(state.started).toBe(0);
  });
});

describe("the table being scored is never the output", () => {
  it("refuses, and says a filter would cut it down", async () => {
    const res = await run({
      output: { schema: "analytics", table: "revenue_facts" },
      where: "region = 'EMEA'",
    });
    expect((res as { error: string }).error).toMatch(
      /analytics\.revenue_facts is the table being scored\. Writing the predictions there would replace it with only the rows the filter keeps/,
    );
    expect(state.started).toBe(0);
  });

  it("compares without case", async () => {
    // The schema must match an owned schema exactly, so only the table name
    // can differ in case here; DuckDB would resolve it to the same table.
    const res = await run({ output: { schema: "analytics", table: "Revenue_Facts" } });
    expect((res as { error: string }).error).toMatch(/is the table being scored/);
    expect(state.started).toBe(0);
  });
});

describe("what batch scoring is for still works", () => {
  it("scores into a free name", async () => {
    const res = await run();
    expect(res).toEqual({ ok: true, predictionId: "p-1" });
    expect(state.started).toBe(1);
  });

  it("scores again into a table an earlier prediction of yours wrote", async () => {
    // A daily schedule writing its own output each morning.
    state.tableExists = true;
    state.prior = [{ id: "earlier" }];
    const res = await run();
    expect(res).toEqual({ ok: true, predictionId: "p-1" });
    expect(state.started).toBe(1);
  });
});
