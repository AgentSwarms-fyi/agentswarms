// Model call traces under their owner's user key (R448).
//
// A trace keeps what a model was sent and what it answered: the prompt, the
// messages and system prompt, the tool calls with their arguments and results,
// a preview of the reply. All of that is sealed by the app under the owner's
// user key (as Agent Chat is, sealedChat.server), which a customer key wraps
// when the user is a customer's member.
//
// What the platform runs on stays readable: the columns (model, tokens, cost,
// latency, status, error message) and, in the request payload, the keys in
// TRACE_CLEAR_KEYS, which budgets, the reprice sweep and the Traces list ask
// Postgres about. Every other key of that payload is sealed, including one
// nobody has added yet: a new key is private until someone chooses otherwise.
//
// A sealed payload carries `body_sealed`, which is how the pass finds the rows
// left to do; PostgREST cannot be asked about a key with a colon in it, so the
// marker is not the sealed form's own key. Values stored before R448 are
// plaintext and read as they are.
//
// Writing a trace must never break the call it records, and it is what budgets
// add up, so when the owner's key cannot be had the row is written without its
// text: the cost is kept and nothing is left in the clear or put under another
// key.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  isSealedJson,
  openJson,
  sealJson,
  SEALED_JSON_KEY,
  unreadableReason,
} from "@/utils/chat/sealedThreads.server";
import { DataKeyUnavailableError } from "@/utils/kms/keyHierarchy.server";
import { isSealedText, openText, sealedTextKid, sealText } from "@/utils/providers/crypto.server";
import type { TracePass } from "./tracePass";

export const TRACE_SEALED_MARK = "body_sealed";
export const TRACE_DROPPED_MARK = "body_dropped";

/** The request payload's keys that stay readable; the rest are sealed. */
export const TRACE_CLEAR_KEYS: ReadonlySet<string> = new Set([
  "surface",
  "kind",
  "tokens_estimated",
  "pricing_missing",
  "price_source",
  "repriced_at",
  "parent_trace_id",
  "model_fallback",
  "image_count",
  "replayed_final",
  "turn_tokens_in",
  "turn_tokens_out",
  "turn_cost_usd",
]);

export const traceWhere = {
  prompt: (id: string) => `execution_traces/${id}/prompt`,
  request: (id: string) => `execution_traces/${id}/request_payload`,
  response: (id: string) => `execution_traces/${id}/response_payload`,
  toolCalls: (id: string) => `execution_traces/${id}/tool_calls`,
};

type TraceBodies = {
  prompt: string | null;
  request_payload: unknown;
  response_payload: unknown;
  tool_calls: unknown;
};

export function fieldsOf(payload: unknown): Record<string, unknown> {
  if (payload === null || payload === undefined) return {};
  if (typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { value: payload };
}

/** The request payload's keys that stay readable, with nothing of the sealed form. */
function clearPart(payload: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fieldsOf(payload)).filter(([k]) => TRACE_CLEAR_KEYS.has(k)),
  );
}

async function sealColumn(value: unknown, owner: string, where: string): Promise<unknown> {
  if (value === null || value === undefined || isSealedJson(value)) return value ?? null;
  return sealJson(value, { owner, where });
}

/**
 * A trace's bodies, sealed under `owner`'s key and bound to its id; null before
 * the user-key tables exist. Throws DataKeyUnavailableError when the owner's
 * key cannot be had: never sealed under another key. A column already sealed
 * is left: the reprice sweep can put a payload read before the pass back.
 */
export async function sealTraceBodies(
  owner: string,
  id: string,
  row: TraceBodies,
): Promise<TraceBodies | null> {
  const fields = fieldsOf(row.request_payload);
  const body = Object.fromEntries(Object.entries(fields).filter(([k]) => !TRACE_CLEAR_KEYS.has(k)));
  const sealed = await sealText(JSON.stringify(body), { owner, where: traceWhere.request(id) });
  if (!sealed) return null;
  return {
    prompt:
      row.prompt && !isSealedText(row.prompt)
        ? await sealText(row.prompt, { owner, where: traceWhere.prompt(id) })
        : row.prompt,
    request_payload: {
      ...clearPart(fields),
      [TRACE_SEALED_MARK]: true,
      [SEALED_JSON_KEY]: sealed,
    },
    response_payload: await sealColumn(row.response_payload, owner, traceWhere.response(id)),
    tool_calls: await sealColumn(row.tool_calls, owner, traceWhere.toolCalls(id)),
  };
}

/** Whether PERSIST_PROMPT_BODIES=false already dropped this row's bodies. */
function isRedacted(payload: unknown): boolean {
  return fieldsOf(payload).redacted === true;
}

/**
 * A trace row as it is stored: sealed under its owner's key; as it is when
 * there is nothing to seal (bodies not kept, no owner, no user-key tables).
 * Never throws: when the owner's key cannot be had the row loses its text and
 * keeps its cost, because it is what budgets add up.
 */
export async function sealTraceRow<T extends TraceBodies & { id: string; user_id: string | null }>(
  row: T,
): Promise<T> {
  if (!row.user_id || isRedacted(row.request_payload)) return row;
  try {
    const sealed = await sealTraceBodies(row.user_id, row.id, row);
    return sealed ? ({ ...row, ...sealed } as T) : row;
  } catch (e) {
    console.warn(`[trace] kept without its text: ${(e as Error).message}`);
    return {
      ...row,
      prompt: null,
      request_payload: {
        ...clearPart(row.request_payload),
        [TRACE_SEALED_MARK]: true,
        [TRACE_DROPPED_MARK]: true,
      },
      response_payload: {},
      tool_calls: [],
    };
  }
}

export type TraceSealing = {
  /** Its bodies are stored under the owner's key. */
  body_sealed: boolean;
  /** Recorded without its text: the owner's key could not be had at the time. */
  body_dropped: boolean;
  /** Why its text cannot be read now; null when it can. */
  body_unreadable: string | null;
};

/**
 * A whole trace row, opened. A row that cannot be opened keeps its readable
 * figures and says why: one unreadable trace must not take the page with it.
 */
export async function openTraceRow<T extends TraceBodies & { id: string }>(
  row: T,
): Promise<T & TraceSealing> {
  const stored = fieldsOf(row.request_payload);
  const body_sealed = stored[TRACE_SEALED_MARK] === true;
  const body_dropped = stored[TRACE_DROPPED_MARK] === true;
  try {
    const [prompt, body, response_payload, tool_calls] = await Promise.all([
      row.prompt ? openText(row.prompt, traceWhere.prompt(row.id)) : row.prompt,
      isSealedJson(stored)
        ? openJson<Record<string, unknown>>(stored, traceWhere.request(row.id))
        : null,
      openJson<unknown>(row.response_payload, traceWhere.response(row.id)),
      openJson<unknown>(row.tool_calls, traceWhere.toolCalls(row.id)),
    ]);
    return {
      ...row,
      prompt,
      request_payload: body_sealed ? { ...body, ...clearPart(stored) } : row.request_payload,
      response_payload,
      tool_calls,
      body_sealed,
      body_dropped,
      body_unreadable: null,
    };
  } catch (e) {
    return {
      ...row,
      prompt: null,
      request_payload: clearPart(stored),
      response_payload: {},
      tool_calls: [],
      body_sealed,
      body_dropped,
      body_unreadable: unreadableReason(e),
    };
  }
}

/**
 * The list's prompts, opened. A key that is gone is asked for once, not once
 * for each of a page's rows.
 */
export async function openTracePrompts<T extends { id: string; prompt: string | null }>(
  rows: T[],
): Promise<Array<T & { body_unreadable: string | null }>> {
  const refused = new Map<string, string>();
  const out: Array<T & { body_unreadable: string | null }> = [];
  for (const row of rows) {
    const kid = row.prompt ? sealedTextKid(row.prompt) : null;
    const known = kid ? refused.get(kid) : undefined;
    if (known) {
      out.push({ ...row, prompt: null, body_unreadable: known });
      continue;
    }
    try {
      const prompt = row.prompt ? await openText(row.prompt, traceWhere.prompt(row.id)) : null;
      out.push({ ...row, prompt, body_unreadable: null });
    } catch (e) {
      const reason = unreadableReason(e);
      if (kid && e instanceof DataKeyUnavailableError) refused.set(kid, reason);
      out.push({ ...row, prompt: null, body_unreadable: reason });
    }
  }
  return out;
}

// ── The pass ─────────────────────────────────────────────────────────────────

/** How many traces one background pass seals; the button's pass has no limit. */
export function traceSealPerPass(raw = process.env.TRACE_SEAL_PER_PASS): number {
  const v = Number((raw ?? "").trim());
  return Number.isInteger(v) && v > 0 ? v : 2000;
}

const PAGE = 100;
const NO_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Seal the traces kept before R448. A trace with no owner has no key to go
 * under, and one whose bodies were not kept (PERSIST_PROMPT_BODIES=false) has
 * nothing to seal. A row that cannot be sealed (its owner's key cannot be had)
 * is counted and left. A row is written only if it is still unsealed.
 */
export async function sealOlderTraces(opts: { limit?: number } = {}): Promise<TracePass> {
  const r: TracePass = { traces: 0, unreadable: 0, left: false, failed: 0, errors: [] };
  let budget = opts.limit ?? Number.POSITIVE_INFINITY;
  const fail = (what: string, e: unknown) => {
    if (e instanceof DataKeyUnavailableError) {
      r.unreadable++;
      return;
    }
    r.failed++;
    if (r.errors.length < 10) r.errors.push(`${what}: ${(e as Error).message}`);
  };

  let cursor = NO_ID;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("execution_traces")
      .select("id, user_id, prompt, request_payload, response_payload, tool_calls")
      .not("user_id", "is", null)
      .is(`request_payload->>${TRACE_SEALED_MARK}`, null)
      .is("request_payload->>redacted", null)
      .gt("id", cursor)
      .order("id")
      .limit(PAGE);
    if (error) {
      fail("traces", new Error(error.message));
      break;
    }
    const rows = data ?? [];
    for (const row of rows) {
      if (budget <= 0) {
        r.left = true;
        return r;
      }
      cursor = row.id;
      try {
        const sealed = await sealTraceBodies(row.user_id as string, row.id, row);
        // No user keys yet: nothing in this pass can be sealed.
        if (!sealed) return r;
        const { data: moved, error: e1 } = await supabaseAdmin
          .from("execution_traces")
          .update(sealed as never)
          .eq("id", row.id)
          .is(`request_payload->>${TRACE_SEALED_MARK}`, null)
          .select("id");
        if (e1) throw new Error(e1.message);
        if (!moved?.length) continue;
        r.traces++;
        budget--;
      } catch (e) {
        fail(`trace ${row.id}`, e);
      }
    }
    if (rows.length < PAGE) break;
  }
  return r;
}
