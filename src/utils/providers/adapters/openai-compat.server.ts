// Generic OpenAI-compatible Chat Completions streaming adapter.
// Used by providers that expose an OpenAI-shaped /v1/chat/completions endpoint
// (OpenAI itself, Google Gemini OpenAI-compat layer, Grok, Ollama, etc.).
import { usageReportingBody } from "@/utils/observability/providerCost";
import type { ChatMessage } from "../types";

export async function openAICompatChatStream(args: {
  baseUrl: string; // e.g. https://api.openai.com/v1
  apiKey?: string; // optional (Ollama doesn't need it)
  modelId: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  organizationId?: string; // OpenAI only
  providerLabel?: string; // for error messages
  extraHeaders?: Record<string, string>;
}): Promise<Response> {
  const {
    baseUrl,
    apiKey,
    modelId,
    systemPrompt,
    messages,
    temperature,
    maxTokens,
    organizationId,
    providerLabel,
    extraHeaders,
  } = args;

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const fullMessages: ChatMessage[] = [];
  if (systemPrompt?.trim()) fullMessages.push({ role: "system", content: systemPrompt });
  fullMessages.push(...messages);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extraHeaders || {}),
  };
  if (apiKey) {
    // Defensive: strip whitespace and any accidentally-pasted "Bearer " /
    // "key=" prefix users copy from docs. Google's OpenAI-compat endpoint
    // returns "Multiple authentication credentials received" if a key sneaks
    // into both Authorization and another auth surface.
    const cleanKey = apiKey
      .trim()
      .replace(/^Bearer\s+/i, "")
      .replace(/^key=/i, "");
    headers.Authorization = `Bearer ${cleanKey}`;
  }
  if (organizationId) headers["OpenAI-Organization"] = organizationId;

  const upstream = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelId,
      messages: fullMessages,
      stream: true,
      temperature: temperature ?? 0.7,
      max_tokens: maxTokens ?? 8192,
      // Ask the provider what the call cost, where it can answer. The amount
      // it computes is the one the account is billed, so it beats pricing the
      // tokens off a table that can only know models somebody added by hand.
      // Empty for every other endpoint — `usage: {include:true}` is an
      // OpenRouter extension and OpenAI 400s on unrecognised arguments, so
      // sending it blind would break working providers to ask a question they
      // do not understand.
      ...usageReportingBody(baseUrl),
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text();
    throw new Error(
      `${providerLabel || "OpenAI-compatible"} error [${upstream.status}]: ${t.slice(0, 300)}`,
    );
  }

  return new Response(upstream.body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
