// What a failed /api/chat request was, from the response the route sent.
//
// FOUND IN R193. The playground called every 402 "AI credits exhausted" and
// offered to "pick another model and continue", and prefixed every other
// failure with the provider's name. But the chat route answers 402 itself
// when a monthly budget cap is reached, before any provider is called, and
// 403 when the administrator's model rules refuse the model: the budget
// refusal was shown as a provider's billing problem (with five models
// offered, every one of which the same cap refuses), and the model rule read
// "openrouter: Your administrator has not allowed …". The route marks its own
// refusals with a code in `error` and the sentence in `message`; an upstream
// provider's failure carries only its message in `error`.

/** The route's own refusals, made before any provider is called. */
export const PLATFORM_REFUSALS = [
  "budget_exceeded",
  "model_not_allowed",
  "conversation_too_large",
] as const;

export type ChatFailureReason = "rate_limit" | "credits" | "platform" | "error";

export function classifyChatFailure(
  status: number,
  body: unknown,
  message: string,
): ChatFailureReason {
  const code =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : null;
  if (code && (PLATFORM_REFUSALS as readonly string[]).includes(code)) return "platform";
  if (status === 429) return "rate_limit";
  if (status === 402 || /credit|payment required|insufficient/i.test(message)) return "credits";
  if (/rate limit|too many requests/i.test(message)) return "rate_limit";
  return "error";
}
