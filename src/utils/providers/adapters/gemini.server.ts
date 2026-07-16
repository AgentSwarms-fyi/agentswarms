import type { ChatMessage } from "../types";

type GeminiStreamPart = {
  text?: string;
};

type GeminiStreamChunk = {
  candidates?: Array<{
    content?: {
      parts?: GeminiStreamPart[];
      role?: string;
    };
  }>;
};

function normalizeGeminiApiKey(apiKey: string): string {
  return apiKey
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^key=/i, "")
    .replace(/^["']+|["']+$/g, "");
}

function toGeminiContents(messages: ChatMessage[]) {
  return messages
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }))
    .filter((message) => message.parts[0].text.trim().length > 0);
}

export async function geminiChatStream(args: {
  apiKey: string;
  modelId: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<Response> {
  const { apiKey, modelId, systemPrompt, messages, temperature, maxTokens } = args;
  const cleanKey = normalizeGeminiApiKey(apiKey);

  if (!cleanKey) {
    throw new Error("Gemini API key is missing.");
  }

  const body: Record<string, unknown> = {
    contents: toGeminiContents(messages),
  };

  if (systemPrompt?.trim()) {
    body.system_instruction = {
      parts: [{ text: systemPrompt.trim() }],
    };
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof temperature === "number") generationConfig.temperature = temperature;
  if (typeof maxTokens === "number") generationConfig.maxOutputTokens = maxTokens;
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": cleanKey,
      },
      body: JSON.stringify(body),
    },
  );

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    throw new Error(`Gemini error [${upstream.status}]: ${text.slice(0, 300)}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let textBuffer = "";

  const toOpenAISse = (deltaText: string) =>
    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: deltaText } }] })}\n\n`);

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const consumeLine = (line: string) => {
          if (!line.startsWith("data: ")) return;
          const payload = line.slice(6).trim();
          if (!payload || payload === "[DONE]") return;

          const parsed = JSON.parse(payload) as GeminiStreamChunk;
          const parts = parsed.candidates?.[0]?.content?.parts ?? [];
          const deltaText = parts
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("");

          if (deltaText) {
            controller.enqueue(toOpenAISse(deltaText));
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            textBuffer += decoder.decode(value, { stream: true });
            let newlineIndex = -1;
            while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
              let line = textBuffer.slice(0, newlineIndex);
              textBuffer = textBuffer.slice(newlineIndex + 1);
              if (line.endsWith("\r")) line = line.slice(0, -1);
              if (!line || line.startsWith(":")) continue;
              consumeLine(line);
            }
          }

          if (textBuffer.trim()) {
            consumeLine(textBuffer.trim());
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        reader.cancel(reason).catch(() => {});
      },
    }),
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}
