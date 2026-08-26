// POST /api/bi
// Lightweight JSON-only LLM endpoint for the BI Agent pipeline (plan / sql /
// chart / narrative / suggestions). Routes through OpenRouter with
// response_format: json_object so the client can JSON.parse the reply
// directly without prose-stripping heuristics.
//
// Credentials follow the app's BYOK rule: the CALLER's OpenRouter
// integration (connected under /integrations, incl. base-URL overrides and
// {{secret:}} refs) is used first, falling back to the operator's shared
// OPENROUTER_API_KEY — same resolution as /api/chat and /api/python-chat.
// The default model likewise comes from the caller's integration
// (default_model) before the instance fallback.
//
// Auth: Bearer token (any signed-in user). Writes one execution_traces row
// per call so analytics stay accurate.
//
// The call itself — transport resolution, IAM gating, deadlines, retry and
// JSON salvage — lives in utils/bi/llmJson.server.ts, because embedded AI
// Analysts run the same reasoning without a JWT to authenticate with. This
// handler is the signed-in door onto it.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { llmJsonServer } from "@/utils/bi/llmJson.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// Map the body.stage (sent by the BI Agent client) to the surface label used
// in execution_traces.agent_name so the analytics dashboard can group rows.
function surfaceFor(stage?: string): string {
  switch (stage) {
    case "plan":
      return "BI Agent: Plan";
    case "sql":
      return "BI Agent: SQL";
    case "chart":
      return "BI Agent: Chart";
    case "narrative":
      return "BI Agent: Narrative";
    case "suggestions":
      return "BI Agent: Suggestions";
    default:
      return "BI Agent: Generic";
  }
}

export const Route = createFileRoute("/api/bi")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: corsHeaders }),
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") || "";
        const token = auth.replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Unauthorized" }, 401);

        const supabaseUrl = (process.env.SUPABASE_URL || import.meta.env.VITE_SUPABASE_URL)!;
        const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
        const userClient = createClient(supabaseUrl, supabaseKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const {
          data: { user },
        } = await userClient.auth.getUser();
        if (!user) return json({ error: "Unauthorized" }, 401);

        const body = (await request.json().catch(() => ({}))) as {
          systemPrompt?: string;
          userPrompt?: string;
          provider?: string;
          model?: string;
          temperature?: number;
          stage?: string;
          maxTokens?: number;
        };
        if (!body.userPrompt) return json({ error: "userPrompt required" }, 400);

        const res = await llmJsonServer({
          userId: user.id,
          iamClient: userClient as unknown as Parameters<typeof llmJsonServer>[0]["iamClient"],
          systemPrompt: body.systemPrompt,
          userPrompt: body.userPrompt,
          provider: body.provider,
          model: body.model,
          temperature: body.temperature,
          maxTokens: body.maxTokens,
          surface: surfaceFor(body.stage),
        });
        if (res.ok) return json({ result: res.result });
        return json({ error: res.error, ...(res.raw ? { raw: res.raw } : {}) }, res.status);
      },
    },
  },
});
