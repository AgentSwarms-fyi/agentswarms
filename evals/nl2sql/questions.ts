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
// NOTE ON ALIASES: the older reference queries avoid `total` and `value`.
// Both are reserved words in AlaSQL, which USED to be the default engine, so
// `SUM(Sales) AS total` was a parse error there while working fine in DuckDB.
// DuckDB is the default now and `AS total` executes correctly, so newer
// questions do not observe that restriction. The old ones are left as they are
// — rewriting them would change what a score means, and the whole point of
// this file is that a number is only comparable to another number from the
// same question set.
//
// THE ENGINE FLIP CHANGED WHAT CAN BE ASKED, not just what runs. DuckDB has
// window functions, CTEs and correlated subqueries; AlaSQL had none of them.
// A question set written against AlaSQL therefore could not test the top-N-per-
// group, running-total or share-of-total questions that people actually ask a
// BI tool, and its score said nothing about them. The `window` category exists
// to cover that gap rather than leave it flattering.

export type EvalCategory =
  | "lookup"
  | "filter"
  | "aggregate"
  | "grouping"
  | "ranking"
  | "date"
  | "ratio"
  | "ambiguity"
  /** Two or more tables. The set had none of these at all until now. */
  | "join"
  /** Window functions, CTEs, correlated subqueries — impossible under AlaSQL. */
  | "window"
  /**
   * Data that is not tidy: identifiers with leading zeros, a column name with
   * a space, the same status written three ways, blank cells, thousands
   * separators, non-ASCII names.
   *
   * The other fourteen samples are clean, so every score before this one was
   * measured on data no customer has. These questions are answerable — the
   * mess is incidental to the analysis, exactly as it is in a real export —
   * but each has a specific way to get it wrong.
   */
  | "dirty";

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
    question: "Which country had the highest infant mortality in 2019, and what was the rate?",
    referenceSql:
      "SELECT country, infant_mortality_per_1k FROM world_health_indicators " +
      "WHERE year = 2019 ORDER BY infant_mortality_per_1k DESC LIMIT 1",
    category: "ranking",
    ordered: true,
    note:
      "Asks for the rate explicitly. 'Which country had the highest...' alone makes a " +
      "one-column answer equally correct, and a question with two right shapes grades the " +
      "model on a coin toss — the third such question found in this set.",
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

  // ── Joins ────────────────────────────────────────────────────────────────
  // The set had ZERO multi-table questions before these. That is the single
  // biggest thing an execution-accuracy score can be blind to: joining is the
  // most common non-trivial operation in real BI work and the one where a
  // model most often produces something that runs and is wrong — a missing
  // condition silently fans out to a cross product and the totals inflate.
  {
    id: "join-champ-double",
    tables: ["f1_world_champions", "f1_constructor_champions"],
    question:
      "In how many seasons did the drivers' champion drive for the team that won the constructors' championship?",
    referenceSql:
      "SELECT COUNT(*) AS n FROM f1_world_champions d " +
      "JOIN f1_constructor_champions c ON d.season = c.season AND d.team = c.champion",
    category: "join",
    note:
      "Two joined conditions, and the second one compares columns with DIFFERENT names " +
      "(team vs champion) that mean the same thing. Joining on season alone gives 68 " +
      "instead of 56 -- a plausible-looking number, which is what makes it worth scoring.",
  },
  {
    id: "join-champ-mismatch",
    tables: ["f1_world_champions", "f1_constructor_champions"],
    question:
      "List the seasons where the drivers' champion did not drive for the constructors' champion, with both champions named.",
    referenceSql:
      "SELECT d.season, d.champion AS driver_champion, c.champion AS constructor_champion " +
      "FROM f1_world_champions d JOIN f1_constructor_champions c ON d.season = c.season " +
      "WHERE d.team <> c.champion ORDER BY d.season",
    category: "join",
    ordered: true,
    note: "Join plus an inequality filter, returning columns from both sides.",
  },
  {
    id: "join-drivers-of-leader",
    tables: ["f1_driver_standings", "f1_constructor_standings"],
    question: "Which drivers race for the constructor at the top of the standings?",
    referenceSql:
      "SELECT d.driver FROM f1_driver_standings d " +
      "JOIN f1_constructor_standings c ON d.team = c.team " +
      "WHERE c.position = 1 ORDER BY d.position",
    category: "join",
    ordered: true,
    note:
      "The join key is a team NAME shared by both tables, and the filter applies to the " +
      "joined side rather than the selected one.",
  },
  {
    id: "join-health-renewables",
    tables: ["global_electricity", "world_health_indicators"],
    question:
      "What is the average life expectancy in countries where renewables are more than half of electricity generation?",
    referenceSql:
      "SELECT AVG(h.life_expectancy) AS avg_life_expectancy " +
      "FROM global_electricity e JOIN world_health_indicators h " +
      "ON e.country = h.country AND e.year = h.year " +
      "WHERE e.renewables_share_pct > 50",
    category: "join",
    note:
      "A COMPOSITE key: country AND year. Joining on country alone multiplies every " +
      "country by its number of years and quietly skews the average -- it still returns " +
      "a number, so nothing looks broken.",
  },
  {
    id: "join-renewables-by-region",
    tables: ["global_electricity", "world_health_indicators"],
    question: "In 2019, what was the average renewables share by region?",
    referenceSql:
      "SELECT h.region, AVG(e.renewables_share_pct) AS avg_renewables " +
      "FROM global_electricity e JOIN world_health_indicators h " +
      "ON e.country = h.country AND e.year = h.year " +
      "WHERE e.year = 2019 GROUP BY h.region ORDER BY avg_renewables DESC",
    category: "join",
    ordered: true,
    note:
      "The grouping column lives in one table and the measure in the other -- the model " +
      "has to work out that region is only available via the health table.",
  },
  {
    id: "join-big-generators-life",
    tables: ["global_electricity", "world_health_indicators"],
    question:
      "In 2019, what was the average life expectancy of countries that generated more than 500 TWh in total?",
    referenceSql:
      "SELECT AVG(h.life_expectancy) AS avg_life_expectancy " +
      "FROM global_electricity e JOIN world_health_indicators h " +
      "ON e.country = h.country AND e.year = h.year " +
      "WHERE e.year = 2019 AND e.total_twh > 500",
    category: "join",
    note: "Filters on both sides of the join and on the shared year.",
  },
  {
    id: "join-missing-health-record",
    tables: ["global_electricity", "world_health_indicators"],
    question: "Which countries have 2020 electricity data but no health record for that year?",
    referenceSql:
      "SELECT e.country FROM global_electricity e " +
      "LEFT JOIN world_health_indicators h ON e.country = h.country AND e.year = h.year " +
      "WHERE e.year = 2020 AND h.country IS NULL ORDER BY e.country",
    category: "join",
    ordered: true,
    note:
      "An ANTI-JOIN. Reaching for an inner join here returns the exact opposite set, and " +
      "the answer still looks like a tidy list of countries.",
  },

  // ── Window functions, CTEs, correlated subqueries ────────────────────────
  // None of these were expressible under AlaSQL, so no earlier score says
  // anything about them. They are also the shape of question a BI tool gets
  // asked constantly: best per group, share of total, running total.
  {
    id: "window-top-product-per-region",
    tables: ["saas_sales"],
    question: "What is the best-selling product by revenue in each region?",
    referenceSql:
      "WITH ranked AS (SELECT Region, Product, SUM(Sales) AS revenue, " +
      "ROW_NUMBER() OVER (PARTITION BY Region ORDER BY SUM(Sales) DESC) AS rn " +
      "FROM saas_sales GROUP BY Region, Product) " +
      "SELECT Region, Product, revenue FROM ranked WHERE rn = 1 ORDER BY Region",
    category: "window",
    ordered: true,
    note:
      "Top-N-per-group, the canonical window-function question. A plain GROUP BY with " +
      "ORDER BY and LIMIT returns the single best product overall, not one per region.",
  },
  {
    id: "window-share-of-total",
    tables: ["saas_sales"],
    question: "What percentage of total sales does each region account for?",
    referenceSql:
      "SELECT Region, SUM(Sales) * 100.0 / SUM(SUM(Sales)) OVER () AS pct_of_total " +
      "FROM saas_sales GROUP BY Region ORDER BY pct_of_total DESC",
    category: "window",
    ordered: true,
    note:
      "Share of a grand total computed alongside the grouping. Any correct route passes " +
      "-- a subquery for the denominator is equally valid -- but it cannot be done in one " +
      "pass without a window or a subquery.",
  },
  {
    id: "window-running-total",
    tables: ["global_electricity"],
    question: "Show worldwide total generation by year as a running cumulative total.",
    referenceSql:
      "WITH yearly AS (SELECT year, SUM(total_twh) AS gen FROM global_electricity GROUP BY year) " +
      "SELECT year, SUM(gen) OVER (ORDER BY year) AS cumulative FROM yearly ORDER BY year",
    category: "window",
    ordered: true,
    note: "An ordered window over an aggregate -- two levels, and the order is the answer.",
  },
  {
    id: "window-above-average-regions",
    tables: ["saas_sales"],
    question: "Which regions have total sales above the average region's total sales?",
    referenceSql:
      "WITH per_region AS (SELECT Region, SUM(Sales) AS revenue FROM saas_sales GROUP BY Region) " +
      "SELECT Region, revenue FROM per_region " +
      "WHERE revenue > (SELECT AVG(revenue) FROM per_region) ORDER BY revenue DESC",
    category: "window",
    ordered: true,
    note:
      "Compares each group against an aggregate OF the groups, not of the rows. Comparing " +
      "to AVG(Sales) over the raw rows is the tempting misreading and gives a different set.",
  },
  {
    id: "window-biggest-improvement",
    tables: ["nba_team_seasons"],
    question:
      "Which franchise improved its win total the most from one season to the very next season, and by how many wins?",
    referenceSql:
      "SELECT b.franchise, b.wins - a.wins AS improvement FROM nba_team_seasons a " +
      "JOIN nba_team_seasons b ON a.franchise = b.franchise AND b.season = a.season + 1 " +
      "ORDER BY improvement DESC LIMIT 1",
    category: "window",
    ordered: true,
    note:
      "A SELF-JOIN on consecutive seasons (LAG is equally correct). Consecutiveness is the " +
      "trap: comparing each season to the franchise's previous ROW rather than its previous " +
      "YEAR gives a wrong answer wherever a season is missing.",
  },
  {
    id: "window-rank-franchises",
    tables: ["nba_team_seasons"],
    question:
      "Rank franchises by their total playoff wins, highest first, showing the top 5 with their rank.",
    referenceSql:
      "WITH totals AS (SELECT franchise, SUM(playoff_wins) AS pw FROM nba_team_seasons GROUP BY franchise) " +
      "SELECT franchise, pw, RANK() OVER (ORDER BY pw DESC) AS rnk FROM totals ORDER BY pw DESC LIMIT 5",
    category: "window",
    ordered: true,
    note: "An explicit rank column, which is not the same as row position.",
  },

  // ── Ambiguity ────────────────────────────────────────────────────────────
  // There was exactly one of these. They are scored to notice when a
  // convention DRIFTS, not because one answer is the only defensible one --
  // the reference encodes the reading a competent analyst would default to.
  {
    id: "ambiguous-best-customer",
    tables: ["saas_sales"],
    question: "Who is our best customer?",
    referenceSql:
      "SELECT Customer, SUM(Sales) AS revenue FROM saas_sales " +
      "GROUP BY Customer ORDER BY revenue DESC LIMIT 1",
    category: "ambiguity",
    ordered: true,
    note:
      "'Best' could be revenue, profit, or order count. Revenue is the usual default; " +
      "profit is defensible and would score as wrong here, which is the cost of pinning a " +
      "convention and is worth paying to see it move.",
  },
  {
    id: "ambiguous-biggest-security-problem",
    tables: ["siem_alerts"],
    question: "What is our biggest security problem right now?",
    referenceSql:
      "SELECT technique_name, COUNT(*) AS n FROM siem_alerts " +
      "WHERE status NOT IN ('CLOSED', 'BENIGN') GROUP BY technique_name ORDER BY n DESC LIMIT 1",
    category: "ambiguity",
    ordered: true,
    note:
      "'Right now' should narrow to unresolved alerts rather than all history. Tests " +
      "whether the model reads the status column as meaningful instead of ignoring it. " +
      "UNRESOLVED IS NOT status='NEW': the first version of this used that and produced a " +
      "THREE-WAY TIE at 4, so the reference's own answer depended on which row the engine " +
      "sorted first and the question was ungradeable. Excluding CLOSED and BENIGN is both " +
      "the truer reading and gives a unique winner (16 against 13).",
  },
  {
    id: "ambiguous-healthiest-region",
    tables: ["world_health_indicators"],
    question: "Which region is the healthiest?",
    referenceSql:
      "SELECT region, AVG(life_expectancy) AS avg_life_expectancy FROM world_health_indicators " +
      "WHERE year = 2019 GROUP BY region ORDER BY avg_life_expectancy DESC LIMIT 1",
    category: "ambiguity",
    ordered: true,
    note:
      "Two ambiguities at once: which measure means 'healthiest', and which year. " +
      "Averaging every year together is the common mistake and changes the winner.",
  },

  // ── dirty data ────────────────────────────────────────────────────────────
  // messy_orders is the only sample that looks like a real export.
  {
    id: "dirty-status-casing",
    tables: ["messy_orders"],
    question: "How many orders are in each status?",
    referenceSql:
      "SELECT LOWER(Status) AS status, COUNT(*) AS orders FROM messy_orders " +
      "GROUP BY LOWER(Status) ORDER BY orders DESC, status",
    category: "dirty",
    // NOT `ordered`. cancelled and pending both count 3, so the second and
    // third rows are a tie and whichever the engine emits first is arbitrary —
    // the same coin-toss flaw the ambiguity questions already carry. Graded as
    // a SET, which is what the question actually asks for: "how many orders in
    // each status" has no inherent order. The reference keeps its ORDER BY only
    // so its own output is stable to read.
    note:
      "Status is written three ways — Shipped, shipped, SHIPPED. Grouping on the raw " +
      "column returns nine rows instead of three and every count is wrong. Nothing in " +
      "the question hints at it; the schema sample is the only clue.",
  },
  {
    id: "dirty-leading-zero-lookup",
    tables: ["messy_orders"],
    question: "What is the amount for order 00104?",
    referenceSql: `SELECT Amount FROM messy_orders WHERE "Order ID" = '00104'`,
    category: "dirty",
    note:
      "The id is text with leading zeros. Matching it as a number (= 104) finds nothing, " +
      "and the column name needs quoting because of the space.",
  },
  {
    id: "dirty-spaced-column-earliest",
    tables: ["messy_orders"],
    question: "Which order was placed earliest?",
    referenceSql: `SELECT "Order ID", "Order Date" FROM messy_orders ORDER BY "Order Date" LIMIT 1`,
    category: "dirty",
    ordered: true,
    note: "Both columns needed here contain a space; unquoted they are a syntax error.",
  },
  {
    id: "dirty-total-by-region",
    tables: ["messy_orders"],
    question: "What is the total order amount for each region that has one recorded?",
    referenceSql:
      "SELECT Region, SUM(Amount) AS total FROM messy_orders " +
      "WHERE Region IS NOT NULL AND Region <> '' GROUP BY Region ORDER BY total DESC",
    category: "dirty",
    ordered: true,
    note:
      "Three rows have a blank region. The question asks only for regions that have one, " +
      "so the blank group must be excluded rather than reported as its own region. " +
      "Amounts carry thousands separators, so a column read as text sums to nothing.",
  },
  {
    id: "dirty-top-customer",
    tables: ["messy_orders"],
    question: "Which customer has spent the most in total?",
    referenceSql:
      "SELECT Customer, SUM(Amount) AS total FROM messy_orders " +
      "GROUP BY Customer ORDER BY total DESC LIMIT 1",
    category: "dirty",
    ordered: true,
    note:
      "Customer names include non-ASCII (Café Rouge, Björn Industries, 日本テック). The " +
      "winner is ASCII, so a query that mangles encoding still looks plausible — it just " +
      "returns the wrong name.",
  },
];

export const CATEGORIES = [...new Set(QUESTIONS.map((q) => q.category))];
