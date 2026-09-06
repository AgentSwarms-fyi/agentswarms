// Experiment logging, for anything that can reach the platform: a notebook
// with its session token, a script with a user token.
//
// Authenticated by `resolvePythonCaller`, which is the same door the in-sandbox
// helper already uses for knowledge bases and models — so a kernel logging a
// run proves it is that user's kernel, and never carries a key of its own.
//
// Deliberately small. One endpoint, three operations, flat maps of numbers and
// strings. A tracking API that needed a schema is one nobody logs to from the
// middle of a training loop.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { MAX_RUNS_PER_EXPERIMENT, mergeCapped, type ScalarMap } from "@/lib/experiments";
import { resolvePythonCaller } from "@/utils/notebookRuntime/caller.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** A parameter or a metric: a name and a scalar. Nothing nested. */
const SCALARS = z.record(
  z.string().min(1).max(120),
  z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
);

const schema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("start"),
    experiment: z.string().trim().min(1).max(120),
    name: z.string().trim().max(200).optional(),
    params: SCALARS.optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    model_id: z.string().uuid().optional(),
  }),
  z.object({
    op: z.literal("log"),
    run_id: z.string().uuid(),
    params: SCALARS.optional(),
    metrics: SCALARS.optional(),
  }),
  z.object({
    op: z.literal("finish"),
    run_id: z.string().uuid(),
    status: z.enum(["finished", "failed"]).optional(),
    metrics: SCALARS.optional(),
    error: z.string().max(4000).optional(),
    notes: z.string().max(4000).optional(),
    artifact_uri: z.string().max(1000).optional(),
    artifact_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
]);

export const Route = createFileRoute("/api/ml/experiments")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await resolvePythonCaller(request);
        if (!caller) return json({ error: "Not signed in" }, 401);

        let body: z.infer<typeof schema>;
        try {
          body = schema.parse(await request.json());
        } catch (e) {
          return json({ error: (e as Error).message.slice(0, 500) }, 400);
        }

        if (body.op === "start") {
          // The experiment is created on first use. Naming one before logging
          // to it is a step nobody takes from inside a training loop.
          const { data: found } = await supabaseAdmin
            .from("ml_experiments")
            .select("id")
            .eq("user_id", caller.userId)
            .eq("name", body.experiment)
            .maybeSingle();
          let experimentId = found?.id as string | undefined;
          if (!experimentId) {
            const { data: made, error } = await supabaseAdmin
              .from("ml_experiments")
              .insert({
                user_id: caller.userId,
                name: body.experiment,
                model_id: body.model_id ?? null,
              })
              .select("id")
              .single();
            if (error) return json({ error: error.message }, 400);
            experimentId = made.id as string;
          }

          const { count } = await supabaseAdmin
            .from("ml_experiment_runs")
            .select("id", { count: "exact", head: true })
            .eq("experiment_id", experimentId);
          if ((count ?? 0) >= MAX_RUNS_PER_EXPERIMENT) {
            return json(
              { error: `${body.experiment} already has ${MAX_RUNS_PER_EXPERIMENT} runs` },
              429,
            );
          }

          const { data: run, error: runErr } = await supabaseAdmin
            .from("ml_experiment_runs")
            .insert({
              experiment_id: experimentId,
              user_id: caller.userId,
              name: body.name ?? null,
              params: body.params ?? {},
              tags: body.tags ?? [],
              // A session token means a sandbox is logging; a user token means
              // something else is. Recorded rather than asked for.
              source: caller.scopeUserId ? "notebook" : "api",
              session_id: caller.sessionId ?? null,
            })
            .select("id")
            .single();
          if (runErr) return json({ error: runErr.message }, 400);
          return json({ run_id: run.id, experiment_id: experimentId });
        }

        // Both remaining operations write to one run, and may only write to a
        // run the caller owns — the id is a uuid, not a capability.
        const { data: run } = await supabaseAdmin
          .from("ml_experiment_runs")
          .select("id, params, metrics, started_at, status")
          .eq("id", body.run_id)
          .eq("user_id", caller.userId)
          .maybeSingle();
        if (!run) return json({ error: "Run not found" }, 404);
        // A finished run is a record of what happened. Late arrivals from a
        // process that outlived its own `finish` would rewrite it.
        if (run.status !== "running") {
          return json({ error: `That run already ${run.status}` }, 409);
        }

        if (body.op === "log") {
          // Merged, not replaced: a loop logging epoch by epoch is the normal
          // case, and each call should add rather than forget.
          const patch: { params?: Json; metrics?: Json } = {};
          if (body.params) {
            const m = mergeCapped(run.params, body.params as ScalarMap, "parameters");
            if ("error" in m) return json({ error: m.error }, 400);
            patch.params = m.value as Json;
          }
          if (body.metrics) {
            const m = mergeCapped(run.metrics, body.metrics as ScalarMap, "metrics");
            if ("error" in m) return json({ error: m.error }, 400);
            patch.metrics = m.value as Json;
          }
          if (Object.keys(patch).length === 0) return json({ ok: true });
          const { error } = await supabaseAdmin
            .from("ml_experiment_runs")
            .update(patch)
            .eq("id", body.run_id);
          if (error) return json({ error: error.message }, 400);
          return json({ ok: true });
        }

        const finalMetrics = mergeCapped(run.metrics, (body.metrics ?? {}) as ScalarMap, "metrics");
        if ("error" in finalMetrics) return json({ error: finalMetrics.error }, 400);

        const finishedAt = new Date();
        const { error } = await supabaseAdmin
          .from("ml_experiment_runs")
          .update({
            status: body.status ?? "finished",
            metrics: finalMetrics.value as Json,
            error: body.error ?? null,
            notes: body.notes ?? null,
            artifact_uri: body.artifact_uri ?? null,
            artifact_sha256: body.artifact_sha256 ?? null,
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() - new Date(run.started_at).getTime(),
          })
          .eq("id", body.run_id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      },
    },
  },
});
