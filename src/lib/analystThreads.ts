// The AI Analyst page's reads and writes of its threads. Since R447 they go
// through the server (src/utils/analystThreads.functions.ts), which seals them
// under the user's key; this gives them back as `{ data, error }`, as Supabase
// did, so the page's error handling stays what it was.
import { withToken } from "@/lib/chatHistory";
import {
  getAnalystThread,
  listAnalystThreads,
  saveAnalystThread,
  type AnalystThreadView,
} from "@/utils/analystThreads.functions";

type Result<T> = { data: T | null; error: { message: string } | null };

/** The signed-in user's analyses with an analyst, newest first. */
export async function threadsOf(
  analystId: string,
  limit: number,
): Promise<Result<AnalystThreadView[]>> {
  const r = await withToken((t) =>
    listAnalystThreads({ data: { access_token: t, analyst_id: analystId, limit } }),
  );
  return { data: r.data?.threads ?? null, error: r.error };
}

/** One analysis, read again. */
export async function threadById(id: string): Promise<Result<AnalystThreadView | null>> {
  const r = await withToken((t) => getAnalystThread({ data: { access_token: t, id } }));
  return { data: r.data?.thread ?? null, error: r.error };
}

/** Save an analysis's turns: over its row, or as a new one when `id` is null. */
export async function saveThread(args: {
  id: string | null;
  analyst: string;
  title: string;
  turns: unknown[];
}): Promise<Result<AnalystThreadView>> {
  const r = await withToken((t) =>
    saveAnalystThread({
      data: {
        access_token: t,
        id: args.id,
        analyst_id: args.analyst,
        title: args.title,
        turns: args.turns,
      },
    }),
  );
  return { data: r.data?.thread ?? null, error: r.error };
}
