// The semantic cache's rules, with nothing that touches a database or a
// model. What may be answered from cache, what may be written to it, and the
// three values that scope an entry — imported by the gateway, the editor and
// the tests, so a rule cannot be enforced in one place and not another.
import { createHash } from "node:crypto";

import type { OpenAiMessage } from "@/utils/gateway/keys";
import { splitConversation } from "@/utils/gateway/keys";

/** What a cache entry belongs to. All three have to match for a hit. */
export type CacheScope = {
  /** The key's owner. There is no cross-user cache and no way to ask for one. */
  userId: string;
  /** "agent:<id>", or "<provider>/<model>" for a bare model call. */
  targetKey: string;
  /** sha256 of the system instruction the turn runs with. */
  promptHash: string;
};

export type CacheDecision =
  | { cacheable: true; question: string }
  /** `reason` is for the log and the tests, never for the caller. */
  | { cacheable: false; reason: string };

export const CACHE_MISS_REASONS = {
  off: "the key has the cache switched off",
  multiTurn: "the conversation has more than one turn",
  noQuestion: "there is no question to match on",
  temperature: "the temperature is above the cacheable ceiling",
  tools: "the answer used tools",
  empty: "the answer is empty",
} as const;

/** The scope key for a resolved target, in the form the table stores. */
export function targetKeyFor(
  target:
    | { kind: "agent"; agent: { id: string } }
    | { kind: "model"; provider: string; model: string },
): string {
  return target.kind === "agent"
    ? `agent:${target.agent.id}`
    : `${target.provider}/${target.model}`;
}

/** sha256 of the system instruction, so a re-instructed agent shares nothing. */
export function promptHashOf(systemPrompt: string | undefined | null): string {
  return createHash("sha256")
    .update(systemPrompt ?? "")
    .digest("hex");
}

/**
 * Whether this request may be answered from cache, and what to match on.
 *
 * ONE USER TURN ONLY. A follow-up's answer depends on everything said before
 * it, and matching on the last message alone would answer "and for Europe?"
 * with whatever the last person who asked that got. A conversation with a
 * history is always a miss, and that is a correctness rule rather than a
 * conservative default.
 *
 * A high temperature is a request for variety; serving it from cache would be
 * answering a different question than the one that was asked.
 */
export function cacheLookupDecision(args: {
  keyCacheEnabled: boolean;
  messages: readonly OpenAiMessage[];
  temperature: number;
  maxTemperature: number;
}): CacheDecision {
  if (!args.keyCacheEnabled) return { cacheable: false, reason: CACHE_MISS_REASONS.off };
  if (args.temperature > args.maxTemperature) {
    return { cacheable: false, reason: CACHE_MISS_REASONS.temperature };
  }
  const { turns } = splitConversation([...args.messages]);
  if (turns.length !== 1 || turns[0].role !== "user") {
    return { cacheable: false, reason: CACHE_MISS_REASONS.multiTurn };
  }
  const question = messageText(turns[0].content).trim();
  if (!question) return { cacheable: false, reason: CACHE_MISS_REASONS.noQuestion };
  return { cacheable: true, question };
}

/**
 * Whether the answer that just came back may be stored.
 *
 * An answer that used tools read something live — a table, a search, a
 * prediction — and storing it would serve yesterday's number tomorrow. The
 * turn is cacheable only when the model answered from what it already knew.
 */
export function cacheStoreDecision(args: {
  lookup: CacheDecision;
  usedTools: boolean;
  answer: string;
}): CacheDecision {
  if (!args.lookup.cacheable) return args.lookup;
  if (args.usedTools) return { cacheable: false, reason: CACHE_MISS_REASONS.tools };
  if (!args.answer.trim()) return { cacheable: false, reason: CACHE_MISS_REASONS.empty };
  return args.lookup;
}

/** Text out of a message whose content may be parts. */
function messageText(content: OpenAiMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text ?? "") : ""))
    .join(" ");
}

/** The `tools` the platform reported, as a yes or no. */
export function usedTools(extras: { tools?: unknown[] } | null | undefined): boolean {
  return Array.isArray(extras?.tools) && extras.tools.length > 0;
}

/** A pgvector literal. The client sends text; the column parses it. */
export function vectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Similarity as the response and the audit row report it: three decimals. */
export function roundSimilarity(similarity: number): number {
  return Math.round(similarity * 1000) / 1000;
}
