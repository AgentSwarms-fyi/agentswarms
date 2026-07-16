// vLLM streaming adapter. vLLM serves an OpenAI-compatible /v1 API, so the
// SSE stream can be forwarded untouched.
// Docs: https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html
import type { ChatMessage, VLLMConfig, VLLMCreds } from "../types";

export async function vllmChatStream(args: {
  creds: VLLMCreds;
  config: VLLMConfig;
  modelId: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<Response> {
  const { creds, config, modelId, systemPrompt, messages, temperature, maxTokens } = args;

  const baseUrl = (config.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("vLLM base URL is required");

  // If the operator configured a served-model-name, use it (vLLM will reject
  // any other model id). Otherwise pass the model id supplied by the agent.
  const modelToSend = config.servedModelName?.trim() || modelId;

  const fullMessages: ChatMessage[] = [];
  if (systemPrompt?.trim()) fullMessages.push({ role: "system", content: systemPrompt });
  fullMessages.push(...messages);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (creds.apiKey?.trim()) headers.Authorization = `Bearer ${creds.apiKey.trim()}`;

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelToSend,
      messages: fullMessages,
      stream: true,
      temperature: temperature ?? 0.7,
      max_tokens: maxTokens ?? 8192,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text();
    throw new Error(`vLLM error [${upstream.status}]: ${t.slice(0, 300)}`);
  }

  return new Response(upstream.body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
