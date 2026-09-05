// One text answer from a model, through /api/chat on the internal channel.
//
// The channel is the door agents, swarms, the AI gateway, the AI functions
// in SQL and document OCR all use, so the model rules in IAM, the budget, the
// execution trace and the cost accounting apply to every call without a
// second implementation. This helper turns the channel's stream into the
// text it carried, plus the cost it reported, and turns a refusal into the
// sentence a user can act on.
import { internalRunSecret, resolveInternalOrigin } from "@/utils/internalOrigin.server";

export type InternalChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type InternalChatArgs = {
  userId: string;
  provider: string;
  model: string;
  system: string;
  /** Plain text, or parts when a vision-capable model is to read an image. */
  user: string | InternalChatPart[];
  maxTokens: number;
  temperature?: number;
  /** Shown as the agent on the trace and in the audit log. */
  agentName: string;
  decisionId?: string;
  timeoutMs?: number;
};

/** The channel's stream, read to the end: the text and the cost event. */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
): Promise<{ text: string; cost: number | null }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let cost: number | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return { text, cost };
      try {
        const j = JSON.parse(data) as {
          type?: string;
          cost_usd?: number;
          choices?: { delta?: { content?: string } }[];
        };
        if (j.type === "cost" && typeof j.cost_usd === "number") cost = j.cost_usd;
        const delta = j.choices?.[0]?.delta?.content;
        if (typeof delta === "string") text += delta;
      } catch {
        /* keep-alive or a frame we do not read */
      }
    }
  }
  return { text, cost };
}

/** The user-facing reason a model call was refused, from the channel's answer. */
export function describeChatRefusal(status: number, text: string, model: string): string {
  let message = text.slice(0, 300);
  let code: string | null = null;
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof j.message === "string") message = j.message;
    else if (typeof j.error === "string") {
      code = j.error;
      message = j.error;
    }
  } catch {
    /* plain text */
  }
  if (code === "model_not_allowed" || status === 403) {
    return `The model ${model} is not allowed for your role (IAM model rules). Pick another model or ask an administrator.`;
  }
  if (status === 402) return `Budget exhausted: ${message}`;
  if (status === 429) return `The model ${model} is rate limited right now: ${message}`;
  return `The model call to ${model} failed (${status}): ${message}`;
}

/**
 * Ask once, as the user, and get the answer's text. No tools, no memory: a
 * value, not a conversation. Throws with a sentence a user can act on when
 * the channel refuses or the model does not answer in time.
 */
export async function internalChatText(
  args: InternalChatArgs,
): Promise<{ text: string; cost: number | null }> {
  const secret = internalRunSecret();
  if (!secret) throw new Error("Server is missing INTERNAL_RUN_SECRET / SUPABASE_SERVICE_ROLE_KEY");
  const spec = `${args.provider}/${args.model}`;
  const timeoutMs = args.timeoutMs ?? 90_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${resolveInternalOrigin()}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-internal-run-secret": secret },
      body: JSON.stringify({
        internalUserId: args.userId,
        decisionId: args.decisionId,
        agentName: args.agentName,
        provider: args.provider,
        model: args.model,
        systemPrompt: args.system,
        temperature: args.temperature ?? 0,
        maxTokens: args.maxTokens,
        messages: [{ role: "user", content: args.user }],
        // Parts reach the provider as parts only when the caller sent them;
        // the route flattens them to text otherwise.
        vision: typeof args.user !== "string" ? true : undefined,
        enabledTools: [],
        memoryOverrides: { stm_enabled: false, ltm_enabled: false, ltm_scope: "none" },
      }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(describeChatRefusal(res.status, text, spec));
    }
    return await readChatStream(res.body);
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(`The model ${spec} did not answer within ${Math.round(timeoutMs / 1000)} s.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
