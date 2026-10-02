// Opening and saving a swarm chat's transcript (swarm_chats), with every
// answer read.
//
// FOUND IN R109. The chat dialog read and wrote this table without looking
// at the result. A failed read of a conversation showed an empty thread
// while keeping that conversation selected, so the next message saved
// [question, reply] over the stored transcript. Driven: a chat holding
// "R109 turn one" and "R109 turn two", opened while its read was refused,
// showed "Start the conversation below."; one message later the stored
// chat held only that message and its reply. A save that failed, update or
// insert, left the turn on screen with nothing said, and it was gone when
// the conversation was reopened.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

export type ChatMsg = { role: "user" | "assistant"; content: string; ts: number };

type Client = Pick<SupabaseClient<Database>, "from">;

/** An error message as a sentence, so the one after it does not run on. */
export function asSentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export type OpenedChat =
  | { ok: true; messages: ChatMsg[]; state: Record<string, string> }
  | { ok: false; error: string; gone: boolean };

/** A conversation's transcript, or why it could not be read. Never an empty stand-in. */
export async function openChat(sb: Client, id: string): Promise<OpenedChat> {
  const { data, error } = await sb
    .from("swarm_chats")
    .select("messages, state")
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, gone: false };
  if (!data) return { ok: false, error: "That conversation no longer exists.", gone: true };
  return {
    ok: true,
    messages: ((data.messages as ChatMsg[] | null) ?? []) as ChatMsg[],
    state: ((data.state as Record<string, string> | null) ?? {}) as Record<string, string>,
  };
}

export type SavedChat = { ok: true; id: string } | { ok: false; error: string; gone: boolean };

/**
 * Save the whole transcript: over the conversation's row when it has one,
 * as a new row when it does not. An update that reaches no row is not a
 * save: the conversation was deleted elsewhere, and saying "saved" would
 * put the turn nowhere.
 */
export async function saveChat(
  sb: Client,
  args: {
    chatId: string | null;
    userId: string;
    swarmId: string;
    messages: ChatMsg[];
    state: Record<string, string>;
    title: string;
  },
): Promise<SavedChat> {
  if (args.chatId) {
    const { data, error } = await sb
      .from("swarm_chats")
      .update({ messages: args.messages as never, state: args.state as never, title: args.title })
      .eq("id", args.chatId)
      .select("id");
    if (error) return { ok: false, error: error.message, gone: false };
    if (!data?.length) {
      return { ok: false, error: "This conversation is no longer in the database.", gone: true };
    }
    return { ok: true, id: args.chatId };
  }
  const { data, error } = await sb
    .from("swarm_chats")
    .insert({
      user_id: args.userId,
      swarm_id: args.swarmId,
      messages: args.messages as never,
      state: args.state as never,
      title: args.title,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message, gone: false };
  if (!data?.id)
    return { ok: false, error: "The new conversation came back without an id.", gone: false };
  return { ok: true, id: data.id };
}
