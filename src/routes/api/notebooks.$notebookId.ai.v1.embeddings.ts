// OpenAI-compatible embeddings proxy for notebook RAG cells. Always calls
// OpenAI's real /v1/embeddings endpoint — any vendor-prefixed model id a
// notebook cell requests (e.g. "google/gemini-embedding-001", a Lovable AI
// Gateway convention from before this app's OpenRouter migration) is
// normalized to a real OpenAI embedding model so existing notebook cells
// keep working unchanged.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const OPENAI_EMBED_MODELS = new Set([
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
]);
function normalizeEmbedModel(requested: string | undefined): string {
  const bare = (requested ?? "").split("/").pop() ?? "";
  return OPENAI_EMBED_MODELS.has(bare) ? bare : "text-embedding-3-small";
}

export const Route = createFileRoute("/api/notebooks/$notebookId/ai/v1/embeddings")({
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
        const surface = `Notebook[${notebookId}]: Embeddings`;
        const authHeader = request.headers.get("authorization") ?? "";
        const url = process.env.SUPABASE_URL;
        const anon = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!url || !anon) return json({ error: "Backend not configured" }, 500);
        const sb = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
        const { data: userRes, error } = await sb.auth.getUser();
        if (error || !userRes?.user) return json({ error: "Unauthorized" }, 401);

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return json({ error: "OPENAI_API_KEY not configured" }, 500);

        const body = await request.text();
        let parsedBody: { model?: string; input?: string | string[] } = {};
        try {
          parsedBody = JSON.parse(body);
        } catch {
          /* ignore */
        }
        const model = normalizeEmbedModel(parsedBody.model);
        const userId = userRes.user.id;
        const t0 = Date.now();
        const res = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...parsedBody, model }),
        });

        // Read full response, record trace, then return to client. We can't
        // safely fire-and-forget on Cloudflare Workers — the isolate can be
        // torn down right after the response returns, dropping the insert.
        const bodyText = await res.text();
        try {
          const j = JSON.parse(bodyText);
          const { recordGatewayCall, extractUsage } =
            await import("@/utils/observability/recordGatewayUsage.server");
          const usage = extractUsage(j);
          let promptText: string | undefined;
          if (!usage) {
            const inp = parsedBody.input;
            promptText = Array.isArray(inp) ? inp.join("\n") : (inp ?? "");
          }
          await recordGatewayCall({
            userId,
            surface,
            model,
            kind: "embedding",
            tokensIn: usage?.tokensIn,
            promptText,
            latencyMs: Date.now() - t0,
            status: res.ok ? "success" : "error",
            errorMessage: res.ok ? null : `[${res.status}]`,
          });
        } catch (e) {
          console.error("[notebooks/embeddings] trace failed:", e);
        }

        return new Response(bodyText, {
          status: res.status,
          headers: {
            "Content-Type": res.headers.get("content-type") ?? "application/json",
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
