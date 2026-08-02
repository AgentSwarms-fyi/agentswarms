// Fill a PPTX plan's charts and KPI cards with REAL data by running each
// planned analytical question through the BI analyst — the same proven
// plan → SQL → execute pipeline that powers Data & SQL and the dashboards.
//
// The document planner only writes *questions* ("top 8 products by revenue"),
// never numbers. Here we resolve them against the user's actual hydrated data,
// so charts are never empty and figures are never hand-guessed. Everything is
// best-effort: a failed question leaves the model's fallback in place (and an
// empty chart is dropped downstream by chartHasData), never throws.
import {
  generateSql,
  loadSavedMetrics,
  loadSemantics,
  planQuestion,
  type BiPlan,
} from "@/lib/biAgent";
import {
  hydrateFromSupabase,
  runQuery,
  runQueryUnlimited,
  type DatasetMeta,
  type QueryResult,
} from "@/lib/sqlEngine";
import type { DocChart, DocTable, PptxKpi, PptxPlan, PptxSlide } from "./types";

type BiCtx = {
  datasets: DatasetMeta[];
  semantics: Awaited<ReturnType<typeof loadSemantics>>;
  metrics: Awaited<ReturnType<typeof loadSavedMetrics>>;
  model?: string;
};

type ResultLike = { columns: string[]; rows: Record<string, unknown>[] };

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

/** Compact number formatting for KPI values (1_200_000 → "1.2M"). */
function compactNumber(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

/** "total_revenue" / "SUM(revenue)" / "avgOrderValue" → "Total Revenue" etc. */
function prettifyLabel(col: string): string {
  let s = String(col ?? "").trim();
  const fn = s.match(/^[a-z_]+\((?:distinct\s+)?(.+?)\)$/i);
  if (fn) s = fn[1];
  s = s
    .replace(/["'`]/g, "")
    .replace(/\./g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatKpiValue(label: string, v: unknown): string {
  const n = toNum(v);
  if (!Number.isFinite(n)) return String(v ?? "");
  if (/%|percent|rate|margin|ratio|share/i.test(label) && Math.abs(n) <= 100) {
    return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
  }
  return compactNumber(n);
}

/** Run one analytical question through the proven BI pipeline over real data. */
async function analyze(question: string, ctx: BiCtx): Promise<QueryResult | null> {
  let plan: BiPlan;
  try {
    plan = await planQuestion({
      question,
      datasets: ctx.datasets,
      semantics: ctx.semantics,
      metrics: ctx.metrics,
      model: ctx.model,
    });
  } catch {
    // Planning is an optimisation; SQL generation works from schema + question.
    plan = { intent: question, tables: [], metrics: [], breakdowns: [] };
  }
  // Two attempts. Nearly every empty visual in a deck traces back to SQL that
  // failed to execute — a column that doesn't exist, a quoting slip — and the
  // engine's error is usually enough for the model to fix it. Without this the
  // slide is simply blank and nothing anywhere says why.
  let lastSql = "";
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sql = await generateSql({
        question,
        plan,
        datasets: ctx.datasets,
        semantics: ctx.semantics,
        metrics: ctx.metrics,
        model: ctx.model,
        ...(attempt > 0 && lastSql ? { repair: { sql: lastSql, error: lastErr } } : {}),
      });
      lastSql = firstStatement(sql);
      const res = await runQuery(lastSql);
      if (res.row_count > 0) return res;
      // Ran, but returned nothing. A repair pass can still help (over-narrow
      // filter, wrong join), so let the second attempt see that.
      lastErr = "The statement ran but returned 0 rows.";
    } catch (e) {
      lastErr = (e as Error).message || "SQL execution failed";
    }
  }
  return null;
}

/**
 * The first statement of a possibly multi-statement string.
 *
 * Asked for two visuals at once the model answers with "SELECT …; SELECT …;",
 * which the engine rejects outright — so one over-broad question used to cost
 * the slide its chart entirely.
 */
function firstStatement(sql: string): string {
  const trimmed = (sql || "").trim().replace(/;\s*$/, "");
  const idx = trimmed.indexOf(";");
  return (idx === -1 ? trimmed : trimmed.slice(0, idx)).trim();
}

/**
 * result → { categories, series }, robust to column order: the CATEGORY is the
 * first non-numeric column (else the first column), and the SERIES are the
 * numeric columns. Returns null when there's nothing numeric to plot (the
 * caller then shows a table instead of an empty chart) — this also prevents the
 * "filled but flat" chart you get when a non-numeric column is charted as zeros.
 */
function chartDataFromResult(
  res: ResultLike,
): { categories: string[]; series: { name: string; values: number[] }[] } | null {
  if (res.columns.length < 2 || res.rows.length === 0) return null;
  const isNumericCol = (c: string) => res.rows.some((r) => Number.isFinite(toNum(r[c])));
  const numericCols = res.columns.filter(isNumericCol);
  if (numericCols.length === 0) return null;
  const catCol = res.columns.find((c) => !isNumericCol(c)) ?? res.columns[0];
  const measures = numericCols.filter((c) => c !== catCol).slice(0, 4);
  if (measures.length === 0) return null;
  const rows = res.rows.slice(0, 12);
  return {
    categories: rows.map((r) => String(r[catCol] ?? "")),
    series: measures.map((c) => ({
      name: prettifyLabel(c),
      values: rows.map((r) => {
        const n = toNum(r[c]);
        return Number.isFinite(n) ? n : 0;
      }),
    })),
  };
}

/** A one-row multi-metric result → one KPI card per column. */
function kpisFromResult(res: ResultLike): PptxKpi[] {
  if (res.rows.length !== 1) return [];
  const row = res.rows[0];
  return res.columns.slice(0, 5).map((c) => ({
    label: prettifyLabel(c),
    value: formatKpiValue(c, row[c]),
  }));
}

const TEMPORAL =
  /^\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]\b|fy|20\d\d|19\d\d|\d{4}-\d{2}|week|day|month|year)/i;

/** Do the categories look like a time axis (months / quarters / years / dates)? */
function looksTemporal(cats: string[]): boolean {
  if (cats.length < 3) return false;
  const hits = cats.filter((c) => TEMPORAL.test(String(c))).length;
  return hits >= Math.ceil(cats.length * 0.6);
}

/**
 * Pick a data-APPROPRIATE chart type from the real result shape, rotating for
 * VARIETY across the deck (so it isn't all the same visual): time series → line/
 * area; a few categories → column/pie/doughnut; many categories → horizontal
 * bar; multi-series → grouped column (or line over time).
 */
function chooseChartType(
  data: { categories: string[]; series: { name: string; values: number[] }[] },
  i: number,
): DocChart["type"] {
  const single = data.series.length === 1;
  const n = data.categories.length;
  const allPositive = data.series.every((s) => s.values.every((v) => v >= 0));
  if (looksTemporal(data.categories)) return single && i % 3 === 2 ? "area" : "line";
  if (!single) return "column";
  if (n <= 6 && allPositive) return i % 3 === 0 ? "column" : i % 3 === 1 ? "pie" : "doughnut";
  if (n >= 8) return "bar";
  return i % 2 === 0 ? "column" : "bar";
}

/** When the model gives a chart no query, derive one from the slide's own text
 * (title + subtitle + its bullets) so the analyst has enough to target the data. */
function deriveChartQuestion(slide: PptxSlide): string {
  const base = [slide.title, slide.subtitle]
    .map((p) => (p || "").trim())
    .filter(Boolean)
    .join(" — ");
  const hints = (slide.bullets ?? [])
    .map((b) => b.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  return [base, hints].filter(Boolean).join(". ") || (slide.takeaway || "").trim() || "key metrics";
}

/** A small, display-ready table from a query result — the never-empty fallback. */
function resultToTable(res: ResultLike): DocTable {
  const cols = res.columns.slice(0, 6);
  const rows = res.rows.slice(0, 10).map((r) =>
    cols.map((c): string | number | null => {
      const v = r[c];
      if (v === null || v === undefined) return "";
      if (typeof v === "number") return v;
      const n = toNum(v);
      return Number.isFinite(n) && String(v).trim() !== "" && !/[a-z]/i.test(String(v))
        ? n
        : String(v);
    }),
  );
  return { columns: cols.map(prettifyLabel), rows };
}

/** Last-resort content so a slide is never blank: a peek at the primary table. */
/** A table is only worth putting on a slide if it has columns AND rows. */
function tableHasData(t: DocTable | null | undefined): boolean {
  return !!t && (t.columns?.length ?? 0) > 0 && (t.rows?.length ?? 0) > 0;
}

async function fallbackTable(ctx: BiCtx): Promise<DocTable | null> {
  const ds = ctx.datasets[0];
  if (!ds) return null;
  try {
    const r = await runQueryUnlimited(`SELECT * FROM "${ds.name}" LIMIT 8`, 8);
    if (!r.rows.length) return null;
    return resultToTable({ columns: r.columns, rows: r.rows });
  } catch {
    return null;
  }
}

/** Bounded-concurrency runner so we don't fire 15 LLM calls at the provider at once. */
async function runPool(jobs: Array<() => Promise<void>>, limit: number): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      await job();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

/**
 * Resolve every chart/KPI in a PPTX plan against the user's real data. Prefers
 * the natural-language `query` (BI analyst); falls back to raw `dataSql`/`sql`
 * when the model supplied those instead. No-ops (and returns) when there's
 * nothing to compute or no connected data.
 */
/** How many visuals were asked for, and how many ended up carrying real data. */
export type BiFillReport = { visuals: number; filled: number };

export async function materializePptxWithBI(
  plan: PptxPlan,
  opts: { model?: string } = {},
): Promise<BiFillReport> {
  const slides = plan.slides ?? [];
  const needs = slides.some((s) => s.chart || s.kpiQuery || s.kpis?.some((k) => k.sql));
  const report: BiFillReport = { visuals: 0, filled: 0 };
  if (!needs) return report;

  let datasets: DatasetMeta[] = [];
  try {
    datasets = await hydrateFromSupabase();
  } catch {
    datasets = [];
  }
  if (!datasets.length) return report; // no data connected — leave charts to be dropped

  const [semantics, metrics] = await Promise.all([
    loadSemantics(datasets.map((d) => d.id)),
    loadSavedMetrics(),
  ]);
  const ctx: BiCtx = { datasets, semantics, metrics, model: opts.model };

  const jobs: Array<() => Promise<void>> = [];
  let chartIdx = 0; // drives chart-type variety across the deck

  for (const s of slides) {
    // ── Charts ── EVERY chart slide gets a real data attempt so visuals are
    // never empty. Use the model's NL query, else its raw dataSql, else a
    // question derived from the slide title. Real results overwrite any values
    // the model guessed; if the data can't be charted, fall back to a real
    // table (or a peek at the primary table) so the slide is never blank.
    if (s.chart) {
      const slide = s;
      const chart = s.chart;
      const ci = chartIdx++;
      const rawSql = !chart.query ? chart.dataSql?.trim() : undefined;
      const question = chart.query?.trim() || (rawSql ? "" : deriveChartQuestion(slide));
      report.visuals++;
      jobs.push(async () => {
        let res: ResultLike | null = null;
        if (rawSql) {
          try {
            const r = await runQueryUnlimited(rawSql, 60);
            res = { columns: r.columns, rows: r.rows };
          } catch {
            res = null;
          }
        } else if (question) {
          res = await analyze(question, ctx);
        }
        const data = res ? chartDataFromResult(res) : null;
        if (data) {
          report.filled++;
          chart.categories = data.categories;
          chart.series = data.series;
          // Pick the visual type from the real data shape (with variety across
          // the deck) rather than trusting the model's guess.
          chart.type = chooseChartType(data, ci);
          return;
        }
        // No chartable data — drop the guessed/empty chart (chartHasData will
        // skip it) and ALWAYS leave a real data table in the visual area, so the
        // slide never has an empty gap where a chart should be (even when it
        // already has bullets — the renderer puts the table + bullets together).
        chart.categories = undefined;
        chart.series = undefined;
        if (!slide.table) {
          // Both checks matter. A result can have rows but NO columns (the
          // analyst occasionally returns positional arrays rather than keyed
          // objects), which produced a table of empty rows — and the renderer
          // counted that as a visual, so the slide shipped an empty grid where
          // a chart should have been.
          const t = res && res.rows.length ? resultToTable(res) : null;
          if (tableHasData(t)) slide.table = t!;
          else {
            const fb = await fallbackTable(ctx);
            if (tableHasData(fb)) slide.table = fb!;
          }
        }
      });
    }

    // ── KPIs ── prefer one multi-metric question; else per-card scalar sql.
    if (s.kpiQuery) {
      const slide = s;
      const q = slide.kpiQuery;
      jobs.push(async () => {
        const res = await analyze(q ?? "", ctx);
        const cards = res ? kpisFromResult(res) : [];
        if (cards.length) {
          // Carry over any deltas the model set, matched by position.
          slide.kpis = cards.map((c, i) => ({
            ...c,
            delta: slide.kpis?.[i]?.delta,
            positive: slide.kpis?.[i]?.positive,
          }));
        }
      });
    } else if (s.kpis?.some((k) => k.sql)) {
      for (const k of s.kpis) {
        if (!k.sql) continue;
        try {
          const r = await runQueryUnlimited(k.sql, 1);
          const v = r.rows[0]?.[r.columns[0]];
          if (v !== undefined && v !== null && v !== "") k.value = formatKpiValue(k.label, v);
        } catch {
          /* keep model-provided value */
        }
      }
    }
  }

  // Modest concurrency — enough to be quick, low enough to avoid provider
  // rate-limits that would fail individual chart queries.
  await runPool(jobs, 3);
  return report;
}
