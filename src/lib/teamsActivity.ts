// What a Teams activity means, with no network and no database in it.
//
// The Bot Framework sends every kind of event to one endpoint: someone typed a
// message, someone was added to a conversation, someone reacted, the bot was
// installed. Only one of those is a question, and answering any of the others
// puts the bot in a loop or makes it shout into an empty channel.
//
// The second job here is taking Teams' markup out of the text. A mention
// arrives as `<at>Analyst</at> what were sales last week` — leave it in and
// the agent is asked to interpret its own name as part of the question, which
// it will dutifully try to do.

/** The activity shape this integration reads. Everything else is ignored. */
export type TeamsActivity = {
  type?: string;
  id?: string;
  text?: string;
  serviceUrl?: string;
  channelId?: string;
  conversation?: { id?: string; conversationType?: string };
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  channelData?: { tenant?: { id?: string } };
  entities?: { type?: string; text?: string; mentioned?: { id?: string; name?: string } }[];
};

/**
 * Whether this activity is a question to answer.
 *
 * Only `message`. `conversationUpdate` fires when the bot is added — answering
 * it greets an empty room; `messageReaction` fires on a thumbs-up, and
 * answering that answers the bot's own last message. A message the BOT sent is
 * the loop that matters most: Teams delivers the bot's own posts back to it,
 * and a bot that answers itself never stops.
 */
export function isAnswerableActivity(
  activity: TeamsActivity | null | undefined,
): activity is TeamsActivity {
  if (!activity || activity.type !== "message") return false;
  if (!activity.conversation?.id || !activity.serviceUrl) return false;
  const from = activity.from?.id ?? "";
  const bot = activity.recipient?.id ?? "";
  if (from && bot && from === bot) return false;
  return Boolean(teamsMessageText(activity).trim());
}

/**
 * The question, with Teams' own markup removed.
 *
 * `<at>…</at>` is how a mention arrives, and it names the bot — so it is not
 * part of what was asked. Everything else is left exactly as typed: stripping
 * more would quietly change the question, and a question is the one thing this
 * integration must not paraphrase.
 */
export function teamsMessageText(activity: TeamsActivity | null | undefined): string {
  const raw = activity?.text ?? "";
  if (!raw) return "";
  return (
    raw
      .replace(/<at\b[^>]*>.*?<\/at>/gi, " ")
      // A stray tag from a truncated mention, so the text never keeps half of one.
      .replace(/<\/?at\b[^>]*>/gi, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Where to post the answer.
 *
 * Built from the ACTIVITY, never from anything the bot remembers: a reply goes
 * back to the conversation the question came from, and `replyToId` is what
 * puts it in the same thread rather than at the bottom of the channel.
 */
export function replyEndpoint(activity: TeamsActivity): string | null {
  const service = (activity.serviceUrl ?? "").replace(/\/+$/, "");
  const conversation = activity.conversation?.id ?? "";
  if (!service || !conversation) return null;
  return `${service}/v3/conversations/${encodeURIComponent(conversation)}/activities`;
}

/** The message to post back, in the shape Teams expects. */
export function replyActivity(activity: TeamsActivity, text: string): Record<string, unknown> {
  return {
    type: "message",
    text,
    // Threads the answer under the question in a channel; harmless in a chat.
    ...(activity.id ? { replyToId: activity.id } : {}),
    from: activity.recipient
      ? { id: activity.recipient.id, name: activity.recipient.name }
      : undefined,
    conversation: { id: activity.conversation?.id },
    recipient: activity.from ? { id: activity.from.id, name: activity.from.name } : undefined,
  };
}

/** Teams rejects a very long message; this is well inside its limit. */
export const TEAMS_MAX_TEXT = 25_000;

export function truncateForTeams(text: string, limit = TEAMS_MAX_TEXT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 20).trimEnd()}\n\n…(truncated)`;
}

/**
 * Whether a bot registration may serve this activity's tenant.
 *
 * A single-tenant registration names its tenant, and an activity from another
 * one is refused — the token proves it came from Microsoft, not that it came
 * from the organisation whose data this bot answers about.
 */
export function tenantAllowed(
  botTenantId: string | null | undefined,
  activity: TeamsActivity | null | undefined,
): boolean {
  if (!botTenantId) return true; // multi-tenant registration
  return (activity?.channelData?.tenant?.id ?? null) === botTenantId;
}
