// The AI gateway's semantic cache. What is pinned here is the part that
// decides whether an answer may be reused at all — every rule mutation-checked
// against the case it exists to refuse — the scoping that keeps one account's
// answers out of another's, the shape a cached answer comes back in, and the
// wiring: the migration, the settings, the key column, the audit row, the
// editor and the docs.
//
// The rules matter more here than in most caches. An exact cache that misses
// costs a call; a semantic cache that hits wrongly returns the wrong answer,
// confidently, to a client that has no way to tell.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CACHE_MISS_REASONS,
  cacheLookupDecision,
  cacheStoreDecision,
  promptHashOf,
  roundSimilarity,
  targetKeyFor,
  usedTools,
  vectorLiteral,
} from "@/utils/gateway/cache";
import { cachedUpstream, collectUpstreamSse, adaptUpstreamSse } from "@/utils/gateway/api.server";
import type { OpenAiMessage } from "@/utils/gateway/keys";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const ask = (content: string): OpenAiMessage[] => [{ role: "user", content }];
const look = (over: Partial<Parameters<typeof cacheLookupDecision>[0]> = {}) =>
  cacheLookupDecision({
    keyCacheEnabled: true,
    messages: ask("what was revenue last quarter"),
    temperature: 0,
    maxTemperature: 0.3,
    ...over,
  });

describe("what may be answered from the cache", () => {
  it("takes a single user question on a key that asked for the cache", () => {
    const d = look();
    expect(d.cacheable).toBe(true);
    if (d.cacheable) expect(d.question).toBe("what was revenue last quarter");
  });

  it("is off for a key that did not ask for it", () => {
    const d = look({ keyCacheEnabled: false });
    expect(d.cacheable).toBe(false);
    if (!d.cacheable) expect(d.reason).toBe(CACHE_MISS_REASONS.off);
    // Mutation check: the same call with the flag on is a hit, so the flag is
    // doing the refusing rather than something else in the fixture.
    expect(look({ keyCacheEnabled: true }).cacheable).toBe(true);
  });

  it("refuses a conversation with a history, because the last turn is not the question", () => {
    // "and for Europe?" means nothing without what came before it. Matching on
    // the last message alone would answer it with whatever the last person who
    // asked that got, which is the one failure a semantic cache must not have.
    const followUp: OpenAiMessage[] = [
      { role: "user", content: "what was revenue last quarter" },
      { role: "assistant", content: "$4.2M" },
      { role: "user", content: "and for Europe?" },
    ];
    const d = look({ messages: followUp });
    expect(d.cacheable).toBe(false);
    if (!d.cacheable) expect(d.reason).toBe(CACHE_MISS_REASONS.multiTurn);
    // Mutation check: the same last turn on its own is cacheable.
    expect(look({ messages: ask("and for Europe?") }).cacheable).toBe(true);
  });

  it("ignores a system message when counting the turns", () => {
    // A system message is not a turn; it is scope, and it is hashed into the
    // key rather than counted against the one-question rule.
    const withSystem: OpenAiMessage[] = [
      { role: "system", content: "You answer in one line." },
      { role: "user", content: "what was revenue last quarter" },
    ];
    expect(look({ messages: withSystem }).cacheable).toBe(true);
  });

  it("refuses a temperature above the ceiling, and takes the ceiling itself", () => {
    const hot = look({ temperature: 0.9 });
    expect(hot.cacheable).toBe(false);
    if (!hot.cacheable) expect(hot.reason).toBe(CACHE_MISS_REASONS.temperature);
    // Mutation check on the boundary: at the ceiling it is still cacheable, so
    // the comparison is > and not >=.
    expect(look({ temperature: 0.3 }).cacheable).toBe(true);
    expect(look({ temperature: 0.31 }).cacheable).toBe(false);
    // A ceiling of 0 is a real setting: only a deterministic turn qualifies.
    expect(look({ temperature: 0, maxTemperature: 0 }).cacheable).toBe(true);
    expect(look({ temperature: 0.1, maxTemperature: 0 }).cacheable).toBe(false);
  });

  it("refuses an empty question", () => {
    const d = look({ messages: ask("   ") });
    expect(d.cacheable).toBe(false);
    if (!d.cacheable) expect(d.reason).toBe(CACHE_MISS_REASONS.noQuestion);
  });

  it("reads a question sent as content parts", () => {
    const parts: OpenAiMessage[] = [
      { role: "user", content: [{ type: "text", text: "what was revenue last quarter" }] },
    ];
    const d = look({ messages: parts });
    expect(d.cacheable).toBe(true);
    if (d.cacheable) expect(d.question).toBe("what was revenue last quarter");
  });
});

describe("what may be written to the cache", () => {
  it("stores a plain answer to a cacheable question", () => {
    expect(
      cacheStoreDecision({ lookup: look(), usedTools: false, answer: "$4.2M" }).cacheable,
    ).toBe(true);
  });

  it("never stores an answer that used a tool", () => {
    // A tool read something live. Freezing that for a day would serve
    // yesterday's number tomorrow, under today's question.
    const d = cacheStoreDecision({ lookup: look(), usedTools: true, answer: "$4.2M" });
    expect(d.cacheable).toBe(false);
    if (!d.cacheable) expect(d.reason).toBe(CACHE_MISS_REASONS.tools);
  });

  it("never stores an empty answer", () => {
    const d = cacheStoreDecision({ lookup: look(), usedTools: false, answer: "  \n " });
    expect(d.cacheable).toBe(false);
    if (!d.cacheable) expect(d.reason).toBe(CACHE_MISS_REASONS.empty);
  });

  it("carries the lookup's own refusal through rather than inventing a second one", () => {
    const d = cacheStoreDecision({
      lookup: look({ keyCacheEnabled: false }),
      usedTools: false,
      answer: "$4.2M",
    });
    expect(d.cacheable).toBe(false);
    if (!d.cacheable) expect(d.reason).toBe(CACHE_MISS_REASONS.off);
  });

  it("reads the tool report the platform actually sends", () => {
    expect(usedTools({ tools: [{ name: "run_sql" }] })).toBe(true);
    expect(usedTools({ tools: [] })).toBe(false);
    expect(usedTools({})).toBe(false);
    expect(usedTools(null)).toBe(false);
  });
});

describe("an entry belongs to one owner, one target and one instruction", () => {
  it("names an agent target by id and a model target by provider/model", () => {
    expect(targetKeyFor({ kind: "agent", agent: { id: "a-1" } })).toBe("agent:a-1");
    expect(targetKeyFor({ kind: "model", provider: "openrouter", model: "openai/gpt-4o" })).toBe(
      "openrouter/openai/gpt-4o",
    );
    // Two agents never share a key, so no answer can cross between them.
    expect(targetKeyFor({ kind: "agent", agent: { id: "a-1" } })).not.toBe(
      targetKeyFor({ kind: "agent", agent: { id: "a-2" } }),
    );
  });

  it("hashes the system instruction, so a re-instructed agent shares nothing", () => {
    const a = promptHashOf("You answer in one line.");
    const b = promptHashOf("You answer in one line, in French.");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(promptHashOf("You answer in one line.")).toBe(a);
    // No instruction is its own scope, not a wildcard that matches every one.
    expect(promptHashOf(null)).toBe(promptHashOf(""));
    expect(promptHashOf(null)).not.toBe(a);
  });

  it("sends an embedding as a literal pgvector parses", () => {
    expect(vectorLiteral([0.5, -0.25, 0])).toBe("[0.5,-0.25,0]");
  });

  it("reports similarity to three decimals", () => {
    expect(roundSimilarity(0.9812345)).toBe(0.981);
    expect(roundSimilarity(1)).toBe(1);
  });
});

describe("a cached answer comes back in the same shape a live one does", () => {
  const meta = {
    id: "chatcmpl-x",
    model: "openrouter/openai/gpt-4o",
    created: 1,
    includeUsage: true,
    traceId: null,
    fallbackFrom: null,
    cached: { similarity: 0.99, asked: "what was revenue", answered_at: "2026-01-01T00:00:00Z" },
  };

  it("fills a chat.completion the way a real turn does, and says it was cached", async () => {
    const out = await collectUpstreamSse(cachedUpstream("$4.2M"), meta);
    expect(out.text).toBe("$4.2M");
    const body = out.body as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    const choices = body.choices as { message: { content: string }; finish_reason: string }[];
    expect(choices[0].message.content).toBe("$4.2M");
    expect(choices[0].finish_reason).toBe("stop");
    // A hit spends nothing at the provider, and the usage block says so
    // rather than repeating what the original turn cost.
    expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    const extra = body.agentswarms as { cached?: { similarity: number } };
    expect(extra.cached?.similarity).toBe(0.99);
  });

  it("streams as OpenAI chunks, with the cache note in the final one", async () => {
    const stream = adaptUpstreamSse(cachedUpstream("$4.2M"), meta);
    const text = await new Response(stream).text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"$4.2M"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"cached"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("leaves the cache note out of an answer that was not cached", async () => {
    const { cached: _drop, ...live } = meta;
    const out = await collectUpstreamSse(cachedUpstream("$4.2M"), live);
    expect(JSON.stringify(out.body)).not.toContain("cached");
  });
});

describe("the wiring", () => {
  const migration = rd("supabase/migrations/20260870000000_gateway_cache.sql");

  it("scopes the table and its lookup by owner, target and instruction", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.gateway_cache");
    expect(migration).toContain("embedding vector(1536) NOT NULL");
    expect(migration).toContain("ALTER TABLE public.gateway_cache ENABLE ROW LEVEL SECURITY");
    // The RPC runs as definer with the owner as an argument, so that filter is
    // the whole boundary — and it is applied before the ranking, not after.
    const fn = migration.slice(migration.indexOf("FUNCTION public.match_gateway_cache"));
    expect(fn).toContain("SECURITY DEFINER");
    expect(fn).toContain("c.user_id = p_user_id");
    expect(fn).toContain("c.target_key = p_target_key");
    expect(fn).toContain("c.prompt_hash = p_prompt_hash");
    expect(fn).toContain("c.expires_at > now()");
    expect(fn.indexOf("WHERE")).toBeLessThan(fn.indexOf("ORDER BY"));
  });

  it("counts hits in the database rather than read-then-write from the app", () => {
    expect(migration).toContain("FUNCTION public.increment_gateway_cache_hit");
    expect(migration).toContain("hits = hits + 1");
    expect(rd("src/utils/gateway/cache.server.ts")).toContain("increment_gateway_cache_hit");
  });

  it("is off unless a key turns it on, and turning it on is audited", () => {
    expect(migration).toContain("semantic_cache boolean NOT NULL DEFAULT false");
    const trigger = migration.slice(migration.indexOf("CREATE TRIGGER audit_gateway_keys"));
    expect(trigger).toContain("semantic_cache");
    expect(trigger).toContain("audit_row_change('gateway_key')");
  });

  it("reads its three knobs from the settings row, then env, then a default", () => {
    const cfg = rd("src/utils/notebookRuntime/config.server.ts");
    for (const [column, env] of [
      ["gateway_cache_similarity", "AI_GATEWAY_CACHE_SIMILARITY"],
      ["gateway_cache_ttl_hours", "AI_GATEWAY_CACHE_TTL_HOURS"],
      ["gateway_cache_max_temperature", "AI_GATEWAY_CACHE_MAX_TEMPERATURE"],
    ]) {
      expect(cfg).toContain(column);
      expect(cfg).toContain(env);
      expect(migration).toContain(column);
      expect(rd(".env.example")).toContain(env);
    }
    // The ceiling's zero is a setting, not an absent value.
    expect(cfg).toContain("envNumZeroOk");
    const admin = rd("src/utils/notebookRuntimeAdmin.functions.ts");
    expect(admin).toContain("gateway_cache_similarity: z.number().min(0.8).max(1)");
    expect(admin).toContain("gateway_cache_max_temperature: z.number().min(0).max(2)");
    const tab = rd("src/components/admin/RuntimeTab.tsx");
    expect(tab).toContain("gateway_cache_similarity");
    // The two decimal knobs declare a step, or the browser marks 0.97 invalid.
    expect(tab).toContain("step={0.01}");
    // And a save the schema refuses now says which field it refused. It used
    // to reject into the console and leave the page looking saved - found by
    // typing a decimal into a whole-number field in the running app.
    expect(tab).toContain("toast.error(refusalMessage(e))");
    expect(tab).toContain("function refusalMessage");
  });

  it("looks the cache up only after every check that can refuse the call", () => {
    const src = rd("src/utils/gateway/api.server.ts");
    const budget = src.indexOf("const budget = await getBudgetDecision");
    const lookup = src.indexOf("await lookupCached(");
    const call = src.indexOf("await fetch(`${origin}/api/chat`");
    expect(budget).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(budget);
    expect(lookup).toBeLessThan(call);
    // The scope comes from the body the model will actually be given, not
    // from a second derivation that could drift from it.
    expect(src).toContain("promptHashOf(systemPrompt)");
    expect(src).toContain("const primaryBody = internalFor(primary)");
  });

  it("says on every answer whether it was cached, and audits the same word", () => {
    const src = rd("src/utils/gateway/api.server.ts");
    expect(src).toContain('"X-Gateway-Cache": "hit"');
    expect(src).toContain('"X-Gateway-Cache": cacheState');
    expect(src).toContain('!key.semantic_cache ? "off" : lookup.cacheable ? "miss" : "skip"');
    expect(src).toContain("cache: cacheState");
    expect(src).toContain('cache: "hit"');
    expect(src).toContain("cache_similarity: found.hit.similarity");
  });

  it("re-checks the tool rule against the answer rather than trusting the lookup", () => {
    const src = rd("src/utils/gateway/api.server.ts");
    expect(src).toContain("usedTools: usedTools(extras)");
    // Both shapes store: a streaming caller must not quietly skip the write.
    expect(src).toContain("maybeStore(s.text, s.extras)");
    expect(src).toContain("maybeStore(collected.text, collected.extras)");
  });

  it("takes expired rows out on the way past, so the table does not only grow", () => {
    const server = rd("src/utils/gateway/cache.server.ts");
    expect(server).toContain('.lt("expires_at"');
    // Scoped to the owner doing the writing, never a table-wide sweep.
    const prune = server.slice(server.indexOf('.lt("expires_at"') - 200);
    expect(prune).toContain('.eq("user_id", args.scope.userId)');
  });

  it("lets the owner see and empty their own cache, and audits the emptying", () => {
    const fns = rd("src/utils/gatewayKeys.functions.ts");
    expect(fns).toContain("export const gatewayCacheList");
    expect(fns).toContain("export const gatewayCacheClear");
    expect(fns).toContain('action: "gateway.cache.clear"');
    // Both go through resolveCaller, so the caller's own id scopes the read
    // and the delete rather than anything sent in the request.
    const clear = fns.slice(fns.indexOf("export const gatewayCacheClear"));
    expect(clear).toContain("resolveCaller(data.access_token)");
    expect(clear).toContain("clearCache(caller.userId)");
    expect(rd("src/utils/gateway/cache.server.ts")).toContain('.eq("user_id", userId)');
  });

  it("offers the switch in the key editor and shows what is stored", () => {
    const card = rd("src/components/gateway/GatewayApiCard.tsx");
    expect(card).toContain("semantic_cache: semanticCache");
    expect(card).toContain("semantic_cache: on");
    expect(card).toContain("Clear cache");
    expect(card).toContain("Semantic cache");
    // A lifetime counts FORWARD. The list's other timestamps count backward,
    // and reusing that formatter rendered every unexpired answer as
    // "just now" - which is how this was caught, from the running app.
    expect(card).toContain("untilTime(e.expires_at)");
    expect(card).not.toContain("relTime(e.expires_at)");
  });

  it("is documented where an operator and a caller would each look", () => {
    const gateway = rd("docs/AI_GATEWAY.md");
    expect(gateway).toContain("Semantic cache");
    expect(gateway).toContain("X-Gateway-Cache");
    expect(gateway).toContain("AI_GATEWAY_CACHE_SIMILARITY");
    expect(rd("docs/SCALE_AND_LIMITS.md")).toContain("AI_GATEWAY_CACHE_TTL_HOURS");
    // And in the app, where the key is actually minted.
    expect(rd("src/routes/docs.gateway.tsx")).toContain("X-Gateway-Cache");
  });
});
