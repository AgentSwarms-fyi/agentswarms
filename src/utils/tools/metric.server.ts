// metric_query agent tool — lets an agent query GOVERNED semantic metrics
// instead of writing raw SQL. The model picks metric/dimension names from the
// semantic catalog; the compiler turns that into consistent SQL (so "revenue"
// always means the same thing). Owner-scoped exactly like sql_query.
import type { ToolDef, AgentToolContext } from "./registry.server";
import { listSemanticModels, runSemanticQuery } from "@/utils/semantic/query.server";
import {
  COMPARE_PERIODS,
  formatSemanticCatalog,
  TIME_GRAINS,
  type ComparePeriod,
  type SemanticFilter,
  type TimeGrain,
} from "@/lib/semanticLayer";

const RESULT_ROW_CAP = 50;

export const metricQueryTool: ToolDef = {
  type: "function",
  function: {
    name: "metric_query",
    description:
      "Query the organization's GOVERNED semantic metrics and dimensions and return the actual result rows. " +
      "Prefer this over sql_query whenever the question maps to a defined metric — it guarantees the business " +
      "definition (e.g. revenue, active_customers) is computed consistently. Pick metric and dimension NAMES " +
      "from the catalog below; never invent names. Do not write SQL — call this tool and answer from the rows.",
    parameters: {
      type: "object",
      properties: {
        model: { type: "string", description: "Semantic model name from the catalog." },
        metrics: {
          type: "array",
          items: { type: "string" },
          description: "Metric names to compute.",
        },
        dimensions: {
          type: "array",
          items: { type: "string" },
          description: "Dimension names to group by (optional).",
        },
        filters: {
          type: "array",
          description:
            "Optional filters. Each: {field, op, value}. " +
            "op ∈ =,!=,>,>=,<,<=,in,not_in,contains. " +
            "For dates prefer a RELATIVE op over a hard-coded range — " +
            "last_n_days (value = number of days, today included), this_month, last_month, " +
            "this_quarter, last_quarter, ytd. These take no value except last_n_days, " +
            "apply only to a TIME dimension, and resolve against today at query time.",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              op: { type: "string" },
              value: {},
            },
            // `value` is NOT required: every relative-date op except
            // last_n_days takes none, and demanding one would make the model
            // invent a filler that the compiler then has to ignore.
            required: ["field", "op"],
          },
        },
        grains: {
          type: "object",
          description:
            'Optional time rollup per TIME dimension, e.g. {"order_date":"month"}. Values: day|week|month|quarter|year.',
          additionalProperties: { type: "string" },
        },
        compare: {
          type: "string",
          enum: ["prior_period", "mom", "yoy"],
          description:
            "Optional period-over-period comparison. Adds <metric>_prev, <metric>_change and " +
            "<metric>_pct_change (a fraction: 0.25 is +25%). Requires exactly ONE time dimension " +
            "with a grain — that is the axis compared. prior_period steps back one unit of that " +
            "grain; mom one month; yoy one year. A period with no predecessor gets NULL rather " +
            "than being dropped, and pct_change is NULL when the earlier value was zero.",
        },
        limit: { type: "number", description: "Max rows (default 1000)." },
      },
      required: ["model", "metrics"],
    },
  },
};

/** Granted semantic-model ids for a headless (service-role) caller. */
async function grantedModelIdsFor(ctx: AgentToolContext): Promise<string[] | undefined> {
  if (!ctx.scopeUserId) return undefined;
  const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
  const ids = await resolveGrantedResourceIds(ctx.sb, ctx.scopeUserId, "semantic_model");
  return [...ids];
}

/** Compact catalog to append to the tool description at assembly time. */
export async function semanticCatalogForCtx(
  ctx: AgentToolContext,
): Promise<{ count: number; text: string }> {
  // User-JWT callers: RLS returns own + shared. Headless: gate to owner + grants.
  const scope = ctx.scopeUserId
    ? { ownerId: ctx.scopeUserId, grantedIds: await grantedModelIdsFor(ctx) }
    : undefined;
  const models = await listSemanticModels(ctx.sb, scope);
  return { count: models.length, text: formatSemanticCatalog(models) };
}

type MetricArgs = {
  model?: string;
  metrics?: unknown;
  dimensions?: unknown;
  filters?: unknown;
  grains?: unknown;
  compare?: unknown;
  limit?: number;
};

/** A comparison the compiler knows, or nothing — never a guess. */
function sanitizeCompare(v: unknown): ComparePeriod | undefined {
  return typeof v === "string" && (COMPARE_PERIODS as readonly string[]).includes(v)
    ? (v as ComparePeriod)
    : undefined;
}

/** Keep only well-formed {dimension: grain} entries from model-authored args. */
function sanitizeGrains(v: unknown): Record<string, TimeGrain> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, TimeGrain> = {};
  for (const [k, g] of Object.entries(v as Record<string, unknown>)) {
    if (typeof g === "string" && (TIME_GRAINS as readonly string[]).includes(g)) {
      out[k] = g as TimeGrain;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

export async function runMetricQuery(ctx: AgentToolContext, args: MetricArgs): Promise<string> {
  const model = typeof args.model === "string" ? args.model : "";
  if (!model) return "Error: `model` is required (a semantic model name from the catalog).";
  const metrics = asStringArray(args.metrics);
  const dimensions = asStringArray(args.dimensions);
  if (metrics.length === 0 && dimensions.length === 0) {
    return "Error: provide at least one metric (or dimension).";
  }
  const filters = Array.isArray(args.filters) ? (args.filters as SemanticFilter[]) : [];

  try {
    const res = await runSemanticQuery({
      sb: ctx.sb,
      userId: ctx.userId,
      scopeUserId: ctx.scopeUserId ?? undefined,
      grantedModelIds: await grantedModelIdsFor(ctx),
      query: {
        model,
        metrics,
        dimensions,
        filters,
        grains: sanitizeGrains(args.grains),
        compare: sanitizeCompare(args.compare),
        limit: args.limit,
      },
      maxRows: RESULT_ROW_CAP,
    });
    const rows = res.rows.slice(0, RESULT_ROW_CAP);
    return (
      `model: ${res.model}\nsql: ${res.sql}\n` + `${rows.length} row(s):\n${JSON.stringify(rows)}`
    );
  } catch (e) {
    return `metric_query failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
