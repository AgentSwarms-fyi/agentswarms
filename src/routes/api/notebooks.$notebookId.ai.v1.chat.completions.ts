// OpenAI-compatible proxy for notebook AI calls. Routes browser-side
// LangChain (ChatOpenAI / etc) through OpenRouter without exposing
// OPENROUTER_API_KEY to the client. Requires an authenticated Supabase session.
// Records every call into execution_traces for analytics.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import {
  OPENROUTER_CHAT_URL,
  getOpenRouterApiKey,
} from "@/utils/providers/openrouterDefault.server";

export const Route = createFileRoute("/api/notebooks/$notebookId/ai/v1/chat/completions")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        }),
      POST: async ({ request, params }) => {
        const notebookId = (params?.notebookId ?? "unknown").slice(0, 64);
        const surface = `Notebook[${notebookId}]: AI Chat`;
        const authHeader = request.headers.get("authorization") ?? "";
        const url = process.env.SUPABASE_URL;
        const anon = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!url || !anon) return json({ error: "Backend not configured" }, 500);
        const sb = createClient(url, anon, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data: userRes, error: uerr } = await sb.auth.getUser();
        if (uerr || !userRes?.user) return json({ error: "Unauthorized" }, 401);

        const apiKey = getOpenRouterApiKey();
        if (!apiKey) return json({ error: "OPENROUTER_API_KEY not configured" }, 500);

        const body = await request.text();
        let parsedBody: { model?: string; messages?: { content?: string }[]; stream?: boolean } =
          {};
        try {
          parsedBody = JSON.parse(body);
        } catch {
          /* ignore */
        }
        const model = parsedBody.model ?? "openai/gpt-4o-mini";
        const userId = userRes.user.id;
        const promptText = (parsedBody.messages ?? [])
          .map((m) => (typeof m?.content === "string" ? m.content : ""))
          .join("\n")
          .slice(0, 4000);
        const t0 = Date.now();

        const res = await fetch(OPENROUTER_CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
        });

        const record = async (opts: {
          tokensIn?: number;
          tokensOut?: number;
          responseText?: string;
          status: "success" | "error";
          errorMessage?: string | null;
        }) => {
          try {
            const { recordGatewayCall } =
              await import("@/utils/observability/recordGatewayUsage.server");
            await recordGatewayCall({
              userId,
              surface,
              model,
              tokensIn: opts.tokensIn,
              tokensOut: opts.tokensOut,
              promptText: opts.tokensIn ? undefined : promptText,
              responseText: opts.responseText,
              latencyMs: Date.now() - t0,
              status: opts.status,
              errorMessage: opts.errorMessage ?? null,
            });
          } catch (e) {
            console.error("[notebooks/chat] trace failed:", e);
          }
        };

        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          await record({ status: "error", errorMessage: `[${res.status}] ${text.slice(0, 200)}` });
          return new Response(text || JSON.stringify({ error: "Gateway error" }), {
            status: res.status || 500,
            headers: {
              "Content-Type": res.headers.get("content-type") ?? "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        const contentType = res.headers.get("content-type") ?? "application/json";
        const isStream = contentType.includes("text/event-stream") || parsedBody.stream === true;

        if (!isStream) {
          const j = await res.json();
          const { extractUsage } = await import("@/utils/observability/recordGatewayUsage.server");
          const usage = extractUsage(j);
          const responseText =
            (j as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message
              ?.content ?? "";
          await record({
            tokensIn: usage?.tokensIn,
            tokensOut: usage?.tokensOut,
            responseText,
            status: "success",
          });

          return new Response(JSON.stringify(j), {
            status: res.status,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // Streaming: tee through a TransformStream, parse SSE to accumulate
        // content and capture usage if include_usage is set upstream.
        let accumulated = "";
        let usageIn: number | undefined;
        let usageOut: number | undefined;
        let buffer = "";
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const evt = JSON.parse(payload);
                const delta = evt?.choices?.[0]?.delta?.content;
                if (typeof delta === "string") accumulated += delta;
                if (evt?.usage) {
                  usageIn = Number(evt.usage.prompt_tokens ?? evt.usage.input_tokens ?? usageIn);
                  usageOut = Number(
                    evt.usage.completion_tokens ?? evt.usage.output_tokens ?? usageOut,
                  );
                }
              } catch {
                /* ignore parse */
              }
            }
          },
          async flush() {
            await record({
              tokensIn: usageIn,
              tokensOut: usageOut,
              responseText: accumulated,
              status: "success",
            });
            // help TS by referencing encoder (avoids unused warning if tree-shaken)
            void encoder;
          },
        });

        return new Response(res.body.pipeThrough(transform), {
          status: res.status,
          headers: {
            "Content-Type": contentType,
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
