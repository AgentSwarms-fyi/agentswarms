// The Teams side of a channel: finding the bot an activity belongs to, and
// posting the answer back into the conversation it came from.
//
// Slack's mirror image, with one structural difference. Slack hands a slash
// command a `response_url` that needs no credential; Bot Framework never does.
// EVERY answer requires an outbound token minted from the bot's app password,
// so a registration with no password can receive questions and not answer
// them — which is why saving one is not optional here the way a Slack bot
// token is.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptJson } from "@/utils/providers/crypto.server";
import { connectorFetch } from "@/utils/http/connectorFetch.server";
import type { ChannelTarget } from "@/utils/channels/core";
import { replyActivity, replyEndpoint, type TeamsActivity } from "@/lib/teamsActivity";

export type TeamsBotRow = {
  id: string;
  user_id: string;
  app_id: string;
  display_name: string | null;
  tenant_id: string | null;
  target_type: "agent" | "analyst" | null;
  target_id: string | null;
  is_active: boolean;
  app_password_enc: { ciphertext?: string; iv?: string } | null;
};

const BOT_COLUMNS =
  "id, user_id, app_id, display_name, tenant_id, target_type, target_id, is_active, app_password_enc";

/**
 * The bot a request belongs to, with the service role: an inbound activity
 * carries no AgentSwarms session, only the app id its token is addressed to.
 *
 * Returns null for an unknown or paused registration, which the endpoint turns
 * into the same terse denial as every other failure — distinguishing them
 * would tell a prober which bots exist.
 */
export async function loadTeamsBot(appId: string): Promise<TeamsBotRow | null> {
  const { data } = await supabaseAdmin
    .from("teams_bots")
    .select(BOT_COLUMNS)
    .eq("app_id", appId)
    .maybeSingle();
  const row = data as TeamsBotRow | null;
  if (!row || !row.is_active) return null;
  return row;
}

export async function teamsAppPassword(bot: TeamsBotRow): Promise<string | null> {
  const enc = bot.app_password_enc;
  if (!enc?.ciphertext || !enc?.iv) return null;
  try {
    // The same envelope shape the Slack workspace uses, so both credentials
    // are stored and read one way.
    const { password } = await decryptJson<{ password: string }>(enc.ciphertext, enc.iv);
    return password || null;
  } catch {
    return null;
  }
}

/** Who answers in this bot's Teams conversations. */
export function teamsTargetOf(bot: TeamsBotRow): ChannelTarget | null {
  if (!bot.target_type || !bot.target_id) return null;
  return { type: bot.target_type, id: bot.target_id };
}

// An outbound token lasts an hour; minting one per activity would add a
// round-trip to every answer for no benefit. Keyed by app id, and dropped a
// minute early so a token never expires mid-request.
const tokenCache = new Map<string, { token: string; until: number }>();

/**
 * Mint the token that authorises posting back.
 *
 * Client credentials against the bot's own tenant, for the Bot Framework
 * scope. A single-tenant registration must authenticate against its tenant
 * rather than `botframework.com`, which is the difference that makes a
 * single-tenant bot work at all.
 */
export async function teamsOutboundToken(bot: TeamsBotRow): Promise<string | null> {
  const cached = tokenCache.get(bot.app_id);
  if (cached && cached.until > Date.now()) return cached.token;

  const password = await teamsAppPassword(bot);
  if (!password) return null;

  const authority = bot.tenant_id
    ? `https://login.microsoftonline.com/${encodeURIComponent(bot.tenant_id)}/oauth2/v2.0/token`
    : "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
  const res = await connectorFetch(authority, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: bot.app_id,
      client_secret: password,
      scope: "https://api.botframework.com/.default",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    console.warn(
      `[teams] token for ${bot.app_id}: ${body.error_description ?? `HTTP ${res.status}`}`,
    );
    return null;
  }
  tokenCache.set(bot.app_id, {
    token: body.access_token,
    until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000,
  });
  return body.access_token;
}

/** Forget a cached outbound token — for a rotated password. */
export function forgetTeamsToken(appId: string): void {
  tokenCache.delete(appId);
}

/**
 * Post an answer back into the conversation.
 *
 * The endpoint comes from the ACTIVITY's serviceUrl, which the inbound token
 * already vouched for — that check is what stops an attacker naming a host of
 * their own and having the bot deliver the answer there.
 */
export async function postTeamsReply(args: {
  bot: TeamsBotRow;
  activity: TeamsActivity;
  text: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = replyEndpoint(args.activity);
  if (!url) return { ok: false, error: "activity has no conversation to reply to" };
  const token = await teamsOutboundToken(args.bot);
  if (!token) {
    return {
      ok: false,
      error: "no app password saved for this bot, so it cannot post an answer",
    };
  }
  const res = await connectorFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(replyActivity(args.activity, args.text)),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    // A rotated password shows up here as a 401; drop the cached token so the
    // next attempt mints a fresh one rather than repeating the stale one.
    if (res.status === 401) forgetTeamsToken(args.bot.app_id);
    return { ok: false, error: `Teams ${res.status}: ${text}` };
  }
  return { ok: true };
}

/** Record that this bot was used, and any trouble it had answering. */
export async function markTeamsActivity(botId: string, error?: string | null): Promise<void> {
  await supabaseAdmin
    .from("teams_bots")
    .update({ last_activity_at: new Date().toISOString(), last_error: error ?? null })
    .eq("id", botId);
}
