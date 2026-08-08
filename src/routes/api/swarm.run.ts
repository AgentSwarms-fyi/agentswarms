// Public swarm run endpoint.
//
//   POST /api/swarm/run
//   Authorization: Bearer sk_swarm_…
//   Idempotency-Key: <optional, client-chosen>
//   { "input": "…", "inputs": { "field": "value" },
//     "history": [{ "role": "user"|"assistant", "content": "…" }],
//     "async": false, "callback_url": "https://…" }
//   → { "output": "…", "runId": "…" }          (sync)
//   → 202 { "accepted": true, "callback_url": … } (async)
//
// Idempotency-Key makes retries safe: repeating a key returns the original
// result instead of re-running (and re-billing) the swarm. Reusing a key with
// a different body is rejected with 422.
//
// async:true returns immediately and POSTs the result to callback_url when the
// run finishes, signed with the key's webhook secret (X-AgentSwarms-Signature,
// HMAC-SHA256 over "<timestamp>.<body>").
//
// `history` (optional) turns a swarm into a multi-turn chatbot: prior turns
// are replayed into every agent node so the swarm answers in context. The
// caller manages the transcript (append the returned output as the assistant
// turn and send it back next time) — the endpoint stays stateless.
//
// Authenticated by a per-swarm API key (SHA-256 hash looked up server-side).
// The swarm runs headlessly via the server executor as the key's owner.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sha256Hex } from "@/utils/swarmDeploy.functions";
import { executeSwarmServer } from "@/utils/swarmExecute.server";
import { resolveDeployedGraph } from "@/lib/swarmPublish";
import { resolveInternalOrigin } from "@/utils/internalOrigin.server";
import { acquireSlotGlobal, envInt, rateLimitedGlobal } from "@/utils/rateLimit.server";
import { auditEvent } from "@/utils/audit.server";
import { clientIp, clientUserAgent } from "@/utils/requestMeta.server";
import { budgetMessage, getBudgetDecision } from "@/utils/budgetGuard.server";
import { deliverRunCallback, hashBody } from "@/utils/swarmWebhook.server";
import { idempotencyVerdict, type IdempotencyRow } from "@/utils/swarmIdempotency";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });

export const Route = createFileRoute("/api/swarm/run")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: cors }),
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization");
        const rawKey = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (!rawKey) return json({ error: "Missing API key" }, 401);

        const keyHash = await sha256Hex(rawKey);
        const { data: key } = await supabaseAdmin
          .from("swarm_api_keys")
          .select(
            "id, user_id, swarm_id, is_active, reject_approvals, expires_at, scopes, webhook_secret, callback_url",
          )
          .eq("key_hash", keyHash)
          .maybeSingle();
        if (!key) return json({ error: "Invalid or disabled API key" }, 401);

        // Deny reasons are audited: a revoked or lapsed key still being used is
        // a security signal the owner should see, not just a 401 in the logs.
        const denyKey = (reason: string, message: string, status = 401) => {
          auditEvent({
            userId: key.user_id,
            action: "swarm.api_key.denied",
            resourceType: "swarm",
            resourceId: key.swarm_id,
            detail: {
              reason,
              key_id: key.id,
              ip: clientIp(request),
              user_agent: clientUserAgent(request),
            },
          });
          return json({ error: message }, status);
        };

        if (!key.is_active) return denyKey("key_disabled", "Invalid or disabled API key");
        if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) {
          return denyKey("key_expired", "This API key has expired.", 403);
        }
        // Empty scopes = legacy key minted before scoping; treat as "run".
        const scopes = key.scopes?.length ? key.scopes : ["run"];
        if (!scopes.includes("run")) {
          return denyKey("missing_scope", "This API key is not allowed to run swarms.", 403);
        }

        // A swarm run is expensive and can hold a worker for minutes, so bound
        // both the request rate and how many may be in flight for this key.
        // Counted in Postgres, NOT per-process: these are the ceilings an
        // operator configures and reads back in the docs, and a per-instance
        // count silently multiplied them by the number of instances.
        const bucket = `swarm-run:${key.id}`;
        if (await rateLimitedGlobal(bucket, envInt("SWARM_RUN_RATE_LIMIT_PER_MIN", 30))) {
          return json({ error: "Rate limit exceeded — slow down and retry." }, 429);
        }
        // The lease outlives the run's own timeout so a slot is never reclaimed
        // from a run that is still going.
        const slot = await acquireSlotGlobal(
          bucket,
          envInt("SWARM_RUN_MAX_CONCURRENT", 5),
          envInt("SWARM_RUN_TIMEOUT_MS", 600_000) / 1000 + 300,
        );
        if (!slot) {
          return json(
            { error: "Too many concurrent runs for this key — retry when one finishes." },
            429,
          );
        }

        // Budget gate before any work: a swarm run can fan out to many model
        // calls, so refusing up-front is much cheaper than aborting mid-run.
        const budget = await getBudgetDecision(key.user_id, {
          type: "swarm_api_key",
          id: key.id,
        });
        if (budget.over) {
          await slot.release();
          return json({ error: budgetMessage(budget) }, 402);
        }

        // Set when a detached async run takes ownership of the concurrency
        // slot, so the outer finally does not release it early.
        let asyncStarted = false;

        try {
          let payload: {
            input?: unknown;
            inputs?: unknown;
            history?: unknown;
            async?: unknown;
            callback_url?: unknown;
          } = {};
          try {
            payload = (await request.json()) as typeof payload;
          } catch {
            /* empty body ok */
          }

          // ── Idempotency ───────────────────────────────────────────────
          // A retried POST (client timeout, proxy retry, at-least-once queue)
          // used to re-run the whole swarm and re-bill it. With a key we
          // return the original result instead.
          const idemKey = (request.headers.get("idempotency-key") || "").trim().slice(0, 200);
          const reqHash = idemKey ? await hashBody(payload) : "";
          if (idemKey) {
            const { data: existing } = await supabaseAdmin
              .from("swarm_run_idempotency")
              .select("status, response, request_hash, run_id")
              .eq("api_key_id", key.id)
              .eq("idempotency_key", idemKey)
              .maybeSingle();
            const verdict = idempotencyVerdict(existing as IdempotencyRow | null, reqHash);
            if (verdict.action === "mismatch") {
              return json(
                { error: "This Idempotency-Key was already used with a different request body." },
                422,
              );
            }
            if (verdict.action === "replay") {
              return json(verdict.response as Record<string, unknown>);
            }
            if (verdict.action === "in_progress") {
              return json(
                {
                  error: "A run with this Idempotency-Key is still in progress.",
                  runId: verdict.runId,
                },
                409,
              );
            }

            // CLAIM ATOMICALLY. This was an upsert, which SUCCEEDS FOR BOTH
            // racers: two concurrent requests carrying the same key both read
            // no row, both upserted, and both ran the swarm — double work and
            // double billing, in exactly the situation idempotency exists for,
            // because at-least-once queues and proxy retries are concurrent by
            // nature.
            //
            // insert() leans on UNIQUE (api_key_id, idempotency_key), so only
            // one racer can create the row.
            const { error: claimErr } = await supabaseAdmin.from("swarm_run_idempotency").insert({
              api_key_id: key.id,
              idempotency_key: idemKey,
              request_hash: reqHash,
              status: "in_progress",
            });
            if (claimErr) {
              // A row exists. Either a racer just created it, or an earlier
              // attempt failed and this is a retry — and only ONE retrier may
              // proceed, so the takeover is a conditional update that matches
              // just the failed state. No match means somebody else owns it.
              const { data: taken } = await supabaseAdmin
                .from("swarm_run_idempotency")
                .update({
                  request_hash: reqHash,
                  status: "in_progress",
                  response: null,
                  completed_at: null,
                })
                .eq("api_key_id", key.id)
                .eq("idempotency_key", idemKey)
                .eq("status", "failed")
                .select("id")
                .maybeSingle();
              if (!taken) {
                return json(
                  { error: "A run with this Idempotency-Key is already in progress." },
                  409,
                );
              }
            }
          }

          const input = typeof payload.input === "string" ? payload.input : "";
          const initialState: Record<string, string> = {};
          if (payload.inputs && typeof payload.inputs === "object") {
            for (const [k, v] of Object.entries(payload.inputs as Record<string, unknown>)) {
              initialState[k] = typeof v === "string" ? v : JSON.stringify(v);
            }
          }
          // Optional conversation history (chat mode). Keep only valid turns and
          // cap to the last 20 so a long transcript can't blow up token usage.
          const history: { role: "user" | "assistant"; content: string }[] = Array.isArray(
            payload.history,
          )
            ? (payload.history as unknown[])
                .filter(
                  (m): m is { role: "user" | "assistant"; content: string } =>
                    !!m &&
                    typeof m === "object" &&
                    ((m as { role?: unknown }).role === "user" ||
                      (m as { role?: unknown }).role === "assistant") &&
                    typeof (m as { content?: unknown }).content === "string",
                )
                .slice(-20)
            : [];

          const { data: swarm } = await supabaseAdmin
            .from("swarms")
            .select("id, name, nodes, edges, published_nodes, published_edges, published_at")
            .eq("id", key.swarm_id)
            .maybeSingle();
          if (!swarm) return json({ error: "Swarm not found" }, 404);
          // Serve the PUBLISHED graph, so editing the canvas cannot change
          // what this key returns mid-flight. Swarms deployed before
          // publishing existed have no snapshot and fall back to the draft.
          const deployed = resolveDeployedGraph(swarm);
          const runGraph = {
            id: swarm.id,
            name: swarm.name,
            nodes: deployed.nodes,
            edges: deployed.edges,
          };

          // Resolved from configuration only — never from the request's Host
          // header, because the executor sends an internal secret to this origin.
          const origin = resolveInternalOrigin();

          // Best-effort last-used stamp (incl. calling IP, for forensics).
          const ip = clientIp(request);
          void supabaseAdmin
            .from("swarm_api_keys")
            .update({
              last_used_at: new Date().toISOString(),
              ...(ip ? { last_used_ip: ip } : {}),
            })
            .eq("id", key.id)
            .then(undefined, () => undefined);

          const runSwarm = () =>
            executeSwarmServer({
              swarm: runGraph,
              userId: key.user_id,
              origin,
              input,
              initialState,
              history,
              rejectApprovals: key.reject_approvals,
              source: "api",
            });

          /** Record the outcome against the idempotency key, if one was sent. */
          const finishIdempotency = async (status: "completed" | "failed", body: unknown) => {
            if (!idemKey) return;
            await supabaseAdmin
              .from("swarm_run_idempotency")
              .update({
                status,
                response: body as never,
                completed_at: new Date().toISOString(),
              })
              .eq("api_key_id", key.id)
              .eq("idempotency_key", idemKey);
          };

          // ── Async mode ────────────────────────────────────────────────
          // A long swarm shouldn't hold an HTTP connection open. Return
          // immediately and POST the result to the callback when it lands.
          const wantAsync = payload.async === true;
          const callbackUrl =
            typeof payload.callback_url === "string" && payload.callback_url.trim()
              ? payload.callback_url.trim()
              : (key.callback_url ?? null);
          if (wantAsync) {
            if (!callbackUrl) {
              return json(
                {
                  error:
                    "Async runs need a callback: pass callback_url, or set a default on the API key.",
                },
                400,
              );
            }
            // Detached: hold the concurrency slot for the real duration of the
            // run, and release it in this task rather than the outer finally.
            void (async () => {
              try {
                const result = await runSwarm();
                const body = {
                  runId: result.runId,
                  status: result.status,
                  output: result.output,
                  error: result.error,
                  swarmId: swarm.id,
                };
                // A suspended run is NOT complete: leaving the idempotency
                // record open lets the same request be retried after the
                // approval lands, rather than replaying a half-run result.
                if (result.status !== "suspended") {
                  await finishIdempotency(result.status === "error" ? "failed" : "completed", body);
                }
                await deliverRunCallback({
                  url: callbackUrl,
                  secret: key.webhook_secret,
                  payload: body,
                });
              } catch (e) {
                const body = {
                  runId: null,
                  status: "error" as const,
                  output: "",
                  error: (e as Error).message,
                  swarmId: swarm.id,
                };
                await finishIdempotency("failed", body);
                await deliverRunCallback({
                  url: callbackUrl,
                  secret: key.webhook_secret,
                  payload: body,
                });
              } finally {
                await slot.release();
              }
            })();
            asyncStarted = true; // outer finally must not double-release
            return json({ accepted: true, callback_url: callbackUrl }, 202);
          }

          // ── Synchronous mode (default) ────────────────────────────────
          const result = await runSwarm();
          if (result.status === "error") {
            const body = { error: result.error, runId: result.runId };
            await finishIdempotency("failed", body);
            return json(body, 400);
          }
          const body = { output: result.output, runId: result.runId };
          await finishIdempotency("completed", body);
          return json(body);
        } finally {
          // Give the concurrency slot back — except in async mode, where the
          // detached task owns it until the run actually finishes.
          if (!asyncStarted) await slot.release();
        }
      },
    },
  },
});
