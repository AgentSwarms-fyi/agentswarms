// Repair generator for the AlaSQL-era sample dashboards.
//
//   npx tsx scripts/fixLegacySampleWidgetSql.ts
//
// The six dashboards seeded by 20260721300000 and 20260722000000 predate the
// engine swap to DuckDB-Wasm and their widget SQL uses three AlaSQL-isms the
// current engine rejects (all confirmed live before writing this):
//   1. [bracketed] identifiers            → Parser Error in DuckDB
//   2. strftime('<fmt>', value) arg order → DuckDB takes strftime(value, fmt)
//   3. string concatenation with `+`      → DuckDB needs `||`
// The widgets still RENDER (shipped snapshots), but ↻ silently fails and the
// data never refreshes.
//
// This script extracts every widget SQL from those two migrations, rewrites
// it, PROVES each rewritten query against the real bundled CSVs in DuckDB —
// with tables typed exactly as the browser types them (number → DOUBLE,
// everything else VARCHAR, empty string → NULL), mirroring materialise() in
// src/lib/browserDuckdb.ts — and emits
//   supabase/migrations/20260808000000_fix_sample_widget_sql_duckdb.sql
// which swaps each old SQL string for its fixed form wherever it appears:
// sample templates, users' seeded copies (widgets AND pages — a 20260728
// backfill mirrored widgets into pages[0]), and version-history snapshots so
// a restore cannot resurrect the broken dialect. Matching is by the full
// JSON-encoded string, so a widget whose SQL a user edited is left alone.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(__dirname, "../supabase/migrations");
const ASSETS = resolve(__dirname, "../src/assets/sample-data");

const LEGACY_MIGRATIONS = [
  "20260721300000_bi_sample_dashboards.sql",
  "20260722000000_bi_samples_sports_health_energy.sql",
];

// Browser column types for the datasets these dashboards query, as computed
// by src/lib/sqlEngine.ts inferColumns() at seed time and stored on
// user_data_tables.columns (fetched from the live instance 2026-08-07 —
// production output of the real function, not a re-implementation). Only the
// number/other distinction matters: duckType() maps number → DOUBLE and
// everything else (string, date) → VARCHAR.
const TABLE_COLUMNS: Record<string, { name: string; type: string }[]> = {
  saas_sales: [
    { name: "Row ID", type: "number" },
    { name: "Order ID", type: "string" },
    { name: "Order Date", type: "date" },
    { name: "Date Key", type: "number" },
    { name: "Contact Name", type: "string" },
    { name: "Country", type: "string" },
    { name: "City", type: "string" },
    { name: "Region", type: "string" },
    { name: "Subregion", type: "string" },
    { name: "Customer", type: "string" },
    { name: "Customer ID", type: "number" },
    { name: "Industry", type: "string" },
    { name: "Segment", type: "string" },
    { name: "Product", type: "string" },
    { name: "License", type: "string" },
    { name: "Sales", type: "number" },
    { name: "Quantity", type: "number" },
    { name: "Discount", type: "number" },
    { name: "Profit", type: "number" },
  ],
  q3_budget_variance: [
    { name: "GL_Code", type: "number" },
    { name: "Department", type: "string" },
    { name: "Category", type: "string" },
    { name: "Q3_Budget", type: "number" },
    { name: "Q3_Actual", type: "number" },
    { name: "Variance", type: "number" },
    { name: "Status", type: "string" },
  ],
  siem_alerts: [
    { name: "alert_id", type: "string" },
    { name: "ts", type: "date" },
    { name: "source", type: "string" },
    { name: "src_ip", type: "string" },
    { name: "dst_ip", type: "string" },
    { name: "mitre_technique", type: "string" },
    { name: "technique_name", type: "string" },
    { name: "severity", type: "string" },
    { name: "asset_criticality", type: "string" },
    { name: "asset_class", type: "string" },
    { name: "status", type: "string" },
  ],
  nba_team_seasons: [
    { name: "season", type: "number" },
    { name: "franchise", type: "string" },
    { name: "games", type: "number" },
    { name: "wins", type: "number" },
    { name: "losses", type: "number" },
    { name: "win_pct", type: "number" },
    { name: "avg_elo", type: "number" },
    { name: "pts_per_game", type: "number" },
    { name: "opp_pts_per_game", type: "number" },
    { name: "playoff_games", type: "number" },
    { name: "playoff_wins", type: "number" },
  ],
  world_health_indicators: [
    { name: "country", type: "string" },
    { name: "region", type: "string" },
    { name: "year", type: "number" },
    { name: "life_expectancy", type: "number" },
    { name: "health_spend_pct_gdp", type: "number" },
    { name: "health_spend_per_capita_usd", type: "number" },
    { name: "physicians_per_1k", type: "number" },
    { name: "infant_mortality_per_1k", type: "number" },
    { name: "population_m", type: "number" },
  ],
  global_electricity: [
    { name: "country", type: "string" },
    { name: "year", type: "number" },
    { name: "coal_twh", type: "number" },
    { name: "gas_twh", type: "number" },
    { name: "oil_twh", type: "number" },
    { name: "nuclear_twh", type: "number" },
    { name: "hydro_twh", type: "number" },
    { name: "solar_twh", type: "number" },
    { name: "wind_twh", type: "number" },
    { name: "other_renewables_twh", type: "number" },
    { name: "total_twh", type: "number" },
    { name: "renewables_share_pct", type: "number" },
    { name: "per_capita_kwh", type: "number" },
  ],
};

// ── Extraction ───────────────────────────────────────────────────────────────
type WidgetRef = { dashboard: string; title: string; sql: string; snapshotRows: number };

function extractWidgets(file: string): WidgetRef[] {
  const s = readFileSync(resolve(MIG, file), "utf-8");
  const out: WidgetRef[] = [];
  const re =
    /VALUES \(\s*\d+,\s*\$sample\$(.*?)\$sample\$,\s*\$sample\$.*?\$sample\$,\s*\$sample\$(\[.*?\])\$sample\$/gs;
  for (const m of s.matchAll(re)) {
    const dashboard = m[1];
    const widgets = JSON.parse(m[2]) as Record<string, unknown>[];
    for (const w of widgets) {
      const sql = typeof w.sql === "string" ? w.sql : "";
      if (!sql) continue;
      out.push({
        dashboard,
        title: String(w.title ?? "?"),
        sql,
        snapshotRows: Array.isArray(w.rows) ? w.rows.length : 0,
      });
    }
  }
  return out;
}

// ── Rewrite ──────────────────────────────────────────────────────────────────
/**
 * VARCHAR date column → timestamp expression. Formats verified against the
 * bundled CSVs: saas_sales "Order Date" is M/D/YYYY on every one of its
 * 9,994 rows (day exceeds 12 in 6,017 of them, which pins the order);
 * siem_alerts ts is ISO 8601, which a plain cast parses.
 */
function timestampExpr(valueToken: string): string {
  if (valueToken === '"Order Date"') return `strptime("Order Date", '%m/%d/%Y')`;
  return `CAST(${valueToken} AS TIMESTAMP)`;
}

function rewriteSql(sql: string): string {
  let out = sql;
  // 1. [bracket] identifiers → "double quoted". No identifier contains ']'.
  out = out.replace(/\[([^\]]+)\]/g, (_, id: string) => `"${id}"`);
  // 2. strftime(format, value) → strftime(<parsed value>, format).
  //    Two changes at once: the engine's canonical order is (value, format),
  //    and date columns are VARCHAR in the browser tables (see duckType in
  //    browserDuckdb.ts), so the string must be parsed to a timestamp first —
  //    DuckDB refuses strftime(VARCHAR, VARCHAR). After step 1 the value arg
  //    is a quoted identifier or bare column name — never nested parens here.
  out = out.replace(
    /strftime\(\s*('(?:[^'])*')\s*,\s*("(?:[^"])*"|[A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
    (_, fmt: string, value: string) => `strftime(${timestampExpr(value)}, ${fmt})`,
  );
  // 2b. DATE(x) → a cast: DuckDB has no date() scalar function.
  out = out.replace(
    /\bDATE\(\s*("(?:[^"])*"|[A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
    (_, value: string) => `CAST(${timestampExpr(value)} AS DATE)`,
  );
  // 3. String concatenation. Two shapes exist in these dashboards:
  //    col + 'literal' + col   and   CAST(... AS STRING) + 'literal'.
  out = out.replace(
    /([A-Za-z_][A-Za-z0-9_]*)\s*\+\s*('(?:[^'])*')\s*\+\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, a: string, lit: string, b: string) => `${a} || ${lit} || ${b}`,
  );
  out = out.replace(
    /(CAST\([^()]*(?:\([^()]*\)[^()]*)*AS STRING\))\s*\+\s*('(?:[^'])*')/g,
    (_, cast: string, lit: string) => `${cast} || ${lit}`,
  );
  return out;
}

function assertClean(sql: string, where: string) {
  if (/\[[^\]]*\]/.test(sql)) throw new Error(`brackets survived in ${where}: ${sql}`);
  if (/strftime\(\s*'/.test(sql))
    throw new Error(`format-first strftime survived in ${where}: ${sql}`);
  if (/'\s*\+|\+\s*'/.test(sql)) throw new Error(`string + concat survived in ${where}: ${sql}`);
  if (/AS STRING\)\s*\+/.test(sql)) throw new Error(`CAST + concat survived in ${where}: ${sql}`);
}

// ── Browser-equivalent tables (mirrors materialise() in browserDuckdb.ts) ────
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined || v === "") return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}
function numericLiteral(v: unknown): string {
  if (v === null || v === undefined || v === "") return "NULL";
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : "NULL";
}
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function main() {
  const widgets = LEGACY_MIGRATIONS.flatMap(extractWidgets);
  if (widgets.length === 0)
    throw new Error("extracted 0 widgets — regex drifted from the migrations");

  const pairs: { old: string; new: string }[] = [];
  for (const w of widgets) {
    const fixed = rewriteSql(w.sql);
    if (fixed === w.sql) continue;
    assertClean(fixed, `${w.dashboard} :: ${w.title}`);
    pairs.push({ old: w.sql, new: fixed });
  }
  // Same SQL can appear in more than one widget; dedupe pairs.
  const seen = new Set<string>();
  const map = pairs.filter((p) => (seen.has(p.old) ? false : (seen.add(p.old), true)));
  console.log(
    `widgets: ${widgets.length}, rewritten: ${pairs.length}, unique pairs: ${map.length}`,
  );

  // ── Validate every rewritten query in DuckDB against the bundled CSVs ──────
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  for (const [table, cols] of Object.entries(TABLE_COLUMNS)) {
    const csv = readFileSync(resolve(ASSETS, `${table}.csv`), "utf-8");
    const parsed = Papa.parse<Record<string, unknown>>(csv, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false, // parseCsv() does its own coercion; literals below match it
    });
    const rows = parsed.data.filter((r) => r && Object.keys(r).length > 0);
    const ddl = cols.map(
      (c) => `${quoteIdent(c.name)} ${c.type === "number" ? "DOUBLE" : "VARCHAR"}`,
    );
    await conn.run(`CREATE TABLE ${quoteIdent(table)} (${ddl.join(", ")})`);
    for (let i = 0; i < rows.length; i += 500) {
      const values = rows
        .slice(i, i + 500)
        .map(
          (row) =>
            "(" +
            cols
              .map((c) =>
                c.type === "number" ? numericLiteral(row[c.name]) : sqlLiteral(row[c.name]),
              )
              .join(", ") +
            ")",
        )
        .join(", ");
      await conn.run(`INSERT INTO ${quoteIdent(table)} VALUES ${values}`);
    }
  }

  const bySql = new Map(map.map((p) => [p.old, p.new]));
  let checked = 0;
  for (const w of widgets) {
    const fixed = bySql.get(w.sql);
    if (!fixed) continue;
    let rows: unknown[];
    try {
      rows = (await conn.runAndReadAll(fixed)).getRowObjects();
    } catch (e) {
      throw new Error(`REWRITTEN SQL FAILS [${w.dashboard} :: ${w.title}]\n${fixed}\n${String(e)}`);
    }
    if (rows.length === 0) throw new Error(`0 rows [${w.dashboard} :: ${w.title}]\n${fixed}`);
    if (w.snapshotRows > 0 && rows.length !== w.snapshotRows) {
      console.log(
        `  note: row count ${rows.length} vs snapshot ${w.snapshotRows} — ${w.dashboard} :: ${w.title}`,
      );
    }
    checked++;
  }
  console.log(`validated ${checked} rewritten queries against real CSVs (browser-typed tables)`);

  // ── Emit migration ─────────────────────────────────────────────────────────
  const mapJson = JSON.stringify(map, null, 1);
  if (mapJson.includes("$map$") || mapJson.includes("$fix$"))
    throw new Error("dollar-quote collision");

  const migration = `-- Repair the AlaSQL-era sample dashboards for the DuckDB engine.
--
-- Generated by scripts/fixLegacySampleWidgetSql.ts — edit that script and
-- re-run it rather than editing this file.
--
-- The dashboards seeded by 20260721300000 and 20260722000000 predate the
-- browser engine's swap to DuckDB-Wasm. Their widget SQL uses [bracketed]
-- identifiers, strftime(format, value) argument order, and '+' string
-- concatenation — AlaSQL dialect that DuckDB rejects, so ↻ silently failed
-- and widgets could only ever show their shipped snapshots.
--
-- Every replacement below was executed against the bundled CSVs in DuckDB
-- (tables typed exactly as the browser types them) before this file was
-- generated. Replacement is by the full JSON-encoded SQL string — templates,
-- users' seeded copies and version snapshots whose SQL is unmodified are
-- fixed; anything a user edited no longer matches and is left alone. The
-- widgets and pages columns are both treated: a 20260728 backfill mirrored
-- widgets into pages, so the broken SQL lives in both.
DO $fix$
DECLARE
  _map jsonb := $map$${mapJson}$map$::jsonb;
  _e jsonb;
  _needle text;
  _repl text;
BEGIN
  FOR _e IN SELECT jsonb_array_elements(_map) LOOP
    -- ->'old' keeps the JSON string form (quotes + escapes included), which
    -- is exactly how the SQL appears inside widgets::text / pages::text.
    _needle := (_e -> 'old')::text;
    _repl := (_e -> 'new')::text;

    UPDATE public.bi_sample_dashboards
      SET widgets = replace(widgets::text, _needle, _repl)::jsonb
      WHERE position(_needle in widgets::text) > 0;
    UPDATE public.bi_sample_dashboards
      SET pages = replace(pages::text, _needle, _repl)::jsonb
      WHERE position(_needle in pages::text) > 0;

    UPDATE public.bi_dashboards
      SET widgets = replace(widgets::text, _needle, _repl)::jsonb
      WHERE position(_needle in widgets::text) > 0;
    UPDATE public.bi_dashboards
      SET pages = replace(pages::text, _needle, _repl)::jsonb
      WHERE position(_needle in pages::text) > 0;

    UPDATE public.bi_dashboard_versions
      SET widgets = replace(widgets::text, _needle, _repl)::jsonb
      WHERE position(_needle in widgets::text) > 0;
    UPDATE public.bi_dashboard_versions
      SET pages = replace(pages::text, _needle, _repl)::jsonb
      WHERE position(_needle in pages::text) > 0;
  END LOOP;
END
$fix$;
`;
  const out = resolve(MIG, "20260808000000_fix_sample_widget_sql_duckdb.sql");
  writeFileSync(out, migration);
  console.log(`migration written: ${out} (${(migration.length / 1024).toFixed(0)} KB)`);
  conn.closeSync?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
