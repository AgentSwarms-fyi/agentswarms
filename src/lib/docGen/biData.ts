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
import type { PptxKpi, PptxPlan } from "./types";

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
  try {
    const sql = await generateSql({
      question,
      plan,
      datasets: ctx.datasets,
      semantics: ctx.semantics,
      metrics: ctx.metrics,
      model: ctx.model,
    });
    const res = runQuery(sql);
    return res.row_count > 0 ? res : null;
  } catch {
    return null;
  }
}

/** result → { categories, series }: first column = category, numeric cols = series. */
function chartDataFromResult(
  res: ResultLike,
): { categories: string[]; series: { name: string; values: number[] }[] } | null {
  if (res.columns.length < 2 || res.rows.length === 0) return null;
  const catCol = res.columns[0];
  const numCols = res.columns
    .slice(1)
    .filter((c) => res.rows.some((r) => Number.isFinite(toNum(r[c]))));
  const useCols = numCols.length ? numCols : res.columns.slice(1, 2);
  const rows = res.rows.slice(0, 12);
  return {
    categories: rows.map((r) => String(r[catCol] ?? "")),
    series: useCols.map((c) => ({
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
export async function materializePptxWithBI(
  plan: PptxPlan,
  opts: { model?: string } = {},
): Promise<void> {
  const slides = plan.slides ?? [];
  const needs = slides.some(
    (s) => s.chart?.query || s.chart?.dataSql || s.kpiQuery || s.kpis?.some((k) => k.sql),
  );
  if (!needs) return;

  let datasets: DatasetMeta[] = [];
  try {
    datasets = await hydrateFromSupabase();
  } catch {
    datasets = [];
  }
  if (!datasets.length) return; // no data connected — leave charts to be dropped

  const [semantics, metrics] = await Promise.all([
    loadSemantics(datasets.map((d) => d.id)),
    loadSavedMetrics(),
  ]);
  const ctx: BiCtx = { datasets, semantics, metrics, model: opts.model };

  const jobs: Array<() => Promise<void>> = [];

  for (const s of slides) {
    // ── Charts ── prefer the NL question (BI analyst); else raw dataSql (no LLM).
    if (s.chart?.query) {
      const chart = s.chart;
      const q = chart.query;
      jobs.push(async () => {
        const res = await analyze(q ?? "", ctx);
        const data = res ? chartDataFromResult(res) : null;
        if (data) {
          chart.categories = data.categories;
          chart.series = data.series;
        }
      });
    } else if (s.chart?.dataSql) {
      const chart = s.chart;
      try {
        const r = runQueryUnlimited(chart.dataSql ?? "", 60);
        const data = chartDataFromResult({ columns: r.columns, rows: r.rows });
        if (data) {
          chart.categories = data.categories;
          chart.series = data.series;
        }
      } catch {
        /* keep any model-provided series */
      }
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
          const r = runQueryUnlimited(k.sql, 1);
          const v = r.rows[0]?.[r.columns[0]];
          if (v !== undefined && v !== null && v !== "") k.value = formatKpiValue(k.label, v);
        } catch {
          /* keep model-provided value */
        }
      }
    }
  }

  await runPool(jobs, 4);
}
