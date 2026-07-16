import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { recordGatewayCall, extractUsage } from "@/utils/observability/recordGatewayUsage.server";
import {
  OPENROUTER_CHAT_URL,
  getOpenRouterApiKey,
} from "@/utils/providers/openrouterDefault.server";

const ChatInput = z.object({
  model: z.string().min(1).max(120).optional(),
  messages: z.array(z.any()).min(1).max(60),
  tools: z.array(z.any()).max(20).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().min(1).max(8192).optional(),
  notebookId: z.string().min(1).max(64).optional(),
});

export const notebookAiChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ChatInput.parse(input))
  .handler(async ({ data, context }) => {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured on the server");
    const model = data.model ?? "openai/gpt-4o-mini";
    const userId = (context as { userId?: string } | undefined)?.userId ?? null;
    const surface = `Notebook[${data.notebookId ?? "unknown"}]: AI Chat`;
    const t0 = Date.now();
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: data.messages,
        tools: data.tools,
        temperature: data.temperature ?? 0.7,
        max_tokens: data.max_tokens ?? 2048,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      if (userId) {
        void recordGatewayCall({
          userId,
          surface,
          model,
          latencyMs: Date.now() - t0,
          status: "error",
          errorMessage: `[${res.status}] ${errText.slice(0, 200)}`,
        });
      }
      if (res.status === 429)
        throw new Error("AI Gateway: rate limited (429). Try again in a moment.");
      if (res.status === 402) throw new Error("AI Gateway: workspace credits exhausted (402).");
      throw new Error(`AI Gateway error [${res.status}]: ${errText.slice(0, 300)}`);
    }
    const json = await res.json();
    if (userId) {
      const usage = extractUsage(json);
      const responseText =
        (json as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message
          ?.content ?? "";
      void recordGatewayCall({
        userId,
        surface,
        model,
        tokensIn: usage?.tokensIn,
        tokensOut: usage?.tokensOut,
        responseText,
        latencyMs: Date.now() - t0,
      });
    }
    return json;
  });

const SearchInput = z.object({
  query: z.string().min(1).max(500),
  options: z.record(z.string(), z.any()).optional(),
});

export const notebookFirecrawlSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SearchInput.parse(input))
  .handler(async ({ data }) => {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error("Firecrawl is not connected. Link it via Integrations.");
    const mod = await import("@mendable/firecrawl-js");
    const Firecrawl = (mod as any).default ?? (mod as any).Firecrawl;
    const client = new Firecrawl({ apiKey });
    return client.search(data.query, data.options ?? {});
  });

const ScrapeInput = z.object({
  url: z.string().url().max(2000),
  options: z.record(z.string(), z.any()).optional(),
});

export const notebookFirecrawlScrape = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ScrapeInput.parse(input))
  .handler(async ({ data }) => {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error("Firecrawl is not connected. Link it via Integrations.");
    const mod = await import("@mendable/firecrawl-js");
    const Firecrawl = (mod as any).default ?? (mod as any).Firecrawl;
    const client = new Firecrawl({ apiKey });
    return client.scrape(data.url, data.options ?? {});
  });
