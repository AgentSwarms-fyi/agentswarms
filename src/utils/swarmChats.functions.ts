// Swarm chats, read and written through the server (R447). A transcript and
// its flow state are sealed under their owner's user key, which the browser
// does not hold. Each function acts for the signed-in caller on the caller's
// own rows only, as the table's row-level security did for the browser.
// Deleting stays in the browser, under that same security: it reads nothing.
//
// The answers keep what R109 made of them: a read that failed is never an
// empty transcript, and an update that reached no row is not a save.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callerFailure } from "@/utils/callerLookup.server";
import {
  openJson,
  sealSwarmChat,
  threadWhere,
  unreadableReason,
} from "@/utils/chat/sealedThreads.server";
import { openText } from "@/utils/providers/crypto.server";

type ChatMsg = { role: "user" | "assistant"; content: string; ts: number };

export type SwarmChatRow = { id: string; title: string; updated_at: string };
export type OpenedChat =
  | { ok: true; messages: ChatMsg[]; state: Record<string, string> }
  | { ok: false; error: string; gone: boolean };
export type SavedChat = { ok: true; id: string } | { ok: false; error: string; gone: boolean };

async function callerId(accessToken: string): Promise<string | { error: string }> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { error: callerFailure(error, "Unauthorized") };
  return data.user.id;
}

const token = z.string().min(1);
const id = z.string().uuid();

/** The caller's chats with one swarm, newest first, titles opened. */
export const listSwarmChats = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token, swarm_id: id }).parse(v))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; chats: SwarmChatRow[] } | { ok: false; error: string }> => {
      const user = await callerId(data.access_token);
      if (typeof user !== "string") return { ok: false, error: user.error };
      const { data: rows, error } = await supabaseAdmin
        .from("swarm_chats")
        .select("id, title, updated_at")
        .eq("swarm_id", data.swarm_id)
        .eq("user_id", user)
        .order("updated_at", { ascending: false });
      if (error) return { ok: false, error: error.message };
      const chats = await Promise.all(
        (rows ?? []).map(async (row): Promise<SwarmChatRow> => {
          try {
            return { ...row, title: await openText(row.title, threadWhere.swarmTitle(row.id)) };
          } catch {
            return { ...row, title: "Cannot be read" };
          }
        }),
      );
      return { ok: true, chats };
    },
  );

/** One of the caller's chats, opened: or why not, never an empty stand-in. */
export const openSwarmChat = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token, id }).parse(v))
  .handler(async ({ data }): Promise<OpenedChat> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return { ok: false, error: user.error, gone: false };
    const { data: row, error } = await supabaseAdmin
      .from("swarm_chats")
      .select("messages, state")
      .eq("id", data.id)
      .eq("user_id", user)
      .maybeSingle();
    if (error) return { ok: false, error: error.message, gone: false };
    if (!row) return { ok: false, error: "That conversation no longer exists.", gone: true };
    try {
      const messages = await openJson<ChatMsg[] | null>(
        row.messages,
        threadWhere.swarmMessages(data.id),
      );
      const state = await openJson<Record<string, string> | null>(
        row.state,
        threadWhere.swarmState(data.id),
      );
      return { ok: true, messages: messages ?? [], state: state ?? {} };
    } catch (e) {
      // Not opened is not empty: the dialog keeps what is on screen, so the
      // next turn cannot save over a transcript it never read.
      return {
        ok: false,
        error: `This conversation cannot be read: ${unreadableReason(e)}`,
        gone: false,
      };
    }
  });

// The whole transcript is saved each turn, so it is allowed to be long.
const MAX_TRANSCRIPT = 16_000_000;

/**
 * Save the whole transcript: over the conversation's row when it has one, as a
 * new row when it does not. An update that reaches no row is not a save: the
 * conversation was deleted elsewhere, and saying "saved" would put the turn
 * nowhere.
 */
export const saveSwarmChat = createServerFn({ method: "POST" })
  .validator((v: unknown) =>
    z
      .object({
        access_token: token,
        chat_id: id.nullable(),
        swarm_id: id,
        title: z.string().max(500),
        // As loose as the column: a transcript that could be kept before can
        // be kept now.
        messages: z.array(z.unknown()),
        state: z.record(z.string(), z.unknown()),
      })
      .refine((c) => JSON.stringify([c.messages, c.state]).length <= MAX_TRANSCRIPT, {
        message: "This conversation is too large to keep",
      })
      .parse(v),
  )
  .handler(async ({ data }): Promise<SavedChat> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return { ok: false, error: user.error, gone: false };
    const chatId = data.chat_id ?? crypto.randomUUID();
    let sealed: Awaited<ReturnType<typeof sealSwarmChat>>;
    try {
      sealed = await sealSwarmChat(user, chatId, {
        title: data.title,
        messages: data.messages,
        state: data.state,
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message, gone: false };
    }
    if (data.chat_id) {
      const { data: moved, error } = await supabaseAdmin
        .from("swarm_chats")
        .update(sealed)
        .eq("id", chatId)
        .eq("user_id", user)
        .select("id");
      if (error) return { ok: false, error: error.message, gone: false };
      if (!moved?.length) {
        return { ok: false, error: "This conversation is no longer in the database.", gone: true };
      }
      return { ok: true, id: chatId };
    }
    const { data: row, error } = await supabaseAdmin
      .from("swarm_chats")
      .insert({ id: chatId, user_id: user, swarm_id: data.swarm_id, ...sealed })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message, gone: false };
    if (!row?.id) {
      return { ok: false, error: "The new conversation came back without an id.", gone: false };
    }
    return { ok: true, id: row.id };
  });
