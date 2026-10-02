// Batch-job result callback. A headless batch kernel POSTs its outcome here
// using its session token (never a user JWT or provider key). We map the token
// to the exact session it belongs to and persist the result — the client polls
// /api/notebook/runtime (action:status) to read it.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifySessionToken } from "@/utils/notebookRuntime/token.server";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/notebook/runtime/result")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization");
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
        const claims = await verifySessionToken(token);
        if (!claims) return json(401, { error: "Invalid or expired session token" });

        let body: {
          status?: string;
          result?: unknown;
          logs?: string;
          error?: string;
          partial?: boolean;
          /** A continuous run's per-tick report: positions and counters. */
          progress?: unknown;
        };
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }

        // Live log streaming: a partial post replaces the run's captured-so-far
        // logs without touching status — the Runs tab polls these while the
        // run executes, so a 20-minute job is not a black box until it ends.
        // Secret scrubbing happens at finalisation; partial logs are only ever
        // shown to the owner who could read the sandbox anyway, and the final
        // write overwrites them scrubbed.
        if (body.partial) {
          const { data: session } = await supabaseAdmin
            .from("notebook_runtime_sessions")
            .select("etl_run_id, inputs")
            .eq("id", claims.sid)
            .eq("user_id", claims.sub)
            .maybeSingle();
          if (session?.etl_run_id && typeof body.logs === "string") {
            await import("@/utils/etl/service.server")
              .then((m) => m.appendPartialLogs(session.etl_run_id as string, body.logs as string))
              .catch(() => {});
          }
          if (session?.etl_run_id && body.progress && typeof body.progress === "object") {
            await import("@/utils/etl/service.server")
              .then((m) =>
                m.recordEtlProgress(
                  session.etl_run_id as string,
                  body.progress as Record<string, unknown>,
                ),
              )
              .catch(() => {});
          }
          const mlStash = (await import("@/utils/ml/types")).mlJobStashOf(session?.inputs);
          if (mlStash && typeof body.logs === "string") {
            await (
              mlStash.kind === "predict"
                ? import("@/utils/ml/predict.server").then((m) =>
                    m.appendPredictionLogs(mlStash.job_id, body.logs as string),
                  )
                : import("@/utils/ml/train.server").then((m) =>
                    m.appendMlPartialLogs(mlStash.job_id, body.logs as string),
                  )
            ).catch(() => {});
          }
          const sqStash = (await import("@/utils/lakehouse/sparkQuery.server")).sparkQueryStashOf(
            session?.inputs,
          );
          if (sqStash && typeof body.logs === "string") {
            await import("@/utils/lakehouse/sparkQuery.server")
              .then((m) => m.appendSparkQueryLogs(sqStash.query_id, body.logs as string))
              .catch(() => {});
          }
          return json(200, { ok: true });
        }

        const status = body.status === "error" ? "error" : "succeeded";
        // Scope the write to exactly the token's session + user.
        const { data: updated, error } = await supabaseAdmin
          .from("notebook_runtime_sessions")
          .update({
            status,
            result: (body.result ?? null) as never,
            logs: typeof body.logs === "string" ? body.logs.slice(0, 200_000) : null,
            error: typeof body.error === "string" ? body.error.slice(0, 4000) : null,
            stopped_at: new Date().toISOString(),
          })
          .eq("id", claims.sid)
          .eq("user_id", claims.sub)
          .eq("kind", "batch")
          .select("etl_run_id, inputs, container_ref")
          .maybeSingle();
        if (error) return json(500, { error: error.message });

        // A batch session executing an ETL run also finalises that run:
        // outcome + scrubbed logs onto etl_runs, pipeline summary, post-run
        // catalog crawl, failure notification. Errors there must not make the
        // sandbox retry its callback — the session result above is already
        // durable, so log and acknowledge.
        if (updated?.etl_run_id) {
          await import("@/utils/etl/service.server")
            .then((m) =>
              m.finalizeEtlRun(updated.etl_run_id as string, {
                status: body.status ?? "succeeded",
                result: body.result,
                logs: typeof body.logs === "string" ? body.logs : "",
                error: typeof body.error === "string" ? body.error : null,
              }),
            )
            .catch((e) => console.warn("[etl] finalize failed:", (e as Error).message));
        }
        // Likewise a training job: the version, the audit row and the
        // structured log line all come from this one callback.
        const mlStash = (await import("@/utils/ml/types")).mlJobStashOf(updated?.inputs);
        if (mlStash) {
          const outcome = {
            status: body.status ?? "succeeded",
            result: body.result,
            logs: typeof body.logs === "string" ? body.logs : "",
            error: typeof body.error === "string" ? body.error : null,
          };
          await (
            mlStash.kind === "predict"
              ? import("@/utils/ml/predict.server").then((m) =>
                  m.finalizePrediction(mlStash.job_id, outcome),
                )
              : import("@/utils/ml/train.server").then((m) =>
                  // The shard rides in the session's own stash, so a worker
                  // cannot claim to be a different one than it was started as.
                  m.finalizeMlJob(mlStash.job_id, outcome, mlStash.shard, mlStash.phase),
                )
          ).catch((e) => console.warn("[ml] finalize failed:", (e as Error).message));
        }
        // And a lakehouse query on Spark: its rows, or the reason there are none.
        const sqStash = (await import("@/utils/lakehouse/sparkQuery.server")).sparkQueryStashOf(
          updated?.inputs,
        );
        if (sqStash) {
          await import("@/utils/lakehouse/sparkQuery.server")
            .then((m) =>
              m.finalizeSparkQuery(sqStash.query_id, {
                status: body.status ?? "succeeded",
                result: body.result,
                logs: typeof body.logs === "string" ? body.logs : "",
                error: typeof body.error === "string" ? body.error : null,
              }),
            )
            .catch((e) => console.warn("[sparkq] finalize failed:", (e as Error).message));
        }

        // FOUND FROM THE SURVEY (R94). This callback is how a batch sandbox
        // ends NORMALLY - an ETL run, a training worker, a prediction, a Spark
        // query - and the write above is what makes its row terminal. From
        // that moment refreshSession returns at its first line and the reaper
        // skips the row, so nothing left anywhere will remove the container.
        // R93 taught the refresher to tear down what it finds; it never finds
        // these, because they are terminal before it looks. MEASURED: 122 of
        // the survey host's 139 leftovers had `Exited (0)`, which is this.
        //
        // Last, after every finalisation above, because those read `updated`
        // and the logs are already stored on the row - the container has
        // nothing left in it worth keeping.
        if (updated?.container_ref) {
          const ref = updated.container_ref as string;
          const { getRuntimeSettings } = await import("@/utils/notebookRuntime/config.server");
          const { getOrchestrator } = await import("@/utils/notebookRuntime/orchestrator");
          const teardown = await getRuntimeSettings()
            .then((s) => getOrchestrator(s))
            .then((orch) => orch.stop(ref))
            .catch((e) => ({ removed: false, error: (e as Error).message }));
          if (!teardown.removed) {
            console.warn(
              `[runtime] session ${claims.sid} reported ${status} but its sandbox ${ref} was not removed: ${teardown.error}; it is still on this host and nothing else will look for it`,
            );
          }
        }
        return json(200, { ok: true });
      },
    },
  },
});
