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

async function handle(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  const claims = await verifySessionToken(token);
  if (!claims) return json(401, { error: "Invalid or expired session token" });

  const { data: session } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("notebook_id, mcp_app_id, entrypoint")
    .eq("id", claims.sid)
    .eq("user_id", claims.sub)
    .maybeSingle();

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
