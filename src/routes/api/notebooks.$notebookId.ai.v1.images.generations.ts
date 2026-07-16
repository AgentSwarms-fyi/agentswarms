// OpenAI-compatible image-generation proxy for notebook multimodal cells.
// OpenRouter has no dedicated /images/generations endpoint — image-capable
// models are reached through /chat/completions with modalities:["image","text"].
// This proxy accepts either the classic { prompt } shape or the { messages,
// modalities } shape notebook cells use, translates both into a chat
// completion, and reshapes the reply back into the classic
// { data: [{ b64_json }] } response notebook code expects. Records the call
// in execution_traces.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import {
  OPENROUTER_CHAT_URL,
  getOpenRouterApiKey,
} from "@/utils/providers/openrouterDefault.server";

export const Route = createFileRoute("/api/notebooks/$notebookId/ai/v1/images/generations")({
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
        const surface = `Notebook[${notebookId}]: Image Gen`;
        const authHeader = request.headers.get("authorization") ?? "";
        const url = process.env.SUPABASE_URL;
        const anon = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!url || !anon) return json({ error: "Backend not configured" }, 500);
        const sb = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
        const { data: userRes, error } = await sb.auth.getUser();
        if (error || !userRes?.user) return json({ error: "Unauthorized" }, 401);

        const apiKey = getOpenRouterApiKey();
        if (!apiKey) return json({ error: "OPENROUTER_API_KEY not configured" }, 500);

        const body = await request.text();
        let parsed: {
          model?: string;
          prompt?: string;
          messages?: { role: string; content: unknown }[];
          max_tokens?: number;
        } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          /* ignore */
        }
        const model = parsed.model ?? "google/gemini-2.5-flash-image";
        const userId = userRes.user.id;
        const t0 = Date.now();

        const messages =
          Array.isArray(parsed.messages) && parsed.messages.length > 0
            ? parsed.messages
            : [{ role: "user", content: parsed.prompt ?? "Generate an image." }];

        const res = await fetch(OPENROUTER_CHAT_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            modalities: ["image", "text"],
            max_tokens: parsed.max_tokens ?? 16384,
          }),
        });

        let bodyText: string;
        if (!res.ok) {
          bodyText = await res.text();
        } else {
          // Reshape the chat-completions image reply into the classic
          // { data: [{ b64_json }] } response notebook code expects.
          const chatJson = (await res.json()) as {
            choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
          };
          const dataUrl = chatJson.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
          const b64Match = /^data:image\/\w+;base64,(.+)$/.exec(dataUrl);
          bodyText = b64Match
            ? JSON.stringify({ data: [{ b64_json: b64Match[1] }] })
            : JSON.stringify({ data: dataUrl ? [{ url: dataUrl }] : [] });
        }

        try {
          const { recordGatewayCall } =
            await import("@/utils/observability/recordGatewayUsage.server");
          let imageCount = 0;
          try {
            const j = JSON.parse(bodyText);
            imageCount = Array.isArray(j?.data) ? j.data.length : 0;
          } catch {
            /* ignore */
          }
          await recordGatewayCall({
            userId,
            surface,
            model,
            kind: "image",
            imageCount: imageCount || 1,
            promptText:
              typeof parsed.prompt === "string"
                ? parsed.prompt
                : JSON.stringify(parsed.messages ?? "").slice(0, 4000),
            latencyMs: Date.now() - t0,
            status: res.ok ? "success" : "error",
            errorMessage: res.ok ? null : `[${res.status}]`,
          });
        } catch (e) {
          console.error("[notebooks/images] trace failed:", e);
        }

        return new Response(bodyText, {
          status: res.status,
          headers: {
            "Content-Type": "application/json",
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
