// Source provider for batch jobs. A headless batch kernel fetches the code of
// its notebook from here using its session token (never a user JWT). Returns
// the concatenated code cells of the session's notebook, scoped to the token's
// user — so a job can only ever read its own notebook's code.
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

async function handle(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  const claims = verifySessionToken(token);
  if (!claims) return json(401, { error: "Invalid or expired session token" });

  const { data: session } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("notebook_id, entrypoint")
    .eq("id", claims.sid)
    .eq("user_id", claims.sub)
    .maybeSingle();
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
