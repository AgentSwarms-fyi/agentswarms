// AI Analyst threads, read and written through the server (R447). An
// analysis's turns hold the question, the SQL, the narrative and samples of
// the rows it read, sealed with its title under the owner's user key, which
// the browser does not hold. Threads are per-user even on a shared analyst, so
// each function acts for the signed-in caller on the caller's own rows only,
// as the table's row-level security did for the browser.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { callerFailure } from "@/utils/callerLookup.server";
import {
  openAnalystTitle,
  openAnalystTurns,
  sealAnalystThread,
  sealJson,
  threadWhere,
  unreadableReason,
} from "@/utils/chat/sealedThreads.server";
import { isSealedText, sealText } from "@/utils/providers/crypto.server";

type Fail = { ok: false; error: string };

export type AnalystThreadView = {
  id: string;
  analyst_id: string;
  title: string;
  turns: Json;
  updated_at: string;
  /** Set when it cannot be opened; `title` then says so and `turns` is empty. */
  unreadable: string | null;
};

async function callerId(accessToken: string): Promise<string | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { ok: false, error: callerFailure(error, "Unauthorized") };
  return data.user.id;
}

async function openThread(row: {
  id: string;
  analyst_id: string;
  title: string;
  turns: unknown;
  updated_at: string;
}): Promise<AnalystThreadView> {
  try {
    return {
      ...row,
      title: await openAnalystTitle(row),
      turns: ((await openAnalystTurns<Json>(row)) ?? []) as Json,
      unreadable: null,
    };
  } catch (e) {
    return { ...row, title: "Cannot be read", turns: [], unreadable: unreadableReason(e) };
  }
}

const token = z.string().min(1);
const id = z.string().uuid();
const COLUMNS = "id, analyst_id, title, turns, updated_at";

/** The caller's analyses with one analyst, newest first, opened. */
export const listAnalystThreads = createServerFn({ method: "POST" })
  .validator((v: unknown) =>
    z
      .object({ access_token: token, analyst_id: id, limit: z.number().int().min(1).max(500) })
      .parse(v),
  )
  .handler(async ({ data }): Promise<{ ok: true; threads: AnalystThreadView[] } | Fail> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return user;
    const { data: rows, error } = await supabaseAdmin
      .from("ai_analyst_threads")
      .select(COLUMNS)
      .eq("analyst_id", data.analyst_id)
      .eq("user_id", user)
      .order("updated_at", { ascending: false })
      .limit(data.limit);
    if (error) return { ok: false, error: error.message };
    return { ok: true, threads: await Promise.all((rows ?? []).map(openThread)) };
  });

/** One of the caller's analyses, opened. Null when it is not there. */
export const getAnalystThread = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token, id }).parse(v))
  .handler(async ({ data }): Promise<{ ok: true; thread: AnalystThreadView | null } | Fail> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return user;
    const { data: row, error } = await supabaseAdmin
      .from("ai_analyst_threads")
      .select(COLUMNS)
      .eq("id", data.id)
      .eq("user_id", user)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, thread: row ? await openThread(row) : null };
  });

const MAX_TURNS = 16_000_000;

/**
 * Save an analysis's turns, sealed: over its row when it has one, as a new row
 * when it does not. An update that reaches no row is not a save.
 */
export const saveAnalystThread = createServerFn({ method: "POST" })
  .validator((v: unknown) =>
    z
      .object({
        access_token: token,
        id: id.nullable(),
        analyst_id: id,
        title: z.string().max(500),
        turns: z.array(z.unknown()),
      })
      .refine((t) => JSON.stringify(t.turns).length <= MAX_TURNS, {
        message: "This analysis is too large to keep",
      })
      .parse(v),
  )
  .handler(async ({ data }): Promise<{ ok: true; thread: AnalystThreadView } | Fail> => {
    const user = await callerId(data.access_token);
    if (typeof user !== "string") return user;
    const now = new Date().toISOString();
    try {
      if (data.id) {
        const { data: row, error: readErr } = await supabaseAdmin
          .from("ai_analyst_threads")
          .select("id, title")
          .eq("id", data.id)
          .eq("user_id", user)
          .maybeSingle();
        if (readErr) return { ok: false, error: readErr.message };
        if (!row) return { ok: false, error: "This analysis is no longer in the database" };
        const turns =
          (await sealJson(data.turns, {
            owner: user,
            where: threadWhere.analystTurns(data.id),
          })) ?? (data.turns as Json);
        // A row from before R447 has its title sealed with its first save.
        const title = isSealedText(row.title)
          ? row.title
          : ((await sealText(row.title, {
              owner: user,
              where: threadWhere.analystTitle(data.id),
            })) ?? row.title);
        const { data: moved, error } = await supabaseAdmin
          .from("ai_analyst_threads")
          .update({ turns, title, updated_at: now })
          .eq("id", data.id)
          .eq("user_id", user)
          .select(COLUMNS)
          .maybeSingle();
        if (error) return { ok: false, error: error.message };
        if (!moved) return { ok: false, error: "This analysis is no longer in the database" };
        return { ok: true, thread: await openThread(moved) };
      }
      const newId = crypto.randomUUID();
      const sealed = await sealAnalystThread(user, newId, {
        title: data.title.slice(0, 80),
        turns: data.turns,
      });
      const { data: row, error } = await supabaseAdmin
        .from("ai_analyst_threads")
        .insert({ id: newId, analyst_id: data.analyst_id, user_id: user, ...sealed })
        .select(COLUMNS)
        .single();
      if (error || !row) {
        return { ok: false, error: error?.message ?? "The analysis came back without a row" };
      }
      return { ok: true, thread: await openThread(row) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
