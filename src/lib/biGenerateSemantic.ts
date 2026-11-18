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

/**
 * What each governed shape needs from the query: how many dimensions and
 * metrics, whether a dimension has to be a time, and a line for the planner.
 *
 * Six shapes until R507. The rest of the visuals the builder offers were out
 * of reach of a dashboard generated from a semantic model, although a query
 * of metrics by dimensions fills most of them; lib/biSemanticCharts builds
 * each one from the query.
 */
type GovernedShape = {
  dims: [number, number];
  metrics: [number, number];
  /** "first": the first dimension must be a time; "one": a lone dimension must be. */
  time?: "first" | "one";
  /** Forced rollup on the time dimension (a calendar is a square per day). */
  grain?: PlannerGrain;
  plan: string;
};

export const GOVERNED_SHAPES: Record<SemanticChartType, GovernedShape> = {
  kpi: {
    dims: [0, 1],
    metrics: [1, 1],
    time: "one",
    plan: "one metric, no dimension (a headline figure); or one TIME dimension, which shows the latest period against the one before with a trend line",
  },
  gauge: { dims: [0, 0], metrics: [1, 1], plan: "one metric, no dimension, against a maximum" },
  insight: {
    dims: [1, 1],
    metrics: [1, 1],
    plan: "1 dimension, one metric: a sentence computed from the data (who leads; or, over a time dimension, what changed)",
  },
  bar: {
    dims: [1, 2],
    metrics: [1, 4],
    plan: "1-2 dimensions; with one dimension up to 4 metrics side by side",
  },
  hbar: { dims: [1, 1], metrics: [1, 4], plan: "1 dimension, ranked bars" },
  line: {
    dims: [1, 2],
    metrics: [1, 4],
    plan: "1-2 dimensions, best over a time dimension; with one dimension up to 4 metrics as lines",
  },
  area: {
    dims: [1, 2],
    metrics: [1, 1],
    plan: "1-2 dimensions, one metric, over a time dimension",
  },
  scolumn: {
    dims: [2, 2],
    metrics: [1, 1],
    plan: "exactly 2 dimensions: parts of a total per category",
  },
  shbar: {
    dims: [2, 2],
    metrics: [1, 1],
    plan: "exactly 2 dimensions, as horizontal stacked bars",
  },
  combo: {
    dims: [1, 1],
    metrics: [2, 4],
    plan: "1 dimension, 2-4 metrics on different scales (bars and a line)",
  },
  scatter: {
    dims: [1, 1],
    metrics: [2, 3],
    plan: "1 dimension (the points), 2-3 metrics (x, y, size)",
  },
  pie: {
    dims: [1, 1],
    metrics: [1, 1],
    plan: "exactly 1 dimension, one metric (shares of a whole)",
  },
  nightingale: { dims: [1, 1], metrics: [1, 1], plan: "1 dimension of 12 or fewer values" },
  funnel: { dims: [1, 1], metrics: [1, 1], plan: "1 dimension of sequential stages" },
  radialbar: { dims: [1, 1], metrics: [1, 1], plan: "1 dimension of 8 or fewer values" },
  treemap: {
    dims: [1, 1],
    metrics: [1, 2],
    plan: "1 dimension; a second metric colours the tiles",
  },
  pareto: {
    dims: [1, 1],
    metrics: [1, 1],
    plan: "1 dimension: which few values make most of the total",
  },
  pictogram: {
    dims: [1, 1],
    metrics: [1, 1],
    plan: "1 dimension of 6 or fewer values, counts of people or things",
  },
  waterfall: { dims: [1, 1], metrics: [1, 1], plan: "1 dimension of additive contributions" },
  wordcloud: { dims: [1, 1], metrics: [1, 1], plan: "1 text dimension, sized by the metric" },
  map: { dims: [1, 1], metrics: [1, 1], plan: "1 dimension of countries or US states" },
  bubblemap: {
    dims: [1, 1],
    metrics: [1, 1],
    plan: "1 dimension of countries or US states, as circles",
  },
  calendar: {
    dims: [1, 1],
    metrics: [1, 1],
    time: "first",
    grain: "day",
    plan: "1 TIME dimension, one square per day",
  },
  radar: {
    dims: [1, 2],
    metrics: [1, 6],
    plan: "1 dimension (spokes) and several metrics, or a second dimension as series",
  },
  heatmap: { dims: [2, 2], metrics: [1, 1], plan: "exactly 2 dimensions, one metric as colour" },
  sankey: {
    dims: [2, 2],
    metrics: [1, 1],
    plan: "exactly 2 dimensions: flows from the first to the second",
  },
  smallmultiples: {
    dims: [2, 2],
    metrics: [1, 1],
    plan: "exactly 2 dimensions: the first on each panel's axis (often time), one panel per value of the second",
  },
  matrix: {
    dims: [2, 3],
    metrics: [1, 4],
    plan: "2-3 dimensions (rows, columns, a nested row level) and 1-4 metrics: a pivot",
  },
  table: { dims: [0, 4], metrics: [1, 8], plan: "0-4 dimensions, one or more metrics" },
};

/** Chart shapes a governed widget can take. Mirrors SemanticChartType. */
export const GOVERNED_CHART_TYPES = Object.keys(GOVERNED_SHAPES) as SemanticChartType[];

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
 * A KPI grouped by a category is a category list pretending to be one number;
 * a pie with two is a chart nobody can read. Enforced rather than trusted,
 * because a planner asked for "variety" will reach for shapes that do not fit.
 */
const DIMENSION_RULES = Object.fromEntries(
  Object.entries(GOVERNED_SHAPES).map(([k, v]) => [k, { min: v.dims[0], max: v.dims[1] }]),
) as Record<SemanticChartType, { min: number; max: number }>;

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
  const shape = GOVERNED_SHAPES[chartType];
  const times = new Set(timeDimensions(model));
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
  // A KPI over a category shows one category's figure as the total; over a
  // time it shows the latest period against the one before.
  if (shape.time === "one" && dimensions.length === 1 && !times.has(dimensions[0])) {
    return reject(
      `A ${chartType} shows a single figure and cannot be grouped by a dimension that is not a time`,
    );
  }
  if (shape.time === "first" && !times.has(dimensions[0])) {
    return reject(`A ${chartType} needs a time dimension, and "${dimensions[0]}" is not one`);
  }
  if (metrics.length < shape.metrics[0]) {
    return reject(`A ${chartType} chart needs at least ${shape.metrics[0]} metrics`);
  }
  if (metrics.length > shape.metrics[1]) {
    return reject(
      shape.metrics[1] === 1
        ? `A ${chartType} chart shows one metric`
        : `A ${chartType} chart cannot show more than ${shape.metrics[1]} metrics`,
    );
  }
  // More than one metric beside a second dimension: the second dimension
  // splits the chart, so the extra metrics would never be drawn.
  if (
    dimensions.length === 2 &&
    metrics.length > 1 &&
    (chartType === "bar" || chartType === "line" || chartType === "radar")
  ) {
    return reject(`A ${chartType} split by a second dimension shows one metric`);
  }

  // Grains: only on a declared TIME dimension that this widget actually groups
  // by, and only a rollup the compiler knows. A grain on a non-time dimension
  // compiles to a date truncation over something that is not a date.
  let grains: Record<string, PlannerGrain> | undefined;
  if (raw?.grains && typeof raw.grains === "object") {
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

  // A calendar is a square per day, whatever rollup was asked for.
  if (shape.grain && dimensions[0]) {
    const asked = grains?.[dimensions[0]];
    if (asked && asked !== shape.grain) {
      return reject(`A ${chartType} draws one square per ${shape.grain}, not per ${asked}`);
    }
    grains = { ...(grains ?? {}), [dimensions[0]]: shape.grain };
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
  orderBy?: Array<{ field: string; dir?: "asc" | "desc" }>;
  limit?: number;
} {
  // A calendar is a square per day and shows the latest 400 of them, so it
  // asks for those: newest first, under the widget's snapshot cap. Ascending
  // with a limit would have drawn the oldest days in the model.
  if (widget.chartType === "calendar" && widget.dimensions[0]) {
    return {
      model: modelName,
      metrics: widget.metrics,
      dimensions: widget.dimensions,
      ...(widget.grains ? { grains: widget.grains } : {}),
      orderBy: [{ field: widget.dimensions[0], dir: "desc" }],
      limit: 400,
    };
  }
  // A time axis oldest first: a governed query has no order of its own, and
  // quarters reached a combo as 2024-10, 2024-04, 2022-04 (R507).
  const time = widget.dimensions.find((d) => widget.grains?.[d]);
  return {
    model: modelName,
    metrics: widget.metrics,
    ...(widget.dimensions.length ? { dimensions: widget.dimensions } : {}),
    ...(widget.grains ? { grains: widget.grains } : {}),
    ...(time ? { orderBy: [{ field: time, dir: "asc" as const }] } : {}),
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
${Object.entries(GOVERNED_SHAPES)
  .map(([k, v]) => `  ${k.padEnd(14)} - ${v.plan}`)
  .join("\n")}

Use "grains" only on a dimension typed as time, and only one of:
day, week, month, quarter, year.

Return STRICT JSON: an array of
{
  "title": "short widget title",
  "chartType": "${GOVERNED_CHART_TYPES.join("|")}",
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
