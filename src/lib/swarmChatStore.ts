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
//
// Since R447 these go through the server (src/utils/swarmChats.functions.ts),
// which seals a transcript under the user's key. Deleting stays in the dialog.
import { supabase } from "@/integrations/supabase/client";
import {
  listSwarmChats,
  openSwarmChat,
  saveSwarmChat,
  type OpenedChat,
  type SavedChat,
  type SwarmChatRow,
} from "@/utils/swarmChats.functions";

export type { OpenedChat, SavedChat } from "@/utils/swarmChats.functions";

export type ChatMsg = { role: "user" | "assistant"; content: string; ts: number };

/** An error message as a sentence, so the one after it does not run on. */
export function asSentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

async function token(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

const SIGNED_OUT = "You are signed out";

/** The signed-in user's chats with a swarm, newest first. */
export async function listChats(
  swarmId: string,
): Promise<{ data: SwarmChatRow[] | null; error: { message: string } | null }> {
  try {
    const t = await token();
    if (!t) return { data: null, error: { message: SIGNED_OUT } };
    const r = await listSwarmChats({ data: { access_token: t, swarm_id: swarmId } });
    return r.ok ? { data: r.chats, error: null } : { data: null, error: { message: r.error } };
  } catch (e) {
    return { data: null, error: { message: (e as Error).message } };
  }
}

/** A conversation's transcript, or why it could not be read. Never an empty stand-in. */
export async function openChat(id: string): Promise<OpenedChat> {
  try {
    const t = await token();
    if (!t) return { ok: false, error: SIGNED_OUT, gone: false };
    return await openSwarmChat({ data: { access_token: t, id } });
  } catch (e) {
    return { ok: false, error: (e as Error).message, gone: false };
  }
}

/**
 * Save the whole transcript: over the conversation's row when it has one,
 * as a new row when it does not.
 */
export async function saveChat(args: {
  chatId: string | null;
  swarmId: string;
  messages: ChatMsg[];
  state: Record<string, string>;
  title: string;
}): Promise<SavedChat> {
  try {
    const t = await token();
    if (!t) return { ok: false, error: SIGNED_OUT, gone: false };
    return await saveSwarmChat({
      data: {
        access_token: t,
        chat_id: args.chatId,
        swarm_id: args.swarmId,
        title: args.title,
        messages: args.messages,
        state: args.state,
      },
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message, gone: false };
  }
}
