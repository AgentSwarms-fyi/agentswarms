// Agent Chat history under its owner's user key (R446).
//
// A conversation's messages (their text and their metadata: citations, the
// knowledge-base passages they quote, a generated document's name and
// thumbnail) and its title are sealed by the app under the user's key
// (crypto.server's sealed text), which a customer key wraps when the user is a
// customer's member. Erasing the key, destroying the customer key or the
// customer revoking theirs leaves them unreadable, and nobody else's.
//
// The browser used to read and write these rows itself, so it could not be
// given a key; the chat page now goes through chatHistory.functions, which
// seals on the way in and opens on the way out. Deleting stays in the
// browser: it reads nothing.
//
// One field stays readable: a generated document's storage path
// (`<user id>/<file id>.<ext>`, no content), which chat retention finds in SQL
// (`metadata->doc->>path`) to delete the file with its message. The document's
// name and thumbnail are sealed with the rest.
//
// Values stored before R446 are plaintext and read as they are; the pass below
// seals them.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DataKeyUnavailableError } from "@/utils/kms/keyHierarchy.server";
import { isSealedText, openText, sealText } from "@/utils/providers/crypto.server";
import type { ChatPass } from "./chatPass";
import { sealOlderThreads } from "./sealedThreads.server";

export { chatPassDetail, type ChatPass } from "./chatPass";

export const chatWhere = {
  content: (id: string) => `messages/${id}/content`,
  metadata: (id: string) => `messages/${id}/metadata`,
  title: (id: string) => `conversations/${id}/title`,
};

/** The key a sealed message's metadata is kept under; a colon keeps it apart from real fields. */
export const SEALED_METADATA_KEY = "ck1:metadata";

/** The title a new conversation starts with: no one's words, kept as it is. */
export const DEFAULT_TITLE = "New Chat";

type Metadata = Record<string, unknown> | null;

const docPath = (m: Metadata): string | null => {
  const doc = m?.doc as { path?: unknown } | undefined;
  return typeof doc?.path === "string" && doc.path ? doc.path : null;
};

/**
 * A message to store: its text and metadata sealed under `owner`'s key, bound
 * to the message's id; as they are before the user-key tables exist. Throws
 * DataKeyUnavailableError when the owner's key cannot be had: never sealed
 * under another key.
 */
export async function sealMessage(
  owner: string,
  id: string,
  content: string,
  metadata: Metadata,
): Promise<{ content: string; metadata: Metadata; sealed: boolean }> {
  const sealedContent = await sealText(content, { owner, where: chatWhere.content(id) });
  if (!sealedContent) return { content, metadata, sealed: false };
  const meta = metadata && Object.keys(metadata).length ? metadata : null;
  if (!meta) return { content: sealedContent, metadata: {}, sealed: true };
  const sealedMeta = await sealText(JSON.stringify(meta), {
    owner,
    where: chatWhere.metadata(id),
  });
  const path = docPath(meta);
  return {
    content: sealedContent,
    metadata: { ...(path ? { doc: { path } } : {}), [SEALED_METADATA_KEY]: sealedMeta },
    sealed: true,
  };
}

/**
 * A stored message, opened. One whose key cannot be had (erased, destroyed,
 * refused) or that does not open where it is comes back without its text and
 * says why, so a conversation still loads around it.
 */
export async function openMessage(row: {
  id: string;
  content: string;
  metadata: unknown;
}): Promise<{ content: string; metadata: Metadata; unreadable: string | null }> {
  const stored = (
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata
      : null
  ) as Metadata;
  try {
    const content = await openText(row.content, chatWhere.content(row.id));
    const sealedMeta = stored?.[SEALED_METADATA_KEY];
    const metadata = isSealedText(sealedMeta)
      ? (JSON.parse(await openText(sealedMeta, chatWhere.metadata(row.id))) as Metadata)
      : stored;
    return { content, metadata, unreadable: null };
  } catch (e) {
    return {
      content: "",
      metadata: {},
      unreadable:
        e instanceof DataKeyUnavailableError
          ? e.message
          : `It did not open: ${(e as Error).message}`,
    };
  }
}

/** A conversation title to store: sealed, unless it is the starting one or there is no user key. */
export async function sealTitle(owner: string, id: string, title: string): Promise<string> {
  if (title === DEFAULT_TITLE) return title;
  return (await sealText(title, { owner, where: chatWhere.title(id) })) ?? title;
}

/** A stored title, opened; one that cannot be had reads as such, and the list still loads. */
export async function openTitle(row: { id: string; title: string }): Promise<{
  title: string;
  unreadable: string | null;
}> {
  try {
    return { title: await openText(row.title, chatWhere.title(row.id)), unreadable: null };
  } catch (e) {
    return {
      title: "Cannot be read",
      unreadable:
        e instanceof DataKeyUnavailableError
          ? e.message
          : `It did not open: ${(e as Error).message}`,
    };
  }
}

// ── The pass ─────────────────────────────────────────────────────────────────

/** How many chat values one background pass seals; the button's pass has no limit. */
export function chatSealPerPass(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.CHAT_SEAL_PER_PASS ?? "").trim();
  if (!raw) return 2000;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : 2000;
}

const PAGE = 200;
const NO_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Seal chat history kept before R446 and R447: every Agent Chat message (text
 * and metadata), every title a person wrote or that came from their first
 * message, and every swarm chat and analysis. At most `limit` values; nothing
 * at all before the user-key tables exist. A value is written only if it is
 * still the one that was read.
 */
export async function sealOlderChats(opts: { limit?: number } = {}): Promise<ChatPass> {
  const r: ChatPass = {
    messages: 0,
    titles: 0,
    swarmChats: 0,
    analystThreads: 0,
    unreadable: 0,
    left: false,
    failed: 0,
    errors: [],
  };
  let budget = opts.limit ?? Number.POSITIVE_INFINITY;
  const fail = (what: string, e: unknown) => {
    if (e instanceof DataKeyUnavailableError) {
      r.unreadable++;
      return;
    }
    r.failed++;
    if (r.errors.length < 10) r.errors.push(`${what}: ${(e as Error).message}`);
  };

  // Messages.
  let cursor = NO_ID;
  for (;;) {
    if (budget <= 0) break;
    const { data, error } = await supabaseAdmin
      .from("messages")
      .select("id, user_id, content, metadata")
      .not("content", "like", "ck1:%")
      .gt("id", cursor)
      .order("id")
      .limit(PAGE);
    if (error) {
      fail("messages", new Error(error.message));
      break;
    }
    for (const row of data ?? []) {
      cursor = row.id;
      if (budget <= 0) {
        r.left = true;
        break;
      }
      try {
        const sealed = await sealMessage(
          row.user_id,
          row.id,
          row.content,
          (row.metadata ?? null) as Metadata,
        );
        // No user keys yet: nothing in this pass can be sealed.
        if (!sealed.sealed) return r;
        const { data: moved, error: e1 } = await supabaseAdmin
          .from("messages")
          .update({ content: sealed.content, metadata: sealed.metadata as never })
          .eq("id", row.id)
          .eq("content", row.content)
          .select("id");
        if (e1) throw new Error(e1.message);
        if (!moved?.length) continue;
        r.messages++;
        budget--;
      } catch (e) {
        fail(`message ${row.id}`, e);
      }
    }
    if (!data || data.length < PAGE || r.left) break;
  }

  // Titles.
  cursor = NO_ID;
  for (;;) {
    if (budget <= 0) break;
    const { data, error } = await supabaseAdmin
      .from("conversations")
      .select("id, user_id, title")
      .not("title", "like", "ck1:%")
      .neq("title", DEFAULT_TITLE)
      .gt("id", cursor)
      .order("id")
      .limit(PAGE);
    if (error) {
      fail("titles", new Error(error.message));
      break;
    }
    for (const row of data ?? []) {
      cursor = row.id;
      // The starting title is no one's words (the query leaves it out too).
      if (row.title === DEFAULT_TITLE) continue;
      if (budget <= 0) {
        r.left = true;
        break;
      }
      try {
        const sealed = await sealTitle(row.user_id, row.id, row.title);
        if (!isSealedText(sealed)) return r;
        const { data: moved, error: e1 } = await supabaseAdmin
          .from("conversations")
          .update({ title: sealed })
          .eq("id", row.id)
          .eq("title", row.title)
          .select("id");
        if (e1) throw new Error(e1.message);
        if (!moved?.length) continue;
        r.titles++;
        budget--;
      } catch (e) {
        fail(`title ${row.id}`, e);
      }
    }
    if (!data || data.length < PAGE || r.left) break;
  }

  // Swarm chats and AI Analyst threads (R447).
  await sealOlderThreads(r, budget);
  return r;
}
