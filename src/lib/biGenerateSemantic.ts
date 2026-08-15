// Generating a dashboard FROM a governed semantic model.
//
// WHY THIS EXISTS. Building a chart by hand could already pin it to a certified
// metric: the compiler writes the SQL, refuses a query that would fan out, and
// applies row filters and field masks. "Generate with AI" could not — it read
// raw columns and let the model choose the aggregation, so `revenue` meant
// whatever the model inferred rather than what the semantic model defines. The
// path that produces twelve widgets with the least review was the one path with
// no governance on it, and the result looked identical either way.
//
// THE MODEL NEVER WRITES SQL HERE, and never names a measure. It picks from
// what the semantic model DECLARES — metric names, dimension names — and the
// compiler turns that into SQL. So the worst a bad suggestion can do is ask a
// well-formed question nobody wanted, rather than compute a number nobody
// defined.
//
// Everything it returns is checked against the declarations before it reaches
// the compiler. A suggestion naming something undeclared is REFUSED WITH A
// REASON, not quietly dropped: silently discarding three of twelve widgets
// hands someone a dashboard they think is complete.
//
// Pure module — no imports beyond types — so the validation is testable without
// a browser, a model or a database.
import type { MetricModelOption } from "@/components/bi/biDataContext";
import type { LlmJsonFn } from "./biAgent";
import type { SemanticChartType } from "./biDashboards";

/** Time rollups the planner may request on a time dimension. */
export const ALLOWED_GRAINS = ["day", "week", "month", "quarter", "year"] as const;
export type PlannerGrain = (typeof ALLOWED_GRAINS)[number];

/** Chart shapes a governed widget can take. Mirrors SemanticChartType. */
export const GOVERNED_CHART_TYPES: SemanticChartType[] = [
  "kpi",
  "bar",
  "line",
  "area",
  "pie",
  "table",
];

/** What the planner is asked to return, per widget. */
export type GovernedSuggestion = {
  title: string;
  chartType: string;
  metrics: string[];
  dimensions?: string[];
  grains?: Record<string, string>;
  /** Why this widget is worth having — shown in the review checklist. */
  rationale?: string;
};

/** A suggestion that survived validation, ready to compile. */
export type ValidGovernedWidget = {
  title: string;
  chartType: SemanticChartType;
  metrics: string[];
  dimensions: string[];
  grains?: Record<string, PlannerGrain>;
  rationale?: string;
};

/** A suggestion that did not survive, and the reason a human can act on. */
export type RejectedGovernedWidget = { title: string; reason: string };

export type GovernedPlan = {
  widgets: ValidGovernedWidget[];
  rejected: RejectedGovernedWidget[];
};

/**
 * The model's declarations, as prompt text.
 *
 * Deliberately NOT the underlying tables or columns. The planner is choosing
 * from a vocabulary, and showing it the physical schema would invite it to
 * reach past the semantic layer — which is the exact behaviour this path
 * exists to prevent.
 */
export function describeModelForPlanner(model: MetricModelOption): string {
  const metrics = model.metrics
    .map((m) => `  - ${m.name} (${m.agg}${m.format ? `, ${m.format}` : ""})`)
    .join("\n");
  const dims = model.dimensions
    .map((d) => `  - ${d.name}${d.type ? ` (${d.type})` : ""}`)
    .join("\n");
  return (
    `Semantic model: ${model.label || model.name}\n\n` +
    `METRICS you may use (these are the only measures that exist):\n${metrics || "  (none)"}\n\n` +
    `DIMENSIONS you may group by:\n${dims || "  (none)"}\n` +
    (model.scoped
      ? `\nNote: this model is shared under a restrictive policy, so the numbers ` +
        `will be a scoped view of the data.\n`
      : "")
  );
}

/** Dimensions the model declared as time-typed — the only ones a grain suits. */
export function timeDimensions(model: MetricModelOption): string[] {
  return model.dimensions
    .filter((d) => (d.type ?? "").toLowerCase().includes("time") || (d.type ?? "") === "date")
    .map((d) => d.name);
}

/**
 * How many dimensions each chart shape can actually render.
 *
 * A KPI with a dimension is a category list pretending to be one number; a pie
 * with two is a chart nobody can read. Enforced rather than trusted, because a
 * planner asked for "variety" will reach for shapes that do not fit.
 */
const DIMENSION_RULES: Record<SemanticChartType, { min: number; max: number }> = {
  kpi: { min: 0, max: 0 },
  pie: { min: 1, max: 1 },
  bar: { min: 1, max: 2 },
  line: { min: 1, max: 2 },
  area: { min: 1, max: 2 },
  table: { min: 0, max: 4 },
};

function normalise(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

/**
 * Check one suggestion against what the model declares.
 *
 * Returns the validated widget, or a reason. The reason is written for the
 * person reading the dialog, not for a log: it names the thing that did not
 * exist, because "invalid suggestion" tells them nothing they can act on.
 */
export function validateSuggestion(
  raw: GovernedSuggestion,
  model: MetricModelOption,
): { ok: true; widget: ValidGovernedWidget } | { ok: false; rejected: RejectedGovernedWidget } {
  const title = normalise(raw?.title) || "Untitled";
  const reject = (reason: string) => ({ ok: false as const, rejected: { title, reason } });

  const declaredMetrics = new Set(model.metrics.map((m) => m.name));
  const declaredDims = new Set(model.dimensions.map((d) => d.name));

  const chartType = normalise(raw?.chartType).toLowerCase() as SemanticChartType;
  if (!GOVERNED_CHART_TYPES.includes(chartType)) {
    return reject(`"${raw?.chartType}" is not a chart type this dashboard can build`);
  }

  const metrics = Array.isArray(raw?.metrics) ? raw.metrics.map(normalise).filter(Boolean) : [];
  if (metrics.length === 0) return reject("No metric was chosen");
  // THE CENTRAL CHECK. A metric the model did not declare cannot be compiled,
  // and must never be silently swapped for one that looks similar — that would
  // answer a different question under this widget's title.
  const unknownMetric = metrics.find((m) => !declaredMetrics.has(m));
  if (unknownMetric) {
    return reject(`The metric "${unknownMetric}" is not defined on this semantic model`);
  }

  const dimensions = Array.isArray(raw?.dimensions)
    ? raw.dimensions.map(normalise).filter(Boolean)
    : [];
  const unknownDim = dimensions.find((d) => !declaredDims.has(d));
  if (unknownDim) {
    return reject(`The dimension "${unknownDim}" is not defined on this semantic model`);
  }

  const rule = DIMENSION_RULES[chartType];
  if (dimensions.length < rule.min) {
    return reject(`A ${chartType} chart needs at least ${rule.min} dimension`);
  }
  if (dimensions.length > rule.max) {
    return reject(
      rule.max === 0
        ? `A ${chartType} shows a single figure and cannot be grouped by a dimension`
        : `A ${chartType} chart cannot show more than ${rule.max} dimensions`,
    );
  }

  // Grains: only on a declared TIME dimension that this widget actually groups
  // by, and only a rollup the compiler knows. A grain on a non-time dimension
  // compiles to a date truncation over something that is not a date.
  let grains: Record<string, PlannerGrain> | undefined;
  if (raw?.grains && typeof raw.grains === "object") {
    const times = new Set(timeDimensions(model));
    for (const [dim, g] of Object.entries(raw.grains)) {
      const grain = normalise(g).toLowerCase() as PlannerGrain;
      if (!dimensions.includes(dim)) continue; // a grain on an unused dimension is noise, not an error
      if (!times.has(dim)) {
        return reject(`"${dim}" is not a time dimension, so it cannot be rolled up by ${grain}`);
      }
      if (!ALLOWED_GRAINS.includes(grain)) {
        return reject(`"${grain}" is not a time rollup this dashboard supports`);
      }
      grains = { ...(grains ?? {}), [dim]: grain };
    }
  }

  return {
    ok: true,
    widget: {
      title,
      chartType,
      metrics,
      dimensions,
      ...(grains ? { grains } : {}),
      ...(normalise(raw?.rationale) ? { rationale: normalise(raw.rationale) } : {}),
    },
  };
}

/**
 * Validate a whole plan, keeping the rejects.
 *
 * Both halves are returned because the dialog shows both. A generate that
 * proposed twelve widgets and silently produced nine is indistinguishable from
 * one that only ever thought of nine.
 */
export function validatePlan(raw: unknown, model: MetricModelOption): GovernedPlan {
  const list = Array.isArray(raw) ? raw : [];
  const widgets: ValidGovernedWidget[] = [];
  const rejected: RejectedGovernedWidget[] = [];
  const seen = new Set<string>();

  for (const item of list as GovernedSuggestion[]) {
    const result = validateSuggestion(item, model);
    if (!result.ok) {
      rejected.push(result.rejected);
      continue;
    }
    // Two widgets asking the identical question are one widget and a duplicate;
    // keyed on the QUERY, not the title, because a planner will happily give
    // the same query two names.
    const key = JSON.stringify([
      result.widget.chartType,
      [...result.widget.metrics].sort(),
      [...result.widget.dimensions].sort(),
      result.widget.grains ?? null,
    ]);
    if (seen.has(key)) {
      rejected.push({
        title: result.widget.title,
        reason: "Duplicate of another suggested widget",
      });
      continue;
    }
    seen.add(key);
    widgets.push(result.widget);
  }
  return { widgets, rejected };
}

/** The query the compiler will be handed for one validated widget. */
export function toSemanticQuery(
  widget: ValidGovernedWidget,
  modelName: string,
): {
  model: string;
  metrics: string[];
  dimensions?: string[];
  grains?: Record<string, PlannerGrain>;
  limit?: number;
} {
  return {
    model: modelName,
    metrics: widget.metrics,
    ...(widget.dimensions.length ? { dimensions: widget.dimensions } : {}),
    ...(widget.grains ? { grains: widget.grains } : {}),
    // A categorical breakdown with hundreds of members is unreadable as a
    // chart and slow to compile. KPIs return one row by construction.
    ...(widget.chartType === "kpi" ? {} : { limit: 200 }),
  };
}

/** System prompt for the planner. Vocabulary in, widget plan out. */
export const GOVERNED_PLANNER_SYSTEM = `You design a business-intelligence dashboard over a GOVERNED SEMANTIC MODEL.

You are given the model's declared METRICS and DIMENSIONS. Those names are the
only vocabulary that exists. You do not write SQL, you do not invent measures,
and you do not choose aggregations — every metric is already defined, and a
compiler turns your choices into SQL.

Propose 8-14 widgets that together tell the story of this model. Vary the chart
types. Start with one or two KPI widgets for the headline figures, then
breakdowns and trends.

Chart types and what they can show:
  kpi   - exactly one metric, NO dimensions (a single headline figure)
  bar   - 1-2 dimensions, one metric (categories)
  line  - 1-2 dimensions, one metric (best over a time dimension)
  area  - 1-2 dimensions, one metric
  pie   - exactly 1 dimension, one metric (shares of a whole)
  table - 0-4 dimensions, one or more metrics

Use "grains" only on a dimension typed as time, and only one of:
day, week, month, quarter, year.

Return STRICT JSON: an array of
{
  "title": "short widget title",
  "chartType": "kpi|bar|line|area|pie|table",
  "metrics": ["declared metric name"],
  "dimensions": ["declared dimension name"],
  "grains": { "some_time_dimension": "month" },
  "rationale": "one short line on why this is worth showing"
}

Every metric and dimension name must appear EXACTLY as declared. A name that is
not in the lists will be rejected.`;

/** The planner's whole answer: a deck of widgets plus how it framed them. */
export type GovernedPlanResult = {
  title: string;
  summary: string;
  plan: GovernedPlan;
};

/**
 * Ask a model to design a dashboard over this semantic model.
 *
 * `llm` is injectable for the same reason the analyst's is: the browser path
 * reads the signed-in session, and tests must not. Failures propagate — unlike
 * the deck narrative, there is no useful fallback here, because without a plan
 * there are no widgets to build.
 */
export async function suggestGovernedWidgets(args: {
  model: MetricModelOption;
  focus?: string;
  aiModel?: string;
  llm: LlmJsonFn;
}): Promise<GovernedPlanResult> {
  const raw = await args.llm<{
    title?: unknown;
    summary?: unknown;
    widgets?: unknown;
  }>({
    systemPrompt: GOVERNED_PLANNER_SYSTEM,
    userPrompt:
      describeModelForPlanner(args.model) +
      (args.focus?.trim() ? `\nFocus the dashboard on: ${args.focus.trim()}\n` : "") +
      `\nReturn JSON: { "title": "dashboard title", "summary": "2-3 sentence executive summary", ` +
      `"widgets": [ …the array described above… ] }`,
    temperature: 0.3,
    maxTokens: 3000,
    model: args.aiModel,
  });

  return {
    title:
      typeof raw?.title === "string" && raw.title.trim()
        ? raw.title.trim()
        : args.model.label || args.model.name,
    summary: typeof raw?.summary === "string" ? raw.summary.trim() : "",
    plan: validatePlan(raw?.widgets, args.model),
  };
}
