// Slack as an agent channel, the dependency-free half: what a slash command
// normalises to, who answers it, and what is left of a message once Slack's
// own markup is taken out. Imported by both endpoints, the server functions,
// the editor and the tests, so all of them agree on one set of rules.

/** What a channel can point at. An analyst answers questions about data; an agent is an agent. */
export const CHANNEL_TARGET_TYPES = ["agent", "analyst"] as const;
export type ChannelTargetType = (typeof CHANNEL_TARGET_TYPES)[number];

export type ChannelTarget = { type: ChannelTargetType; id: string };

export type SlackRoute = {
  command: string;
  target_type: ChannelTargetType;
  target_id: string;
  is_active: boolean;
};

/**
 * The stored form of a slash command: lowercase, exactly one leading slash,
 * no surrounding space. Slack sends "/Ask" if that is how the app was
 * registered, and a route saved as "ask" must still match it, so both sides
 * pass through here and the lookup is an equality rather than a guess.
 *
 * Returns null for anything that is not a command — the empty string, a
 * sentence, characters a Slack command cannot contain — so a bad value is
 * refused when it is saved instead of becoming a route nothing can reach.
 */
export function normalizeSlashCommand(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase().replace(/^\/+/, "");
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(trimmed)) return null;
  return `/${trimmed}`;
}

/**
 * Who answers this command.
 *
 * A route wins; an inactive route is as good as none. With no route the
 * workspace's own analyst answers, which is what every installation had
 * before routes existed — so adding that table changed nothing until someone
 * adds a row. No analyst and no route is `null`, and the endpoint says so in
 * words rather than failing.
 */
export function routeForCommand(
  command: string | null | undefined,
  routes: readonly SlackRoute[],
  fallbackAnalystId: string | null | undefined,
): ChannelTarget | null {
  const normalized = normalizeSlashCommand(command);
  if (normalized) {
    const hit = routes.find((r) => r.is_active && r.command === normalized);
    if (hit) return { type: hit.target_type, id: hit.target_id };
  }
  return fallbackAnalystId ? { type: "analyst", id: fallbackAnalystId } : null;
}

/**
 * What the person actually asked, with Slack's markup taken out.
 *
 * An `app_mention` arrives as "<@U123ABC> what was revenue last month?" — the
 * bot's own id first, and sometimes others' further in. User and channel
 * mentions become nothing and their labels are kept ("<#C1|general>" is
 * "general"), links keep their text, and the whole thing is unescaped, since
 * Slack sends `&amp;` for an ampersand and a model should read the question
 * the way it was typed.
 */
export function slackMessageText(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<@[UWB][A-Z0-9]*(\|[^>]*)?>/g, " ")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "$1")
    .replace(/<#[A-Z0-9]+>/g, " ")
    .replace(/<!(?:here|channel|everyone)(\|[^>]*)?>/g, " ")
    .replace(/<((?:https?|mailto):[^>|]+)\|([^>]*)>/g, "$2")
    .replace(/<((?:https?|mailto):[^>|]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Slack events worth answering: someone said the bot's name in a channel, or
 * typed to it directly.
 *
 * A message the bot itself posted is excluded, and so is every message with a
 * `bot_id` — otherwise two bots in one channel answer each other for as long
 * as the workspace can afford it. Subtypes (edits, joins, file shares) are
 * left alone: an edited message is not a new question.
 */
export function isAnswerableSlackEvent(
  event: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    channel_type?: string;
    user?: string;
    text?: string;
  } | null,
  botUserId?: string | null,
): boolean {
  if (!event || typeof event.type !== "string") return false;
  if (event.bot_id) return false;
  if (event.subtype) return false;
  if (botUserId && event.user === botUserId) return false;
  if (!event.text || !event.text.trim()) return false;
  if (event.type === "app_mention") return true;
  // A DM to the bot arrives as a plain message with channel_type "im"; a
  // message in a channel does not, and answering those would make the bot
  // reply to every sentence anyone says.
  return event.type === "message" && event.channel_type === "im";
}

/**
 * Slack retries an event delivery when the endpoint is slow or errors, with
 * the attempt number in a header. The work is already running from the first
 * one, so a retry must be acknowledged and dropped — the alternative is the
 * same question answered three times.
 */
export function isSlackRetry(retryNumHeader: string | null | undefined): boolean {
  return typeof retryNumHeader === "string" && retryNumHeader.trim() !== "";
}

/**
 * What a channel reply says when the target is gone or was never chosen. One
 * sentence, no internals: the person in Slack cannot fix an id, and the owner
 * reads the real reason on the integration page and in the audit log.
 */
export function channelTargetMissing(target: ChannelTargetType | null): string {
  if (target === "agent") {
    return "That points at an agent this workspace can no longer reach. Whoever set it up can pick another under Integrations → Slack.";
  }
  return "No analyst or agent is connected to this workspace yet. Whoever set it up can pick one under Integrations → Slack.";
}
