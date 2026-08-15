// Running one analyst turn SERVER-side, as the analyst's owner.
//
// The AI Analyst normally runs in the asking user's browser: their DuckDB
// holds the local datasets, their JWT compiles governed queries, their session
// reaches the model. An embedded analyst has none of those — the visitor is
// anonymous — so this module supplies each one from the OWNER's side of the
// wall, exactly as an embedded agent already answers with the owner's agent.
//
// It runs the SAME loop (runAnalystTurn). That matters more than it sounds:
// an embed that reimplemented the reasoning would drift from the product the
// owner tested, and the first anyone would know is a visitor being told
// something the analyst would never say. Only the three side-effecting
// dependencies are swapped.
//
// WHAT THE VISITOR CAN REACH, precisely:
//
//   • Only the analyst's own `source` — the named local datasets, or the one
//     warehouse connection. Not "the owner's data": the analyst's scope IS
//     the boundary, which is why the embed dialog tells owners to scope the
//     analyst before publishing.
//   • Governed metrics compile through runSemanticQuery under the OWNER's
//     id, so the owner's row filters and column masks still apply.
//   • Every model call is metered to the embed key, so the per-key budget cap
//     and the owner's IAM model rules both bite.
//
// Nothing here trusts anything from the visitor except the question text.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runAnalystTurn, type AnalystSource, type AnalystTurn } from "@/lib/aiAnalyst";
import type { LlmJsonOpts } from "@/lib/biAgent";
import { parseModelChoice } from "@/utils/providers/modelChoice";
import { llmJsonServer } from "@/utils/bi/llmJson.server";
import { runLocalSqlForUser } from "@/utils/bi/refresh.server";
import { runSemanticQuery } from "@/utils/semantic/query.server";
import type { DatasetMeta, QueryResult } from "@/lib/sqlEngine";
import type { SemanticQuery } from "@/lib/semanticLayer";

/** Same cap the scheduled refresh uses — a trace, not a data export. */
const ROW_CAP = 5000;

export type AnalystRunOutcome =
  | { ok: true; turn: AnalystTurn }
  | { ok: false; status: number; error: string };

/** The analyst row an embed is allowed to run, or null. */
export async function loadEmbeddedAnalyst(analystId: string, ownerId: string) {
  const { data } = await supabaseAdmin
    .from("ai_analysts")
    .select("id, user_id, name, model, source")
    .eq("id", analystId)
    .maybeSingle();
  // The embed key names an owner; an analyst belonging to someone else must
  // never resolve through it, however the key was obtained.
  if (!data || data.user_id !== ownerId) return null;
  return data;
}

/**
 * Dataset metadata for the prompt's schema section.
 *
 * Metadata only — names, columns, row counts. The rows themselves are loaded
 * by runLocalSqlForUser at execution time, so a 40-column table costs nothing
 * here beyond its column list.
 */
async function datasetsForSource(ownerId: string, source: AnalystSource): Promise<DatasetMeta[]> {
  if (source.kind !== "local") return [];
  // `row_count` is NOT a column here — the count lives in parquet_rows. Asking
  // for it made the whole query fail, which surfaced as "this analyst's
  // datasets are no longer available": a confident, actionable-sounding
  // message sending the owner to re-scope an analyst that was fine. That is
  // why the caller now distinguishes a FAILED read from an empty one.
  const { data, error } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, name, columns, user_id, is_sample, source_filename, parquet_rows")
    .or(`user_id.eq.${ownerId},is_sample.eq.true`);
  if (error) throw new Error(`Could not read the analyst's datasets: ${error.message}`);
  const all = (data ?? []).map(
    (t) =>
      ({
        id: t.id,
        name: t.name,
        source_filename: t.source_filename,
        is_sample: t.is_sample,
        user_id: t.user_id,
        columns: t.columns,
        // Row count is advisory in the prompt's schema section; 0 when the
        // table has no columnar mirror to read it from.
        row_count: typeof t.parquet_rows === "number" ? t.parquet_rows : 0,
      }) as unknown as DatasetMeta,
  );
  const wanted = source.tables ?? [];
  // An empty `tables` means "every local dataset", which is the analyst's own
  // convention — see the ai_analysts migration.
  return wanted.length === 0 ? all : all.filter((d) => wanted.includes(d.name));
}

/** Execute one step's SQL against whatever the analyst is scoped to. */
async function executorFor(
  ownerId: string,
  source: AnalystSource,
): Promise<{ execute?: (sql: string) => Promise<QueryResult>; dialect?: string }> {
  if (source.kind !== "warehouse") {
    // Local datasets: the same server-side engine the scheduled refresh uses.
    return {
      execute: async (sql: string) => {
        const res = await runLocalSqlForUser(ownerId, sql);
        return {
          columns: res.columns,
          rows: res.rows,
          row_count: res.rows.length,
          total_matched: res.rows.length,
          capped: false,
          duration_ms: 0,
        };
      },
    };
  }
  const { loadWarehouseConnectionForUser } = await import("@/utils/warehouse/connections.server");
  const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
  const conn = await loadWarehouseConnectionForUser(
    supabaseAdmin,
    { connectionId: source.connection_id },
    ownerId,
  );
  return {
    dialect: conn.config.provider,
    execute: async (sql: string) => {
      const res = await executeWarehouseQuery(conn.config, sql, ROW_CAP, { userId: ownerId });
      return {
        columns: res.columns.map((c) => c.name),
        rows: res.rows,
        row_count: res.rows.length,
        total_matched: res.rows.length,
        capped: res.rows.length >= ROW_CAP,
        duration_ms: 0,
      };
    },
  };
}

/**
 * Answer one question as the analyst's owner.
 *
 * A thrown error becomes a refused RESULT rather than a 500: the visitor
 * needs to know the analyst could not answer, and the host developer needs
 * the reason, and neither is served by a stack trace.
 */
export async function runAnalystTurnServer(args: {
  analystId: string;
  ownerId: string;
  question: string;
  priorTurns: AnalystTurn[];
  /** Meters the spend, so the embed key's budget cap applies. */
  costScope?: { type: "embed_key"; id: string };
  surface?: string;
  /**
   * Partial turns as the loop produces them, for streaming.
   *
   * A turn takes 30–95s. Without this the visitor stares at a spinner for a
   * minute and a half with no evidence anything is happening, which reads as
   * broken long before it finishes — and the trace, which is the whole point
   * of this analyst, arrives all at once at the end instead of unfolding.
   *
   * Callers streaming to an anonymous viewer MUST sanitise each snapshot, not
   * just the final turn: a partial carries the same step SQL as the last one.
   */
  onUpdate?: (turn: AnalystTurn) => void;
}): Promise<AnalystRunOutcome> {
  const analyst = await loadEmbeddedAnalyst(args.analystId, args.ownerId);
  if (!analyst) {
    return { ok: false, status: 404, error: "The embedded analyst no longer exists." };
  }
  const source = analyst.source as unknown as AnalystSource;

  // Model transport: the owner's credentials, the owner's IAM rules, metered
  // to the embed key. parseModelChoice splits the stored "provider::model".
  const choice = parseModelChoice(analyst.model);
  const llm = async <T>(opts: LlmJsonOpts): Promise<T> => {
    const inner = parseModelChoice(opts.model);
    const res = await llmJsonServer({
      userId: args.ownerId,
      iamClient: supabaseAdmin as unknown as Parameters<typeof llmJsonServer>[0]["iamClient"],
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      provider: inner?.provider ?? choice?.provider,
      model: inner?.model ?? choice?.model,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      surface: args.surface ?? `Embed Analyst: ${analyst.name}`,
      costScope: args.costScope,
    });
    // The loop's stages catch and degrade; a thrown Error carries the
    // specific reason (no credits, model not allowed, timed out) up to them
    // rather than a bare "failed".
    if (!res.ok) throw new Error(res.error);
    return res.result as T;
  };

  let executor: { execute?: (sql: string) => Promise<QueryResult>; dialect?: string };
  try {
    executor = await executorFor(args.ownerId, source);
  } catch (e) {
    return {
      ok: false,
      status: 503,
      error: `This analyst's data source is unavailable: ${(e as Error).message}`,
    };
  }

  // A FAILED read and an EMPTY one are different faults with different fixes,
  // and collapsing them is how "re-scope your analyst" got shown for a
  // malformed query against datasets that were perfectly fine.
  let datasets: DatasetMeta[];
  try {
    datasets = await datasetsForSource(args.ownerId, source);
  } catch (e) {
    return { ok: false, status: 503, error: (e as Error).message };
  }
  if (source.kind === "local" && datasets.length === 0) {
    // Saying "no data" would read as an answer. This is a configuration
    // fault on the owner's side and the message says whose.
    return {
      ok: false,
      status: 503,
      error: `This analyst is scoped to ${
        (source.tables ?? []).length > 0
          ? `"${(source.tables ?? []).join('", "')}", which no longer exists`
          : "local datasets, and there are none"
      }. The owner needs to re-scope it.`,
    };
  }

  try {
    const turn = await runAnalystTurn({
      question: args.question,
      datasets,
      semantics: new Map(),
      metrics: [],
      priorTurns: args.priorTurns,
      model: analyst.model,
      execute: executor.execute,
      dialect: executor.dialect,
      llm,
      // Governed steps still compile — under the OWNER's id, so their row
      // filters and column masks are applied exactly as they are in the app.
      runSemantic: async (query: SemanticQuery) => {
        const res = await runSemanticQuery({
          sb: supabaseAdmin as unknown as Parameters<typeof runSemanticQuery>[0]["sb"],
          userId: args.ownerId,
          query,
          maxRows: 1000,
        });
        return {
          sql: res.sql,
          columns: res.columns,
          rows: res.rows as Record<string, unknown>[],
          rollup: res.rollup,
          access_note: res.access_note,
        };
      },
      onUpdate: (t) => args.onUpdate?.(t),
    });
    return { ok: true, turn };
  } catch (e) {
    return { ok: false, status: 502, error: (e as Error).message.slice(0, 400) };
  }
}
