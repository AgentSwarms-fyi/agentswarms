// Turn bookkeeping for the public embed chat.
//
// Extracted from routes/embed.agent.$key so it can be tested. It was three
// lines inside a component, and two of them were wrong in ways that only show
// up on the SECOND message — which is exactly the shape of bug a component
// test written against the happy path never reaches.
import type { EmbedChatMessage } from "./embedClient";

export type EmbedTurn = EmbedChatMessage & {
  /**
   * A local notice (a failed request, an empty answer) rather than something
   * the model said. Rendered like an assistant message, never sent back as
   * one.
   */
  notice?: true;
};

/**
 * The messages to send to the model.
 *
 * NOTICES ARE EXCLUDED. The error path replaced the pending assistant turn
 * with `⚠️ <message>` and left it in state, so the next send transmitted
 * "⚠️ Failed to fetch" to the model as a prior assistant message. One network
 * blip permanently poisoned the conversation: the model saw itself apparently
 * having answered with an error, and every later turn inherited it.
 */
export function historyForModel(turns: EmbedTurn[], next: string): EmbedChatMessage[] {
  const prior = turns
    .filter((t) => !t.notice && t.content.trim() !== "")
    .map(({ role, content }) => ({ role, content }));
  return [...prior, { role: "user" as const, content: next }];
}

/**
 * Replace the trailing placeholder with a notice.
 *
 * Marked so historyForModel drops it. Falls back to appending if there is no
 * placeholder to replace, so a notice is never silently lost.
 */
export function withNotice(turns: EmbedTurn[], message: string): EmbedTurn[] {
  const notice: EmbedTurn = { role: "assistant", content: message, notice: true };
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant") return [...turns, notice];
  return [...turns.slice(0, -1), notice];
}

/**
 * Called when the stream ends. An assistant turn that never received a token
 * stays `content: ""`, and the bubble renders a spinner for empty content —
 * so a stream that closes early (a proxy timeout, an empty completion) left a
 * spinner turning forever with `busy` already false and nothing to explain it.
 */
export function settleTurns(turns: EmbedTurn[]): EmbedTurn[] {
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant" || last.content.trim() !== "") return turns;
  return withNotice(turns, "No response was returned. Please try again.");
}
