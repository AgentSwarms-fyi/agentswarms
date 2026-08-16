// POST /api/slack/command — a Slack slash command asks the AI Analyst.
//
// THE 3-SECOND RULE SHAPES EVERYTHING HERE. Slack shows the user an error if
// the endpoint has not replied within three seconds, and an analyst turn takes
// 30–95. So this acknowledges immediately and posts the real answer to the
// `response_url` afterwards. Anything that "just awaits the turn" works in
// testing with a trivial question and fails in production with a real one.
//
// THE ENDPOINT IS PUBLIC. It has to be — Slack calls it — so the signature is
// the entire boundary. It is verified against the RAW body before anything is
// parsed, and every failure path returns the same terse 401 rather than
// explaining itself to a prober. The reason is logged on the server, where it
// belongs.
//
// The request also carries no AgentSwarms identity: the workspace's `team_id`
// is the only link to an owner, which is why one workspace maps to exactly one
// installation (see migration 20260833000000).

import { createFileRoute } from "@tanstack/react-router";

import { analystAnswerBlocks, analystErrorBlocks, ackBlocks } from "@/lib/slackBlocks";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptJson } from "@/utils/providers/crypto.server";
import { runAnalystTurnServer } from "@/utils/analyst/run.server";
import {
  isSlackResponseUrl,
  parseSlashCommand,
  verifySlackRequest,
} from "@/utils/slack/signature.server";

/** Slack renders this to the user; it must not describe why auth failed. */
function deny() {
  return new Response("Unauthorized", { status: 401 });
}

/** An ephemeral reply only the invoking user sees. */
function ephemeral(text: string, blocks?: unknown[]) {
  return new Response(
    JSON.stringify({ response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function postToSlack(url: string, payload: unknown): Promise<void> {
  // Guarded even though the URL came from a VERIFIED request: if the signing
  // secret ever leaks, an unchecked response_url turns this into an open relay
  // that posts wherever an attacker names.
  if (!isSlackResponseUrl(url)) {
    console.warn("[slack] refused to post to a non-Slack response_url");
    return;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Nothing to do but record it: the user is waiting in Slack and there is
    // no second channel to apologise on.
    console.error("[slack] could not post the answer:", e);
  }
}

export const Route = createFileRoute("/api/slack/command")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // RAW body first, and used for BOTH the signature and the parse.
        // Re-serializing changes bytes and the signature is over bytes.
        const rawBody = await request.text();
        const timestamp = request.headers.get("x-slack-request-timestamp");
        const signature = request.headers.get("x-slack-signature");

        // Parse only enough to find the workspace, so its secret can be
        // fetched — the parse is not trusted for anything else until the
        // signature has been checked against it.
        const teamId = new URLSearchParams(rawBody).get("team_id");
        if (!teamId) return deny();

        // Cast for the reason budgetSpendClient documents: types.ts is
        // generated from the DEPLOYED schema, and this table ships in
        // migration 20260833000000. Regenerating types after applying it
        // removes the need.
        type SlackWorkspaceRow = {
          id: string;
          user_id: string;
          analyst_id: string | null;
          is_active: boolean;
          signing_secret_enc: { ciphertext?: string; iv?: string } | null;
        };
        const admin = supabaseAdmin as unknown as {
          from: (t: string) => {
            select: (c: string) => {
              eq: (
                col: string,
                v: string,
              ) => { maybeSingle: () => Promise<{ data: SlackWorkspaceRow | null }> };
            };
            update: (v: Record<string, unknown>) => {
              eq: (col: string, v: string) => Promise<unknown>;
            };
          };
        };

        const { data: ws } = await admin
          .from("slack_workspaces")
          .select("id, user_id, analyst_id, is_active, signing_secret_enc")
          .eq("team_id", teamId)
          .maybeSingle();
        if (!ws || !ws.is_active) return deny();

        const enc = ws.signing_secret_enc as { ciphertext?: string; iv?: string } | null;
        if (!enc?.ciphertext || !enc?.iv) return deny();
        let signingSecret: string;
        try {
          ({ secret: signingSecret } = await decryptJson<{ secret: string }>(
            enc.ciphertext,
            enc.iv,
          ));
        } catch {
          return deny();
        }

        const verdict = verifySlackRequest({
          rawBody,
          timestamp,
          signature,
          signingSecret,
          nowSeconds: Math.floor(Date.now() / 1000),
        });
        if (!verdict.ok) {
          console.warn(`[slack] rejected a request from ${teamId}: ${verdict.reason}`);
          return deny();
        }

        const cmd = parseSlashCommand(rawBody);
        if (!cmd) return deny();

        if (!cmd.text) {
          return ephemeral("Ask me something — for example: `/ask what was revenue last month?`");
        }
        if (!ws.analyst_id) {
          // Named precisely. "Something went wrong" here would send someone
          // hunting through Slack when the fix is two clicks in AgentSwarms.
          return ephemeral(
            "This workspace is connected but no analyst is selected yet. Pick one in AgentSwarms → Integrations → Slack.",
          );
        }

        // ANSWER OUT OF BAND. Started, deliberately not awaited: the ack below
        // has to be on its way inside three seconds.
        void (async () => {
          try {
            const outcome = await runAnalystTurnServer({
              analystId: ws.analyst_id!,
              ownerId: ws.user_id,
              question: cmd.text,
              priorTurns: [],
              surface: "slack",
            });
            if (!outcome.ok) {
              await postToSlack(cmd.responseUrl, {
                response_type: "in_channel",
                blocks: analystErrorBlocks({ question: cmd.text, error: outcome.error }),
              });
              return;
            }
            const turn = outcome.turn;
            await postToSlack(cmd.responseUrl, {
              response_type: "in_channel",
              blocks: analystAnswerBlocks({
                question: cmd.text,
                answer: turn.answer ?? "The analyst returned no summary.",
                steps: (turn.steps ?? []).map((s) => ({
                  title: s.goal,
                  // The step's own self-check note is the closest thing to a
                  // one-line summary the trace carries; the numbers stay in
                  // the app either way.
                  summary: s.check?.note,
                  // `governed` is the compile's own disclosure — present only
                  // when the semantic layer wrote the SQL. Slack must not be
                  // the one surface where that distinction disappears.
                  governed: Boolean(s.governed),
                  // rowCount is the TRUE count before trimming, so it is only
                  // worth showing when trimming actually happened.
                  truncatedRows:
                    typeof s.rowCount === "number" && s.rows && s.rowCount > s.rows.length
                      ? s.rowCount
                      : undefined,
                })),
              }),
            });
            await admin
              .from("slack_workspaces")
              .update({ last_command_at: new Date().toISOString(), last_error: null })
              .eq("id", ws.id);
          } catch (e) {
            const msg = e instanceof Error ? e.message : "The analyst failed.";
            await postToSlack(cmd.responseUrl, {
              response_type: "in_channel",
              blocks: analystErrorBlocks({ question: cmd.text, error: msg }),
            });
            // Recorded on the row so a broken integration is visible in the
            // app, not only to whoever happened to be in the channel.
            await admin
              .from("slack_workspaces")
              .update({ last_command_at: new Date().toISOString(), last_error: msg })
              .eq("id", ws.id);
          }
        })();

        return new Response(
          JSON.stringify({ response_type: "in_channel", blocks: ackBlocks(cmd.text) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
