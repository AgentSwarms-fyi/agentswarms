// Lineage for an analyst step. The risk here is not that the panel shows too
// little — it is that it ASSERTS something false: a table the query never
// opened, a governed model vouching for SQL a human rewrote, or a fact table
// named as the source when a rollup answered instead.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  describeLineage,
  sourceTablesFrom,
  stepLineage,
  type StepLineage,
} from "@/lib/analystLineage";
import type { AnalystStep } from "@/lib/aiAnalyst";

const step = (over: Partial<AnalystStep> = {}): AnalystStep => ({
  goal: "Total by region",
  sql: "SELECT region, SUM(amount) FROM orders GROUP BY region",
  status: "done",
  ...over,
});

describe("tables a query actually reads", () => {
  it("finds the plain ones, including across a join and a schema prefix", () => {
    expect(
      sourceTablesFrom("SELECT 1 FROM orders o JOIN customers c ON c.id = o.customer_id"),
    ).toEqual(["orders", "customers"]);
    expect(sourceTablesFrom("SELECT 1 FROM sales.orders")).toEqual(["sales.orders"]);
  });

  it("does NOT report a table named only in a comment", () => {
    // The panel makes an assertion, so a false positive is a false statement.
    // The extraction itself is pinned in tests/unit/sqlRefs.test.ts, which the
    // catalog, the audit and the object-store planner also depend on.
    const sql = "SELECT 1 FROM orders -- was: from legacy_orders\n";
    expect(sourceTablesFrom(sql)).toEqual(["orders"]);
  });

  it("does NOT report a table named only inside a block comment", () => {
    const sql = "SELECT 1 /* from archived_orders */ FROM orders";
    expect(sourceTablesFrom(sql)).toEqual(["orders"]);
  });

  it("does NOT report a table named only inside a string literal", () => {
    const sql = "SELECT 1 FROM orders WHERE note = 'imported from stripe_charges'";
    expect(sourceTablesFrom(sql)).toEqual(["orders"]);
  });

  it("drops CTE names — they are computed here, not read from storage", () => {
    const sql = "WITH t AS (SELECT 1 FROM orders) SELECT * FROM t";
    expect(sourceTablesFrom(sql)).toEqual(["orders"]);
  });

  it("keeps a real table that a CTE also selects from", () => {
    const sql =
      "WITH regional AS (SELECT * FROM orders) SELECT * FROM regional JOIN customers ON 1=1";
    expect(sourceTablesFrom(sql)).toEqual(["orders", "customers"]);
  });

  it("descends into a subquery rather than reporting the paren as a table", () => {
    expect(sourceTablesFrom("SELECT * FROM (SELECT 1 FROM orders) AS x")).toEqual(["orders"]);
  });

  it("names a table once however many times the query reads it", () => {
    // A table read in both the outer query and a subquery is one source, not
    // two. Listing it twice reads as two different inputs to the answer.
    const sql = "SELECT * FROM orders WHERE id IN (SELECT id FROM orders WHERE amount > 0)";
    expect(sourceTablesFrom(sql)).toEqual(["orders"]);
  });

  it("survives SQL with nothing to find", () => {
    expect(sourceTablesFrom("")).toEqual([]);
    expect(sourceTablesFrom("SELECT 1")).toEqual([]);
  });
});

describe("what the panel is willing to claim", () => {
  it("calls a governed step compiled, and names the model", () => {
    const l = stepLineage(step({ governed: { model: "sales_model" } }));
    expect(l.basis).toBe("compiled");
    expect(l.model).toBe("sales_model");
  });

  it("calls an ungoverned step written, with no model named", () => {
    const l = stepLineage(step());
    expect(l.basis).toBe("written");
    expect(l.model).toBeUndefined();
  });

  it("REFUSES to credit a governed model for SQL a human rewrote", () => {
    // The page clears `governed` on edit, but lineage must not depend on
    // another module's discipline to avoid making a false claim.
    const l = stepLineage(step({ governed: { model: "sales_model" }, edited: true }));
    expect(l.basis).toBe("written");
    expect(l.model).toBeUndefined();
    expect(l.edited).toBe(true);
  });

  it("says a rollup answered, since the fact table was not read", () => {
    const l = stepLineage(
      step({
        sql: "SELECT region, total FROM orders_daily_rollup",
        governed: { model: "sales_model", rollup: "orders_daily_rollup" },
      }),
    );
    expect(l.rollup).toBe("orders_daily_rollup");
    // The reported table is the one in the SQL, not the model's fact table.
    expect(l.origins.map((o) => o.table)).toEqual(["orders_daily_rollup"]);
    expect(describeLineage(l)).toContain("not the fact table");
  });

  it("carries the viewer's row filters and column masks", () => {
    const l = stepLineage(step({ governed: { model: "m", accessNote: "Rows limited to EMEA." } }));
    expect(describeLineage(l)).toContain("Rows limited to EMEA.");
  });

  it("reports no tables for a step that never ran SQL", () => {
    const l = stepLineage(step({ sql: undefined }));
    expect(l.origins).toEqual([]);
    expect(describeLineage(l)).toBe("");
  });
});

describe("upstream evidence", () => {
  it("names the inputs a prep flow combined to build the table", () => {
    const index = new Map([
      ["name:revenue_prepared", { usedBy: [], derivedFrom: ["Orders", "Customers"] }],
    ]);
    const l = stepLineage(step({ sql: "SELECT 1 FROM revenue_prepared" }), {
      lineageIndex: index,
    });
    expect(l.origins[0].derivedFrom).toEqual(["orders", "customers"]);
  });

  it("reads warehouse lineage by the trailing two segments, as the catalog does", () => {
    const edges = [
      {
        upstream_fqn: "main.raw.orders_raw",
        downstream_fqn: "main.sales.orders",
        upstream_column: null,
        downstream_column: null,
      },
    ];
    const l = stepLineage(step({ sql: "SELECT 1 FROM sales.orders" }), { catalogEdges: edges });
    expect(l.origins[0].upstream).toEqual(["main.raw.orders_raw"]);
  });

  it("does not invent upstream where the catalog records none", () => {
    const l = stepLineage(step(), { catalogEdges: [], lineageIndex: new Map() });
    expect(l.origins[0].derivedFrom).toEqual([]);
    expect(l.origins[0].upstream).toEqual([]);
  });
});

describe("the sentence", () => {
  it("says nothing when there is nothing to say", () => {
    const empty: StepLineage = { basis: "written", edited: false, origins: [] };
    expect(describeLineage(empty)).toBe("");
  });

  it("warns that hand-edited SQL has no governed backing", () => {
    const l = stepLineage(step({ edited: true }));
    expect(describeLineage(l)).toContain("edited by hand");
  });
});

describe("the wiring", () => {
  const page = readFileSync("src/routes/_authenticated/ai-analyst.tsx", "utf8");
  // Anchored at the panel's own comment, not at the summary text: `onToggle`
  // lives on the <details> element ABOVE the summary, so slicing from the
  // summary produced an empty string and the toggle assertion below proved
  // nothing about where the loader is called.
  const panel = page.slice(page.indexOf("{/* Where the numbers came from."));
  const body = panel.slice(0, panel.indexOf("</details>"));

  it("is anchored on something that actually exists", () => {
    expect(page).toContain("{/* Where the numbers came from.");
    expect(body.length).toBeGreaterThan(200);
  });

  it("builds the lineage from the STEP, with the loaded upstream evidence", () => {
    expect(body).toContain("stepLineage(s, {");
    expect(body).toContain("lineageIndex: upstream.index ?? undefined");
    expect(body).toContain("catalogEdges: upstream.edges ?? undefined");
  });

  it("loads the upstream evidence only when a reader opens the panel", () => {
    // Scoped to the toggle handler: `upstream.ensure` appearing anywhere in
    // the file would also match an eager call on mount, which is the thing
    // this lazy load exists to avoid.
    const toggle = body.slice(body.indexOf("onToggle"), body.indexOf("</summary>"));
    expect(toggle).toContain("upstream.ensure()");
    expect(page).not.toContain("void ensureLineage()");
  });

  it("keeps a failed lookup distinct from an empty one", () => {
    // "Nothing upstream" is a claim about the catalog. Only a successful read
    // supports it, so the failure branch must exist and come first.
    expect(body).toContain("upstream.failed ?");
    expect(body).toContain("Could not check for upstream sources.");
    expect(body.indexOf("upstream.failed ?")).toBeLessThan(
      body.indexOf("No prep flow or warehouse lineage"),
    );
  });

  it("hands the panel the real loader state rather than a placeholder", () => {
    const call = page.slice(page.indexOf("upstream={{"));
    const props = call.slice(0, call.indexOf("}}"));
    expect(props).toContain("index: lineageIndex");
    expect(props).toContain("edges: catalogEdges");
    expect(props).toContain("failed: lineageFailed");
    expect(props).toContain("ensure: ensureLineage");
  });
});
