// Running saved agents and swarms from Developer-workspace notebooks.
//
// The notebook helper could already call raw models and search knowledge bases,
// but not the AGENTS you had actually built — so a notebook could not reuse the
// prompt, tools, knowledge and guardrails that make an agent an agent, and
// people re-implemented them badly in Python instead.
//
// Every call is brokered here rather than executed in the kernel: provider keys
// never enter the sandbox, and the run is governed exactly like any other —
// IAM model rules, budgets, guardrails and traces all apply because this
// delegates to the same paths the rest of the platform uses.
//
// Auth accepts a Supabase user JWT or a notebook-runtime
// session token (server kernel); either way the caller may only reach agents
// and swarms they own.
import { createFileRoute } from "@tanstack/react-router";
import { resolvePythonCaller } from "@/utils/notebookRuntime/caller.server";
import { resolveInternalOrigin } from "@/utils/internalOrigin.server";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The origin comes from utils/internalOrigin.server, which every other headless
// path already uses. This file had its own copy of that function, and the copy
// had drifted: it fell back to localhost:8080 rather than 127.0.0.1:8080, and
// it skipped the `^https?://` validation, so a PUBLIC_APP_URL of "example.com"
// (no scheme) produced "example.com/api/chat" and a failed fetch instead of
// falling back to loopback. Same reasoning about the Host header, one
// implementation.

export const Route = createFileRoute("/api/python-agent")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await resolvePythonCaller(request);
        if (!caller) return json(401, { error: "Sign in to run agents from a notebook" });

        let body: {
          action?: string;
          agent_id?: string;
          swarm_id?: string;
          prompt?: string;
          input?: string;
          inputs?: Record<string, unknown>;
          history?: { role?: string; content?: string }[];
        };
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }

        const action = (body.action || "run_agent").toLowerCase();
        // Session-token callers get a service-role client, so ownership has to
        // be pinned explicitly; JWT callers are already RLS-scoped.
        const ownerId = caller.scopeUserId ?? caller.userId;

        // ── list: what this user can run ──
        if (action === "list") {
          const [agents, swarms] = await Promise.all([
            caller.sb.from("agents").select("id, name, description").eq("user_id", ownerId),
            caller.sb.from("swarms").select("id, name, description").eq("user_id", ownerId),
          ]);
          // Both failures are reported. Returning [] for a failed swarms query
          // while 500-ing on a failed agents query told the notebook "you have
          // no swarms" when the truth was "the query did not run" — and the
          // caller's next line is usually a lookup by name against that list.
          if (agents.error) return json(500, { error: agents.error.message });
          if (swarms.error) return json(500, { error: swarms.error.message });
          return json(200, { agents: agents.data ?? [], swarms: swarms.data ?? [] });
        }

        // ── run_agent: one turn against a saved agent ──
        if (action === "run_agent") {
          const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          if (!agentId) return json(400, { error: "agent_id is required" });
          if (!prompt) return json(400, { error: "prompt is required" });

          // Confirm ownership before spending anything. A service-role client
          // would otherwise happily read someone else's agent.
          const { data: agent, error } = await caller.sb
            .from("agents")
            .select("id, user_id")
            .eq("id", agentId)
            .eq("user_id", ownerId)
            .maybeSingle();
          if (error) return json(500, { error: error.message });
          if (!agent) return json(404, { error: "Agent not found" });

          const messages = [
            ...(Array.isArray(body.history)
              ? body.history
                  .filter((m) => m && typeof m.content === "string")
                  .map((m) => ({
                    role: m.role === "assistant" ? "assistant" : "user",
                    content: String(m.content),
                  }))
              : []),
            { role: "user", content: prompt },
          ];

          // KNOWN LIMITATION, stated rather than papered over.
          //
          // This delegates to /api/chat so the agent runs with its real prompt,
          // tools, knowledge, memory and guardrails — reimplementing any of
          // that here would drift from what the same agent does everywhere
          // else. The delegation forwards the caller's Authorization header,
          // which works for a Supabase JWT and cannot work for a notebook
          // SESSION TOKEN: /api/chat verifies a JWT or the internal-run secret,
          // and a session token is neither. So a kernel got a bare
          // "Agent run failed (401)" with nothing explaining why.
          //
          // AND THE SESSION TOKEN IS THE ONLY CALLER. A first pass at this
          // described the JWT path as the working one and pointed users at the
          // in-browser runtime instead — but that runtime was removed (see
          // routes/_authenticated/notebooks.tsx), and the sole caller of
          // run_agent is docker/notebook-runtime/agentswarms_helper.py, which
          // authenticates with AGENTSWARMS_TOKEN. So run_agent has never worked
          // from a notebook at all; it is not a gap for one caller type.
          //
          // The obvious repair — call the internal channel with
          // x-internal-run-secret + internalUserId, the way scheduled and
          // deployed swarm runs do — is WRONG here, and quietly so. In
          // /api/chat the agent-config load is gated on `authToken`
          // (`if (body.agentId && authToken)`), so on the internal channel the
          // agent's name, tools, guardrails and skills are never read. An
          // earlier version of this note also cited retrieveCitations and the
          // auto-RAG path; retrieveCitations was dead code and has since been
          // deleted, and auto-RAG runs through retrieveCitationsServer, which
          // takes an explicit scope. One blocker, not three — the conclusion
          // is unchanged, because it is the load-bearing one.
          // On the internal channel agentId is accepted and
          // ignored, so the call would succeed and answer from a bare default
          // model with no prompt, no tools and no knowledge base. Turning a
          // visible 401 into a plausible-looking wrong answer is worse than the
          // bug.
          //
          // Supporting it properly means teaching that branch to use the
          // service-role client scoped to internalUserId (the idiom already
          // used for iamSb in chat.ts) — a change to an auth-sensitive path,
          // where every converted query loses its RLS narrowing and needs an
          // explicit user_id filter instead. Miss one and it is a cross-tenant
          // read in the busiest route in the app.
          //
          // WEIGHED AND DECLINED, rather than left as an open TODO:
          //
          //   * It has never worked from a notebook, so nothing regressed and
          //     nobody is waiting on a restoration.
          //   * run_swarm covers the use case. A one-node swarm runs a saved
          //     agent with its real prompt, tools and knowledge, because the
          //     builder SNAPSHOTS an imported agent into the node rather than
          //     referencing it (see importFromLibrary in NodeInspector) — so
          //     the wrapper is a faithful copy, not an approximation.
          //   * What is genuinely lost is liveness: a snapshot does not follow
          //     later edits to the agent. That is the whole delta, and it does
          //     not justify touching this path.
          //
          // Revisit if "always the current agent, from a notebook" becomes a
          // real requirement. Until then this fails immediately and points at
          // the thing that works.
          if (caller.scopeUserId) {
            return json(501, {
              error:
                "run_agent is not available from a notebook: the kernel authenticates with a " +
                "runtime session token, and /api/chat accepts only a user JWT or the internal-run " +
                "secret. Use run_swarm instead — it executes in-process. To run one saved agent, " +
                "wrap it in a single-node swarm: importing an agent onto a node copies its prompt, " +
                "model, tools and knowledge base, so the run is faithful to the agent as it was " +
                "when you imported it.",
            });
          }
          const resp = await fetch(`${resolveInternalOrigin()}/api/chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: request.headers.get("authorization") ?? "",
            },
            body: JSON.stringify({ agentId, messages, stream: false }),
          });
          const text = await resp.text();
          if (!resp.ok) {
            return json(resp.status === 402 ? 402 : 502, {
              error: `Agent run failed (${resp.status})`,
              detail: text.slice(0, 500),
            });
          }
          // /api/chat answers as SSE; collapse it to the plain reply the
          // notebook actually wants.
          return json(200, { output: collapseSse(text) });
        }

        // ── run_swarm: execute a saved swarm end to end ──
        if (action === "run_swarm") {
          const swarmId = typeof body.swarm_id === "string" ? body.swarm_id.trim() : "";
          const input = typeof body.input === "string" ? body.input : (body.prompt ?? "");
          if (!swarmId) return json(400, { error: "swarm_id is required" });

          // One query does ownership and the graph: the executor takes the
          // swarm itself, and filtering on user_id here is what stops a
          // service-role caller reaching another tenant's graph.
          const { data: full, error } = await caller.sb
            .from("swarms")
            .select("id, name, nodes, edges")
            .eq("id", swarmId)
            .eq("user_id", ownerId)
            .maybeSingle();
          if (error) return json(500, { error: error.message });
          if (!full) return json(404, { error: "Swarm not found" });

          // Typed start-form values arrive as `inputs` and seed flow state, the
          // same way the Run panel and the public API seed it.
          const initialState: Record<string, string> = {};
          for (const [k, v] of Object.entries(body.inputs ?? {})) {
            initialState[k] = typeof v === "string" ? v : JSON.stringify(v);
          }

          const { executeSwarmServer } = await import("@/utils/swarmExecute.server");
          try {
            const result = await executeSwarmServer({
              swarm: full,
              userId: ownerId,
              origin: resolveInternalOrigin(),
              input: String(input ?? ""),
              initialState,
              // A notebook is unattended for approval purposes: nobody is
              // watching the canvas, so a gate would hang the cell until the
              // run timeout rather than ever being decided.
              rejectApprovals: true,
              source: "api",
            });
            if (result.status === "error") {
              return json(502, { error: result.error || "Swarm run failed" });
            }
            return json(200, { output: result.output, runId: result.runId });
          } catch (e) {
            return json(502, { error: (e as Error).message || "Swarm run failed" });
          }
        }

        return json(400, {
          error: `Unknown action "${action}" — use "run_agent", "run_swarm" or "list".`,
        });
      },
    },
  },
});

/** Pull the assistant text out of an OpenAI-style SSE transcript. Exported for
 *  tests: it is the one piece of this route that is pure, and it decides what a
 *  notebook cell prints. */
export function collapseSse(raw: string): string {
  let out = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as {
        choices?: { delta?: { content?: string }; message?: { content?: string } }[];
      };
      const piece =
        parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
      if (typeof piece === "string") out += piece;
    } catch {
      /* keep-alive or a custom event frame — ignore */
    }
  }
  // The fallback is for a body that is NOT SSE — some providers answer plain
  // JSON — and it has to distinguish that from an SSE stream that simply
  // carried no text. `out || raw` could not: an answer whose frames hold only
  // citations, or a guardrail-blocked one, or an empty completion, printed the
  // whole protocol transcript into the notebook cell:
  //
  //   : keep-alive
  //   event: citations
  //   data: {"citations":[{"index":1,"documentName":"policy.pdf"}]}
  //   data: [DONE]
  //
  // An SSE body that produced no text is an empty answer, and says so.
  if (out) return out;
  return /^(?:data|event): /m.test(raw) ? "" : raw;
}
