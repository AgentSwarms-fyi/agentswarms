// The gateway's semantic cache, against a running instance and a real model.
//
// The unit tests decide what MAY be cached. Only this can show that the second
// identical call is actually answered from the table, that a different
// question is not, that a key without the switch never reads it, and that the
// row is invisible to any owner but its own.
//
// The key this mints is generated here and hashed by the app's own function;
// its plaintext exists in this process and in nothing else, and the row is
// deleted in an afterAll along with every cache entry the run creates.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { admin, hasSupabase, TEST_PREFIX } from "./setup";

const BASE = process.env.APP_BASE_URL ?? "http://localhost:8080";

/**
 * Unique to this run, so nothing already in the cache can answer it and the
 * cleanup can find exactly what this test wrote.
 */
const RUN = Math.random().toString(36).slice(2, 8);
const QUESTION = `In one short sentence, what is the capital of France? (itest ${RUN})`;
const OTHER = `In one short sentence, what is the boiling point of water? (itest ${RUN})`;

async function appIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe.skipIf(!hasSupabase)("gateway semantic cache", () => {
  let up = false;
  let userId: string | null = null;
  let model: string | null = null;
  let cachedKey: string | null = null;
  let plainKey: string | null = null;
  let uncachedKey: string | null = null;
  let plainUncached: string | null = null;

  const call = async (key: string, question: string, stream = false) => {
    const res = await fetch(`${BASE}/api/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream,
        temperature: 0,
        messages: [{ role: "user", content: question }],
      }),
    });
    const text = await res.text();
    return { status: res.status, cache: res.headers.get("X-Gateway-Cache"), text };
  };

  const contentOf = (jsonText: string): string => {
    const body = JSON.parse(jsonText) as {
      choices?: { message?: { content?: string } }[];
      usage?: Record<string, number>;
      agentswarms?: { cached?: { similarity: number; asked: string } };
    };
    return body.choices?.[0]?.message?.content ?? "";
  };

  beforeAll(async () => {
    up = await appIsUp();
    if (!up) return;

    // An owner with a working provider model. Borrowing an agent's model is
    // the cheapest way to be sure the call can actually reach something.
    const { data: agent } = await admin()
      .from("agents")
      .select("user_id, llm_provider, llm_model")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (!agent) return;
    userId = agent.user_id;
    model = `${agent.llm_provider}/${agent.llm_model}`;

    const { generateGatewayKey, gatewayKeyPrefix, hashGatewayKey } =
      await import("@/utils/gateway/keys");
    const mint = async (name: string, semanticCache: boolean) => {
      const plaintext = generateGatewayKey();
      const { data } = await admin()
        .from("gateway_keys")
        .insert({
          user_id: agent.user_id,
          name: `${TEST_PREFIX}${name}`,
          key_hash: await hashGatewayKey(plaintext),
          key_prefix: gatewayKeyPrefix(plaintext),
          scopes: ["models"],
          semantic_cache: semanticCache,
          is_active: true,
        })
        .select("id")
        .maybeSingle();
      return { id: data?.id ?? null, plaintext };
    };
    const cached = await mint("cache-on", true);
    cachedKey = cached.id;
    plainKey = cached.plaintext;
    const uncached = await mint("cache-off", false);
    uncachedKey = uncached.id;
    plainUncached = uncached.plaintext;
  });

  afterAll(async () => {
    for (const id of [cachedKey, uncachedKey]) {
      if (id) await admin().from("gateway_keys").delete().eq("id", id);
    }
    // Only the rows this run wrote: an owner's real cache is left alone.
    if (userId) {
      await admin()
        .from("gateway_cache")
        .delete()
        .eq("user_id", userId)
        .in("question", [QUESTION, OTHER]);
    }
  });

  it("misses the first time and answers the second from the cache", async () => {
    if (!up || !plainKey) return;
    const first = await call(plainKey, QUESTION);
    expect(first.status, first.text.slice(0, 300)).toBe(200);
    expect(first.cache).toBe("miss");
    const answer = contentOf(first.text);
    expect(answer.length).toBeGreaterThan(0);

    // The write is fire and forget so the first caller is not made to wait
    // for it; give it a moment to land before asking again.
    await new Promise((r) => setTimeout(r, 5_000));

    const second = await call(plainKey, QUESTION);
    expect(second.status).toBe(200);
    expect(second.cache).toBe("hit");
    expect(contentOf(second.text)).toBe(answer);
    const body = JSON.parse(second.text) as {
      usage: Record<string, number>;
      agentswarms: { cached?: { similarity: number; asked: string } };
    };
    // A hit spends nothing at the provider, and says so.
    expect(body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(body.agentswarms.cached?.similarity).toBeGreaterThanOrEqual(0.97);
    expect(body.agentswarms.cached?.asked).toBe(QUESTION);
  }, 240_000);

  it("does not answer a different question from that entry", async () => {
    if (!up || !plainKey) return;
    const res = await call(plainKey, OTHER);
    expect(res.status).toBe(200);
    // The whole risk of a semantic cache in one assertion: a question that
    // is not the stored one must reach the model.
    expect(res.cache).toBe("miss");
  }, 240_000);

  it("never reads the cache for a key that did not switch it on", async () => {
    if (!up || !plainUncached || !plainKey) return;
    const res = await call(plainUncached, QUESTION);
    expect(res.status).toBe(200);
    expect(res.cache).toBe("off");
    // Mutation check: the same question on the cached key is still a hit, so
    // "off" is the key's flag talking and not an empty cache.
    const onKey = await call(plainKey, QUESTION);
    expect(onKey.cache).toBe("hit");
  }, 240_000);

  it("serves a hit as a stream too, in OpenAI chunks", async () => {
    if (!up || !plainKey) return;
    const res = await call(plainKey, QUESTION, true);
    expect(res.status).toBe(200);
    expect(res.cache).toBe("hit");
    expect(res.text).toContain('"object":"chat.completion.chunk"');
    expect(res.text).toContain('"finish_reason":"stop"');
    expect(res.text).toContain('"cached"');
    expect(res.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("keeps the entry invisible to every owner but its own", async () => {
    if (!up || !userId) return;
    const { data: rows } = await admin()
      .from("gateway_cache")
      .select("id, target_key, prompt_hash, embedding")
      .eq("user_id", userId)
      .eq("question", QUESTION)
      .limit(1);
    const row = rows?.[0] as
      | { target_key: string; prompt_hash: string; embedding: string }
      | undefined;
    expect(row, "the first call did not store anything").toBeTruthy();
    if (!row) return;

    const args = {
      p_target_key: row.target_key,
      p_prompt_hash: row.prompt_hash,
      query_embedding: row.embedding,
      min_similarity: 0.9,
    };
    // Its own owner finds it...
    const mine = await admin().rpc("match_gateway_cache", { ...args, p_user_id: userId });
    expect((mine.data ?? []).length).toBe(1);
    // ...and nobody else does, with the identical vector.
    const theirs = await admin().rpc("match_gateway_cache", { ...args, p_user_id: randomUUID() });
    expect((theirs.data ?? []).length).toBe(0);
    // The system instruction is scope too, not decoration.
    const reinstructed = await admin().rpc("match_gateway_cache", {
      ...args,
      p_user_id: userId,
      p_prompt_hash: "0".repeat(64),
    });
    expect((reinstructed.data ?? []).length).toBe(0);
  });

  it("records the hit in the audit chain, with what it matched", async () => {
    if (!up || !cachedKey) return;
    const { data: events } = await admin()
      .from("audit_events")
      .select("action, detail")
      .eq("resource_id", cachedKey)
      .eq("action", "gateway.chat")
      .order("created_at", { ascending: false })
      .limit(20);
    const details = (events ?? []).map((e) => e.detail as Record<string, unknown>);
    const hit = details.find((d) => d.cache === "hit");
    expect(hit, "no gateway.chat row said cache: hit").toBeTruthy();
    expect(Number(hit?.cache_similarity)).toBeGreaterThanOrEqual(0.97);
    expect(hit?.tokens_in).toBe(0);
    // The live calls on the same key said "miss" in the same field, so a
    // reader can tell the two apart without inferring anything.
    expect(details.some((d) => d.cache === "miss")).toBe(true);
    // And the key that never switched the cache on says so on its own rows.
    if (uncachedKey) {
      const { data: offEvents } = await admin()
        .from("audit_events")
        .select("detail")
        .eq("resource_id", uncachedKey)
        .eq("action", "gateway.chat")
        .limit(5);
      expect(
        (offEvents ?? []).some((e) => (e.detail as Record<string, unknown>).cache === "off"),
      ).toBe(true);
    }
  });
});
