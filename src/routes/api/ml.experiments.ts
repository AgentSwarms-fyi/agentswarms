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
import { MAX_KEYS_PER_RUN, MAX_RUNS_PER_EXPERIMENT } from "@/lib/experiments";
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
        if ("checkFailed" in caller) return json({ error: caller.checkFailed }, 503);

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
        //
        // FOUND IN R316. Each read the run, merged what it was sent onto what
        // it had read, and wrote the result over whatever the run held by
        // then: twenty metrics logged from twenty threads kept five. And
        // `finish` wrote every field it could be sent, so the `finish()` at the
        // end of `with start_run(...)`, which sends no artifact, wrote null
        // over the model `save_model` had just recorded. Both now go through
        // one statement that locks the run, merges onto what it holds, and
        // writes only the fields it was given.
        let close: Json | null = null;
        if (body.op === "finish") {
          const fields: Record<string, string | null> = { status: body.status ?? "finished" };
          if (body.error !== undefined) fields.error = body.error;
          if (body.notes !== undefined) fields.notes = body.notes;
          // The artifact is a pair: sending either half replaces both.
          if (body.artifact_uri !== undefined || body.artifact_sha256 !== undefined) {
            fields.artifact_uri = body.artifact_uri ?? null;
            fields.artifact_sha256 = body.artifact_sha256 ?? null;
          }
          close = fields;
        }
        const { data: wrote, error } = await supabaseAdmin.rpc("ml_experiment_run_write", {
          p_run_id: body.run_id,
          p_user_id: caller.userId,
          p_params: (body.op === "log" ? body.params : undefined) ?? {},
          p_metrics: body.metrics ?? {},
          p_max_keys: MAX_KEYS_PER_RUN,
          ...(close ? { p_close: close } : {}),
        });
        if (error) return json({ error: error.message }, 400);
        const answer = (wrote ?? {}) as {
          ok?: boolean;
          error?: "missing" | "closed" | "too_many";
          status?: string;
          what?: string;
          count?: number;
        };
        if (answer.ok) return json({ ok: true });
        if (answer.error === "missing") return json({ error: "Run not found" }, 404);
        if (answer.error === "closed") {
          return json({ error: `That run already ${answer.status}` }, 409);
        }
        if (answer.error === "too_many") {
          return json(
            {
              error: `A run may hold ${MAX_KEYS_PER_RUN} ${answer.what}; this would make ${answer.count}`,
            },
            400,
          );
        }
        return json({ error: "The run could not be written" }, 500);
      },
    },
  },
});
