// Swarm run traces under their owner's user key (R449).
//
// A run keeps what went in and what came out: its input and final output, each
// step's input, output, thinking, tool calls, the memory and passages it used
// and what it extracted, a preview of what passed along each link, and, for a
// run still going or parked at an approval, its flow state. All of that is
// sealed by the app under the owner's user key (as model call traces are,
// sealedTraces.server), which a customer key wraps when the user is a
// customer's member. A reply kept for an Idempotency-Key is sealed too.
//
// What stays readable: the figures, statuses, times and error messages, which
// Swarm Traces, Analytics and the OpenTelemetry export read, and the run's graph
// snapshot, which is the swarm's own definition, kept readable as the swarm is.
//
// A step's `input` is never empty once it is sealed, and carries `body_sealed`,
// which is how the pass finds the steps left to do. Runs, links and checkpoints
// hold text, so the pass asks Postgres which of it is not yet sealed. Values
// stored before R449 are plaintext and read as they are.
//
// A trace must never break the run it records, so when the owner's key cannot
// be had a row loses its text and keeps its figures: nothing is left in the
// clear or put under another key. A checkpoint is different. A run resumes from
// it, so one without its state would be wrong: it is not written at all, and the
// run falls back to not being resumable.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  isSealedJson,
  openJson,
  SEALED_JSON_KEY,
  sealJson,
  unreadableReason,
} from "@/utils/chat/sealedThreads.server";
import { DataKeyUnavailableError } from "@/utils/kms/keyHierarchy.server";
import { isSealedText, openText, sealText } from "@/utils/providers/crypto.server";
import {
  fieldsOf,
  TRACE_DROPPED_MARK,
  TRACE_SEALED_MARK,
  type TraceSealing,
} from "./sealedTraces.server";
import type { RunPass } from "./tracePass";

const STEP_TEXT = ["output", "thinking"] as const;
const STEP_JSON = ["tool_calls", "memory_used", "rag_chunks", "data_extractions"] as const;

export const runWhere = {
  input: (id: string) => `swarm_runs/${id}/input_prompt`,
  output: (id: string) => `swarm_runs/${id}/final_output`,
  stepInput: (id: string) => `swarm_run_steps/${id}/input`,
  step: (id: string, column: string) => `swarm_run_steps/${id}/${column}`,
  edge: (id: string) => `swarm_run_edges/${id}/payload_preview`,
  ctx: (runId: string) => `swarm_run_checkpoints/${runId}/ctx`,
  lastOutput: (runId: string) => `swarm_run_checkpoints/${runId}/last_output`,
  reply: (apiKeyId: string, key: string) => `swarm_run_idempotency/${apiKeyId}/${key}/response`,
};

const DROPPED_INPUT = { [TRACE_SEALED_MARK]: true, [TRACE_DROPPED_MARK]: true };

type StepResult = {
  output?: string | null;
  thinking?: string | null;
  tool_calls?: unknown;
  memory_used?: unknown;
  rag_chunks?: unknown;
  data_extractions?: unknown;
};

function dropped(e: unknown): void {
  console.warn(`[swarm-trace] kept without its text: ${(e as Error).message}`);
}

/** A text as it is stored: sealed, as it is before the tables exist, null if its key cannot be had. */
async function sealOrDrop(
  text: string | null,
  owner: string,
  where: string,
): Promise<string | null> {
  if (!text) return text;
  try {
    return (await sealText(text, { owner, where })) ?? text;
  } catch (e) {
    dropped(e);
    return null;
  }
}

/** A run's input as it is stored. Never throws. */
export function sealRunInput(owner: string, runId: string, text: string | null) {
  return sealOrDrop(text, owner, runWhere.input(runId));
}

/** A run's final output as it is stored. Never throws. */
export function sealRunOutput(owner: string, runId: string, text: string | null) {
  return sealOrDrop(text, owner, runWhere.output(runId));
}

/** What passed along a link, as it is stored. Never throws. */
export function sealEdgePreview(owner: string, edgeId: string, text: string | null) {
  return sealOrDrop(text, owner, runWhere.edge(edgeId));
}

/**
 * A step's `input`, sealed and marked; null before the user-key tables exist.
 * One whose bodies were not kept (PERSIST_PROMPT_BODIES=false) is only marked,
 * so the pass can go on to the rest of the row.
 */
async function sealInputColumn(owner: string, id: string, input: unknown) {
  if (fieldsOf(input).redacted === true) return { redacted: true, [TRACE_SEALED_MARK]: true };
  const sealed = await sealText(JSON.stringify(input ?? {}), {
    owner,
    where: runWhere.stepInput(id),
  });
  return sealed ? { [TRACE_SEALED_MARK]: true, [SEALED_JSON_KEY]: sealed } : null;
}

/** A step's `input` as it is stored. Never throws. */
export async function sealStepInput(owner: string, id: string, input: unknown): Promise<unknown> {
  try {
    return (await sealInputColumn(owner, id, input)) ?? input;
  } catch (e) {
    dropped(e);
    return DROPPED_INPUT;
  }
}

/**
 * What a step left, sealed; null before the user-key tables exist. A column
 * already sealed is left. Throws DataKeyUnavailableError when the owner's key
 * cannot be had: never sealed under another key.
 */
async function sealStepColumns<T extends StepResult>(
  owner: string,
  id: string,
  result: T,
): Promise<T | null> {
  const out: Record<string, unknown> = { ...result };
  for (const column of STEP_TEXT) {
    const value = result[column];
    if (!value || isSealedText(value)) continue;
    const sealed = await sealText(value, { owner, where: runWhere.step(id, column) });
    if (!sealed) return null;
    out[column] = sealed;
  }
  for (const column of STEP_JSON) {
    const value = result[column];
    if (value === null || value === undefined || isSealedJson(value)) continue;
    const sealed = await sealJson(value, { owner, where: runWhere.step(id, column) });
    if (!sealed) return null;
    out[column] = sealed;
  }
  return out as T;
}

/**
 * What a step left, as it is stored. Never throws: when the owner's key cannot
 * be had the step keeps its figures and loses its text, and its `input` says so.
 */
export async function sealStepResult<T extends StepResult>(
  owner: string,
  id: string,
  result: T,
): Promise<T & { input?: unknown }> {
  try {
    return (await sealStepColumns(owner, id, result)) ?? result;
  } catch (e) {
    dropped(e);
    return {
      ...result,
      output: null,
      thinking: null,
      tool_calls: [],
      memory_used: [],
      rag_chunks: [],
      data_extractions: [],
      input: DROPPED_INPUT,
    };
  }
}

/**
 * A run's flow state, sealed under `owner`'s key and bound to the run; as it is
 * before the user-key tables exist. Its last output is always sealed, the empty
 * one too: that is how the pass finds the checkpoints left to do. Throws when
 * the key cannot be had, and the caller writes nothing: a run must not resume
 * from a state with the text gone.
 */
export async function sealCheckpoint<T extends { ctx: unknown; last_output: string | null }>(
  owner: string,
  runId: string,
  body: T,
): Promise<T> {
  const last_output = await sealText(body.last_output ?? "", {
    owner,
    where: runWhere.lastOutput(runId),
  });
  if (!last_output) return body;
  const ctx = await sealJson(body.ctx, { owner, where: runWhere.ctx(runId) });
  return { ...body, ctx, last_output };
}

/** A run's flow state, opened. Throws when it cannot be: a resume must not guess. */
export async function openCheckpoint<T extends { ctx: unknown; last_output: string | null }>(
  runId: string,
  row: T,
): Promise<T> {
  const [ctx, last_output] = await Promise.all([
    openJson<unknown>(row.ctx, runWhere.ctx(runId)),
    row.last_output ? openText(row.last_output, runWhere.lastOutput(runId)) : row.last_output,
  ]);
  return { ...row, ctx, last_output };
}

/** A run's input, opened, for a resume. Throws when it cannot be. */
export async function openRunInput(row: {
  id: string;
  input_prompt: string | null;
}): Promise<string | null> {
  return row.input_prompt ? openText(row.input_prompt, runWhere.input(row.id)) : row.input_prompt;
}

/**
 * The reply kept for an Idempotency-Key. Never throws. A reply that cannot be
 * sealed is not kept, and the record is left `failed`, so a retry runs again
 * rather than be handed nothing.
 */
export async function sealIdempotentReply(
  owner: string,
  apiKeyId: string,
  key: string,
  status: "completed" | "failed",
  body: unknown,
): Promise<{ status: "completed" | "failed"; response: unknown }> {
  try {
    const where = runWhere.reply(apiKeyId, key);
    return { status, response: (await sealJson(body, { owner, where })) ?? body };
  } catch (e) {
    dropped(e);
    return { status: "failed", response: null };
  }
}

/** The reply kept for an Idempotency-Key, opened. Throws when it cannot be. */
export function openIdempotentReply(stored: unknown, apiKeyId: string, key: string) {
  return openJson<Record<string, unknown>>(stored, runWhere.reply(apiKeyId, key));
}

/** A run, opened. One that cannot be keeps its figures and says why. */
export async function openRunRow<
  T extends { id: string; input_prompt: string | null; final_output: string | null },
>(row: T): Promise<T & { body_sealed: boolean; body_unreadable: string | null }> {
  const body_sealed =
    (!!row.input_prompt && isSealedText(row.input_prompt)) ||
    (!!row.final_output && isSealedText(row.final_output));
  try {
    const [input_prompt, final_output] = await Promise.all([
      openRunInput(row),
      row.final_output ? openText(row.final_output, runWhere.output(row.id)) : row.final_output,
    ]);
    return { ...row, input_prompt, final_output, body_sealed, body_unreadable: null };
  } catch (e) {
    return {
      ...row,
      input_prompt: null,
      final_output: null,
      body_sealed,
      body_unreadable: unreadableReason(e),
    };
  }
}

type StoredStep = {
  id: string;
  input: unknown;
  output: string | null;
  thinking: string | null;
  tool_calls: unknown;
  memory_used: unknown;
  rag_chunks: unknown;
  data_extractions: unknown;
};

/** A step, opened. One that cannot be keeps its figures and says why. */
export async function openStepRow<T extends StoredStep>(row: T): Promise<T & TraceSealing> {
  const stored = fieldsOf(row.input);
  const body_sealed = stored[TRACE_SEALED_MARK] === true;
  const body_dropped = stored[TRACE_DROPPED_MARK] === true;
  try {
    const opened = await Promise.all([
      isSealedJson(stored) ? openJson<unknown>(stored, runWhere.stepInput(row.id)) : null,
      ...STEP_TEXT.map((c) => {
        const value = row[c];
        return value ? openText(value, runWhere.step(row.id, c)) : value;
      }),
      ...STEP_JSON.map((c) => openJson<unknown>(row[c], runWhere.step(row.id, c))),
    ]);
    const [body, output, thinking, tool_calls, memory_used, rag_chunks, data_extractions] = opened;
    const input = isSealedJson(stored)
      ? body
      : body_dropped
        ? {}
        : stored.redacted === true
          ? { redacted: true }
          : row.input;
    return {
      ...row,
      input,
      output: output as string | null,
      thinking: thinking as string | null,
      tool_calls,
      memory_used,
      rag_chunks,
      data_extractions,
      body_sealed,
      body_dropped,
      body_unreadable: null,
    };
  } catch (e) {
    return {
      ...row,
      input: {},
      output: null,
      thinking: null,
      tool_calls: [],
      memory_used: [],
      rag_chunks: [],
      data_extractions: [],
      body_sealed,
      body_dropped,
      body_unreadable: unreadableReason(e),
    };
  }
}

/** A link, opened. One that cannot be keeps its figures and says why. */
export async function openEdgeRow<T extends { id: string; payload_preview: string | null }>(
  row: T,
): Promise<T & { body_unreadable: string | null }> {
  try {
    const payload_preview = row.payload_preview
      ? await openText(row.payload_preview, runWhere.edge(row.id))
      : row.payload_preview;
    return { ...row, payload_preview, body_unreadable: null };
  } catch (e) {
    return { ...row, payload_preview: null, body_unreadable: unreadableReason(e) };
  }
}

// ── The pass ─────────────────────────────────────────────────────────────────

const PAGE = 100;
const NO_ID = "00000000-0000-0000-0000-000000000000";

/* eslint-disable @typescript-eslint/no-explicit-any -- one walk over four tables; the row types differ. */
const table = (name: string): any => (supabaseAdmin as any).from(name);
type Row = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

const stillPlain = "ck1:%";

/**
 * Seal the run traces kept before R449: runs, their steps and links, and the
 * state of runs still parked. They share one limit. A row that cannot be sealed
 * (its owner's key cannot be had) is counted and left. A step not yet finished
 * has only its input sealed, since its finish writes the rest; a row is written
 * only if it is still as it was read.
 */
export async function sealOlderRuns(opts: { limit?: number } = {}): Promise<RunPass> {
  const r: RunPass = {
    runs: 0,
    steps: 0,
    edges: 0,
    checkpoints: 0,
    unreadable: 0,
    left: false,
    failed: 0,
    errors: [],
  };
  let budget = opts.limit ?? Number.POSITIVE_INFINITY;
  const fail = (what: string, e: unknown) => {
    if (e instanceof DataKeyUnavailableError) {
      r.unreadable++;
      return;
    }
    r.failed++;
    if (r.errors.length < 10) r.errors.push(`${what}: ${(e as Error).message}`);
  };

  /** One table, page by page. False stops the pass: no user keys yet, or the limit. */
  const walk = async (
    what: string,
    name: string,
    columns: string,
    idColumn: string,
    unsealed: (q: ReturnType<typeof table>) => ReturnType<typeof table>,
    seal: (row: Row) => Promise<boolean | "no-keys">,
  ): Promise<boolean> => {
    let cursor = NO_ID;
    for (;;) {
      const { data, error } = await unsealed(table(name).select(columns))
        .gt(idColumn, cursor)
        .order(idColumn)
        .limit(PAGE);
      if (error) {
        fail(what, new Error(error.message));
        return true;
      }
      const rows = (data ?? []) as Row[];
      for (const row of rows) {
        if (budget <= 0) {
          r.left = true;
          return false;
        }
        cursor = row[idColumn];
        try {
          const done = await seal(row);
          if (done === "no-keys") return false;
          if (done) budget--;
        } catch (e) {
          fail(`${what} ${row[idColumn]}`, e);
        }
      }
      if (rows.length < PAGE) return true;
    }
  };

  // A run can match both of its walks; one it could not seal is counted once.
  const triedRuns = new Set<string>();
  const sealRun = async (row: Row) => {
    if (triedRuns.has(row.id)) return false;
    triedRuns.add(row.id);
    const patch: Row = {};
    for (const [column, where] of [
      ["input_prompt", runWhere.input(row.id)],
      ["final_output", runWhere.output(row.id)],
    ] as const) {
      const value = row[column];
      if (!value || isSealedText(value)) continue;
      const sealed = await sealText(value, { owner: row.user_id, where });
      if (!sealed) return "no-keys" as const;
      patch[column] = sealed;
    }
    let q = table("swarm_runs").update(patch).eq("id", row.id);
    for (const column of Object.keys(patch)) q = q.not(column, "like", stillPlain);
    const { data: moved, error } = await q.select("id");
    if (error) throw new Error(error.message);
    if (!moved?.length) return false;
    r.runs++;
    return true;
  };
  // An empty value has nothing to seal, so the walks leave it out.
  const runColumns = "id, user_id, input_prompt, final_output";
  const goOn =
    (await walk(
      "runs",
      "swarm_runs",
      runColumns,
      "id",
      (q) => q.not("input_prompt", "like", stillPlain).neq("input_prompt", ""),
      sealRun,
    )) &&
    (await walk(
      "runs",
      "swarm_runs",
      runColumns,
      "id",
      (q) => q.not("final_output", "like", stillPlain).neq("final_output", ""),
      sealRun,
    )) &&
    (await walk(
      "steps",
      "swarm_run_steps",
      "id, user_id, status, finished_at, input, output, thinking, tool_calls, memory_used, rag_chunks, data_extractions",
      "id",
      (q) => q.is(`input->>${TRACE_SEALED_MARK}`, null),
      async (row) => {
        const input = await sealInputColumn(row.user_id, row.id, row.input);
        if (!input) return "no-keys";
        const patch: Row = { input };
        if (row.finished_at) {
          const { output, thinking, tool_calls, memory_used, rag_chunks, data_extractions } = row;
          const rest = await sealStepColumns(row.user_id, row.id, {
            output,
            thinking,
            tool_calls,
            memory_used,
            rag_chunks,
            data_extractions,
          });
          if (!rest) return "no-keys";
          Object.assign(patch, rest);
        }
        const { data: moved, error } = await table("swarm_run_steps")
          .update(patch)
          .eq("id", row.id)
          .eq("status", row.status)
          .is(`input->>${TRACE_SEALED_MARK}`, null)
          .select("id");
        if (error) throw new Error(error.message);
        if (!moved?.length) return false;
        r.steps++;
        return true;
      },
    )) &&
    (await walk(
      "links",
      "swarm_run_edges",
      "id, user_id, payload_preview",
      "id",
      (q) => q.not("payload_preview", "like", stillPlain).neq("payload_preview", ""),
      async (row) => {
        const sealed = await sealText(row.payload_preview, {
          owner: row.user_id,
          where: runWhere.edge(row.id),
        });
        if (!sealed) return "no-keys";
        const { data: moved, error } = await table("swarm_run_edges")
          .update({ payload_preview: sealed })
          .eq("id", row.id)
          .not("payload_preview", "like", stillPlain)
          .select("id");
        if (error) throw new Error(error.message);
        if (!moved?.length) return false;
        r.edges++;
        return true;
      },
    ));
  if (goOn) {
    await walk(
      "checkpoints",
      "swarm_run_checkpoints",
      "run_id, user_id, ctx, last_output",
      "run_id",
      (q) => q.not("last_output", "like", stillPlain),
      async (row) => {
        const sealed = await sealCheckpoint(row.user_id, row.run_id, {
          ctx: row.ctx,
          last_output: row.last_output as string | null,
        });
        if (!sealed.last_output || !isSealedText(sealed.last_output)) return "no-keys";
        const { data: moved, error } = await table("swarm_run_checkpoints")
          .update(sealed)
          .eq("run_id", row.run_id)
          .not("last_output", "like", stillPlain)
          .select("run_id");
        if (error) throw new Error(error.message);
        if (!moved?.length) return false;
        r.checkpoints++;
        return true;
      },
    );
  }
  return r;
}
