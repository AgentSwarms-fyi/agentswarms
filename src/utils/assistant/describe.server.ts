// Reading one of the reader's things for the assistant (R552).
//
// Every read uses the READER'S OWN client, so row-level security decides
// whether the thing can be seen at all — the same answer its page gets. Each
// kind reads a named list of columns (a test refuses one that names a
// credential, a prompt's text, a pipeline's code or its secrets), and the
// words are made by `@/lib/describeThing`.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  describeAgent,
  describeDashboard,
  describeDataset,
  describeGeneric,
  describeModel,
  describePipeline,
  describeSwarm,
  describeWorkflow,
  headline,
} from "@/lib/describeThing";
import { healthLine } from "@/lib/mlHealth";
import { isObjectKindId, OBJECT_KINDS, objectKind, type ObjectKindId } from "@/lib/objectKinds";
import { SEALED_NAMES } from "@/utils/objectSearch/extras.server";
import { readObjectsByIds } from "@/utils/objectSearch/sources.server";
import type { AgentToolContext, ToolDef } from "@/utils/tools/registry.server";
import { hrefOf } from "./tools.server";

type Sb = SupabaseClient<Database>;
type Row = Record<string, unknown>;

/** The columns each kind reads. Nothing outside these is ever selected. */
export const DESCRIBE_COLUMNS: Partial<Record<ObjectKindId, { table: string; columns: string }>> = {
  ml_model: {
    table: "ml_models",
    columns:
      "id, name, description, task, target_column, source, feature_columns, production_version_id, updated_at, user_id",
  },
  dataset: {
    table: "user_data_tables",
    columns:
      "id, name, columns, parquet_rows, source_filename, storage_mode, data_loaded_at, is_sample, updated_at, user_id",
  },
  dashboard: {
    table: "bi_dashboards",
    columns: "id, name, description, pages, widgets, published, updated_at, user_id",
  },
  workflow: {
    table: "workflows",
    columns:
      "id, name, description, graph, cron_expr, timezone, is_active, last_run_at, last_run_status, updated_at, user_id",
  },
  agent: {
    table: "agents",
    columns:
      "id, name, description, llm_provider, llm_model, tools, knowledge_base_id, is_active, updated_at, user_id",
  },
  swarm: {
    table: "swarms",
    columns: "id, name, description, nodes, is_deployed, published_at, updated_at, user_id",
  },
  etl_pipeline: {
    table: "etl_pipelines",
    columns:
      "id, name, description, engine, mode, cron_expr, timezone, is_active, last_run_at, last_run_status, updated_at, user_id",
  },
};

const NOT_FOUND =
  "Nothing of that kind with that id is open to this user. Say you could not find it; do not guess what it holds.";

/** A few lines about one thing, read as the reader, or why not. */
export async function describeThing(
  sb: Sb,
  userId: string,
  kindRaw: unknown,
  idRaw: unknown,
): Promise<string> {
  if (!isObjectKindId(kindRaw)) return "Name the kind of thing, as find_my_work gives it.";
  const kind: ObjectKindId = kindRaw;
  const id = typeof idRaw === "string" ? idRaw.trim().slice(0, 400) : "";
  if (!id) return "Give the thing's id, as find_my_work or the mention gives it.";
  const label = objectKind(kind).label;
  const spec = DESCRIBE_COLUMNS[kind];

  if (!spec) {
    // Every other kind: what search knows about it, read with the same rules.
    const entries = await readObjectsByIds(sb, userId, { [kind]: [id] }, SEALED_NAMES);
    const e = entries.find((x) => x.kind === kind && x.id === id);
    if (!e) return NOT_FOUND;
    return [
      headline({ name: e.name, href: hrefOf(e), kindLabel: label, mine: e.mine, sample: e.sample }),
      ...describeGeneric(e.detail, e.updatedAt),
    ].join("\n");
  }

  const { data, error } = await sb
    .from(spec.table as "agents")
    .select(spec.columns)
    .eq("id", id)
    .maybeSingle();
  const row = data as Row | null;
  if (error || !row) return NOT_FOUND;
  const name = typeof row.name === "string" ? row.name : "";
  const head = headline({
    name,
    href: hrefOf({ kind, id, name }),
    kindLabel: label,
    mine: row.user_id === userId,
    sample: row.is_sample === true,
  });

  let lines: string[];
  switch (kind) {
    case "ml_model":
      lines = await modelLines(sb, row);
      break;
    case "dataset":
      lines = describeDataset(row);
      break;
    case "dashboard":
      lines = describeDashboard(row);
      break;
    case "workflow":
      lines = describeWorkflow(row);
      break;
    case "agent":
      lines = describeAgent(row);
      break;
    case "swarm":
      lines = describeSwarm(row);
      break;
    default:
      lines = describePipeline(row);
  }
  return [head, ...lines].join("\n");
}

async function modelLines(sb: Sb, row: Row): Promise<string[]> {
  const versionId =
    typeof row.production_version_id === "string" ? row.production_version_id : null;
  let production: {
    version: number;
    algorithm: string | null;
    metric?: string;
    value?: number | null;
  } | null = null;
  if (versionId) {
    const { data: v } = await sb
      .from("ml_model_versions")
      .select("version, algorithm, metrics")
      .eq("id", versionId)
      .maybeSingle();
    if (v) {
      const { ML_PRIMARY_METRIC } = await import("@/utils/ml/types");
      const metric = ML_PRIMARY_METRIC[row.task as keyof typeof ML_PRIMARY_METRIC];
      const m = (v.metrics ?? {}) as Record<string, unknown>;
      production = {
        version: v.version,
        algorithm: v.algorithm ?? null,
        metric,
        value: metric && typeof m[metric] === "number" ? (m[metric] as number) : null,
      };
    }
  }
  // The health sentence is the one that already travels with a model to
  // agents and the Analyst (R546): headlines, never another caller's rows.
  let health: string | null = null;
  if (versionId) {
    try {
      const { modelHealthFor } = await import("@/utils/ml/health.server");
      const h = await modelHealthFor([{ id: String(row.id), production_version_id: versionId }]);
      health = healthLine(h.get(String(row.id)));
    } catch {
      health = null;
    }
  }
  return describeModel(row, production, health);
}

// ── describe_my_thing ───────────────────────────────────────────────────

export const describeMyThingTool: ToolDef = {
  type: "function",
  function: {
    name: "describe_my_thing",
    description:
      "Read a few plain facts about one of the user's own things: what it is, whose, and what " +
      "matters first (a model's task, production version and health; a dataset's columns and " +
      "rows; a dashboard's pages and visual titles; a workflow's steps, schedule and last run; " +
      "an agent's model and tools). Use it when the user asks about a thing they mentioned, the " +
      "thing open on their page, or one find_my_work returned, with that thing's kind and id.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: OBJECT_KINDS.map((k) => k.id),
          description: "The kind of thing, e.g. ml_model or dashboard.",
        },
        id: { type: "string", description: "Its id, exactly as given." },
      },
      required: ["kind", "id"],
    },
  },
};

export async function runDescribeMyThing(
  ctx: AgentToolContext,
  args: { kind?: string; id?: string },
): Promise<string> {
  // The reader's own token, or nothing: a headless run's client is the
  // service role, which would read every tenant's things.
  if (ctx.scopeUserId || !ctx.authToken) {
    return "Reading the user's things works only in the signed-in app.";
  }
  return describeThing(ctx.sb, ctx.userId, args?.kind, args?.id);
}
