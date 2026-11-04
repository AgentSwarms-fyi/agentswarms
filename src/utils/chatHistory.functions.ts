// Agent Chat's conversations and messages, read and written through the
// server (R446). Messages and titles are sealed under their owner's user key,
// which the browser does not hold, so the chat page no longer reads or writes
// these rows itself. Each function acts for the signed-in caller on the
// caller's own rows only, as the tables' row-level security did for the
// browser. Deleting stays in the browser, under that same security: it reads
// nothing.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callerFailure } from "@/utils/callerLookup.server";
import type { Json } from "@/integrations/supabase/types";
import {
  DEFAULT_TITLE,
  openMessage,
  openTitle,
  sealMessage,
  sealTitle,
} from "@/utils/chat/sealedChat.server";

type Fail = { ok: false; error: string };

async function callerId(accessToken: string): Promise<string | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { ok: false, error: callerFailure(error, "Unauthorized") };
  return data.user.id;
}

const token = z.string().min(1);
const id = z.string().uuid();

export type ConversationView = {
  id: string;
  user_id: string;
  agent_id: string;
  title: string;
  /** Set when the title cannot be opened; `title` then says so. */
  unreadable: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageView = {
  id: string;
  conversation_id: string;
  user_id: string;
  role: string;
  content: string;
  metadata: Json | null;
  /** Set when the message cannot be opened; `content` is then empty. */
  unreadable: string | null;
  created_at: string;
};

async function openConversation(row: {
  id: string;
  user_id: string;
  agent_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}): Promise<ConversationView> {
  const t = await openTitle(row);
  return { ...row, title: t.title, unreadable: t.unreadable };
}

/** The caller's conversations with one agent, newest first, titles opened. */
export const listConversations = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token, agent_id: id }).parse(v))
  .handler(async ({ data }): Promise<{ ok: true; conversations: ConversationView[] } | Fail> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return user;
    const { data: rows, error } = await supabaseAdmin
      .from("conversations")
      .select("id, user_id, agent_id, title, created_at, updated_at")
      .eq("user_id", user)
      .eq("agent_id", data.agent_id)
      .order("updated_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, conversations: await Promise.all((rows ?? []).map(openConversation)) };
  });

/** A new conversation with an agent, titled as every one starts. */
export const startConversation = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token, agent_id: id }).parse(v))
  .handler(async ({ data }): Promise<{ ok: true; conversation: ConversationView } | Fail> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return user;
    const { data: row, error } = await supabaseAdmin
      .from("conversations")
      .insert({ user_id: user, agent_id: data.agent_id, title: DEFAULT_TITLE })
      .select("id, user_id, agent_id, title, created_at, updated_at")
      .single();
    if (error || !row) return { ok: false, error: error?.message ?? "no conversation came back" };
    return { ok: true, conversation: await openConversation(row) };
  });

/** Name one of the caller's conversations; the title is sealed under their key. */
export const setConversationTitle = createServerFn({ method: "POST" })
  .validator((v: unknown) =>
    z.object({ access_token: token, id, title: z.string().trim().min(1).max(200) }).parse(v),
  )
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return user;
    let title: string;
    try {
      title = await sealTitle(user, data.id, data.title);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const { data: moved, error } = await supabaseAdmin
      .from("conversations")
      .update({ title })
      .eq("id", data.id)
      .eq("user_id", user)
      .select("id");
    if (error) return { ok: false, error: error.message };
    if (!moved?.length) return { ok: false, error: "There is no such conversation of yours" };
    return { ok: true };
  });

/** One of the caller's conversations, its messages opened, oldest first. */
export const listMessages = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token, conversation_id: id }).parse(v))
  .handler(async ({ data }): Promise<{ ok: true; messages: MessageView[] } | Fail> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return user;
    const { data: rows, error } = await supabaseAdmin
      .from("messages")
      .select("id, conversation_id, user_id, role, content, metadata, created_at")
      .eq("conversation_id", data.conversation_id)
      .eq("user_id", user)
      .order("created_at", { ascending: true });
    if (error) return { ok: false, error: error.message };
    const messages = await Promise.all(
      (rows ?? []).map(async (row): Promise<MessageView> => {
        const opened = await openMessage(row);
        return { ...row, ...opened, metadata: (opened.metadata ?? null) as Json | null };
      }),
    );
    return { ok: true, messages };
  });

// A reply can be long, and a document message carries a thumbnail.
const MAX_CONTENT = 1_000_000;
const MAX_METADATA = 4_000_000;

/** Save a message to one of the caller's conversations, sealed under their key. */
export const saveMessage = createServerFn({ method: "POST" })
  .validator((v: unknown) =>
    z
      .object({
        access_token: token,
        conversation_id: id,
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().max(MAX_CONTENT),
        metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      })
      .refine((m) => JSON.stringify(m.metadata ?? {}).length <= MAX_METADATA, {
        message: "The message's metadata is too large to keep",
      })
      .parse(v),
  )
  .handler(async ({ data }): Promise<{ ok: true; id: string } | Fail> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return user;
    // Only into a conversation of the caller's own.
    const { data: convo, error: convoErr } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("id", data.conversation_id)
      .eq("user_id", user)
      .maybeSingle();
    if (convoErr) return { ok: false, error: convoErr.message };
    if (!convo) return { ok: false, error: "There is no such conversation of yours" };
    const messageId = crypto.randomUUID();
    let sealed: Awaited<ReturnType<typeof sealMessage>>;
    try {
      sealed = await sealMessage(user, messageId, data.content, data.metadata ?? null);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const { error } = await supabaseAdmin.from("messages").insert({
      id: messageId,
      conversation_id: data.conversation_id,
      user_id: user,
      role: data.role,
      content: sealed.content,
      metadata: (sealed.metadata ?? {}) as never,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: messageId };
  });
