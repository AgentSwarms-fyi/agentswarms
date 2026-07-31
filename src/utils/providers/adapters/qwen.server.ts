// Qwen (Alibaba DashScope) streaming adapter.
// Uses the OpenAI-compatible endpoint so we can forward the SSE stream untouched.
// Docs: https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope
import type { ChatMessage, QwenConfig, QwenCreds } from "../types";

const DEFAULT_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

export async function qwenChatStream(args: {
  creds: QwenCreds;
  config: QwenConfig;
  modelId: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<Response> {
  const { creds, config, modelId, systemPrompt, messages, temperature, maxTokens } = args;

  const baseUrl = (config.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  const fullMessages: ChatMessage[] = [];
  if (systemPrompt?.trim()) fullMessages.push({ role: "system", content: systemPrompt });
  fullMessages.push(...messages);

  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      messages: fullMessages,
      stream: true,
      temperature: temperature ?? 0.7,
      max_tokens: maxTokens ?? 8192,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text();
    throw new Error(`Qwen error [${upstream.status}]: ${t.slice(0, 300)}`);
  }

  // OpenAI-compatible SSE → forward as-is.
  return new Response(upstream.body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
