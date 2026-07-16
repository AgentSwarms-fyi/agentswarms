// Azure OpenAI streaming adapter. Azure is OpenAI-compatible — passthrough SSE.
import type { AzureConfig, AzureCreds, ChatMessage } from "../types";

export async function azureOpenAIChatStream(args: {
  creds: AzureCreds;
  config: AzureConfig;
  // For Azure, modelId is the *deployment name*.
  modelId: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<Response> {
  const { creds, config, modelId, systemPrompt, messages, temperature, maxTokens } = args;
  const endpoint = config.endpoint?.replace(/\/$/, "");
  if (!endpoint) throw new Error("Azure OpenAI endpoint is missing");
  const apiVersion = config.apiVersion || "2024-08-01-preview";
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(modelId)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const body = {
    messages: [
      ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
      ...messages,
    ],
    temperature: temperature ?? 0.7,
    max_tokens: maxTokens ?? 8192,
    stream: true,
  };

  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "api-key": creds.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text();
    throw new Error(`Azure OpenAI error [${upstream.status}]: ${t.slice(0, 300)}`);
  }
  return new Response(upstream.body, { headers: { "Content-Type": "text/event-stream" } });
}
