// POST /api/slack/events — @mentions and direct messages, answered in thread.
//
// A slash command is a form with a `response_url` to post back to. An event
// is neither: the only way to answer is Slack's Web API with the workspace's
// bot token, which is why a workspace that wants mentions must save one and
// one that only wants slash commands need not.
//
// THE 3-SECOND RULE AGAIN, harder. Slack retries an event that is not
// acknowledged in three seconds, and a turn takes 30–95, so the work starts
// unawaited and the 200 goes out immediately. A retry therefore arrives while
// the first attempt is still thinking: it carries X-Slack-Retry-Num, and the
// only correct response is to acknowledge and drop it. Answering it too would
// post the same answer three times.
//
// Same trust boundary as the slash-command endpoint: public, so the signature
// over the raw body is the whole of it, and every failure is the same terse
// 401.
import { createFileRoute } from "@tanstack/react-router";

import { agentAnswerBlocks, analystAnswerBlocks, truncateForSlack } from "@/lib/slackBlocks";
import {
  channelTargetMissing,
  isAnswerableSlackEvent,
  isSlackRetry,
  slackMessageText,
} from "@/utils/channels/core";
import { answerForTarget, auditChannelTurn } from "@/utils/channels/run.server";
import {
  loadSlackWorkspace,
  markSlackSeen,
  mentionTargetOf,
  postSlackMessage,
  slackBotToken,
  slackSigningSecret,
} from "@/utils/channels/slack.server";
import { verifySlackRequest } from "@/utils/slack/signature.server";

function deny() {
  return new Response("Unauthorized", { status: 401 });
}

/** Slack wants a 200 and nothing else; the answer arrives later, over the API. */
function ack() {
  return new Response("", { status: 200 });
}

type SlackEventBody = {
  type?: string;
  /** Present only on the one-off URL verification handshake. */
  challenge?: string;
  team_id?: string;
  authorizations?: { user_id?: string }[];
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
  };
};

export const Route = createFileRoute("/api/slack/events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // RAW body first, for both the signature and the parse.
        const rawBody = await request.text();
        const timestamp = request.headers.get("x-slack-request-timestamp");
        const signature = request.headers.get("x-slack-signature");

        let body: SlackEventBody;
        try {
          body = JSON.parse(rawBody) as SlackEventBody;
        } catch {
          return deny();
        }

        // The handshake Slack does once when the URL is saved. It is signed
        // like everything else, so it is verified like everything else — but
        // it names no team, so the secret cannot be looked up by team_id.
        // Every workspace's secret is tried; one of them is the new one.
        if (body.type === "url_verification") {
          if (typeof body.challenge !== "string") return deny();
          const ok = await anyWorkspaceVerifies({ rawBody, timestamp, signature });
          if (!ok) return deny();
          return new Response(JSON.stringify({ challenge: body.challenge }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        const teamId = body.team_id;
        if (!teamId) return deny();
        const ws = await loadSlackWorkspace(teamId);
        if (!ws) return deny();
        const signingSecret = await slackSigningSecret(ws);
        if (!signingSecret) return deny();

        const verdict = verifySlackRequest({
          rawBody,
          timestamp,
          signature,
          signingSecret,
          nowSeconds: Math.floor(Date.now() / 1000),
        });
        if (!verdict.ok) {
          console.warn(`[slack] rejected an event from ${teamId}: ${verdict.reason}`);
          return deny();
        }

        // A retry means the first delivery is still being answered. Drop it.
        if (isSlackRetry(request.headers.get("x-slack-retry-num"))) return ack();

        const event = body.event ?? null;
        const botUserId = body.authorizations?.[0]?.user_id ?? null;
        if (!isAnswerableSlackEvent(event, botUserId) || !event?.channel) return ack();

        const question = slackMessageText(event.text);
        const channel = event.channel;
        // Answer in the thread the question is in, or start one under it, so
        // a minute-long answer lands beside its question rather than at the
        // bottom of a channel that has moved on.
        const threadTs = event.thread_ts ?? event.ts ?? null;

        const token = await slackBotToken(ws);
        if (!token) {
          // Nothing to answer with. Recorded where the owner will see it,
          // since there is no way to tell the person in Slack.
          markSlackSeen(ws.id, "last_event_at", "A bot token is required to answer mentions.");
          return ack();
        }
        if (!question) {
          await postSlackMessage({
            token,
            channel,
            threadTs,
            text: "Ask me something — mention me with a question and I will answer here.",
          });
          return ack();
        }

        const target = mentionTargetOf(ws);
        if (!target) {
          await postSlackMessage({ token, channel, threadTs, text: channelTargetMissing(null) });
          markSlackSeen(ws.id, "last_event_at", "No mention target is selected.");
          return ack();
        }

        // ANSWER OUT OF BAND, for the same reason the slash command does.
        void (async () => {
          const audit = (
            status: "success" | "error",
            extra: { targetName?: string | null; error?: string; traceId?: string | null },
          ) =>
            auditChannelTurn({
              ownerId: ws.user_id,
              surface: "slack",
              channelId: ws.id,
              channelName: ws.team_name ?? ws.team_id,
              target,
              targetName: extra.targetName ?? null,
              question,
              status,
              error: extra.error,
              traceId: extra.traceId,
              command: event.type === "app_mention" ? "@mention" : "dm",
              asker: event.user ?? null,
            });
          try {
            const outcome = await answerForTarget({
              ownerId: ws.user_id,
              target,
              question,
              surface: "slack",
            });
            if (!outcome.ok) {
              await postSlackMessage({
                token,
                channel,
                threadTs,
                text: `Could not answer: ${truncateForSlack(outcome.error, 500)}`,
              });
              markSlackSeen(ws.id, "last_event_at", outcome.error);
              audit("error", { error: outcome.error });
              return;
            }
            const blocks =
              outcome.kind === "agent"
                ? agentAnswerBlocks({
                    question,
                    answer: outcome.text,
                    agentName: outcome.targetName,
                  })
                : analystAnswerBlocks({
                    question,
                    answer: outcome.turn.answer ?? "The analyst returned no summary.",
                    steps: (outcome.turn.steps ?? []).map((s) => ({
                      title: s.goal,
                      summary: s.check?.note,
                      governed: Boolean(s.governed),
                      truncatedRows:
                        typeof s.rowCount === "number" && s.rows && s.rowCount > s.rows.length
                          ? s.rowCount
                          : undefined,
                    })),
                  });
            // `text` is the notification body and the fallback for clients
            // that cannot render blocks; without it Slack shows an empty
            // message in the sidebar.
            const posted = await postSlackMessage({
              token,
              channel,
              threadTs,
              text: truncateForSlack(
                outcome.kind === "agent" ? outcome.text : (outcome.turn.answer ?? "Answered."),
                500,
              ),
              blocks,
            });
            markSlackSeen(ws.id, "last_event_at", posted.ok ? null : posted.error);
            audit(posted.ok ? "success" : "error", {
              targetName: outcome.targetName,
              error: posted.ok ? undefined : posted.error,
              traceId: outcome.kind === "agent" ? outcome.traceId : null,
            });
          } catch (e) {
            const error = e instanceof Error ? e.message : "The turn failed.";
            await postSlackMessage({
              token,
              channel,
              threadTs,
              text: `Could not answer: ${error}`,
            });
            markSlackSeen(ws.id, "last_event_at", error);
            audit("error", { error });
          }
        })();

        return ack();
      },
    },
  },
});

/**
 * The URL-verification handshake names no workspace, so there is no secret to
 * look up by id — every configured one is tried, and the request is accepted
 * if any of them signs it. That is not a weaker check: each secret still has
 * to produce this exact signature over these exact bytes.
 */
async function anyWorkspaceVerifies(args: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
}): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("slack_workspaces")
    .select("signing_secret_enc")
    .eq("is_active", true)
    .limit(100);
  const { decryptJson } = await import("@/utils/providers/crypto.server");
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const row of data ?? []) {
    const enc = row.signing_secret_enc as { ciphertext?: string; iv?: string } | null;
    if (!enc?.ciphertext || !enc?.iv) continue;
    try {
      const { secret } = await decryptJson<{ secret: string }>(enc.ciphertext, enc.iv);
      if (!secret) continue;
      const verdict = verifySlackRequest({ ...args, signingSecret: secret, nowSeconds });
      if (verdict.ok) return true;
    } catch {
      // A secret that will not decrypt cannot be the one that signed this.
    }
  }
  return false;
}
