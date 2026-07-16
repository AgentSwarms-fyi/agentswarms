// xAI Grok streaming adapter. Grok exposes an OpenAI-compatible Chat
// Completions endpoint, so we can pass the SSE stream straight through.
import type { ChatMessage, GrokConfig, GrokCreds } from "../types";

export async function grokChatStream(args: {
  creds: GrokCreds;
  config?: GrokConfig;
  modelId: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<Response> {
  const { creds, config, modelId, systemPrompt, messages, temperature, maxTokens } = args;
  const baseUrl = (config?.baseUrl || "https://api.x.ai/v1").replace(/\/+$/, "");

  const fullMessages: ChatMessage[] = [];
  if (systemPrompt?.trim()) fullMessages.push({ role: "system", content: systemPrompt });
  fullMessages.push(...messages);

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      messages: fullMessages,
      temperature: temperature ?? 0.7,
      max_tokens: maxTokens ?? 8192,
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text();
    throw new Error(`Grok error [${upstream.status}]: ${t.slice(0, 300)}`);
  }

  // Already OpenAI-compatible SSE — pass through.
  return new Response(upstream.body, { headers: { "Content-Type": "text/event-stream" } });
}
