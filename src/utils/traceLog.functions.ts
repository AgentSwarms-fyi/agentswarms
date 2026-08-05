import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const TraceLogInput = z.object({
  accessToken: z.string().min(1),
  days: z.number().int().min(1).max(365),
});

const TraceDetailInput = z.object({
  accessToken: z.string().min(1),
  id: z.string().uuid(),
});

export type ExecutionTraceRow = {
  id: string;
  agent_name: string;
  llm_provider: string;
  llm_model: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  status: string;
  prompt: string | null;
  request_payload?: any;
  response_payload?: any;
  tool_calls?: any;
  error_message: string | null;
  created_at: string;
  /** 'true' when the model had no known price at record time (cost_usd is 0
   *  because nothing knew the rate, not because the call was free). Projected
   *  from request_payload by the list query; the reprice sweep clears it. */
  pricing_missing?: string | null;
};

// pricing_missing is projected out of the jsonb payload rather than selecting
// the whole payload: the list pulls 2000 rows and request_payload carries
// prompt/response previews. A $0.0000 with this flag set is money nothing knew
// how to price — the UI must not render it as if the call were free.
const TRACE_LIST_COLUMNS =
  "id, agent_name, llm_provider, llm_model, latency_ms, tokens_in, tokens_out, cost_usd, status, prompt, error_message, created_at, parent_trace_id, pricing_missing:request_payload->>pricing_missing";

export const getExecutionTraces = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => TraceLogInput.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; traces: ExecutionTraceRow[] } | { ok: false; error: string }> => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(
        data.accessToken,
      );
      const userId = authData.user?.id;
      if (authError || !userId) {
        return { ok: false, error: authError?.message ?? "Invalid session" };
      }

      const since = new Date(Date.now() - data.days * 86400000).toISOString();
      const { data: rows, error } = await supabaseAdmin
        .from("execution_traces")
        .select(TRACE_LIST_COLUMNS)
        .eq("user_id", userId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(2000);

      if (error) return { ok: false, error: error.message };
      return { ok: true, traces: (rows ?? []) as ExecutionTraceRow[] };
    },
  );

export const getExecutionTraceDetail = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => TraceDetailInput.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; trace: ExecutionTraceRow | null } | { ok: false; error: string }> => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(
        data.accessToken,
      );
      const userId = authData.user?.id;
      if (authError || !userId) {
        return { ok: false, error: authError?.message ?? "Invalid session" };
      }

      const { data: row, error } = await supabaseAdmin
        .from("execution_traces")
        .select("*")
        .eq("id", data.id)
        .eq("user_id", userId)
        .maybeSingle();

      if (error) return { ok: false, error: error.message };
      if (!row) return { ok: true, trace: null };
      // The list projects pricing_missing out of the payload; the detail row
      // replaces the list row in the UI, so it must carry the same field or
      // an "unpriced" cost would flip back to $0.0000 the moment the panel
      // finishes loading.
      const payload = (row as { request_payload?: { pricing_missing?: unknown } }).request_payload;
      const trace = {
        ...(row as object),
        pricing_missing:
          payload?.pricing_missing === true || payload?.pricing_missing === "true" ? "true" : null,
      };
      return { ok: true, trace: trace as ExecutionTraceRow };
    },
  );
