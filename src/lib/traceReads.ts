// A trace's row for the Agent Chat trace panel. Since R448 a trace's bodies are
// sealed under the user's key, which the browser does not hold, so it is read
// through the server (src/utils/traceLog.functions.ts); this gives it back as
// `{ data, error }`, as Supabase did, so the panel's handling stays what it was.
import { withToken } from "@/lib/chatHistory";
import { getExecutionTraceDetail, type ExecutionTraceRow } from "@/utils/traceLog.functions";

/** The signed-in user's trace, or null while it has not been written. */
export async function traceById(id: string): Promise<{
  data: ExecutionTraceRow | null;
  error: { message: string } | null;
}> {
  const r = await withToken((t) => getExecutionTraceDetail({ data: { accessToken: t, id } }));
  return { data: r.data?.trace ?? null, error: r.error };
}
