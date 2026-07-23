// metric_query agent tool — lets an agent query GOVERNED semantic metrics
// instead of writing raw SQL. The model picks metric/dimension names from the
// semantic catalog; the compiler turns that into consistent SQL (so "revenue"
// always means the same thing). Owner-scoped exactly like sql_query.
import type { ToolDef, AgentToolContext } from "./registry.server";
import {
  listSemanticModels,
  runSemanticQuery,
} from "@/utils/semantic/query.server";
import { formatSemanticCatalog, type SemanticFilter } from "@/lib/semanticLayer";

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
          description: "Optional filters. Each: {field, op, value}. op ∈ =,!=,>,>=,<,<=,in,not_in,contains.",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              op: { type: "string" },
              value: {},
            },
            required: ["field", "op", "value"],
          },
        },
        limit: { type: "number", description: "Max rows (default 1000)." },
      },
      required: ["model", "metrics"],
    },
  },
};

/** Compact catalog to append to the tool description at assembly time. */
export async function semanticCatalogForCtx(
  ctx: AgentToolContext,
): Promise<{ count: number; text: string }> {
  const models = await listSemanticModels(ctx.sb, ctx.scopeUserId ?? undefined);
  return { count: models.length, text: formatSemanticCatalog(models) };
}

type MetricArgs = {
  model?: string;
  metrics?: unknown;
  dimensions?: unknown;
  filters?: unknown;
  limit?: number;
};

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
      query: { model, metrics, dimensions, filters, limit: args.limit },
      maxRows: RESULT_ROW_CAP,
    });
    const rows = res.rows.slice(0, RESULT_ROW_CAP);
    return (
      `model: ${res.model}\nsql: ${res.sql}\n` +
      `${rows.length} row(s):\n${JSON.stringify(rows)}`
    );
  } catch (e) {
    return `metric_query failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
