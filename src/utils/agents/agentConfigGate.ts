/**
 * Whether a turn may run, given what came back when its agent was read.
 *
 * FOUND IN R234. `/api/chat` read the agent with `const { data: a } = await …`
 * and swallowed the rest under a comment saying the trace label is
 * non-critical. That was true when the label was all the read fetched. It had
 * not been true since the tool allow-lists and the guardrails moved onto the
 * same row, and the handling never followed: a read that failed left every
 * default standing, and the defaults are the permissive end of both —
 * `enabledToolsFromToggles` returns `undefined` for an empty toggle record,
 * which callers read as "the registry's default set", and `DEFAULT_GUARDRAILS`
 * has every filter off. The turn then ran, looking entirely normal, as an
 * assistant with tools its owner had not granted and none of the filters they
 * had set.
 *
 * The decision lives here, out of a 2,000-line route handler, because it is the
 * whole of the fix and a route that big is where this kind of thing goes back to
 * sleep.
 */

/**
 * What a read of the agent row produced: `null` for "there was no client to ask
 * with", otherwise Supabase's own `{ data, error }`.
 */
export type AgentConfigRead = { data: unknown; error: unknown } | null;

export type ConfigRefusal = {
  code: "agent_unreadable" | "agent_not_found";
  status: 503 | 404;
  message: string;
};

export const AGENT_UNREADABLE_MESSAGE =
  "This agent's configuration could not be read, so the message was not sent — running it " +
  "without the agent's tools and guardrails would not be the agent you asked for. Try again " +
  "in a moment.";

export const AGENT_NOT_FOUND_MESSAGE =
  "That agent could not be found for your account — it may have been deleted. Its guardrails " +
  "and tool permissions went with it, so the message was not sent.";

/**
 * What an embed says instead. Deliberately not "no longer exists": that names a
 * cause the read does not support, and it is the one an owner would act on by
 * rebuilding something that was never gone.
 */
export const EMBED_CONFIG_UNREADABLE =
  "This embed's configuration could not be read just now, so the message was not answered. " +
  "Try again in a moment.";

/**
 * A read that threw, as a read. A thrown client error carries no `error` field
 * of its own, and a falsy cause would read back as "no error" — the exact
 * confusion this round is about — so it is always given a truthy one. `||`
 * rather than `??` on purpose: a thrown "" or 0 is still a throw.
 */
export function failedRead(cause: unknown): AgentConfigRead {
  return { data: null, error: cause || new Error("the agent read threw") };
}

/**
 * The refusal this read calls for, or `null` when the turn may run.
 *
 * A missing row refuses as well as a failed one, and not only for tidiness: the
 * delete dialog promises that "API calls that reference it will stop working",
 * and before R234 they kept answering — minus the guardrails they were deleted
 * with, which is the opposite of what the sentence led its reader to expect.
 */
export function agentConfigRefusal(read: AgentConfigRead): ConfigRefusal | null {
  if (!read || read.error) {
    return { code: "agent_unreadable", status: 503, message: AGENT_UNREADABLE_MESSAGE };
  }
  if (!read.data) {
    return { code: "agent_not_found", status: 404, message: AGENT_NOT_FOUND_MESSAGE };
  }
  return null;
}
