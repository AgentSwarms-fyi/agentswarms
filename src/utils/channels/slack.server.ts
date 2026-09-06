// The Slack side of a channel: loading a workspace by the only id an inbound
// request carries, and posting an answer back into the conversation it came
// from.
//
// A slash command has a `response_url` and needs none of this. An @mention
// has no such thing — the only way to answer is Slack's Web API with the
// workspace's bot token, which is why a workspace that wants mentions has to
// have one saved and a workspace that only wants slash commands does not.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptJson } from "@/utils/providers/crypto.server";
import type { ChannelTarget, SlackRoute } from "@/utils/channels/core";

export type SlackWorkspaceRow = {
  id: string;
  user_id: string;
  team_id: string;
  team_name: string | null;
  analyst_id: string | null;
  mention_target_type: "agent" | "analyst" | null;
  mention_target_id: string | null;
  is_active: boolean;
  signing_secret_enc: { ciphertext?: string; iv?: string } | null;
  bot_token_enc: { ciphertext?: string; iv?: string } | null;
};

const WORKSPACE_COLUMNS =
  "id, user_id, team_id, team_name, analyst_id, mention_target_type, mention_target_id, is_active, signing_secret_enc, bot_token_enc";

/**
 * The workspace a request belongs to, with the service role: an inbound Slack
 * request carries no AgentSwarms session, only `team_id`, and it proves
 * itself with the signature that this row's secret verifies.
 *
 * Returns null for an unknown or paused workspace, which every caller turns
 * into the same terse denial — an endpoint that distinguished them would tell
 * a prober which workspaces exist.
 */
export async function loadSlackWorkspace(teamId: string): Promise<SlackWorkspaceRow | null> {
  const { data } = await supabaseAdmin
    .from("slack_workspaces")
    .select(WORKSPACE_COLUMNS)
    .eq("team_id", teamId)
    .maybeSingle();
  const row = data as SlackWorkspaceRow | null;
  if (!row || !row.is_active) return null;
  return row;
}

/** The decrypted signing secret, or null when there is none to verify with. */
export async function slackSigningSecret(row: SlackWorkspaceRow): Promise<string | null> {
  const enc = row.signing_secret_enc;
  if (!enc?.ciphertext || !enc?.iv) return null;
  try {
    const { secret } = await decryptJson<{ secret: string }>(enc.ciphertext, enc.iv);
    return secret || null;
  } catch {
    return null;
  }
}

/** The decrypted bot token, or null. Only mentions and DMs need one. */
export async function slackBotToken(row: SlackWorkspaceRow): Promise<string | null> {
  const enc = row.bot_token_enc;
  if (!enc?.ciphertext || !enc?.iv) return null;
  try {
    const { token } = await decryptJson<{ token: string }>(enc.ciphertext, enc.iv);
    return token || null;
  } catch {
    return null;
  }
}

/** Active routes for a workspace, in the shape routeForCommand expects. */
export async function slackRoutesFor(workspaceId: string): Promise<SlackRoute[]> {
  const { data } = await supabaseAdmin
    .from("slack_command_routes")
    .select("command, target_type, target_id, is_active")
    .eq("workspace_id", workspaceId);
  return (data ?? []) as SlackRoute[];
}

/** Who answers an @mention or a DM here, if anyone. */
export function mentionTargetOf(row: SlackWorkspaceRow): ChannelTarget | null {
  if (row.mention_target_type && row.mention_target_id) {
    return { type: row.mention_target_type, id: row.mention_target_id };
  }
  return row.analyst_id ? { type: "analyst", id: row.analyst_id } : null;
}

/**
 * Post into a Slack conversation with the bot token.
 *
 * Always in a thread when the message that asked was in one — or under the
 * message itself when it was not — so an answer that takes a minute lands
 * beside its question rather than at the bottom of a channel that has moved
 * on. Slack answers 200 with `{ok:false}` for its own errors, so the body is
 * what says whether this worked, not the status.
 */
export async function postSlackMessage(args: {
  token: string;
  channel: string;
  threadTs?: string | null;
  text: string;
  blocks?: unknown[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({
        channel: args.channel,
        text: args.text,
        ...(args.blocks ? { blocks: args.blocks } : {}),
        ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok) return { ok: false, error: `Slack answered ${res.status}` };
    if (!body?.ok) return { ok: false, error: body?.error ?? "Slack refused the message" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach Slack" };
  }
}

/** Note that Slack reached this deployment, which a saved row does not prove. */
export function markSlackSeen(
  workspaceId: string,
  column: "last_command_at" | "last_event_at",
  error: string | null,
): void {
  const now = new Date().toISOString();
  // Spelled out rather than computed: a computed key widens the update to a
  // string index, and the column names stop being checked at all.
  const patch =
    column === "last_command_at"
      ? { last_command_at: now, last_error: error }
      : { last_event_at: now, last_error: error };
  void supabaseAdmin
    .from("slack_workspaces")
    .update(patch)
    .eq("id", workspaceId)
    .then(() => undefined);
}
