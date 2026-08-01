// The NL-to-SQL question set.
//
// Each entry pairs a question a real user might type with a REFERENCE query
// that answers it. Grading runs both against the same sample data and compares
// results, so any correct paraphrase of the reference passes (see grade.ts).
//
// Writing a reference query is the discipline that makes this honest: if a
// question cannot be answered unambiguously in SQL, it does not belong here —
// it belongs in a conversation about the product, not in a score.
//
// Categories exist so a regression can be located: a drop concentrated in
// `date` or `ranking` says something very different from a uniform drop.
//
// NOTE ON ALIASES: reference queries avoid `total` and `value`. Both are
// reserved words in AlaSQL — the DEFAULT local engine — so `SUM(Sales) AS
// total` is a parse error there while working fine in DuckDB. That is a real
// product defect, not a quirk of this file: "total" is the most natural alias
// a model will pick for "total sales", and today it fails. The eval scores
// that honestly (the pipeline did fail to answer), but the REFERENCE has to
// run in order to grade anything at all.

export type EvalCategory =
  | "lookup"
  | "filter"
  | "aggregate"
  | "grouping"
  | "ranking"
  | "date"
  | "ratio"
  | "ambiguity";

export type EvalQuestion = {
  id: string;
  /** The dataset(s) this question needs loaded. */
  tables: string[];
  question: string;
  /** A correct answer, used to grade by result equivalence. */
  referenceSql: string;
  category: EvalCategory;
  /** True when the answer is a ranking and row order is part of correctness. */
  ordered?: boolean;
  /** Why this question is here — what it would catch if it broke. */
  note: string;
};

export const QUESTIONS: EvalQuestion[] = [
  // ── Lookup and filtering ─────────────────────────────────────────────
  {
    id: "count-rows",
    tables: ["saas_sales"],
    question: "How many sales records are there?",
    referenceSql: "SELECT COUNT(*) AS n FROM saas_sales",
    category: "lookup",
    note: "The simplest possible question; failing this means something is badly wrong.",
  },
  {
    id: "distinct-regions",
    tables: ["saas_sales"],
    question: "Which regions do we sell in?",
    referenceSql: "SELECT DISTINCT Region FROM saas_sales",
    category: "lookup",
    note: "DISTINCT over a plain column.",
  },
  {
    id: "filter-equals",
    tables: ["saas_sales"],
    question: "How many orders came from the EMEA region?",
    referenceSql: "SELECT COUNT(*) AS n FROM saas_sales WHERE Region = 'EMEA'",
    category: "filter",
    note: "Equality filter on a string the model must read from the schema.",
  },
  {
    id: "filter-numeric",
    tables: ["q3_budget_variance"],
    question: "Which departments are under budget in Q3?",
    referenceSql: "SELECT DISTINCT Department FROM q3_budget_variance WHERE Variance < 0",
    category: "filter",
    note: "Requires understanding that a negative variance means under budget.",
  },
  {
    id: "filter-two-conditions",
    tables: ["ecom_returns"],
    question: "How many returns were refunded in full for a changed mind?",
    referenceSql:
      "SELECT COUNT(*) AS n FROM ecom_returns WHERE return_reason = 'Changed mind' AND disposition = 'Refund-Full'",
    category: "filter",
    note: "Two conditions ANDed; a model that ORs them gets a very different number.",
  },

  // ── Aggregation ──────────────────────────────────────────────────────
  {
    id: "sum-total",
    tables: ["saas_sales"],
    question: "What is our total sales revenue?",
    referenceSql: "SELECT SUM(Sales) AS total_sales FROM saas_sales",
    category: "aggregate",
    note: "The most common analytical question there is.",
  },
  {
    id: "avg",
    tables: ["nba_team_seasons"],
    question: "What is the average points per game across all team seasons?",
    referenceSql: "SELECT AVG(pts_per_game) AS avg_pts FROM nba_team_seasons",
    category: "aggregate",
    note: "AVG, where a model that uses SUM/COUNT(*) instead gets it wrong on NULLs.",
  },
  {
    id: "min-max",
    tables: ["world_health_indicators"],
    question: "What are the lowest and highest life expectancy values recorded?",
    referenceSql:
      "SELECT MIN(life_expectancy) AS lo, MAX(life_expectancy) AS hi FROM world_health_indicators",
    category: "aggregate",
    note: "Two aggregates in one statement.",
  },
  {
    id: "count-distinct",
    tables: ["saas_sales"],
    question: "How many distinct customers do we have?",
    referenceSql: "SELECT COUNT(DISTINCT Customer) AS n FROM saas_sales",
    category: "aggregate",
    note: "COUNT(DISTINCT x) — a model that drops DISTINCT overcounts badly.",
  },

  // ── Grouping ─────────────────────────────────────────────────────────
  {
    id: "group-sum",
    tables: ["saas_sales"],
    question: "What are total sales by region?",
    referenceSql: "SELECT Region, SUM(Sales) AS total_sales FROM saas_sales GROUP BY Region",
    category: "grouping",
    note: "The canonical BI shape.",
  },
  {
    id: "group-count",
    tables: ["ecom_returns"],
    question: "How many returns are there for each return reason?",
    referenceSql: "SELECT return_reason, COUNT(*) AS n FROM ecom_returns GROUP BY return_reason",
    category: "grouping",
    note: "Grouped counts.",
  },
  {
    id: "group-two-keys",
    tables: ["saas_sales"],
    question: "What are total sales by region and segment?",
    referenceSql:
      "SELECT Region, Segment, SUM(Sales) AS total_sales FROM saas_sales GROUP BY Region, Segment",
    category: "grouping",
    note: "Two grouping keys; a model that groups by one silently aggregates away a dimension.",
  },
  {
    id: "group-having",
    tables: ["saas_sales"],
    question: "Which industries have more than 100 orders?",
    referenceSql:
      "SELECT Industry, COUNT(*) AS n FROM saas_sales GROUP BY Industry HAVING COUNT(*) > 100",
    category: "grouping",
    note: "HAVING, not WHERE — filtering on an aggregate.",
  },

  // ── Ranking ──────────────────────────────────────────────────────────
  {
    id: "top-n-customers",
    tables: ["saas_sales"],
    question: "Who are our top 5 customers by total sales?",
    referenceSql:
      "SELECT Customer, SUM(Sales) AS total_sales FROM saas_sales GROUP BY Customer ORDER BY total_sales DESC LIMIT 5",
    category: "ranking",
    ordered: true,
    note: "Group, order and limit together — the single most requested BI question.",
  },
  {
    id: "top-n-products",
    tables: ["saas_sales"],
    question: "What are the three best selling products by revenue?",
    referenceSql:
      "SELECT Product, SUM(Sales) AS total_sales FROM saas_sales GROUP BY Product ORDER BY total_sales DESC LIMIT 3",
    category: "ranking",
    ordered: true,
    note: "Same shape, different phrasing — 'best selling' must resolve to revenue, not count.",
  },
  {
    id: "bottom-n",
    tables: ["nba_team_seasons"],
    question: "Which 5 team seasons had the worst win percentage?",
    referenceSql:
      "SELECT franchise, season, win_pct FROM nba_team_seasons ORDER BY win_pct ASC LIMIT 5",
    category: "ranking",
    ordered: true,
    note: "Ascending order — models default to DESC and get the opposite answer.",
  },
  {
    id: "rank-with-filter",
    tables: ["ecom_returns"],
    question: "Which 5 SKUs have the highest total refunded value for full refunds?",
    referenceSql:
      "SELECT sku, SUM(price_usd) AS total_sales FROM ecom_returns WHERE disposition = 'Refund-Full' " +
      "GROUP BY sku ORDER BY total_sales DESC LIMIT 5",
    category: "ranking",
    ordered: true,
    note: "Filter before grouping, then rank — three operations that must compose.",
  },

  // ── Dates ────────────────────────────────────────────────────────────
  {
    id: "date-year-filter",
    tables: ["world_health_indicators"],
    question: "What was the average life expectancy in 2020?",
    referenceSql:
      "SELECT AVG(life_expectancy) AS avg_le FROM world_health_indicators WHERE year = 2020",
    category: "date",
    note: "A year stored as a number, not a date — the model must not try to parse it.",
  },
  {
    id: "date-range",
    tables: ["ecom_returns"],
    question: "How many returns happened in May 2026?",
    referenceSql:
      "SELECT COUNT(*) AS n FROM ecom_returns WHERE return_date >= '2026-05-01' AND return_date <= '2026-05-31'",
    category: "date",
    note: "Dates are ISO TEXT here; a range comparison is correct, date functions are not.",
  },
  {
    id: "date-group-by-year",
    tables: ["nba_team_seasons"],
    question: "How many team seasons are recorded per season year?",
    referenceSql: "SELECT season, COUNT(*) AS n FROM nba_team_seasons GROUP BY season",
    category: "date",
    note: "Grouping by a time column.",
  },

  // ── Ratios and derived values ────────────────────────────────────────
  {
    id: "ratio-profit-margin",
    tables: ["saas_sales"],
    question: "What is our overall profit margin as a percentage of sales?",
    referenceSql: "SELECT SUM(Profit) / SUM(Sales) * 100 AS margin_pct FROM saas_sales",
    category: "ratio",
    note: "SUM(a)/SUM(b), NOT AVG(a/b) — the classic wrong answer that looks plausible.",
  },
  {
    id: "ratio-by-group",
    tables: ["q3_budget_variance"],
    question: "For each department, what percentage of the Q3 budget was actually spent?",
    referenceSql:
      "SELECT Department, SUM(Q3_Actual) / SUM(Q3_Budget) * 100 AS pct FROM q3_budget_variance GROUP BY Department",
    category: "ratio",
    note: "A ratio of two aggregates, per group.",
  },

  // ── Ambiguity: the model should still produce something runnable ──────
  {
    id: "ambiguous-best-region",
    tables: ["saas_sales"],
    question: "Which region is doing best?",
    referenceSql:
      "SELECT Region, SUM(Sales) AS total_sales FROM saas_sales GROUP BY Region ORDER BY total_sales DESC LIMIT 1",
    category: "ambiguity",
    ordered: true,
    note:
      "'Best' is genuinely ambiguous (revenue? profit? growth?). Revenue is the reasonable " +
      "default; this is scored to notice if that convention drifts, not because there is only " +
      "one defensible answer.",
  },

  // -- Beyond saas_sales ----------------------------------------------------
  // Twelve of the first twenty-four questions ran against one table, so the
  // score largely measured performance on a single schema. These spread the
  // set across the other bundled datasets: different column naming styles,
  // different shapes (time series, incident logs), and domain words a model
  // has to map onto real columns.
  //
  // Reference queries stay within what AlaSQL supports -- no CTEs, window
  // functions or subqueries -- because AlaSQL is still the default engine and
  // a reference that cannot run grades nothing.

  {
    id: "siem-count-critical",
    tables: ["siem_alerts"],
    question: "How many P1 alerts are there?",
    referenceSql: "SELECT COUNT(*) AS n FROM siem_alerts WHERE severity = 'P1'",
    category: "filter",
    note: "A literal that must be matched exactly; 'critical' is not a value in the data.",
  },
  {
    id: "siem-by-severity",
    tables: ["siem_alerts"],
    question: "How many alerts of each severity?",
    referenceSql:
      "SELECT severity, COUNT(*) AS n FROM siem_alerts GROUP BY severity ORDER BY severity",
    category: "grouping",
  },
  {
    id: "siem-open-by-technique",
    tables: ["siem_alerts"],
    question: "Which MITRE techniques have the most alerts that are still NEW?",
    referenceSql:
      "SELECT mitre_technique, COUNT(*) AS n FROM siem_alerts WHERE status = 'NEW' " +
      "GROUP BY mitre_technique ORDER BY n DESC, mitre_technique ASC LIMIT 5",
    category: "ranking",
    ordered: true,
    note: "Filter plus group plus rank -- the combination that failed most often at baseline.",
  },
  {
    id: "siem-distinct-assets",
    tables: ["siem_alerts"],
    question: "How many distinct asset classes appear in the alerts?",
    referenceSql: "SELECT COUNT(DISTINCT asset_class) AS n FROM siem_alerts",
    category: "aggregate",
  },
  {
    id: "siem-benign-share",
    tables: ["siem_alerts"],
    question: "What percentage of alerts were closed as benign?",
    referenceSql:
      "SELECT ROUND(100.0 * SUM(CASE WHEN status = 'BENIGN' THEN 1 ELSE 0 END) / COUNT(*), 2) " +
      "AS pct FROM siem_alerts",
    category: "ratio",
  },

  {
    id: "elec-solar-2020",
    tables: ["global_electricity"],
    question: "Which country generated the most solar power in 2020?",
    referenceSql:
      "SELECT country, solar_twh FROM global_electricity WHERE year = 2020 " +
      "ORDER BY solar_twh DESC LIMIT 1",
    category: "ranking",
    ordered: true,
    note: "A superlative: exactly one row is the right answer, not a ranked list.",
  },
  {
    id: "elec-total-by-year",
    tables: ["global_electricity"],
    question: "What was worldwide total generation each year?",
    referenceSql:
      "SELECT year, SUM(total_twh) AS twh FROM global_electricity GROUP BY year ORDER BY year",
    category: "date",
  },
  {
    id: "elec-renewables-leaders",
    tables: ["global_electricity"],
    question:
      "In 2020, list each country that got more than half its electricity from renewables, " +
      "with its renewables share.",
    referenceSql:
      "SELECT country, renewables_share_pct FROM global_electricity " +
      "WHERE year = 2020 AND renewables_share_pct > 50 ORDER BY country",
    category: "filter",
    note:
      "Names the columns it wants: 'which countries' alone would make a one-column " +
      "answer equally correct, and a question with two right shapes cannot be graded.",
  },
  {
    id: "elec-nuclear-avg",
    tables: ["global_electricity"],
    question: "What is the average nuclear generation per country in 2019?",
    referenceSql:
      "SELECT AVG(nuclear_twh) AS avg_nuclear FROM global_electricity WHERE year = 2019",
    category: "aggregate",
  },
  {
    id: "elec-country-count",
    tables: ["global_electricity"],
    question: "How many countries are covered?",
    referenceSql: "SELECT COUNT(DISTINCT country) AS n FROM global_electricity",
    category: "lookup",
  },

  {
    id: "nba-most-wins",
    tables: ["nba_team_seasons"],
    question: "Which franchise had the most wins in a single season, and in which season?",
    referenceSql: "SELECT franchise, season, wins FROM nba_team_seasons ORDER BY wins DESC LIMIT 1",
    category: "ranking",
    ordered: true,
  },
  {
    id: "nba-winning-seasons",
    tables: ["nba_team_seasons"],
    question: "How many seasons did a team win at least 60 games?",
    referenceSql: "SELECT COUNT(*) AS n FROM nba_team_seasons WHERE wins >= 60",
    category: "filter",
    note: "'At least' must become >=, not >.",
  },
  {
    id: "nba-avg-by-franchise",
    tables: ["nba_team_seasons"],
    question: "What is each franchise's average win percentage?",
    referenceSql:
      "SELECT franchise, AVG(win_pct) AS avg_win_pct FROM nba_team_seasons " +
      "GROUP BY franchise ORDER BY franchise",
    category: "grouping",
  },
  {
    id: "nba-playoff-teams",
    tables: ["nba_team_seasons"],
    question: "How many team-seasons reached the playoffs?",
    referenceSql: "SELECT COUNT(*) AS n FROM nba_team_seasons WHERE playoff_games > 0",
    category: "filter",
    note: "The data has no 'made_playoffs' flag; it must be derived from playoff_games.",
  },

  {
    id: "health-life-expectancy-2019",
    tables: ["world_health_indicators"],
    question: "What was average life expectancy by region in 2019?",
    referenceSql:
      "SELECT region, AVG(life_expectancy) AS avg_life_expectancy FROM world_health_indicators " +
      "WHERE year = 2019 GROUP BY region ORDER BY region",
    category: "grouping",
  },
  {
    id: "health-top-spenders",
    tables: ["world_health_indicators"],
    question: "Which three countries spent the most per capita on health in 2019?",
    referenceSql:
      "SELECT country, health_spend_per_capita_usd FROM world_health_indicators " +
      "WHERE year = 2019 ORDER BY health_spend_per_capita_usd DESC, country ASC LIMIT 3",
    category: "ranking",
    ordered: true,
  },
  {
    id: "health-infant-mortality-worst",
    tables: ["world_health_indicators"],
    question: "Which country had the highest infant mortality in 2019?",
    referenceSql:
      "SELECT country, infant_mortality_per_1k FROM world_health_indicators " +
      "WHERE year = 2019 ORDER BY infant_mortality_per_1k DESC LIMIT 1",
    category: "ranking",
    ordered: true,
  },
  {
    id: "health-physicians-threshold",
    tables: ["world_health_indicators"],
    question: "In 2019, how many countries had fewer than 1 physician per 1000 people?",
    referenceSql:
      "SELECT COUNT(*) AS n FROM world_health_indicators WHERE year = 2019 AND physicians_per_1k < 1",
    category: "filter",
  },

  {
    id: "defects-by-line",
    tables: ["factory_defect_log"],
    question: "How many defects were logged on each production line?",
    referenceSql: "SELECT line, COUNT(*) AS n FROM factory_defect_log GROUP BY line ORDER BY line",
    category: "grouping",
  },
  {
    id: "defects-worst-shift",
    tables: ["factory_defect_log"],
    question: "Which shift has the highest average PPM?",
    referenceSql:
      "SELECT shift, AVG(ppm) AS avg_ppm FROM factory_defect_log GROUP BY shift " +
      "ORDER BY avg_ppm DESC LIMIT 1",
    category: "ranking",
    ordered: true,
  },

  {
    id: "claims-fraud-flagged",
    tables: ["auto_claims_history"],
    question: "How many claims were flagged as fraud?",
    referenceSql: "SELECT COUNT(*) AS n FROM auto_claims_history WHERE fraud_flag = 'Y'",
    category: "filter",
    note: "The flag is a Y/N string, not a boolean -- the literal has to match the data.",
  },
  {
    id: "claims-loss-by-peril",
    tables: ["auto_claims_history"],
    question: "What is the total reported loss by peril?",
    referenceSql:
      "SELECT peril, SUM(reported_loss_usd) AS loss_usd FROM auto_claims_history " +
      "GROUP BY peril ORDER BY loss_usd DESC",
    category: "grouping",
    note: "Aliasing this 'total' would be a parse error in AlaSQL -- see the note at the top.",
  },
];

export const CATEGORIES = [...new Set(QUESTIONS.map((q) => q.category))];
