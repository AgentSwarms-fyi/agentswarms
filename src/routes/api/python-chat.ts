// Non-streaming chat completions for Developer-workspace notebooks. Server
// kernels call this via the injected `agentswarms` helper (chat / chat_model /
// llama_llm), presenting a short-lived session token instead of any API key.
//
// Reuses the same credential resolution as /api/chat (per-user keys with the
// operator OpenRouter fallback) and the same IAM model-rule gate, but returns
// a single JSON body — much easier to consume from Python than an SSE stream.
// OpenAI-compatible providers only (openrouter, openai, gemini, groq, grok,
// qwen, ollama, vllm, nvidia).
import { createFileRoute } from "@tanstack/react-router";
import { chooseModel, type IamClient } from "@/utils/providers/defaultModel.server";
import { providerFetch } from "@/utils/ssrfGuard.server";
import { resolveOpenAICompatTransport } from "@/utils/providers/credentials.server";
import type { ProviderId } from "@/utils/providers/types";
import { getEffectiveModelRules, isModelAllowed } from "@/utils/iam.server";
import { budgetRefusal } from "@/utils/budgetGuard.server";
import { resolvePythonCaller } from "@/utils/notebookRuntime/caller.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const COMPAT_PROVIDERS = new Set<string>([
  "openai",
  "gemini",
  "grok",
  "groq",
  "openrouter",
  "ollama",
  "qwen",
  "vllm",
  "nvidia",
]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/python-chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Accepts a Supabase user JWT (app-side callers) OR a notebook-runtime
        // session token (server kernel). Both resolve to a userId; provider keys
        // stay server-side either way.
        const caller = await resolvePythonCaller(request);
        if (!caller) return json(401, { error: "Sign in to run notebook model calls" });
        if ("checkFailed" in caller) return json(503, { error: caller.checkFailed });
        const { userId, sb } = caller;

        let body: {
          provider?: string;
          model?: string;
          // Messages are forwarded verbatim, so assistant messages may carry
          // `tool_calls` and tool results arrive as `{role:"tool", ...}`.
          messages?: Array<{ role: string; content?: unknown; [k: string]: unknown }>;
          temperature?: number;
          max_tokens?: number;
          // OpenAI-style tool schemas + choice, for llm.bind_tools() / agents.
          tools?: unknown[];
          tool_choice?: unknown;
        };
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }

        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (messages.length === 0) return json(400, { error: "messages array is required" });
        // The notebook's chat_model(model=…) when this user can use it, else
        // the instance default (providers/defaultModel.server). A provider this
        // proxy cannot speak to is a choice it cannot use, like an unconnected one.
        const wanted = (body.provider || "").toLowerCase();
        const chosen = await chooseModel(
          userId,
          !wanted || COMPAT_PROVIDERS.has(wanted)
            ? { provider: wanted || null, model: body.model ?? null }
            : null,
          { iamClient: sb as unknown as IamClient },
        );
        if (!chosen.ok) {
          return json(chosen.status, {
            error: chosen.status === 403 ? "model_not_allowed" : "model_unavailable",
            message: chosen.error,
          });
        }
        const provider = chosen.provider;
        const model = chosen.model;

        if (!COMPAT_PROVIDERS.has(provider)) {
          return json(400, {
            error: "unsupported_provider",
            message:
              `Provider "${provider}" isn't available in Python notebooks. ` +
              `Use one of: ${[...COMPAT_PROVIDERS].join(", ")}.`,
          });
        }

        // IAM model governance — same rules as /api/chat.
        const rules = await getEffectiveModelRules(sb, userId);
        if (rules && !isModelAllowed(rules, provider, model)) {
          return json(403, {
            error: "model_not_allowed",
            message: `Your administrator has not allowed ${provider}/${model} for your account.`,
          });
        }

        // The monthly AI budget — same check and same 402 as /api/chat.
        const overBudget = await budgetRefusal(userId);
        if (overBudget) return json(402, { error: "budget_exceeded", message: overBudget });

        const transport = await resolveOpenAICompatTransport({
          userId,
          provider: provider as ProviderId,
        });
        if (!transport) {
          return json(400, {
            error: "provider_not_configured",
            message:
              `No credentials found for "${provider}". Connect it under /integrations` +
              (provider === "openrouter"
                ? " (or ask the operator to set OPENROUTER_API_KEY)."
                : "."),
          });
        }

        const startedAt = Date.now();
        let status = 0;
        let content = "";
        let toolCalls: unknown[] | undefined;
        let finishReason: string | undefined;
        let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
        let errorMessage: string | null = null;
        try {
          const res = await providerFetch(transport.endpointUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(transport.apiKey ? { Authorization: `Bearer ${transport.apiKey}` } : {}),
              ...(transport.extraHeaders ?? {}),
            },
            body: JSON.stringify({
              model,
              messages,
              temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
              max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 1024,
              stream: false,
              // Pass tool schemas through only when supplied so plain chat
              // requests are unchanged. Providers that support function-calling
              // (OpenAI, OpenRouter, …) then return `tool_calls`.
              ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
              ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
            }),
          });
          status = res.status;
          const data = (await res.json().catch(() => ({}))) as {
            choices?: {
              message?: { content?: string | null; tool_calls?: unknown[] };
              finish_reason?: string;
            }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
            error?: { message?: string } | string;
          };
          if (!res.ok) {
            const upstream =
              typeof data.error === "string" ? data.error : (data.error?.message ?? "");
            errorMessage = upstream || `Upstream error (${res.status})`;
          } else {
            const message = data.choices?.[0]?.message;
            content = message?.content ?? "";
            toolCalls = Array.isArray(message?.tool_calls) ? message?.tool_calls : undefined;
            finishReason = data.choices?.[0]?.finish_reason;
            usage = data.usage;
          }
        } catch (e) {
          errorMessage = e instanceof Error ? e.message : "Request failed";
        }

        // Best-effort execution trace so notebook calls show up in /traces and
        // count toward budgets. Written as the service role: execution_traces is
        // owner-SELECT with no client write policy (VA-2026-10-25-13), and the
        // row carries user_id, so the trace is attributed correctly without a
        // client ever being able to erase or zero it.
        try {
          await supabaseAdmin.from("execution_traces").insert({
            user_id: userId,
            agent_name: "Python Notebook",
            llm_provider: provider,
            llm_model: model,
            status: errorMessage ? "error" : "success",
            error_message: errorMessage,
            latency_ms: Date.now() - startedAt,
            tokens_in: usage?.prompt_tokens ?? 0,
            tokens_out: usage?.completion_tokens ?? 0,
          });
        } catch {
          /* tracing must never break the call */
        }

        if (errorMessage) {
          return json(status >= 400 && status < 600 ? status : 502, {
            error: "upstream_error",
            message: errorMessage,
          });
        }
        return json(200, {
          content,
          tool_calls: toolCalls ?? null,
          finish_reason: finishReason ?? null,
          model,
          provider,
          usage: usage ?? null,
        });
      },
    },
  },
});
