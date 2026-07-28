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

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { recordGatewayCall, extractUsage } from "@/utils/observability/recordGatewayUsage.server";
import { getEffectiveModelRules, isModelAllowed } from "@/utils/iam.server";
import {
  getProviderDefaultModel,
  resolveOpenAICompatTransport,
} from "@/utils/providers/credentials.server";
import { isBiCompatProvider } from "@/utils/providers/modelChoice";
import type { ProviderId } from "@/utils/providers/types";

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

        // Which of the caller's integrations executes the call. Defaults to
        // OpenRouter (the zero-config path with an operator env fallback).
        const provider = body.provider || "openrouter";
        if (!isBiCompatProvider(provider)) {
          return json({ error: `Provider "${provider}" isn't available for BI.` }, 400);
        }

        // BYOK: the caller's own integration wins; for OpenRouter the
        // operator's shared env key is the zero-config fallback.
        const transport = await resolveOpenAICompatTransport({
          userId: user.id,
          provider: provider as ProviderId,
        });
        if (!transport || (!transport.apiKey && provider !== "ollama")) {
          return json(
            {
              error:
                `${provider} isn't configured. Connect it under Integrations` +
                (provider === "openrouter"
                  ? " (or ask the operator to set OPENROUTER_API_KEY)."
                  : "."),
            },
            503,
          );
        }

        const startedAt = Date.now();
        // Model precedence: explicit choice → the integration's
        // default_model → the operator's OPENROUTER_DEFAULT_MODEL → the
        // instance default (OpenRouter only). The env override matters on
        // shared operator keys that only carry credit for specific models.
        let model = body.model || "";
        if (!model) {
          model = (await getProviderDefaultModel(user.id, provider as ProviderId)) ?? "";
        }
        if (!model && provider === "openrouter") {
          model = process.env.OPENROUTER_DEFAULT_MODEL || DEFAULT_MODEL;
        }
        if (!model) {
          return json(
            {
              error:
                `Pick a model — your ${provider} integration has no default ` +
                "model set (Integrations → edit the connection).",
            },
            400,
          );
        }
        const surface = surfaceFor(body.stage);

        // IAM model governance: same gate as /api/chat, against the
        // executing provider.
        const rules = await getEffectiveModelRules(
          userClient as unknown as Parameters<typeof getEffectiveModelRules>[0],
          user.id,
        );
        if (rules && !isModelAllowed(rules, provider, model)) {
          return json(
            { error: `Your administrator has not allowed the model ${provider}/${model}.` },
            403,
          );
        }
        const gatewayModelLabel = provider === "openrouter" ? model : `${provider}/${model}`;

        // Deadline on the upstream call — a hung provider must surface as a
        // clear error, not an infinite client spinner.
        //
        // Scaled by the completion budget, because a flat deadline is wrong at
        // both ends: a Deep deck plan asks for ~16k tokens of JSON, which no
        // model emits in 100s, so it always timed out; a small insight call
        // should not be allowed to hang for four minutes. ~8ms/token is a
        // pessimistic-but-real rate for a slow free-tier router.
        const completionCap = Math.min(
          typeof body.maxTokens === "number" && body.maxTokens > 0 ? body.maxTokens : 0,
          16000,
        );
        const upstreamMs = Math.min(240_000, 60_000 + completionCap * 8);
        const upstreamCtrl = new AbortController();
        const upstreamTimer = setTimeout(() => upstreamCtrl.abort(), upstreamMs);

        let r: Response;
        try {
          r = await fetch(transport.endpointUrl, {
            method: "POST",
            signal: upstreamCtrl.signal,
            headers: {
              "Content-Type": "application/json",
              ...(transport.apiKey ? { Authorization: `Bearer ${transport.apiKey}` } : {}),
              ...(transport.extraHeaders ?? {}),
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
              // Larger structured outputs (e.g. a 20-slide deck plan) need a
              // higher completion cap or they truncate into invalid JSON.
              ...(completionCap > 0 ? { max_tokens: completionCap } : {}),
            }),
          });
        } catch (e) {
          if ((e as Error).name === "AbortError") {
            // Record it. This path used to return without a trace, so a timed-out
            // Deep deck left no evidence anywhere — the run simply vanished.
            void recordGatewayCall({
              userId: user.id,
              surface,
              model: gatewayModelLabel,
              promptText: body.userPrompt,
              latencyMs: Date.now() - startedAt,
              status: "error",
              errorMessage: `Timed out after ${Math.round(upstreamMs / 1000)}s (max_tokens ${completionCap})`,
            });
            return json(
              {
                error:
                  `${gatewayModelLabel} did not finish within ${Math.round(upstreamMs / 1000)}s. ` +
                  (completionCap >= 12000
                    ? "This is a large document plan — a faster model usually finishes it, or use Browser (Fast) mode."
                    : "Try again, or pick a different model."),
              },
              504,
            );
          }
          throw e;
        } finally {
          clearTimeout(upstreamTimer);
        }

        if (!r.ok) {
          const errText = await r.text().catch(() => "");
          void recordGatewayCall({
            userId: user.id,
            surface,
            model: gatewayModelLabel,
            promptText: body.userPrompt,
            latencyMs: Date.now() - startedAt,
            status: "error",
            errorMessage: `Gateway ${r.status}: ${errText.slice(0, 200)}`,
          });
          // Name the model. This surface can run on a different model from the
          // one the caller thinks they picked (explicit choice → integration
          // default → instance default), and a bare "credits exhausted" sends
          // people to check the wrong account.
          if (r.status === 429) {
            return json(
              { error: `Rate limited on ${gatewayModelLabel}. Please retry shortly.` },
              429,
            );
          }
          if (r.status === 402) {
            return json(
              {
                error:
                  `No credits for ${gatewayModelLabel} on ${provider}. ` +
                  "Add credit, or pick a model your account can use.",
              },
              402,
            );
          }
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
          model: gatewayModelLabel,
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
