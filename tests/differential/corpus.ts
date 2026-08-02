// The query corpus the engines are compared on.
//
// Shapes are drawn from what the app actually generates and what the LLM
// actually writes: the BI analyst's SELECT/GROUP BY/ORDER BY, the prep
// compiler's joins and aggregates, and the ad-hoc questions users type into
// the workbench. Nothing here is exotic for the sake of it — every entry
// exists because something in the product emits that shape.
//
// SECURITY NOTE: this corpus is synthetic on purpose. Real statements from
// `sql_query_history` may embed customer identifiers and business logic, so
// they are never committed. `npm run test:corpus` can extend a LOCAL run from
// that table; it is not part of CI and writes nothing back.

export type CorpusEntry = {
  id: string;
  sql: string;
  /** True when the statement has an ORDER BY and row order is meaningful. */
  ordered?: boolean;
  /** Why this shape is in the corpus. */
  note: string;
};

export const CORPUS: CorpusEntry[] = [
  // ── Projection ───────────────────────────────────────────────────────
  { id: "select-star", sql: "SELECT * FROM orders", note: "the simplest thing a user types" },
  { id: "select-cols", sql: "SELECT id, region, amount FROM orders", note: "explicit projection" },
  {
    id: "select-alias",
    sql: "SELECT region AS r, amount AS amount_value FROM orders",
    note: "aliases — the BI builder always aliases",
  },

  // ── Filtering ────────────────────────────────────────────────────────
  { id: "where-eq", sql: "SELECT id FROM orders WHERE region = 'EMEA'", note: "equality" },
  {
    id: "where-neq",
    sql: "SELECT id FROM orders WHERE region != 'EMEA'",
    note: "inequality vs NULL rows",
  },
  { id: "where-num", sql: "SELECT id FROM orders WHERE amount > 100", note: "numeric comparison" },
  { id: "where-zero", sql: "SELECT id FROM orders WHERE amount = 0", note: "zero is not NULL" },
  { id: "where-neg", sql: "SELECT id FROM orders WHERE amount < 0", note: "negatives" },
  {
    id: "where-null",
    sql: "SELECT id FROM orders WHERE region IS NULL",
    note: "NULL vs empty string",
  },
  { id: "where-notnull", sql: "SELECT id FROM orders WHERE amount IS NOT NULL", note: "NOT NULL" },
  {
    id: "where-and",
    sql: "SELECT id FROM orders WHERE region = 'EMEA' AND amount > 100",
    note: "AND",
  },
  {
    id: "where-or",
    sql: "SELECT id FROM orders WHERE region = 'EMEA' OR region = 'APAC'",
    note: "OR",
  },
  {
    id: "where-in",
    sql: "SELECT id FROM orders WHERE region IN ('EMEA', 'AMER')",
    note: "IN list",
  },
  { id: "where-like", sql: "SELECT id FROM orders WHERE region LIKE 'A%'", note: "LIKE prefix" },
  {
    id: "where-between",
    sql: "SELECT id FROM orders WHERE amount BETWEEN 50 AND 300",
    note: "BETWEEN is inclusive",
  },
  {
    id: "where-date-range",
    sql: "SELECT id FROM orders WHERE day >= '2026-03-01' AND day < '2026-05-01'",
    note: "date-as-text range — how every dashboard filter compiles",
  },
  { id: "where-unicode", sql: "SELECT id FROM orders WHERE region = 'Zürich'", note: "non-ASCII" },

  // ── Aggregation ──────────────────────────────────────────────────────
  { id: "count-star", sql: "SELECT COUNT(*) AS n FROM orders", note: "COUNT(*) counts rows" },
  {
    id: "count-col",
    sql: "SELECT COUNT(amount) AS n FROM orders",
    note: "COUNT(col) must skip NULLs",
  },
  { id: "sum", sql: "SELECT SUM(amount) AS sum_amount FROM orders", note: "SUM ignoring NULL" },
  {
    id: "avg",
    sql: "SELECT AVG(amount) AS avg_amount FROM orders",
    note: "AVG denominator excludes NULL",
  },
  {
    id: "min-max",
    sql: "SELECT MIN(amount) AS lo, MAX(amount) AS hi FROM orders",
    note: "MIN/MAX",
  },
  {
    id: "group-by",
    sql: "SELECT region, SUM(amount) AS sum_amount FROM orders GROUP BY region",
    note: "the single most common BI shape",
  },
  {
    id: "group-by-count",
    sql: "SELECT region, COUNT(*) AS n FROM orders GROUP BY region",
    note: "grouping with NULL and empty-string keys",
  },
  {
    id: "group-order-limit",
    sql: "SELECT region, SUM(amount) AS sum_amount FROM orders GROUP BY region ORDER BY sum_amount DESC LIMIT 3",
    note: "top-N — what every 'top customers' question compiles to",
    ordered: true,
  },
  {
    id: "group-two-keys",
    sql: "SELECT region, customer_id, COUNT(*) AS n FROM orders GROUP BY region, customer_id",
    note: "multi-key grouping",
  },

  // ── Ordering & paging ────────────────────────────────────────────────
  {
    id: "order-asc",
    sql: "SELECT id, amount FROM orders ORDER BY amount ASC",
    ordered: true,
    note: "ASC with NULLs",
  },
  {
    id: "order-desc",
    sql: "SELECT id, amount FROM orders ORDER BY amount DESC",
    ordered: true,
    note: "DESC with NULLs",
  },
  {
    id: "order-text",
    sql: "SELECT id, region FROM orders ORDER BY region ASC",
    ordered: true,
    note: "text collation",
  },
  { id: "limit", sql: "SELECT id FROM orders ORDER BY id LIMIT 3", ordered: true, note: "LIMIT" },
  {
    id: "limit-offset",
    sql: "SELECT id FROM orders ORDER BY id LIMIT 3 OFFSET 2",
    ordered: true,
    note: "paging",
  },

  // ── Joins ────────────────────────────────────────────────────────────
  {
    id: "inner-join",
    sql: "SELECT o.id, c.name FROM orders o INNER JOIN customers c ON o.customer_id = c.id",
    note: "INNER JOIN drops the unmatched customer_id 99",
  },
  {
    id: "join-group",
    sql: "SELECT c.tier, SUM(o.amount) AS sum_amount FROM orders o INNER JOIN customers c ON o.customer_id = c.id GROUP BY c.tier",
    note: "join then aggregate — the prep compiler's output shape",
  },

  // ── Type looseness ───────────────────────────────────────────────────
  {
    id: "numeric-strings",
    sql: "SELECT SUM(n) AS sum_n FROM loose",
    note: "numbers stored as strings — a pre-coercion CSV",
  },
  {
    id: "numeric-string-compare",
    sql: "SELECT k FROM loose WHERE n > 5",
    note: "string/number comparison, the classic silent-wrongness case",
  },

  // ── Window functions and CTEs ────────────────────────────────────────
  //
  // THE CORPUS HAD NONE OF THESE, AND THAT IS WHY A DIVERGENCE SHIPPED. The
  // engines disagree here more than anywhere else, and worse, AlaSQL accepts
  // the syntax and returns a DIFFERENT ANSWER rather than refusing — the exact
  // silent-wrongness this suite exists to surface. Found by running the
  // NL-to-SQL reference queries on both engines, not by this harness, which
  // could not see a shape it never ran.
  //
  // These matter because local datasets execute in two places: the workbench
  // and the BI "Ask AI" turn run in the BROWSER on AlaSQL, while scheduled
  // refreshes, prep flows, the semantic runner and the agents' sql_query tool
  // run on the SERVER. "Share of total" is a question a BI tool is asked
  // constantly.
  {
    id: "window-share-of-total",
    sql: "SELECT region, SUM(amount) * 100.0 / SUM(SUM(amount)) OVER () AS pct FROM orders GROUP BY region",
    note: "share of a grand total — an aggregate inside a window over the groups",
  },
  {
    id: "window-row-number-partition",
    sql:
      "WITH ranked AS (SELECT region, customer_id, SUM(amount) AS amt, " +
      "ROW_NUMBER() OVER (PARTITION BY region ORDER BY SUM(amount) DESC) AS rn " +
      "FROM orders GROUP BY region, customer_id) " +
      "SELECT region, customer_id, amt FROM ranked WHERE rn = 1",
    note: "top-N-per-group, the canonical window question",
  },
  {
    id: "window-running-total",
    sql:
      "WITH per_day AS (SELECT day, SUM(amount) AS amt FROM orders GROUP BY day) " +
      "SELECT day, SUM(amt) OVER (ORDER BY day) AS cumulative FROM per_day",
    ordered: true,
    note: "ordered running total over an aggregate",
  },
  {
    id: "window-rank",
    sql: "SELECT region, RANK() OVER (ORDER BY amount DESC) AS rnk FROM orders",
    ordered: true,
    note: "RANK() — a named window function rather than an aggregate OVER ()",
  },
  {
    id: "cte-self-reference",
    sql:
      "WITH per_region AS (SELECT region, SUM(amount) AS amt FROM orders GROUP BY region) " +
      "SELECT region, amt FROM per_region WHERE amt > (SELECT AVG(amt) FROM per_region)",
    note: "a CTE referenced twice — once in FROM and once in a subquery",
  },
];

/** Statements that must be REFUSED. A relaxation here is a security bug. */
export const REJECT_CORPUS: { id: string; sql: string; note: string }[] = [
  { id: "insert", sql: "INSERT INTO orders (id) VALUES (99)", note: "write" },
  { id: "update", sql: "UPDATE orders SET amount = 0", note: "write" },
  { id: "delete", sql: "DELETE FROM orders", note: "write" },
  { id: "drop", sql: "DROP TABLE orders", note: "DDL" },
  { id: "create", sql: "CREATE TABLE evil (id int)", note: "DDL" },
  { id: "truncate", sql: "TRUNCATE TABLE orders", note: "DDL" },
];
