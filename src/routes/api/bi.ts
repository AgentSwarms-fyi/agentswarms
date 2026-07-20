// POST /api/bi
// Lightweight JSON-only LLM endpoint for the BI Agent pipeline (plan / sql /
// chart / narrative / suggestions). Uses OpenRouter with
// response_format: json_object so the client can JSON.parse the reply
// directly without prose-stripping heuristics.
//
// Auth: Bearer token (any signed-in user). Writes one execution_traces row
// per call so analytics stay accurate.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { recordGatewayCall, extractUsage } from "@/utils/observability/recordGatewayUsage.server";
import { getEffectiveModelRules, isModelAllowed } from "@/utils/iam.server";
import {
  OPENROUTER_CHAT_URL,
  getOpenRouterApiKey,
} from "@/utils/providers/openrouterDefault.server";

const DEFAULT_MODEL = "google/gemini-2.5-flash";

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

        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL!;
        const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
        const userClient = createClient(supabaseUrl, supabaseKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const {
          data: { user },
        } = await userClient.auth.getUser();
        if (!user) return json({ error: "Unauthorized" }, 401);

        const apiKey = getOpenRouterApiKey();
        if (!apiKey) return json({ error: "BI Agent unavailable (no API key)" }, 503);

        const body = (await request.json().catch(() => ({}))) as {
          systemPrompt?: string;
          userPrompt?: string;
          model?: string;
          temperature?: number;
          stage?: string;
        };
        if (!body.userPrompt) return json({ error: "userPrompt required" }, 400);

        const startedAt = Date.now();
        const model = body.model || DEFAULT_MODEL;
        const surface = surfaceFor(body.stage);

        // IAM model governance: same gate as /api/chat. BI calls route
        // through OpenRouter, so rules match against provider "openrouter".
        const rules = await getEffectiveModelRules(
          userClient as unknown as Parameters<typeof getEffectiveModelRules>[0],
          user.id,
        );
        if (rules && !isModelAllowed(rules, "openrouter", model)) {
          return json(
            { error: `Your administrator has not allowed the model openrouter/${model}.` },
            403,
          );
        }

        const r = await fetch(OPENROUTER_CHAT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "system",
                content:
                  (body.systemPrompt || "You are a helpful assistant.") +
                  "\n\nYou MUST respond with a single valid JSON object. No prose, no markdown, no commentary.",
              },
              { role: "user", content: body.userPrompt },
            ],
            response_format: { type: "json_object" },
            temperature: typeof body.temperature === "number" ? body.temperature : 0.1,
          }),
        });

        if (!r.ok) {
          const errText = await r.text().catch(() => "");
          void recordGatewayCall({
            userId: user.id,
            surface,
            model,
            promptText: body.userPrompt,
            latencyMs: Date.now() - startedAt,
            status: "error",
            errorMessage: `Gateway ${r.status}: ${errText.slice(0, 200)}`,
          });
          if (r.status === 429) return json({ error: "Rate limited. Please retry shortly." }, 429);
          if (r.status === 402) return json({ error: "AI credits exhausted." }, 402);
          return json({ error: `Gateway error ${r.status}: ${errText.slice(0, 200)}` }, r.status);
        }

        const data = (await r.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content ?? "{}";
        const usage = extractUsage(data);

        void recordGatewayCall({
          userId: user.id,
          surface,
          model,
          promptText: body.userPrompt,
          responseText: text,
          tokensIn: usage?.tokensIn,
          tokensOut: usage?.tokensOut,
          latencyMs: Date.now() - startedAt,
          status: "success",
          responsePreview: text.slice(0, 800),
        });

        // The gateway with response_format: json_object should return clean
        // JSON, but be defensive: strip fences just in case some providers
        // ignore the flag.
        const cleaned = text
          .trim()
          .replace(/^```(?:json)?/i, "")
          .replace(/```$/, "")
          .trim();
        try {
          const parsed = JSON.parse(cleaned);
          return json({ result: parsed });
        } catch {
          // Last-ditch: extract the first {...} block.
          const m = cleaned.match(/\{[\s\S]*\}/);
          if (m) {
            try {
              return json({ result: JSON.parse(m[0]) });
            } catch {
              /* fall through */
            }
          }
          return json({ error: "Model returned non-JSON", raw: cleaned.slice(0, 400) }, 502);
        }
      },
    },
  },
});
