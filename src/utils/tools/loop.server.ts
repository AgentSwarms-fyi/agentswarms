// Provider-agnostic tool-calling loop against any OpenAI-compatible
// chat-completions endpoint. We run a synchronous loop:
//
//   1. Send messages + tools to the gateway (non-streaming).
//   2. If the model returns tool_calls, execute them server-side, append
//      tool result messages, and repeat — up to MAX_ITERATIONS.
//   3. When the model returns a final assistant message (no tool_calls),
//      open a NEW streaming request with tools=[] so the UI gets a normal
//      streamed answer that incorporates everything from the tool round-trips.
//
// We also stream lightweight "tool" SSE events to the client between iterations
// so the playground inspector can show what's happening in real time.

import type { ToolDef, ToolHandler, AgentToolContext } from "./registry.server";

type GatewayMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  name?: string;
};

const MAX_ITERATIONS = 5;
const DEFAULT_CHAT_ENDPOINT_URL = "https://openrouter.ai/api/v1/chat/completions";

// One non-streaming chat completion call against any OpenAI-compatible
// endpoint. `endpointUrl` defaults to OpenRouter; pass a per-provider URL
// (e.g. https://api.openai.com/v1/chat/completions) when running tools
// through a user-connected provider.
async function callGateway(opts: {
  apiKey: string;
  model: string;
  messages: GatewayMessage[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  endpointUrl?: string;
  extraHeaders?: Record<string, string>;
  organizationId?: string;
}): Promise<Response> {
  const useNewTokenParam = /^(openai\/gpt-5|google\/gemini-3|gpt-5|gemini-3)/.test(opts.model);
  const temperatureLockedModel = /^(openai\/gpt-5|gpt-5)($|-mini$|-nano$)/.test(opts.model);
  const tokenField = useNewTokenParam ? "max_completion_tokens" : "max_tokens";

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    [tokenField]: opts.maxTokens ?? 8192,
    stream: !!opts.stream,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (!temperatureLockedModel) body.temperature = opts.temperature ?? 0.7;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    ...(opts.extraHeaders || {}),
  };
  if (opts.organizationId) headers["OpenAI-Organization"] = opts.organizationId;

  return fetch(opts.endpointUrl || DEFAULT_CHAT_ENDPOINT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export type ToolEvent =
  | { type: "tool_call"; name: string; args: string; id: string }
  | { type: "tool_result"; name: string; id: string; ok: boolean; preview: string };

// Run the tool-call loop and return the FINAL response (a streaming Response
// from the gateway with the assistant's user-facing answer). Tool events are
// emitted via onEvent during the loop so the client can show progress.
export async function streamChatWithTools(opts: {
  apiKey: string;
  model: string;
  systemPrompt?: string;
  userMessages: { role: "system" | "user" | "assistant"; content: string }[];
  tools: ToolDef[];
  handlers: Map<string, ToolHandler>;
  toolCtx: AgentToolContext;
  temperature?: number;
  maxTokens?: number;
  onToolEvent?: (e: ToolEvent) => void;
  // Optional override: when set, run the tool loop against an arbitrary
  // OpenAI-compatible endpoint (OpenAI, Gemini-via-OpenAI, Grok, Groq,
  // OpenRouter, etc.) so any provider gets access to the same server-side
  // tool catalog.
  endpointUrl?: string;
  extraHeaders?: Record<string, string>;
  organizationId?: string;
  // Observability: record each non-streaming tool round into execution_traces
  // attributed to this user, linked to the parent /api/chat trace row.
  userId?: string | null;
  parentTraceId?: string | null;
}): Promise<Response> {
  // Build the working transcript.
  const transcript: GatewayMessage[] = [];
  if (opts.systemPrompt?.trim()) transcript.push({ role: "system", content: opts.systemPrompt });
  for (const m of opts.userMessages) transcript.push({ role: m.role, content: m.content });

  // Shared overrides applied to every callGateway invocation in this loop.
  const transport = {
    endpointUrl: opts.endpointUrl,
    extraHeaders: opts.extraHeaders,
    organizationId: opts.organizationId,
  };

  // If no tools available, skip the loop entirely.
  if (opts.tools.length === 0) {
    return callGateway({
      apiKey: opts.apiKey,
      model: opts.model,
      messages: transcript,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      stream: true,
      ...transport,
    });
  }

  // Tool-calling loop (non-streaming).
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const tStart = Date.now();
    const r = await callGateway({
      apiKey: opts.apiKey,
      model: opts.model,
      messages: transcript,
      tools: opts.tools,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      stream: false,
      ...transport,
    });
    if (!r.ok) {
      // Bubble up — caller already knows how to format gateway errors.
      return r;
    }
    const j = (await r.json()) as {
      choices?: { message?: GatewayMessage; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (opts.userId) {
      try {
        const { recordGatewayCall } =
          await import("@/utils/observability/recordGatewayUsage.server");
        await recordGatewayCall({
          userId: opts.userId,
          surface: "Chat: tool-round",
          model: opts.model,
          tokensIn: j.usage?.prompt_tokens,
          tokensOut: j.usage?.completion_tokens,
          latencyMs: Date.now() - tStart,
          parentTraceId: opts.parentTraceId ?? null,
          agentId: opts.toolCtx.agentId ?? null,
        });
      } catch (e) {
        console.error("[loop.server] recordGatewayCall failed:", e);
      }
    }
    const msg = j.choices?.[0]?.message;
    if (!msg) {
      // Malformed — fall through to streaming with what we have.
      break;
    }

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // No tools requested. After one or more tool round-trips, some providers
      // return an empty/non-stream-friendly assistant message here. Ask for a
      // fresh streamed final answer from the full transcript instead of trying
      // to replay this non-stream payload.
      return callGateway({
        apiKey: opts.apiKey,
        model: opts.model,
        messages: transcript,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        stream: true,
        ...transport,
      });
    }

    // Append the assistant turn (with tool_calls) so the model can see
    // what it asked for in the next iteration.
    transcript.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: toolCalls,
    });

    // Execute each tool call, append a `tool` message with the result.
    for (const tc of toolCalls) {
      const handler = opts.handlers.get(tc.function.name);
      let result: string;
      let ok = true;
      if (!handler) {
        ok = false;
        result = JSON.stringify({ error: `Unknown tool: ${tc.function.name}` });
      } else {
        opts.onToolEvent?.({
          type: "tool_call",
          name: tc.function.name,
          args: tc.function.arguments,
          id: tc.id,
        });
        try {
          const parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          result = await handler(opts.toolCtx, parsed);
        } catch (e) {
          ok = false;
          result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        }
      }
      opts.onToolEvent?.({
        type: "tool_result",
        name: tc.function.name,
        id: tc.id,
        ok,
        preview: result.slice(0, 400),
      });
      transcript.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content: result,
      });
    }
    // Loop again — model now has the tool results.
  }

  // Hit max iterations — force a final streamed answer with tools=[].
  return callGateway({
    apiKey: opts.apiKey,
    model: opts.model,
    messages: transcript,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    stream: true,
    ...transport,
  });
}
