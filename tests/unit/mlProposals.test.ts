// A model proposed in chat (R527): the shape an agent may propose, the check
// against the table's real columns, and the words the inbox shows.
import { describe, expect, it } from "vitest";

import {
  checkAgainstColumns,
  defaultModelName,
  describeProposal,
  isNumericType,
  isTemporalType,
  ML_TRAIN_ACTION,
  parseProposal,
  parseTableRef,
  proposalFromPayload,
  type MlTrainProposal,
} from "@/lib/mlProposals";

const COLUMNS = [
  { name: "order_id", type: "BIGINT" },
  { name: "Region", type: "VARCHAR" },
  { name: "placed_at", type: "DATE" },
  { name: "net_usd", type: "DECIMAL(18,2)" },
  { name: "churned", type: "BOOLEAN" },
  { name: "score", type: "DOUBLE" },
  { name: "wait", type: "INTERVAL" },
];

const ok = (raw: unknown): MlTrainProposal => {
  const r = parseProposal(raw);
  if (!r.ok) throw new Error(r.error);
  return r.proposal;
};
const err = (raw: unknown): string => {
  const r = parseProposal(raw);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};
const checked = (p: MlTrainProposal) => checkAgainstColumns(p, COLUMNS);

describe("the table an agent names", () => {
  it("reads schema.table, quoted parts, or a source object", () => {
    expect(parseTableRef("analytics.orders")).toEqual({
      kind: "lakehouse",
      schema: "analytics",
      table: "orders",
    });
    expect(parseTableRef('"my schema"."Orders 2024"')).toEqual({
      kind: "lakehouse",
      schema: "my schema",
      table: "Orders 2024",
    });
    expect(parseTableRef({ kind: "lakehouse", schema: "a", table: "b" })?.table).toBe("b");
  });

  it("refuses anything that is not one table", () => {
    for (const v of ["orders", "a.b.c", ".orders", "", null, 7, { schema: "a" }]) {
      expect(parseTableRef(v)).toBeNull();
    }
  });
});

describe("the shape of a proposal", () => {
  it("names the task, the table and, where the task predicts, the target", () => {
    expect(err({ table: "a.b" })).toContain("The task must be one of");
    expect(err({ task: "classification", table: "orders" })).toContain("schema.table");
    expect(err({ task: "regression", table: "a.b" })).toBe("Say which column to predict.");
    expect(err({ task: "forecast", table: "a.b", target_column: "net_usd" })).toContain(
      "date or time column",
    );
    expect(err({ task: "recommendation", table: "a.b", user_column: "customer_id" })).toContain(
      "a user column and an item column",
    );
  });

  it("keeps each field only for the task that uses it", () => {
    const p = ok({
      task: "clustering",
      table: "a.b",
      target_column: "net_usd",
      time_column: "placed_at",
      horizon: 6,
      n_clusters: 4,
    });
    expect(p.target_column).toBeUndefined();
    expect(p.time_column).toBeUndefined();
    expect(p.horizon).toBeUndefined();
    expect(p.n_clusters).toBe(4);
  });

  it("bounds the numbers", () => {
    const base = { task: "forecast", table: "a.b", target_column: "x", time_column: "t" };
    expect(err({ ...base, horizon: 0 })).toContain("1 to 1000");
    expect(err({ ...base, horizon: 2.5 })).toContain("1 to 1000");
    expect(ok({ ...base, horizon: "6" }).horizon).toBe(6);
    expect(err({ ...base, period: "fortnight" })).toContain("The period must be one of");
    expect(err({ task: "clustering", table: "a.b", n_clusters: 1 })).toContain("2 to 50");
  });

  it("makes a name from what the model does when none is given", () => {
    expect(ok({ task: "classification", table: "a.orders", target_column: "churned" }).name).toBe(
      "churned from orders",
    );
    expect(
      ok({ task: "forecast", table: "a.b", target_column: "net_usd", time_column: "t" }).name,
    ).toBe("net_usd forecast");
    expect(
      defaultModelName({
        task: "recommendation",
        source: { kind: "lakehouse", schema: "a", table: "b" },
        user_column: "customer_id",
        item_column: "sku",
      }),
    ).toBe("sku for each customer_id");
    expect(ok({ task: "anomaly", table: "a.orders", name: "  Odd orders " }).name).toBe(
      "Odd orders",
    );
  });

  it("takes no prose from the agent: only names and the task", () => {
    const p = ok({
      task: "anomaly",
      table: "a.orders",
      why: "the user said their card 4111 1111 was charged twice",
      description: "anything",
    }) as Record<string, unknown>;
    expect(p.why).toBeUndefined();
    expect(p.description).toBeUndefined();
    expect(JSON.stringify(describeProposal(p as MlTrainProposal))).not.toContain("4111");
  });
});

describe("against the table's real columns", () => {
  it("keeps the table's spelling of each name", () => {
    const r = checked(
      ok({
        task: "forecast",
        table: "analytics.revenue_facts",
        target_column: "NET_USD",
        time_column: "Placed_At",
        series_column: "region",
      }),
    );
    expect(r.ok && r.proposal).toMatchObject({
      target_column: "net_usd",
      time_column: "placed_at",
      series_column: "Region",
    });
  });

  it("names the table's columns when a name is wrong, so the agent can correct it", () => {
    const r = checked(ok({ task: "classification", table: "analytics.t", target_column: "churn" }));
    expect(!r.ok && r.error).toContain('analytics.t has no column "churn". Its columns: order_id');
    expect(!r.ok && r.error).toContain("churned (BOOLEAN)");
  });

  it("asks each column to be the kind its role needs", () => {
    const reg = checked(ok({ task: "regression", table: "a.b", target_column: "Region" }));
    expect(!reg.ok && reg.error).toContain("use classification to predict a category");
    expect(!reg.ok && reg.error).toContain("net_usd (DECIMAL(18,2))");
    const time = checked(
      ok({ task: "forecast", table: "a.b", target_column: "net_usd", time_column: "Region" }),
    );
    expect(!time.ok && time.error).toContain(
      "not a date or time. Date and time columns: placed_at",
    );
    const cls = checked(ok({ task: "classification", table: "a.b", target_column: "placed_at" }));
    expect(!cls.ok && cls.error).toContain("a date is not a class");
    const series = checked(
      ok({
        task: "forecast",
        table: "a.b",
        target_column: "net_usd",
        time_column: "placed_at",
        series_column: "score",
      }),
    );
    expect(!series.ok && series.error).toContain("needs a category");
    const same = checked(
      ok({
        task: "forecast",
        table: "a.b",
        target_column: "net_usd",
        time_column: "placed_at",
        series_column: "net_usd",
      }),
    );
    expect(!same.ok && same.error).toContain("already the target");
  });

  it("drops the target and its roles from the features, and refuses features that are only those", () => {
    const r = checked(
      ok({
        task: "classification",
        table: "a.b",
        target_column: "churned",
        feature_columns: ["churned", "net_usd", "NET_USD", "region"],
      }),
    );
    expect(r.ok && r.proposal.feature_columns).toEqual(["net_usd", "Region"]);
    const none = checked(
      ok({
        task: "classification",
        table: "a.b",
        target_column: "churned",
        feature_columns: ["churned"],
      }),
    );
    expect(!none.ok && none.error).toContain(
      "Leave feature_columns out to read every other column",
    );
  });

  it("tells numbers and dates by the engine's type names", () => {
    for (const t of ["BIGINT", "INTEGER", "UBIGINT", "HUGEINT", "DOUBLE", "DECIMAL(18,2)", "FLOAT"])
      expect(isNumericType(t), t).toBe(true);
    for (const t of ["INTERVAL", "VARCHAR", "BOOLEAN", "DATE"])
      expect(isNumericType(t), t).toBe(false);
    for (const t of ["DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE"])
      expect(isTemporalType(t), t).toBe(true);
    expect(isTemporalType("TIME")).toBe(false);
  });
});

describe("what the inbox and the chat say", () => {
  it("says what approving does, per task, from names only", () => {
    const f = describeProposal({
      name: "Revenue by region",
      task: "forecast",
      source: { kind: "lakehouse", schema: "analytics", table: "revenue_facts" },
      target_column: "net_usd",
      time_column: "placed_at",
      period: "week",
      horizon: 6,
      series_column: "region",
    });
    expect(f.title).toBe('Train "Revenue by region": forecast net_usd per week');
    expect(f.lines).toEqual([
      "From analytics.revenue_facts.",
      "Along placed_at, 6 weeks ahead.",
      "One forecast per region, beside the total.",
      "Approving makes the model yours and starts training within the platform's limits; rejecting makes nothing.",
    ]);
    const c = describeProposal({
      name: "Churn",
      task: "classification",
      source: { kind: "lakehouse", schema: "crm", table: "customers" },
      target_column: "churned",
      feature_columns: ["tenure", "plan"],
    });
    expect(c.title).toBe('Train "Churn": predict churned');
    expect(c.lines).toContain("Reading 2 columns: tenure, plan.");
    expect(
      describeProposal({
        name: "Groups",
        task: "clustering",
        source: { kind: "lakehouse", schema: "a", table: "b" },
      }).lines,
    ).toContain("The number of groups is found from the data.");
  });

  it("reads a proposal back from the approval it was filed in", () => {
    const p = ok({ task: "regression", table: "a.b", target_column: "net_usd", name: "Net" });
    expect(proposalFromPayload({ proposal: p, link: "/ml" })).toEqual(p);
    expect(proposalFromPayload({ target: { id: "x" } })).toBeNull();
    expect(proposalFromPayload(null)).toBeNull();
    expect(ML_TRAIN_ACTION).toBe("ml.train");
  });
});
