// Swarm chats and AI Analyst threads under their owner's user key (R447).
//
// A swarm chat keeps its whole transcript and the flow state it carries; an
// analysis keeps its turns: the question, the SQL, the narrative and samples
// of the rows it read. Both are sealed by the app under the user's key (as
// Agent Chat is, sealedChat.server), which a customer key wraps when the user
// is a customer's member. The browser used to read and write these rows
// itself, so it goes through the server now (swarmChats.functions,
// analystThreads.functions); a scheduled analysis opens and seals on the
// server. Deleting stays in the browser: it reads nothing.
//
// A JSON column's sealed form is an object of one key, which no real value has
// (`ck1:sealed`), holding the value as sealed text. A row's title is always
// sealed with it, the starting one too: that is how the pass finds the rows
// left to do, since Postgres cannot be asked about a key with a colon in it
// through PostgREST. Values stored before R447 are plaintext and read as they
// are.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { DataKeyUnavailableError } from "@/utils/kms/keyHierarchy.server";
import { isSealedText, openText, sealText } from "@/utils/providers/crypto.server";
import type { ChatPass } from "./chatPass";

export const SEALED_JSON_KEY = "ck1:sealed";

export const threadWhere = {
  swarmTitle: (id: string) => `swarm_chats/${id}/title`,
  swarmMessages: (id: string) => `swarm_chats/${id}/messages`,
  swarmState: (id: string) => `swarm_chats/${id}/state`,
  analystTitle: (id: string) => `ai_analyst_threads/${id}/title`,
  analystTurns: (id: string) => `ai_analyst_threads/${id}/turns`,
};

/** Why a value cannot be opened, in words: the key's own reason, or that it did not open. */
export function unreadableReason(e: unknown): string {
  return e instanceof DataKeyUnavailableError
    ? e.message
    : `It did not open: ${(e as Error).message}`;
}

/** Whether a JSON column holds a sealed value. */
export function isSealedJson(stored: unknown): boolean {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
  return isSealedText((stored as Record<string, unknown>)[SEALED_JSON_KEY]);
}

/** A value for a JSON column, sealed; null before the user-key tables exist. */
export async function sealJson(
  value: unknown,
  opts: { owner: string; where: string },
): Promise<Json | null> {
  const sealed = await sealText(JSON.stringify(value), opts);
  return sealed ? { [SEALED_JSON_KEY]: sealed } : null;
}

/** A JSON column's value, opened; one from before R447 comes back as it is. */
export async function openJson<T>(stored: unknown, where: string): Promise<T> {
  if (!isSealedJson(stored)) return stored as T;
  const text = (stored as Record<string, string>)[SEALED_JSON_KEY];
  return JSON.parse(await openText(text, where)) as T;
}

export type StoredSwarmChat = { title: unknown; messages: unknown; state: unknown };

/**
 * A swarm chat's row, sealed under `owner`'s key and bound to its id; as it is
 * before the user-key tables exist. Throws DataKeyUnavailableError when the
 * owner's key cannot be had: never sealed under another key.
 */
export async function sealSwarmChat(
  owner: string,
  id: string,
  chat: { title: string; messages: unknown; state: unknown },
): Promise<{ title: string; messages: Json; state: Json }> {
  const title = await sealText(chat.title, { owner, where: threadWhere.swarmTitle(id) });
  if (!title) {
    return { title: chat.title, messages: chat.messages as Json, state: chat.state as Json };
  }
  return {
    title,
    messages: (await sealJson(chat.messages, {
      owner,
      where: threadWhere.swarmMessages(id),
    })) as Json,
    state: (await sealJson(chat.state, { owner, where: threadWhere.swarmState(id) })) as Json,
  };
}

/** A sealed analysis's title and turns; as they are before the user-key tables exist. */
export async function sealAnalystThread(
  owner: string,
  id: string,
  thread: { title: string; turns: unknown },
): Promise<{ title: string; turns: Json }> {
  const title = await sealText(thread.title, { owner, where: threadWhere.analystTitle(id) });
  if (!title) return { title: thread.title, turns: thread.turns as Json };
  return {
    title,
    turns: (await sealJson(thread.turns, {
      owner,
      where: threadWhere.analystTurns(id),
    })) as Json,
  };
}

/** An analysis's title, opened. Throws when it cannot be. */
export function openAnalystTitle(row: { id: string; title: string }): Promise<string> {
  return openText(row.title, threadWhere.analystTitle(row.id));
}

/** An analysis's turns, opened. Throws when they cannot be. */
export function openAnalystTurns<T>(row: { id: string; turns: unknown }): Promise<T> {
  return openJson<T>(row.turns, threadWhere.analystTurns(row.id));
}

// ── The pass ─────────────────────────────────────────────────────────────────

const PAGE = 200;
const NO_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Seal swarm chats and analyses kept before R447, at most `budget` rows; the
 * budget left comes back. `r` is the chat pass it reports into. A row that
 * cannot be sealed (its owner's key cannot be had) is counted and left. Its
 * title is the marker, and the guard: a row is written only if its title is
 * still the one that was read.
 */
export async function sealOlderThreads(r: ChatPass, budget: number): Promise<number> {
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
    if (budget <= 0) break;
    const { data, error } = await supabaseAdmin
      .from("swarm_chats")
      .select("id, user_id, title, messages, state")
      .not("title", "like", "ck1:%")
      .gt("id", cursor)
      .order("id")
      .limit(PAGE);
    if (error) {
      fail("swarm chats", new Error(error.message));
      break;
    }
    for (const row of data ?? []) {
      cursor = row.id;
      if (budget <= 0) {
        r.left = true;
        break;
      }
      try {
        const sealed = await sealSwarmChat(row.user_id, row.id, row);
        // No user keys yet: nothing in this pass can be sealed.
        if (!isSealedText(sealed.title)) return budget;
        const { data: moved, error: e1 } = await supabaseAdmin
          .from("swarm_chats")
          .update(sealed as never)
          .eq("id", row.id)
          .eq("title", row.title)
          .select("id");
        if (e1) throw new Error(e1.message);
        if (!moved?.length) continue;
        r.swarmChats++;
        budget--;
      } catch (e) {
        fail(`swarm chat ${row.id}`, e);
      }
    }
    if (!data || data.length < PAGE || r.left) break;
  }

  cursor = NO_ID;
  for (;;) {
    if (budget <= 0) break;
    const { data, error } = await supabaseAdmin
      .from("ai_analyst_threads")
      .select("id, user_id, title, turns")
      .not("title", "like", "ck1:%")
      .gt("id", cursor)
      .order("id")
      .limit(PAGE);
    if (error) {
      fail("analyses", new Error(error.message));
      break;
    }
    for (const row of data ?? []) {
      cursor = row.id;
      if (budget <= 0) {
        r.left = true;
        break;
      }
      try {
        // A save since R447 may have sealed the turns of a row whose title
        // was still plaintext.
        const turns = await openAnalystTurns<unknown>(row);
        const sealed = await sealAnalystThread(row.user_id, row.id, { title: row.title, turns });
        if (!isSealedText(sealed.title)) return budget;
        const { data: moved, error: e1 } = await supabaseAdmin
          .from("ai_analyst_threads")
          .update(sealed as never)
          .eq("id", row.id)
          .eq("title", row.title)
          .select("id");
        if (e1) throw new Error(e1.message);
        if (!moved?.length) continue;
        r.analystThreads++;
        budget--;
      } catch (e) {
        fail(`analysis ${row.id}`, e);
      }
    }
    if (!data || data.length < PAGE || r.left) break;
  }
  return budget;
}
