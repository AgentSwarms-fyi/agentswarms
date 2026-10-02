// POST /api/teams/messages — the Bot Framework endpoint a Teams bot points at.
//
// Same trust boundary as the Slack endpoints and a different proof. Slack signs
// with a shared secret; Microsoft sends a token it signed with a rotating key
// it publishes, so `verifyTeamsToken` is the whole of the security here and
// every failure is the same terse 401 that explains nothing.
//
// THE ORDER MATTERS. The app id comes from the token's own audience claim, and
// is used only to find which bot row to check it against — the signature,
// issuer, audience and serviceUrl are all verified before a single byte of the
// activity is acted on. Reading the activity first and trusting anything in it
// would be trusting the attacker's own JSON.
//
// THE 15-SECOND RULE. Teams gives a bot about fifteen seconds to respond and a
// turn takes 30–95, so the work starts unawaited and the 200 goes out
// immediately; the answer arrives later on the service URL. That is what the
// Bot Framework calls a proactive reply, and it is the only shape that fits an
// agent turn.
import { createFileRoute } from "@tanstack/react-router";

import {
  isAnswerableActivity,
  teamsMessageText,
  tenantAllowed,
  truncateForTeams,
  type TeamsActivity,
} from "@/lib/teamsActivity";
import { channelTargetMissing } from "@/utils/channels/core";
import { answerForTarget, auditChannelTurn } from "@/utils/channels/run.server";
import {
  loadTeamsBot,
  markTeamsActivity,
  postTeamsReply,
  teamsTargetOf,
} from "@/utils/channels/teams.server";
import { verifyTeamsToken } from "@/utils/teams/jwt.server";

function deny() {
  return new Response("Unauthorized", { status: 401 });
}

/** Teams wants a prompt 200; the answer arrives later, over the service URL. */
function ack() {
  return new Response("", { status: 200 });
}

/** The audience of the presented token, read WITHOUT trusting it. */
function audienceOf(authorization: string | null): string | null {
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const pad = parts[1].length % 4 === 0 ? "" : "=".repeat(4 - (parts[1].length % 4));
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/") + pad);
    const aud = (JSON.parse(json) as { aud?: unknown }).aud;
    return typeof aud === "string" && aud ? aud : null;
  } catch {
    return null;
  }
}

/**
 * One markdown message from either kind of answer.
 *
 * An agent returns text. The analyst returns a whole turn — its answer, and
 * the questions it thinks are worth asking next, which in a chat client are
 * the cheapest useful thing on offer: the next question is right there to
 * copy. Its charts and tables are not: Teams would render them as nothing.
 */
function answerText(
  answer: Extract<Awaited<ReturnType<typeof answerForTarget>>, { ok: true }>,
): string {
  if (answer.kind === "agent") return answer.text;
  const turn = answer.turn;
  const parts = [turn.answer ?? "The analyst returned no summary."];
  const followUps = (turn.followUps ?? []).slice(0, 3);
  if (followUps.length) {
    parts.push("", "**Worth asking next**", ...followUps.map((q) => `- ${q}`));
  }
  return parts.join("\n");
}

export const Route = createFileRoute("/api/teams/messages")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization");

        let activity: TeamsActivity;
        try {
          activity = (await request.json()) as TeamsActivity;
        } catch {
          return deny();
        }

        // Which bot is this addressed to? The token says so; nothing is
        // believed about it until the signature has been checked below.
        const appId = audienceOf(authorization);
        if (!appId) return deny();
        const bot = await loadTeamsBot(appId);
        if (!bot) return deny();

        const verdict = await verifyTeamsToken({
          authorization,
          appId: bot.app_id,
          // From the ACTIVITY, so the token's own claim is checked against it
          // rather than against itself.
          serviceUrl: activity.serviceUrl ?? null,
        });
        if (!verdict.ok) {
          console.warn(`[teams] rejected an activity for ${appId}: ${verdict.reason}`);
          return deny();
        }

        // A single-tenant registration answers its own tenant only. The token
        // proves Microsoft sent this; it does not prove which organisation it
        // came from.
        if (!tenantAllowed(bot.tenant_id, activity)) {
          console.warn(`[teams] ${appId}: activity from another tenant`);
          return deny();
        }

        // Everything past here is authenticated. Anything that is not a
        // question — a bot being added, a reaction, the bot's own message
        // coming back — is acknowledged and dropped.
        if (!isAnswerableActivity(activity)) return ack();

        const target = teamsTargetOf(bot);
        if (!target) {
          // Configured but pointed at nothing. Said in Teams, because the
          // person asking cannot see the settings page.
          void postTeamsReply({
            bot,
            activity,
            text: channelTargetMissing(null, "teams"),
          }).catch(() => {});
          void markTeamsActivity(bot.id, "No agent or analyst is chosen for this bot.");
          return ack();
        }

        const question = teamsMessageText(activity);

        // Unawaited: Teams stops waiting long before an agent finishes, so the
        // answer is posted back to the conversation when it is ready.
        void (async () => {
          try {
            const answer = await answerForTarget({
              ownerId: bot.user_id,
              target,
              question,
              surface: "teams",
            });
            const text = answer.ok
              ? truncateForTeams(answerText(answer))
              : `I could not answer that: ${answer.error}`;
            const posted = await postTeamsReply({ bot, activity, text });
            await markTeamsActivity(bot.id, posted.ok ? null : posted.error);
            auditChannelTurn({
              ownerId: bot.user_id,
              surface: "teams",
              channelId: bot.id,
              channelName: bot.display_name ?? bot.app_id,
              target,
              targetName: answer.ok ? answer.targetName : null,
              question,
              status: answer.ok ? "success" : "error",
              error: answer.ok ? undefined : answer.error,
              traceId: answer.ok && answer.kind === "agent" ? answer.traceId : null,
              // Who asked, as Teams names them — an Entra object id, not an
              // AgentSwarms identity.
              asker: activity.from?.aadObjectId ?? activity.from?.id ?? null,
            });
          } catch (e) {
            await markTeamsActivity(bot.id, (e as Error).message.slice(0, 500));
          }
        })();

        return ack();
      },
    },
  },
});
