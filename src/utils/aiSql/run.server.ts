// AI functions in SQL, the running half: register ai_* as DuckDB scalar
// functions on a connection, answer them from a cache, and resolve what the
// cache does not have through the platform's own model channel.
//
// A DuckDB scalar function is synchronous and a model call is not, so a
// statement runs in passes. Pass one evaluates every ai_* call against the
// session cache; a miss returns NULL and is written down. The misses are then
// answered - the durable cache first, then the model, under the instance's
// per-statement call limit - and the statement runs again, now answered. Two
// passes cover every statement whose AI calls do not feed each other; a
// nested ai_summarize(ai_translate(...)) takes one more. The re-run costs a
// scan of small data; the alternative, rewriting the SQL around the calls, is
// where the bugs live.
//
// Every model call goes through /api/chat on the internal channel, the same
// door agents, swarms and the AI gateway use, so the model rules in IAM, the
// budget, the trace and the cost accounting apply per call without a second
// implementation. The cache is keyed per user and per model, so a user never
// reads an answer they could not have asked for.
import {
  ANY,
  BOOLEAN,
  DuckDBScalarFunction,
  VARCHAR,
  type DuckDBConnection,
} from "@duckdb/node-api";
import { createHash } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  AI_SQL_FUNCTIONS,
  aiCallIdentity,
  aiCallsOverCapMessage,
  buildAiPrompt,
  normalizeAiAnswer,
  parseAiArgs,
  usesAiSqlFunctions,
  type AiCall,
  type AiSqlFunction,
} from "@/utils/aiSql/core";
import { auditEvent } from "@/utils/audit.server";
import { GATEWAY_PROVIDERS } from "@/utils/gateway/providers";
import { parseGatewayModel } from "@/utils/gateway/keys";
import { internalChatText } from "@/utils/internalChat.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";

/** Passes a statement may take: two for flat calls, one more per nesting level. */
const MAX_PASSES = 4;
/** Model calls in flight at once for one statement. */
const CONCURRENCY = 4;
/** One model call must answer within this, or the statement fails. */
const CALL_TIMEOUT_MS = 90_000;

export type AiSqlStats = {
  /** Model calls this statement made. */
  calls: number;
  /** Answers served from the durable cache. */
  cached: number;
  functions: AiSqlFunction[];
  models: string[];
  /** Cost reported by the model channel, summed; null when it reported none. */
  cost_usd: number | null;
};

type Miss = { call: AiCall; model: string };

export type AiSqlSession = {
  userId: string;
  defaultModel: string;
  cap: number;
  cacheTtlDays: number;
  /** Cache key -> answer. A null answer is a real answer (the model found no label). */
  answers: Map<string, string | null>;
  misses: Map<string, Miss>;
  stats: AiSqlStats;
  decisionId?: string;
};

function keyOf(userId: string, identity: string): string {
  return createHash("sha256").update(`${userId}\n${identity}`).digest("hex");
}

/** "provider/model" checked against the providers this instance knows. */
function resolveModel(spec: string | null, session: AiSqlSession): string {
  const s = spec ?? session.defaultModel;
  const target = parseGatewayModel(s, GATEWAY_PROVIDERS);
  if (!target || target.kind !== "model") {
    throw new Error(
      `Unknown model "${s}". Write it as provider/model, for example openrouter/google/gemini-3-flash-preview.`,
    );
  }
  return `${target.provider}/${target.model}`;
}

/** What DuckDB hands over for an argument, as the text the model will see. */
function argText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

export async function openAiSqlSession(
  userId: string,
  opts: { decisionId?: string } = {},
): Promise<AiSqlSession> {
  const settings = await getPlatformResources();
  return {
    userId,
    defaultModel: settings.aiSqlDefaultModel,
    cap: settings.aiSqlMaxCallsPerStatement,
    cacheTtlDays: settings.aiSqlCacheTtlDays,
    answers: new Map(),
    misses: new Map(),
    stats: { calls: 0, cached: 0, functions: [], models: [], cost_usd: null },
    decisionId: opts.decisionId,
  };
}

/**
 * Register the named ai_* functions on a connection. Arguments are ANY so a
 * number, a date or a decimal reads naturally; NULL in any argument yields
 * NULL without a call, the way every scalar function behaves.
 */
export function registerAiSqlFunctions(
  conn: DuckDBConnection,
  session: AiSqlSession,
  fns: readonly AiSqlFunction[],
): void {
  for (const fn of fns) {
    if (!AI_SQL_FUNCTIONS.includes(fn)) continue;
    if (!session.stats.functions.includes(fn)) session.stats.functions.push(fn);
    const isBool = fn === "ai_filter";
    conn.registerScalarFunction(
      DuckDBScalarFunction.create({
        name: fn,
        returnType: isBool ? BOOLEAN : VARCHAR,
        varArgsType: ANY,
        // The cache changes between passes, so the planner must not fold a
        // constant call once and keep the NULL.
        volatile: true,
        mainFunction: (info, input, output) => {
          const vectors = [];
          for (let i = 0; i < input.columnCount; i++) vectors.push(input.getColumnVector(i));
          for (let r = 0; r < input.rowCount; r++) {
            const raw = vectors.map((v) => v.getItem(r) as unknown);
            if (raw.some((v) => v === null || v === undefined)) {
              output.setItem(r, null);
              continue;
            }
            const parsed = parseAiArgs(fn, raw.map(argText), GATEWAY_PROVIDERS);
            if (!parsed.ok) {
              info.setError(parsed.error);
              return;
            }
            let model: string;
            try {
              model = resolveModel(parsed.call.model, session);
            } catch (e) {
              info.setError((e as Error).message);
              return;
            }
            const key = keyOf(session.userId, aiCallIdentity(parsed.call, model));
            if (session.answers.has(key)) {
              const a = session.answers.get(key) ?? null;
              output.setItem(r, isBool ? (a === null ? null : a === "true") : a);
            } else {
              session.misses.set(key, { call: parsed.call, model });
              output.setItem(r, null);
            }
          }
          output.flush();
        },
      }),
    );
  }
}

async function callModel(session: AiSqlSession, miss: Miss): Promise<string | null> {
  const target = parseGatewayModel(miss.model, GATEWAY_PROVIDERS);
  if (!target || target.kind !== "model") throw new Error(`Unknown model "${miss.model}"`);
  const prompt = buildAiPrompt(miss.call);
  const { text, cost } = await internalChatText({
    userId: session.userId,
    decisionId: session.decisionId,
    agentName: "AI SQL",
    provider: target.provider,
    model: target.model,
    system: prompt.system,
    user: prompt.user,
    maxTokens: prompt.maxTokens,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  if (cost !== null) session.stats.cost_usd = (session.stats.cost_usd ?? 0) + cost;
  return normalizeAiAnswer(miss.call, text);
}

/**
 * Answer every miss the last pass wrote down: the durable cache first, then
 * the model, never more calls than the instance allows for one statement.
 */
export async function resolveAiSqlMisses(session: AiSqlSession): Promise<void> {
  const keys = [...session.misses.keys()];
  if (!keys.length) return;
  const nowIso = new Date().toISOString();
  for (let i = 0; i < keys.length; i += 200) {
    const slice = keys.slice(i, i + 200);
    const { data } = await supabaseAdmin
      .from("ai_function_cache")
      .select("key, answer")
      .eq("user_id", session.userId)
      .in("key", slice)
      .gt("expires_at", nowIso);
    for (const row of data ?? []) {
      session.answers.set(row.key, row.answer);
      session.misses.delete(row.key);
      session.stats.cached++;
    }
  }
  const pending = [...session.misses.entries()];
  if (!pending.length) return;
  if (session.stats.calls + pending.length > session.cap) {
    throw new Error(aiCallsOverCapMessage(session.stats.calls + pending.length, session.cap));
  }
  for (const [, m] of pending) {
    if (!session.stats.models.includes(m.model)) session.stats.models.push(m.model);
  }
  const expires = new Date(Date.now() + session.cacheTtlDays * 86_400_000).toISOString();
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const [key, miss] = pending[next++];
      const answer = await callModel(session, miss);
      session.stats.calls++;
      session.answers.set(key, answer);
      session.misses.delete(key);
      await supabaseAdmin.from("ai_function_cache").upsert(
        {
          key,
          user_id: session.userId,
          fn: miss.call.fn,
          model: miss.model,
          answer,
          expires_at: expires,
        },
        { onConflict: "key" },
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
}

/**
 * Run a statement that may call ai_* functions: register them, run, answer
 * the misses, run again. `execute` is the statement as the caller would have
 * run it; it is called once per pass. Statements without AI calls run once,
 * untouched.
 */
export async function runWithAiSql<T>(
  conn: DuckDBConnection,
  userId: string,
  sql: string,
  execute: () => Promise<T>,
  opts: { decisionId?: string; auditVia?: string } = {},
): Promise<{ result: T; ai: AiSqlStats | null }> {
  const fns = usesAiSqlFunctions(sql);
  if (!fns.length) return { result: await execute(), ai: null };
  const session = await openAiSqlSession(userId, { decisionId: opts.decisionId });
  registerAiSqlFunctions(conn, session, fns);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    session.misses.clear();
    const result = await execute();
    if (!session.misses.size) {
      if (session.stats.calls || session.stats.cached) {
        auditEvent({
          userId,
          action: "lakehouse.ai_functions",
          resourceType: "lakehouse",
          resourceName: session.stats.functions.join(", "),
          decisionId: opts.decisionId,
          detail: {
            functions: session.stats.functions,
            models: session.stats.models,
            calls: session.stats.calls,
            cached: session.stats.cached,
            cost_usd: session.stats.cost_usd,
            passes: pass + 1,
            via: opts.auditVia,
          },
        });
      }
      return { result, ai: session.stats };
    }
    await resolveAiSqlMisses(session);
  }
  throw new Error(
    `The AI calls in this statement feed each other more than ${MAX_PASSES - 1} levels deep. Split the statement into steps.`,
  );
}
