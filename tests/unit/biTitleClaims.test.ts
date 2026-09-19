// A widget's title is a claim, and claims get checked.
//
// Three instances, all from one generator, all found by looking at a
// dashboard rather than at code:
//
//   "Top 5 Products by Sales"    → SQL carried no LIMIT → 14 bars
//   "Top 10 Customers by Sales"  → bar race caps at 12  → 12 rows
//   "Revenue by Region"          → SQL ended LIMIT 1    → one bar
//
// The third is why this is a separate check from the numeric verifier rather
// than a note on the insight card. That card's every figure verified against
// the widget's data and every sentence was false — "AMER accounts for 100% of
// the total revenue", "there are no other regions contributing" — because the
// query had already discarded the other regions. Nothing that reads the prose
// can catch it. Only something that reads the title against the query can.
import { describe, expect, it, vi } from "vitest";

import {
  parseTitleClaim,
  reconcileTitle,
  reconcileWidgetResult,
  stripTrailingLimit,
  withLimit,
} from "@/lib/biTitleClaims";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ k: `r${i}`, v: n - i }));

describe("the number a title promises", () => {
  it("reads the real titles that failed", () => {
    expect(parseTitleClaim("Top 5 Products by Sales")).toEqual({ kind: "top", n: 5 });
    expect(parseTitleClaim("Top 10 Customers by Sales")).toEqual({ kind: "top", n: 10 });
    expect(parseTitleClaim("Revenue by Region")).toBeNull();
  });

  it("reads the other direction, and the synonyms", () => {
    expect(parseTitleClaim("Bottom 3 regions by margin")).toEqual({ kind: "bottom", n: 3 });
    expect(parseTitleClaim("lowest 5 performers")).toEqual({ kind: "bottom", n: 5 });
    expect(parseTitleClaim("Highest 20 accounts")).toEqual({ kind: "top", n: 20 });
  });

  it("treats a title with no number as promising no number", () => {
    // "Top Products by Revenue" is a description, not a countable promise, and
    // forcing a count onto it would invent a claim nobody made.
    expect(parseTitleClaim("Top Products by Revenue")).toBeNull();
    expect(parseTitleClaim("Sales by Region")).toBeNull();
    expect(parseTitleClaim(undefined)).toBeNull();
    expect(parseTitleClaim("Revenue for 2024")).toBeNull();
  });
});

describe("rewriting the query the title implies", () => {
  it("adds a limit, replacing one already there", () => {
    expect(withLimit("SELECT a FROM t ORDER BY a DESC", 5)).toBe(
      "SELECT a FROM t ORDER BY a DESC LIMIT 5",
    );
    expect(withLimit("SELECT a FROM t ORDER BY a DESC LIMIT 12", 10)).toBe(
      "SELECT a FROM t ORDER BY a DESC LIMIT 10",
    );
    expect(withLimit("SELECT a FROM t;", 3)).toBe("SELECT a FROM t LIMIT 3");
  });

  it("strips only a trailing limit, never one inside a subquery", () => {
    expect(stripTrailingLimit("SELECT a FROM t LIMIT 1")).toBe("SELECT a FROM t");
    const nested = "SELECT * FROM (SELECT a FROM t LIMIT 5) x";
    expect(stripTrailingLimit(nested)).toBe(nested);
  });
});

describe("the verdict", () => {
  const ORDERED = "SELECT p, SUM(s) AS t FROM x GROUP BY p ORDER BY t DESC";

  it("truncates a top-N that the query did not limit — the Top 5 finding", () => {
    const v = reconcileTitle({
      title: "Top 5 Products by Sales",
      sql: ORDERED,
      rowCount: 14,
      chartType: "bar",
    });
    expect(v.verdict).toBe("truncate");
    if (v.verdict !== "truncate") throw new Error("unreachable");
    expect(v.n).toBe(5);
    expect(v.sql).toBe(`${ORDERED} LIMIT 5`);
    expect(v.note).toBe("Showing the top 5 of 14.");
  });

  it("refuses to truncate an unordered result", () => {
    // The first five rows of an unsorted query are an arbitrary five, which is
    // a different lie from the one being repaired.
    const v = reconcileTitle({
      title: "Top 5 Products",
      sql: "SELECT p, SUM(s) AS t FROM x GROUP BY p",
      rowCount: 14,
      chartType: "bar",
    });
    expect(v.verdict).toBe("ok");
  });

  it("widens a category chart whose query kept one row — the LIMIT 1 finding", () => {
    const capped =
      "SELECT region, SUM(revenue) AS total_revenue FROM analytics.bi_demo_sales " +
      "GROUP BY region ORDER BY total_revenue DESC NULLS LAST LIMIT 1";
    const v = reconcileTitle({
      title: "Revenue by Region",
      sql: capped,
      rowCount: 1,
      chartType: "bar",
    });
    expect(v.verdict).toBe("widen");
    if (v.verdict !== "widen") throw new Error("unreachable");
    expect(v.sql).not.toMatch(/limit/i);
    expect(v.sql).toContain("GROUP BY region");
  });

  it("leaves a KPI alone, which legitimately has one row", () => {
    const v = reconcileTitle({
      title: "Total Revenue",
      sql: "SELECT SUM(revenue) AS total FROM t LIMIT 1",
      rowCount: 1,
      chartType: "kpi",
    });
    expect(v.verdict).toBe("ok");
  });

  it("leaves a single-value widget alone even when it grouped to get there", () => {
    // "Best performing region" is a legitimate one-row answer from a GROUP BY
    // with a LIMIT 1. Widening it would turn a KPI into a bar chart nobody
    // asked for — which is why the widen rule is scoped to CATEGORY charts.
    // Mutation-checked: without that scope, the earlier KPI case still passed
    // because its SQL had no GROUP BY, so it never exercised the condition.
    const v = reconcileTitle({
      title: "Best performing region",
      sql: "SELECT region, SUM(v) AS t FROM x GROUP BY region ORDER BY t DESC LIMIT 1",
      rowCount: 1,
      chartType: "kpi",
    });
    expect(v.verdict).toBe("ok");
  });

  it("leaves a one-row result alone when the query never grouped", () => {
    const v = reconcileTitle({
      title: "Revenue by Region",
      sql: "SELECT region, revenue FROM t LIMIT 1",
      rowCount: 1,
      chartType: "bar",
    });
    expect(v.verdict).toBe("ok");
  });

  it("says so when the data cannot meet the promise", () => {
    const v = reconcileTitle({
      title: "Top 10 Customers",
      sql: ORDERED,
      rowCount: 4,
      chartType: "bar",
    });
    expect(v.verdict).toBe("short");
    if (v.verdict !== "short") throw new Error("unreachable");
    expect(v.note).toBe("The data has 4 rows, not 10.");
  });

  it("is silent when title and query already agree", () => {
    expect(
      reconcileTitle({ title: "Top 5 Products", sql: `${ORDERED} LIMIT 5`, rowCount: 5 }).verdict,
    ).toBe("ok");
    expect(reconcileTitle({ title: "Revenue by Region", rowCount: 3 }).verdict).toBe("ok");
  });
});

describe("a title that names an N the query capped itself below", () => {
  // Driven from the UI, on the seeded 36-month lakehouse table. The generator
  // wrote this, verbatim, under the title "Top 5 Months by Revenue":
  //
  //   SELECT month FROM analytics.bi_demo_sales
  //   GROUP BY month ORDER BY SUM(revenue) DESC LIMIT 1
  //
  // and the widget rendered "Top 5 Months by Revenue — The data has 1 row, not
  // 5." The data has thirty-six. The note was a false statement about the
  // reader's table, produced by the guard that exists to prevent exactly that,
  // because `widen` sat behind a branch that a numbered title could not reach.
  const CAPPED = "SELECT month FROM t GROUP BY month ORDER BY SUM(revenue) DESC LIMIT 1";

  it("widens to the promised N instead of calling the table short", () => {
    const v = reconcileTitle({
      title: "Top 5 Months by Revenue",
      sql: CAPPED,
      rowCount: 1,
      chartType: "bar",
    });
    expect(v.verdict).toBe("widen");
    if (v.verdict !== "widen") throw new Error("unreachable");
    expect(v.sql).toBe("SELECT month FROM t GROUP BY month ORDER BY SUM(revenue) DESC LIMIT 5");
    expect(v.n).toBe(5);
    // What the reader is told if the re-run cannot happen: the QUERY stopped.
    expect(v.note).toContain("This query stopped at 1 row");
    expect(v.note).not.toContain("The data has");
  });

  it("still calls a genuinely short table short", () => {
    // No LIMIT, so the four rows ARE the data and the old note is the true one.
    const v = reconcileTitle({
      title: "Top 10 Customers",
      sql: "SELECT c, SUM(s) AS t FROM x GROUP BY c ORDER BY t DESC",
      rowCount: 4,
      chartType: "bar",
    });
    expect(v.verdict).toBe("short");
    if (v.verdict !== "short") throw new Error("unreachable");
    expect(v.note).toBe("The data has 4 rows, not 10.");
  });

  it("calls it short when the query stopped BELOW its own limit", () => {
    // The limit has to sit under the claim for this to be the interesting
    // case: asking for 5 and getting 3 means the table held 3, so widening to
    // 10 would find nothing more and the note about the DATA is the true one.
    const v = reconcileTitle({
      title: "Top 10 Plans",
      sql: "SELECT p, SUM(s) AS t FROM x GROUP BY p ORDER BY t DESC LIMIT 5",
      rowCount: 3,
      chartType: "bar",
    });
    expect(v.verdict).toBe("short");
    if (v.verdict !== "short") throw new Error("unreachable");
    expect(v.note).toBe("The data has 3 rows, not 10.");
  });

  it("will not re-run an unordered query, but stops saying the data is short", () => {
    // Re-running without an ORDER BY returns more arbitrary rows, not the top
    // five — the same objection that stops truncate slicing one. The verdict
    // stays short because nothing can be repaired; the NOTE still has to be
    // true, and the truth is that the query stopped, not that the table did.
    const v = reconcileTitle({
      title: "Top 5 Months by Revenue",
      sql: "SELECT month FROM t GROUP BY month LIMIT 1",
      rowCount: 1,
      chartType: "bar",
    });
    expect(v.verdict).toBe("short");
    if (v.verdict !== "short") throw new Error("unreachable");
    expect(v.note).toContain("This query stopped at 1 row");
  });

  it("re-queries with the promised N and drops the note when it is met", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: rows(5) });
    const out = await reconcileWidgetResult({
      title: "Top 5 Months by Revenue",
      sql: CAPPED,
      chartType: "bar",
      rows: rows(1),
      execute,
    });
    expect(execute).toHaveBeenCalledWith(
      "SELECT month FROM t GROUP BY month ORDER BY SUM(revenue) DESC LIMIT 5",
    );
    expect(out.rows).toHaveLength(5);
    expect(out.changed).toBe("widened");
    expect(out.note).toBeUndefined();
  });

  it("checks the WIDENED result against the title too", async () => {
    // Lift the LIMIT and the table turns out to hold three. Now "short" is a
    // fact about the data, so the reader gets the count — and it is the count
    // from the widened query, not the one the LIMIT was hiding behind.
    const out = await reconcileWidgetResult({
      title: "Top 5 Months by Revenue",
      sql: CAPPED,
      chartType: "bar",
      rows: rows(1),
      execute: () => Promise.resolve({ rows: rows(3) }),
    });
    expect(out.rows).toHaveLength(3);
    expect(out.changed).toBe("widened");
    expect(out.note).toBe("The data has 3 rows, not 5.");
  });

  it("says the query stopped when the re-run cannot be made", async () => {
    const out = await reconcileWidgetResult({
      title: "Top 5 Months by Revenue",
      sql: CAPPED,
      chartType: "bar",
      rows: rows(1),
    });
    expect(out.changed).toBe("none");
    expect(out.rows).toHaveLength(1);
    expect(out.note).toContain("This query stopped at 1 row");
  });

  it("says the same when the re-run fails or comes back empty", async () => {
    const failed = await reconcileWidgetResult({
      title: "Top 5 Months by Revenue",
      sql: CAPPED,
      chartType: "bar",
      rows: rows(1),
      execute: () => Promise.reject(new Error("warehouse down")),
    });
    expect(failed.changed).toBe("none");
    expect(failed.note).toContain("This query stopped at 1 row");

    const empty = await reconcileWidgetResult({
      title: "Top 5 Months by Revenue",
      sql: CAPPED,
      chartType: "bar",
      rows: rows(1),
      execute: () => Promise.resolve({ rows: [] }),
    });
    expect(empty.changed).toBe("none");
    expect(empty.rows).toHaveLength(1);
    expect(empty.note).toContain("This query stopped at 1 row");
  });
});

describe("applying the verdict", () => {
  const ORDERED = "SELECT p, SUM(s) AS t FROM x GROUP BY p ORDER BY t DESC";

  it("slices to the promised N without going back to the database", () => {
    const execute = vi.fn();
    return reconcileWidgetResult({
      title: "Top 5 Products by Sales",
      sql: ORDERED,
      chartType: "bar",
      rows: rows(14),
      execute,
    }).then((out) => {
      expect(out.rows).toHaveLength(5);
      // Already in the query's own order, so slicing IS what LIMIT 5 returns.
      expect(execute).not.toHaveBeenCalled();
      expect(out.sql).toBe(`${ORDERED} LIMIT 5`);
      expect(out.changed).toBe("truncated");
      expect(out.note).toContain("top 5 of 14");
    });
  });

  it("re-queries to widen, and keeps the widened rows", async () => {
    const capped = "SELECT r, SUM(v) AS t FROM x GROUP BY r ORDER BY t DESC LIMIT 1";
    const execute = vi.fn().mockResolvedValue({ rows: rows(3) });
    const out = await reconcileWidgetResult({
      title: "Revenue by Region",
      sql: capped,
      chartType: "bar",
      rows: rows(1),
      execute,
    });
    expect(execute).toHaveBeenCalledWith("SELECT r, SUM(v) AS t FROM x GROUP BY r ORDER BY t DESC");
    expect(out.rows).toHaveLength(3);
    expect(out.changed).toBe("widened");
    expect(out.sql).not.toMatch(/limit/i);
  });

  it("keeps the original rather than breaking the widget when the re-query fails", async () => {
    const capped = "SELECT r, SUM(v) AS t FROM x GROUP BY r ORDER BY t DESC LIMIT 1";
    const out = await reconcileWidgetResult({
      title: "Revenue by Region",
      sql: capped,
      chartType: "bar",
      rows: rows(1),
      execute: () => Promise.reject(new Error("warehouse down")),
    });
    expect(out.rows).toHaveLength(1);
    expect(out.changed).toBe("none");
    // A widget that renders beats a hole in the dashboard — as long as it does
    // not claim more than it has.
    expect(out.note).toContain("other categories were not fetched");
  });

  it("keeps the original rows when widening comes back empty", async () => {
    // An empty widened result is not a wider view, it is no view. Replacing a
    // rendering widget with nothing is a worse outcome than a narrow one.
    const capped = "SELECT r, SUM(v) AS t FROM x GROUP BY r ORDER BY t DESC LIMIT 1";
    const out = await reconcileWidgetResult({
      title: "Revenue by Region",
      sql: capped,
      chartType: "bar",
      rows: rows(1),
      execute: () => Promise.resolve({ rows: [] }),
    });
    expect(out.rows).toHaveLength(1);
    expect(out.changed).toBe("none");
    expect(out.sql).toBe(capped);
  });

  it("does not widen when the caller gave it no way to query", async () => {
    const out = await reconcileWidgetResult({
      title: "Revenue by Region",
      sql: "SELECT r, SUM(v) FROM x GROUP BY r LIMIT 1",
      chartType: "bar",
      rows: rows(1),
    });
    expect(out.changed).toBe("none");
  });

  it("passes an honest widget through untouched", async () => {
    const out = await reconcileWidgetResult({
      title: "Revenue by Region",
      sql: "SELECT r, SUM(v) AS t FROM x GROUP BY r",
      chartType: "bar",
      rows: rows(3),
    });
    expect(out.changed).toBe("none");
    expect(out.note).toBeUndefined();
    expect(out.rows).toHaveLength(3);
  });
});

describe("where the check is spent", () => {
  it("runs in both generators, and the race gets its N", async () => {
    const fs = await import("node:fs");
    for (const f of [
      "src/components/bi/GenerateDashboardDialog.tsx",
      "src/components/bi/GenerateReportDialog.tsx",
    ]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).toContain("reconcileWidgetResult({");
      // The result has to be used, not merely computed — three mutants have
      // survived a green suite in this codebase by severing exactly that.
      expect(src, f).toMatch(/if \(fixed\.changed !== "none" && turn\.result\)/);
      expect(src, f).toContain("turn.sql = fixed.sql;");
    }
    const dash = fs.readFileSync("src/components/bi/GenerateDashboardDialog.tsx", "utf8");
    // The note has to be applied WITH the final title, not before it. The
    // generator ends by assigning `picks[i].title || widget.title`, so a note
    // written earlier is silently overwritten — which is what shipped, and
    // what driving the dashboard caught. Assert the order, not the presence.
    const assignsFinal = dash.indexOf("const base = picks[i].title || widget.title;");
    const appliesNote = dash.indexOf("fixed.note ? `${base}");
    expect(assignsFinal).toBeGreaterThan(-1);
    expect(appliesNote).toBeGreaterThan(assignsFinal);
    expect(dash).not.toMatch(/widget\.title = `\$\{widget\.title\} — \$\{fixed\.note\}`/);
    expect(dash).toMatch(/widget\.chart\.type === "barrace"/);
    expect(dash).toContain("topN: claim.n");
    // And the renderer must actually receive it.
    const render = fs.readFileSync("src/components/bi/BiChartRender.tsx", "utf8");
    expect(render).toContain("topN={chart.topN}");
  });
});
