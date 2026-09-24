// A training set built over a table it did not make.
//
// FOUND IN R105, from R101's sweep. The build is CREATE OR REPLACE TABLE
// <output>, and nothing asked what was at the name. Driven: a feature view
// `r105_features` (analytics.revenue_facts, key order_id, latest by
// placed_at), a scratch `analytics.r105_keep` holding `105 | not a training
// set`, a 20-row label table `analytics.r105_labels` → Training set → Label
// table r105_labels, As of label_at, key order_id, Write to r105_keep →
// Build. The toast read "Built analytics.r105_keep — 20 row(s)".
//
// Run here with the catalog, the audit trail and the engine faked, so the
// test sees whether the replacing statement would be sent.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  tableExists: false,
  existsThrows: null as string | null,
  prior: [] as { id: string }[],
  priorErr: null as { message: string } | null,
  filters: [] as [string, unknown][],
  statements: [] as string[],
};

vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/featureViews/lookup.server", () => ({
  describeViewTable: async () => ({ ok: true, columns: [] }),
}));
vi.mock("@/utils/lakehouse/core.server", () => ({
  lakehouseTableExists: async () => {
    if (state.existsThrows) throw new Error(state.existsThrows);
    return state.tableExists;
  },
  runLakehouseStatement: async (_u: string, sql: string) => {
    state.statements.push(sql);
    return { rows: [[20]], columns: [] };
  },
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const b: any = {
    select: () => b,
    eq: (col: string, v: unknown) => {
      state.filters.push([col, v]);
      return b;
    },
    limit: async () => ({ data: state.prior, error: state.priorErr }),
  };
  return { supabaseAdmin: { from: () => b } };
});

const { buildTrainingSet } = await import("@/utils/featureViews/trainingSet.server");

const VIEW = {
  id: "fv-1",
  name: "r105_features",
  schema_name: "analytics",
  table_name: "revenue_facts",
  key_columns: ["order_id"],
  feature_columns: ["net_usd", "plan"],
  timestamp_column: "placed_at",
};
const SPINE = {
  schema_name: "analytics",
  table_name: "r105_labels",
  timestamp_column: "label_at",
  key_columns: ["order_id"],
  where: null,
};

const build = (output = { schema: "analytics", table: "r105_keep" }) =>
  buildTrainingSet({ userId: "owner", view: VIEW, spine: SPINE, output, measureLeak: false });

const replaced = () => state.statements.some((s) => s.startsWith("CREATE OR REPLACE TABLE"));

beforeEach(() => {
  state.tableExists = false;
  state.existsThrows = null;
  state.prior = [];
  state.priorErr = null;
  state.filters = [];
  state.statements = [];
});

describe("a table no training set wrote is not replaced", () => {
  it("refuses, naming the table and why", async () => {
    // The whole bug: this built, and the table became the training set.
    state.tableExists = true;
    const res = await build();
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(
      /analytics\.r105_keep already exists, and no training set of yours wrote it/,
    );
    expect(replaced()).toBe(false);
  });

  it("asks the audit trail about this user's training sets written to this table", async () => {
    state.tableExists = true;
    await build();
    expect(state.filters).toEqual(
      expect.arrayContaining([
        ["user_id", "owner"],
        ["action", "feature_view.training_set"],
        ["detail->>output", "analytics.r105_keep"],
      ]),
    );
  });

  it("refuses when it cannot tell what wrote the table", async () => {
    state.tableExists = true;
    state.priorErr = { message: "connection reset" };
    const res = await build();
    expect((res as { error: string }).error).toMatch(/Could not check what wrote/);
    expect(replaced()).toBe(false);
  });

  it("refuses when it cannot tell whether the table exists", async () => {
    state.existsThrows = "engine unreachable";
    const res = await build();
    expect((res as { error: string }).error).toMatch(/Could not check whether .* is free/);
    expect(replaced()).toBe(false);
  });
});

describe("the tables the build reads are never its output", () => {
  it("refuses the label table", async () => {
    const res = await build({ schema: "analytics", table: "R105_Labels" });
    expect((res as { error: string }).error).toMatch(/is the label table/);
    expect(replaced()).toBe(false);
  });

  it("refuses the feature view's own table", async () => {
    const res = await build({ schema: "analytics", table: "revenue_facts" });
    expect((res as { error: string }).error).toMatch(/is the table this feature view reads/);
    expect(replaced()).toBe(false);
  });
});

describe("what a training set is for still works", () => {
  it("builds into a free name", async () => {
    const res = await build();
    expect(res).toMatchObject({ ok: true });
    expect(replaced()).toBe(true);
  });

  it("rebuilds into a table an earlier training set of yours wrote", async () => {
    state.tableExists = true;
    state.prior = [{ id: "earlier" }];
    const res = await build();
    expect(res).toMatchObject({ ok: true });
    expect(replaced()).toBe(true);
  });
});
