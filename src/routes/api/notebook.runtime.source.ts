// Source provider for headless sandboxes. A batch kernel or an MCP service
// fetches its own code from here using its session token (never a user JWT),
// scoped to the token's user — so a sandbox can only ever read the code of the
// thing it was started for.
//
// MCP services additionally receive their resolved secret environment here
// rather than as container env vars: a response body is not visible to
// `docker inspect` or in a pod spec, so bound secrets exist only in the
// sandbox process's memory.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifySessionToken } from "@/utils/notebookRuntime/token.server";
import type { LakeManifest } from "@/utils/lakehouse/sandboxLake.server";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Cell = { type?: string; source?: string };

/** Only `{{secret:NAME}}` may become an env value — never a literal. */
const SECRET_BINDING_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(\{\{\s*secret:[A-Za-z][A-Za-z0-9_]*\s*\}\})$/;

/**
 * Code + requirements + resolved secret env for one MCP server.
 *
 * Secret resolution runs as the app's OWNER, which is also the token's subject
 * — the session row was matched on user_id above — so a sandbox cannot reach a
 * secret its owner could not. A binding that fails to resolve is dropped rather
 * than failing the whole start: the server still comes up and the tool that
 * needed it reports a missing variable, which is far easier to diagnose than a
 * container that never starts.
 */
async function mcpAppBundle(appId: string, userId: string): Promise<Response> {
  const { data: app } = await supabaseAdmin
    .from("mcp_apps")
    .select("source_code, requirements, secret_refs")
    .eq("id", appId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!app) return json(404, { error: "MCP server not found" });

  const { resolveSecretRefs } = await import("@/utils/secrets.server");
  const env: Record<string, string> = {};
  for (const binding of app.secret_refs ?? []) {
    const m = SECRET_BINDING_RE.exec(String(binding).trim());
    if (!m) continue;
    try {
      env[m[1]] = await resolveSecretRefs(userId, m[2]);
    } catch {
      /* missing or revoked secret — surfaced inside the tool, not here */
    }
  }

  return json(200, {
    code: app.source_code ?? "",
    requirements: app.requirements ?? "",
    env,
  });
}

type LakeBody = {
  id?: unknown;
  parts?: unknown;
  loads?: unknown;
  cursors?: unknown;
  which?: unknown;
  uri?: unknown;
};

const LAKE_PARTS = new Set([
  "lake_read",
  "lake_stage",
  "lake_commit",
  "lake_cursors",
  "lake_artifact",
]);

/**
 * Pin what this session may do in the lake, when its environment is resolved:
 * the reads and loads its run declared (sandboxLake.server). Every lake_*
 * call is then served from the pin, never from what the sandbox sends. A
 * session whose pin cannot be stored gets no environment.
 */
async function pinLake(
  sessionId: string,
  inputs: unknown,
  lake: unknown,
): Promise<Response | null> {
  if (!lake) return null;
  const base = inputs && typeof inputs === "object" ? (inputs as Record<string, unknown>) : {};
  const { error } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .update({ inputs: { ...base, __lake: lake } as never })
    .eq("id", sessionId);
  return error
    ? json(503, { error: `Could not record this session's lakehouse access: ${error.message}` })
    : null;
}

/** One lake_* call, as the session's owner, from the session's pinned manifest. */
async function lakePart(
  part: string,
  body: LakeBody,
  s: { sessionId: string; userId: string; inputs: unknown; readOnly: boolean; via: string },
): Promise<Response> {
  const lake = await import("@/utils/lakehouse/sandboxLake.server");
  const manifest = lake.lakeManifestOf(s.inputs);
  if (!manifest) {
    return json(409, {
      error: "This session has no lakehouse access recorded; fetch its environment first",
    });
  }
  const id = typeof body.id === "string" ? body.id : "";
  try {
    if (part === "lake_read") {
      return json(
        200,
        await lake.lakeRead({ userId: s.userId, sessionId: s.sessionId, manifest, id, via: s.via }),
      );
    }
    // A URL for one model artifact this run declared. A trainer writes its
    // own and reads none; an assemble step reads its workers'; a prediction
    // and a warm scorer read the version they were asked for.
    if (part === "lake_artifact") {
      const which = body.which === "put" ? "put" : "get";
      if (which === "put" && s.readOnly) {
        return json(403, { error: "A preview reads the lakehouse; it never writes it" });
      }
      return json(
        200,
        lake.lakeArtifact({ manifest, which, uri: typeof body.uri === "string" ? body.uri : "" }),
      );
    }
    if (s.readOnly)
      return json(403, { error: "A preview reads the lakehouse; it never writes it" });
    if (part === "lake_stage") {
      const parts = typeof body.parts === "number" ? body.parts : 1;
      return json(200, lake.lakeStage({ sessionId: s.sessionId, manifest, id, parts }));
    }
    if (part === "lake_commit") {
      const loads = (Array.isArray(body.loads) ? body.loads : []).map((l) => {
        const o = (l ?? {}) as { id?: unknown; batch?: unknown; parts?: unknown; prefix?: unknown };
        return {
          id: typeof o.id === "string" ? o.id : "",
          batch: typeof o.batch === "string" ? o.batch : "",
          parts: typeof o.parts === "number" ? o.parts : 0,
          // A cluster-written load names its batch, not its files: the app
          // lists the prefix (R230). Dropping this flag here sent the load
          // down the numbered-parts path, where it asked for 0 of them.
          prefix: o.prefix === true,
        };
      });
      const cursors: Record<string, string> = {};
      if (body.cursors && typeof body.cursors === "object") {
        for (const [k, v] of Object.entries(body.cursors as Record<string, unknown>)) {
          if (typeof v === "string") cursors[k] = v;
        }
      }
      return json(
        200,
        await lake.lakeCommit({
          userId: s.userId,
          sessionId: s.sessionId,
          manifest,
          loads,
          cursors,
          via: s.via,
        }),
      );
    }
    return json(200, { cursors: await lake.lakeCursors(manifest) });
  } catch (e) {
    return json(400, { error: (e as Error).message });
  }
}

async function handle(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  const claims = await verifySessionToken(token);
  if (!claims) return json(401, { error: "Invalid or expired session token" });

  const { data: session } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("notebook_id, mcp_app_id, etl_run_id, entrypoint, inputs")
    .eq("id", claims.sid)
    .eq("user_id", claims.sub)
    .maybeSingle();

  // ETL batch sessions have two parts: the default returns the run's script
  // (prelude + pinned code); {"part":"etl_env"} returns the resolved secret
  // env + pip requirements. Split so credentials never ride inside code text —
  // the same reasoning as the MCP bundle's env field, one step further.
  if (session?.etl_run_id) {
    let part = "";
    let tableId = "";
    let cursor: string | null = null;
    let consume = false;
    let lakeBody: LakeBody = {};
    try {
      const body = (await request.json()) as {
        part?: string;
        table_id?: string;
        cursor?: string | null;
        consume?: boolean;
      } & LakeBody;
      part = body?.part ?? "";
      tableId = typeof body?.table_id === "string" ? body.table_id : "";
      cursor = typeof body?.cursor === "string" ? body.cursor : null;
      consume = body?.consume === true;
      lakeBody = body ?? {};
    } catch {
      /* empty body = default part */
    }
    if (LAKE_PARTS.has(part)) {
      return lakePart(part, lakeBody, {
        sessionId: claims.sid,
        userId: claims.sub,
        inputs: session.inputs,
        readOnly: false,
        via: `etl_run:${session.etl_run_id}`,
      });
    }
    const etl = await import("@/utils/etl/service.server");
    if (part === "etl_ingest") {
      const { data: run } = await supabaseAdmin
        .from("etl_runs")
        .select("pipeline_id")
        .eq("id", session.etl_run_id)
        .maybeSingle();
      const out = run
        ? await etl.etlIngestFor(run.pipeline_id, claims.sub, { cursor, consume })
        : { error: "ETL run not found for this session" };
      return "error" in out ? json(404, out) : json(200, out);
    }
    if (part === "etl_env") {
      const out = await etl.etlEnvFor(session.etl_run_id, claims.sub, claims.sid);
      if ("error" in out) return json(404, out);
      const { lake, ...rest } = out;
      return (await pinLake(claims.sid, session.inputs, lake)) ?? json(200, rest);
    }
    const out =
      part === "etl_dataset"
        ? await etl.etlDatasetFor(tableId, claims.sub)
        : await etl.etlBundleFor(session.etl_run_id, claims.sub);
    return "error" in out ? json(404, out) : json(200, out);
  }

  // A warm scorer: the model and version ride in the session's inputs, and it
  // fetches the scoring program once at start rather than per request.
  {
    const serve = await import("@/utils/ml/serve.server");
    const stash = serve.mlScoreStashOf(session?.inputs);
    if (stash) {
      // One call: the program and its config. A scorer fetches this once, at
      // start, and asks for a URL to its model's artifact when it loads it.
      const out = await serve.mlScoreBundleFor(stash, claims.sub);
      if ("error" in out) return json(404, out);
      const { lake, ...rest } = out;
      return (await pinLake(claims.sid, session?.inputs, lake)) ?? json(200, rest);
    }
  }

  // ETL node previews: no run row — the pipeline + node ride in the session's
  // inputs, and the bundle is compiled fresh (sampled sources, no loads).
  {
    const etl = await import("@/utils/etl/service.server");
    const stash = etl.etlPreviewStashOf(session?.inputs);
    if (stash) {
      let part = "";
      let tableId = "";
      let lakeBody: LakeBody = {};
      try {
        const body = (await request.json()) as { part?: string; table_id?: string } & LakeBody;
        part = body?.part ?? "";
        tableId = typeof body?.table_id === "string" ? body.table_id : "";
        lakeBody = body ?? {};
      } catch {
        /* empty body = default part */
      }
      if (LAKE_PARTS.has(part)) {
        return lakePart(part, lakeBody, {
          sessionId: claims.sid,
          userId: claims.sub,
          inputs: session?.inputs,
          readOnly: true,
          via: `etl_preview:${stash.pipeline_id}`,
        });
      }
      if (part === "etl_env") {
        const out = await etl.etlPreviewEnvFor(stash, claims.sub);
        if ("error" in out) return json(404, out);
        const { lake, ...rest } = out;
        return (await pinLake(claims.sid, session?.inputs, lake)) ?? json(200, rest);
      }
      const out =
        part === "etl_ingest"
          ? // Previews read the backlog without consuming, whatever the flag says.
            await etl.etlIngestFor(stash.pipeline_id, claims.sub, { consume: false })
          : part === "etl_dataset"
            ? await etl.etlDatasetFor(tableId, claims.sub)
            : await etl.etlPreviewBundleFor(stash, claims.sub);
      return "error" in out ? json(404, out) : json(200, out);
    }
  }

  // ML training jobs: no run row either — the job id rides in the session's
  // inputs; the program is pinned server-side and the env resolved as the
  // model's owner. Same two parts as ETL so the prelude is shared verbatim.
  {
    const ml = await import("@/utils/ml/types");
    const stash = ml.mlJobStashOf(session?.inputs);
    if (stash) {
      let part = "";
      let lakeBody: LakeBody = {};
      try {
        const body = (await request.json()) as { part?: string } & LakeBody;
        part = body?.part ?? "";
        lakeBody = body ?? {};
      } catch {
        /* empty body = default part */
      }
      if (LAKE_PARTS.has(part)) {
        return lakePart(part, lakeBody, {
          sessionId: claims.sid,
          userId: claims.sub,
          inputs: session?.inputs,
          readOnly: false,
          via: `ml_${stash.kind ?? "train"}:${stash.job_id}`,
        });
      }
      let out:
        | { code: string }
        | { env: Record<string, string>; requirements: string[]; lake?: LakeManifest }
        | { error: string };
      if (stash.kind === "predict") {
        const m = await import("@/utils/ml/predict.server");
        out =
          part === "etl_env"
            ? await m.mlPredictEnvFor(stash, claims.sub)
            : await m.mlPredictBundleFor(stash, claims.sub, session?.inputs);
      } else {
        const m = await import("@/utils/ml/train.server");
        out =
          part === "etl_env"
            ? await m.mlEnvFor(stash, claims.sub)
            : await m.mlBundleFor(stash, claims.sub);
      }
      if ("error" in out) return json(404, out);
      if ("lake" in out) {
        const { lake, ...rest } = out;
        return (await pinLake(claims.sid, session?.inputs, lake)) ?? json(200, rest);
      }
      return json(200, out);
    }
  }

  // A lakehouse query on Spark: the query id rides in the session's inputs;
  // the program is compiled from the governed plan and the env resolved as
  // the query's owner. Same two parts as ETL so the prelude is shared verbatim.
  {
    const sq = await import("@/utils/lakehouse/sparkQuery.server");
    const stash = sq.sparkQueryStashOf(session?.inputs);
    if (stash) {
      let part = "";
      try {
        const body = (await request.json()) as { part?: string };
        part = body?.part ?? "";
      } catch {
        /* empty body = default part */
      }
      // A failed read of the query row is a 503, not the 404 an absent one
      // is (R222).
      let out:
        | Awaited<ReturnType<typeof sq.sparkQueryEnvFor>>
        | Awaited<ReturnType<typeof sq.sparkQueryBundleFor>>;
      try {
        out =
          part === "etl_env"
            ? await sq.sparkQueryEnvFor(stash, claims.sub)
            : await sq.sparkQueryBundleFor(stash, claims.sub);
      } catch (e) {
        return json(503, { error: (e as Error).message });
      }
      return "error" in out ? json(404, out) : json(200, out);
    }
  }

  if (session?.mcp_app_id) return mcpAppBundle(session.mcp_app_id, claims.sub);

  if (!session?.notebook_id) return json(404, { error: "No notebook bound to this session" });

  const { data: nb } = await supabaseAdmin
    .from("user_python_notebooks")
    .select("cells")
    .eq("id", session.notebook_id)
    .eq("user_id", claims.sub)
    .maybeSingle();
  if (!nb) return json(404, { error: "Notebook not found" });

  const cells = Array.isArray(nb.cells) ? (nb.cells as Cell[]) : [];
  const code = cells
    .filter((c) => c && c.type === "code" && typeof c.source === "string")
    .map((c) => c.source)
    .join("\n\n");

  return json(200, { code, entrypoint: session.entrypoint ?? null });
}

export const Route = createFileRoute("/api/notebook/runtime/source")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
    },
  },
});
