// The chat page's reads and writes of its conversations and messages. Since
// R446 they go through the server (src/utils/chatHistory.functions.ts), which
// seals them under the user's key; this gives them back in the shape the page
// handled from Supabase before, `{ data, error }` with `error.message`, so its
// error handling stays what it was. Deletes are not here: they stay direct.
import { supabase } from "@/integrations/supabase/client";
import {
  listConversations,
  listMessages,
  saveMessage as saveMessageFn,
  setConversationTitle,
  startConversation as startConversationFn,
  type ConversationView,
  type MessageView,
} from "@/utils/chatHistory.functions";
import type { Json } from "@/integrations/supabase/types";

type Result<T> = { data: T | null; error: { message: string } | null };

export async function withToken<T>(
  run: (accessToken: string) => Promise<({ ok: true } & T) | { ok: false; error: string }>,
): Promise<Result<T>> {
  try {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) return { data: null, error: { message: "You are signed out" } };
    const r = await run(accessToken);
    if (!r.ok) return { data: null, error: { message: r.error } };
    return { data: r as T, error: null };
  } catch (e) {
    return { data: null, error: { message: (e as Error).message } };
  }
}

/** The signed-in user's conversations with an agent, newest first. */
export async function conversationsOf(agentId: string): Promise<Result<ConversationView[]>> {
  const r = await withToken((t) =>
    listConversations({ data: { access_token: t, agent_id: agentId } }),
  );
  return { data: r.data?.conversations ?? null, error: r.error };
}

/** A new conversation with an agent. */
export async function startConversation(agentId: string): Promise<Result<ConversationView>> {
  const r = await withToken((t) =>
    startConversationFn({ data: { access_token: t, agent_id: agentId } }),
  );
  return { data: r.data?.conversation ?? null, error: r.error };
}

/** Rename a conversation (its title is sealed). */
export async function setTitle(
  id: string,
  title: string,
): Promise<{ error: { message: string } | null }> {
  const r = await withToken((t) => setConversationTitle({ data: { access_token: t, id, title } }));
  return { error: r.error };
}

/** A conversation's messages, oldest first. */
export async function messagesOf(conversationId: string): Promise<Result<MessageView[]>> {
  const r = await withToken((t) =>
    listMessages({ data: { access_token: t, conversation_id: conversationId } }),
  );
  return { data: r.data?.messages ?? null, error: r.error };
}

/** Save a message; its id comes back. */
export async function saveMessage(row: {
  conversation_id: string;
  role: string;
  content: string;
  metadata?: Json;
}): Promise<Result<{ id: string }>> {
  const r = await withToken((t) =>
    saveMessageFn({
      data: {
        access_token: t,
        conversation_id: row.conversation_id,
        role: row.role as "user" | "assistant" | "system",
        content: row.content,
        metadata: (row.metadata ?? null) as Record<string, unknown> | null,
      },
    }),
  );
  return { data: r.data ? { id: r.data.id } : null, error: r.error };
}
