// An agent's long-term memory as its owner sees it in the agent form. Since
// R445 memory items are sealed under their owner's key, which the browser does
// not hold, so the form reads them through here: the caller's own items for
// the agent, opened. Deleting stays in the browser, under the table's own
// row-level security, since it reads nothing.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callerFailure } from "@/utils/callerLookup.server";
import { isMemoryKeyError, openMemoryContent } from "@/utils/memory/sealed.server";
import { isSealedText } from "@/utils/providers/crypto.server";

export type MemoryItemView = {
  id: string;
  kind: string;
  /** Null when it cannot be opened; `unreadable` then says why. */
  content: string | null;
  unreadable: string | null;
  /** Kept encrypted under its owner's key; false for an item from before R445 the pass has not reached. */
  sealed: boolean;
  score: number;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
};

const input = z.object({ access_token: z.string().min(1), agent_id: z.string().uuid() });

export const listAgentMemoryItems = createServerFn({ method: "POST" })
  .validator((v: unknown) => input.parse(v))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; items: MemoryItemView[] } | { ok: false; error: string }> => {
      const { data: auth, error: authErr } = await supabaseAdmin.auth.getUser(data.access_token);
      if (authErr || !auth?.user)
        return { ok: false, error: callerFailure(authErr, "Unauthorized") };
      const { data: rows, error } = await supabaseAdmin
        .from("agent_memory_items")
        .select("id, kind, content, score, usage_count, last_used_at, created_at")
        .eq("user_id", auth.user.id)
        .eq("agent_id", data.agent_id)
        .order("last_used_at", { ascending: false, nullsFirst: false })
        .limit(200);
      if (error)
        return { ok: false, error: `Could not read this agent's memory: ${error.message}` };
      const items = await Promise.all(
        (rows ?? []).map(async (row): Promise<MemoryItemView> => {
          try {
            return {
              ...row,
              content: await openMemoryContent(row),
              unreadable: null,
              sealed: isSealedText(row.content),
            };
          } catch (e) {
            return {
              ...row,
              content: null,
              sealed: isSealedText(row.content),
              unreadable: isMemoryKeyError(e)
                ? (e as Error).message
                : `It did not open: ${(e as Error).message}`,
            };
          }
        }),
      );
      return { ok: true, items };
    },
  );
