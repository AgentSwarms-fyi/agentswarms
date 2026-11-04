// Agent memory under its owner's user key (R445).
//
// What an agent keeps about a person between turns (long-term memory items,
// each conversation's rolling summary, and its scratchpad) is sealed by the
// app under that person's user key (crypto.server's sealed text), which a
// customer key wraps when the person is a customer's member. Erasing the user
// key, destroying the customer key or the customer revoking theirs leaves it
// unreadable, and nobody else's. Values stored before R445 are plaintext and
// read as they are; the pass below seals them.
//
// Recall finds items by word in Postgres (a GIN index on `keywords`), so a
// sealed item's keywords are its words as its owner's index key hashes them
// (blind tokens), never the words. A database trigger derives `keywords` from
// `content` whenever content is written: it fires on INSERT and on UPDATE OF
// content only, so the blind tokens are written by a second update that names
// no content. Until it lands, the trigger's keywords are fragments of the
// ciphertext: the item is not found by a word for that moment, and nothing
// readable is kept.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DataKeyUnavailableError } from "@/utils/kms/keyHierarchy.server";
import { blindTokens, isSealedText, openText, sealText } from "@/utils/providers/crypto.server";
import { tokenize } from "./tokenize";
import type { MemoryPass } from "./memoryPass";

export { memoryPassDetail, type MemoryPass } from "./memoryPass";

export const memoryWhere = {
  item: (id: string) => `agent_memory_items/${id}/content`,
  summary: (conversationId: string) => `conversation_memory/${conversationId}/summary`,
  scratchpad: (conversationId: string) => `conversation_memory/${conversationId}/scratchpad`,
};

/**
 * The scratchpad's stored form once sealed: one key, which memory_set cannot
 * write (its keys are letters, digits and underscores), holding the whole
 * scratchpad as sealed JSON.
 */
export const SEALED_SCRATCHPAD_KEY = "ck1:scratchpad";

/** Whether a failure is the owner's key being unavailable (erased, refused, a conflict). */
export function isMemoryKeyError(e: unknown): e is DataKeyUnavailableError {
  return e instanceof DataKeyUnavailableError;
}

type NewItem = {
  user_id: string;
  agent_id: string;
  conversation_id: string | null;
  kind: string;
  content: string;
};

/**
 * Insert memory items, each sealed under its owner's key with blind keywords;
 * as plaintext before the user-key tables exist. Returns the ids inserted. A
 * row whose keywords could not be written is deleted again rather than kept
 * where recall cannot find it.
 */
export async function insertMemoryItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: SupabaseClient<Database> | any,
  items: NewItem[],
): Promise<{ ids: string[]; error: string | null }> {
  if (items.length === 0) return { ids: [], error: null };
  const prepared = await Promise.all(
    items.map(async (it) => {
      const id = crypto.randomUUID();
      const sealed = await sealText(it.content, { owner: it.user_id, where: memoryWhere.item(id) });
      const keywords = sealed ? await blindTokens(tokenize(it.content), it.user_id) : null;
      return { row: { ...it, id, content: sealed ?? it.content }, keywords };
    }),
  );
  const { error } = await sb.from("agent_memory_items").insert(prepared.map((p) => p.row));
  if (error) return { ids: [], error: error.message };
  const ids: string[] = [];
  for (const p of prepared) {
    if (!p.keywords) {
      ids.push(p.row.id);
      continue;
    }
    const { error: kwErr } = await sb
      .from("agent_memory_items")
      .update({ keywords: p.keywords })
      .eq("id", p.row.id);
    if (kwErr) {
      await sb.from("agent_memory_items").delete().eq("id", p.row.id);
      return { ids, error: `the item's keywords could not be written: ${kwErr.message}` };
    }
    ids.push(p.row.id);
  }
  return { ids, error: null };
}

/** The words recall looks for: as they are (items from before R445) and as the owner's tokens. */
export async function recallTerms(userId: string, words: string[]): Promise<string[]> {
  if (words.length === 0) return [];
  try {
    const blind = await blindTokens(words, userId);
    return blind ? [...words, ...blind] : words;
  } catch (e) {
    // The owner's key cannot be had: their sealed items cannot be read either,
    // so only the plaintext ones are looked for.
    if (isMemoryKeyError(e)) return words;
    throw e;
  }
}

/** A memory item's content, opened. Throws DataKeyUnavailableError when its key is gone. */
export function openMemoryContent(row: { id: string; content: string }): Promise<string> {
  return openText(row.content, memoryWhere.item(row.id));
}

/** A conversation summary to store: sealed, or as it is before the user-key tables exist. */
export async function sealSummary(
  owner: string,
  conversationId: string,
  summary: string,
): Promise<string> {
  return (
    (await sealText(summary, { owner, where: memoryWhere.summary(conversationId) })) ?? summary
  );
}

/** A stored conversation summary, opened (null stays null). */
export async function openSummary(
  conversationId: string,
  stored: string | null,
): Promise<string | null> {
  if (stored == null) return null;
  return openText(stored, memoryWhere.summary(conversationId));
}

/** A scratchpad to store: sealed, or as it is before the user-key tables exist. */
export async function sealScratchpad(
  owner: string,
  conversationId: string,
  pad: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sealed = await sealText(JSON.stringify(pad), {
    owner,
    where: memoryWhere.scratchpad(conversationId),
  });
  return sealed ? { [SEALED_SCRATCHPAD_KEY]: sealed } : pad;
}

/** A stored scratchpad, opened; one from before R445 comes back as it is. */
export async function openScratchpad(
  conversationId: string,
  stored: unknown,
): Promise<Record<string, unknown>> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const pad = stored as Record<string, unknown>;
  const sealed = pad[SEALED_SCRATCHPAD_KEY];
  if (!isSealedText(sealed)) return pad;
  const parsed = JSON.parse(await openText(sealed, memoryWhere.scratchpad(conversationId)));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

// ── The pass ─────────────────────────────────────────────────────────────────

/** How many memory values one background pass seals; the button's pass has no limit. */
export function memorySealPerPass(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.MEMORY_SEAL_PER_PASS ?? "").trim();
  if (!raw) return 1000;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : 1000;
}

const PAGE = 200;

/**
 * Seal what agents kept before R445: long-term memory items (with their
 * keywords as blind tokens), conversation summaries and scratchpads. At most
 * `limit` values are sealed; nothing at all before the user-key tables exist.
 * A value is written only if it is still the one that was read.
 */
export async function sealOlderMemory(opts: { limit?: number } = {}): Promise<MemoryPass> {
  const r: MemoryPass = {
    items: 0,
    summaries: 0,
    scratchpads: 0,
    unreadable: 0,
    left: false,
    failed: 0,
    errors: [],
  };
  let budget = opts.limit ?? Number.POSITIVE_INFINITY;
  const fail = (what: string, e: unknown) => {
    if (isMemoryKeyError(e)) {
      r.unreadable++;
      return;
    }
    r.failed++;
    if (r.errors.length < 10) r.errors.push(`${what}: ${(e as Error).message}`);
  };

  // Long-term memory items.
  let cursor = "";
  for (;;) {
    if (budget <= 0) break;
    const { data, error } = await supabaseAdmin
      .from("agent_memory_items")
      .select("id, user_id, content")
      .not("content", "like", "ck1:%")
      .gt("id", cursor || "00000000-0000-0000-0000-000000000000")
      .order("id")
      .limit(PAGE);
    if (error) {
      fail("memory items", new Error(error.message));
      break;
    }
    for (const row of data ?? []) {
      cursor = row.id;
      if (budget <= 0) {
        r.left = true;
        break;
      }
      try {
        const sealed = await sealText(row.content, {
          owner: row.user_id,
          where: memoryWhere.item(row.id),
        });
        // No user keys yet: nothing in this pass can be sealed.
        if (!sealed) return r;
        const keywords = (await blindTokens(tokenize(row.content), row.user_id)) ?? [];
        // The content first: the trigger derives fragments of it. Then the
        // keywords, by an update that names no content, so the trigger leaves them.
        const { data: moved, error: e1 } = await supabaseAdmin
          .from("agent_memory_items")
          .update({ content: sealed })
          .eq("id", row.id)
          .eq("content", row.content)
          .select("id");
        if (e1) throw new Error(e1.message);
        if (!moved?.length) continue;
        const { error: e2 } = await supabaseAdmin
          .from("agent_memory_items")
          .update({ keywords })
          .eq("id", row.id);
        if (e2) throw new Error(e2.message);
        r.items++;
        budget--;
      } catch (e) {
        fail(`memory item ${row.id}`, e);
      }
    }
    if (!data || data.length < PAGE || r.left) break;
  }

  // Conversation summaries.
  cursor = "";
  for (;;) {
    if (budget <= 0) break;
    const { data, error } = await supabaseAdmin
      .from("conversation_memory")
      .select("conversation_id, user_id, summary")
      .not("summary", "like", "ck1:%")
      .gt("conversation_id", cursor || "00000000-0000-0000-0000-000000000000")
      .order("conversation_id")
      .limit(PAGE);
    if (error) {
      fail("summaries", new Error(error.message));
      break;
    }
    for (const row of data ?? []) {
      cursor = row.conversation_id;
      if (row.summary == null) continue;
      if (budget <= 0) {
        r.left = true;
        break;
      }
      try {
        const sealed = await sealText(row.summary, {
          owner: row.user_id,
          where: memoryWhere.summary(row.conversation_id),
        });
        if (!sealed) return r;
        const { data: moved, error: e1 } = await supabaseAdmin
          .from("conversation_memory")
          .update({ summary: sealed })
          .eq("conversation_id", row.conversation_id)
          .eq("summary", row.summary)
          .select("conversation_id");
        if (e1) throw new Error(e1.message);
        if (!moved?.length) continue;
        r.summaries++;
        budget--;
      } catch (e) {
        fail(`summary ${row.conversation_id}`, e);
      }
    }
    if (!data || data.length < PAGE || r.left) break;
  }

  // Scratchpads: a sealed one cannot be told apart in a query (its one key
  // holds a colon), so the non-empty ones are walked and checked here.
  cursor = "";
  for (;;) {
    if (budget <= 0) break;
    const { data, error } = await supabaseAdmin
      .from("conversation_memory")
      .select("conversation_id, user_id, scratchpad")
      .neq("scratchpad", "{}")
      .gt("conversation_id", cursor || "00000000-0000-0000-0000-000000000000")
      .order("conversation_id")
      .limit(PAGE);
    if (error) {
      fail("scratchpads", new Error(error.message));
      break;
    }
    for (const row of data ?? []) {
      cursor = row.conversation_id;
      const pad = row.scratchpad;
      if (!pad || typeof pad !== "object" || Array.isArray(pad)) continue;
      if (isSealedText((pad as Record<string, unknown>)[SEALED_SCRATCHPAD_KEY])) continue;
      if (budget <= 0) {
        r.left = true;
        break;
      }
      try {
        const sealed = await sealScratchpad(
          row.user_id,
          row.conversation_id,
          pad as Record<string, unknown>,
        );
        if (!isSealedText(sealed[SEALED_SCRATCHPAD_KEY])) return r;
        const { error: e1 } = await supabaseAdmin
          .from("conversation_memory")
          .update({ scratchpad: sealed as never })
          .eq("conversation_id", row.conversation_id);
        if (e1) throw new Error(e1.message);
        r.scratchpads++;
        budget--;
      } catch (e) {
        fail(`scratchpad ${row.conversation_id}`, e);
      }
    }
    if (!data || data.length < PAGE || r.left) break;
  }
  return r;
}
