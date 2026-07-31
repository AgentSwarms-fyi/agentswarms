// Anthropic API (direct) streaming adapter -> OpenAI-style SSE.
import type { AnthropicCreds, ChatMessage } from "../types";

function toOpenAIChunk(content: string): string {
  const obj = {
    id: "chatcmpl-anthropic",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content } }],
  };
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function anthropicChatStream(args: {
  creds: AnthropicCreds;
  modelId: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
  anthropicVersion?: string;
}): Promise<Response> {
  const {
    creds,
    modelId,
    systemPrompt,
    messages,
    temperature,
    maxTokens,
    baseUrl,
    anthropicVersion,
  } = args;
  const base = (baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": creds.apiKey,
      "anthropic-version": anthropicVersion || "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens ?? 8192,
      temperature: temperature ?? 0.7,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      stream: true,
    }),
  });
  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text();
    throw new Error(`Anthropic error [${upstream.status}]: ${t.slice(0, 300)}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async pull(controller) {
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const json = line.slice(5).trim();
            if (!json || json === "[DONE]") continue;
            try {
              const ev = JSON.parse(json);
              if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
                const text = ev.delta.text as string;
                if (text) controller.enqueue(new TextEncoder().encode(toOpenAIChunk(text)));
              }
            } catch {
              /* skip */
            }
          }
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}
