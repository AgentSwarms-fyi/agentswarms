// The counts of a pass that seals Agent Chat history kept before R446
// (messages and conversation titles), as the stored-files pass's audit row and
// the Customer keys card carry them. Pure: the card uses it too.

export type ChatPass = {
  messages: number;
  titles: number;
  /** Values whose owner's key cannot be had now (refused, a conflict): left as they are. */
  unreadable: number;
  /** Values that would have been sealed past the pass's limit. */
  left: boolean;
  failed: number;
  errors: string[];
};

/** The pass's counts, for the stored-files pass's audit detail (one row for all of them). */
export function chatPassDetail(c: ChatPass): Record<string, unknown> {
  return {
    ...(c.messages ? { messages_sealed: c.messages } : {}),
    ...(c.titles ? { titles_sealed: c.titles } : {}),
    ...(c.unreadable ? { chat_unreadable: c.unreadable } : {}),
    ...(c.left ? { chat_left: true } : {}),
    ...(c.failed ? { chat_failed: c.failed } : {}),
    ...(c.errors.length ? { chat_errors: c.errors } : {}),
  };
}
