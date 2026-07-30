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
};

const TRACE_LIST_COLUMNS =
  "id, agent_name, llm_provider, llm_model, latency_ms, tokens_in, tokens_out, cost_usd, status, prompt, error_message, created_at, parent_trace_id";

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
      return { ok: true, trace: (row ?? null) as ExecutionTraceRow | null };
    },
  );
