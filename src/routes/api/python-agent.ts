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
// Auth accepts a Supabase user JWT (browser/Pyodide) or a notebook-runtime
// session token (server kernel); either way the caller may only reach agents
// and swarms they own.
import { createFileRoute } from "@tanstack/react-router";
import { resolvePythonCaller } from "@/utils/notebookRuntime/caller.server";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Absolute origin for internal self-calls. Never derived from the request Host
 *  header — that is attacker-controlled and has leaked credentials before. */
function internalOrigin(): string {
  return (process.env.PUBLIC_APP_URL || process.env.SITE_URL || "http://localhost:8080").replace(
    /\/+$/,
    "",
  );
}

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
          if (agents.error) return json(500, { error: agents.error.message });
          return json(200, {
            agents: agents.data ?? [],
            swarms: swarms.error ? [] : (swarms.data ?? []),
          });
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

          const auth = request.headers.get("authorization") ?? "";
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

          // Delegate to /api/chat so the agent runs with its real prompt, tools,
          // knowledge, memory and guardrails — reimplementing any of that here
          // would drift from what the same agent does everywhere else.
          const resp = await fetch(`${internalOrigin()}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: auth },
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
              origin: internalOrigin(),
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

/** Pull the assistant text out of an OpenAI-style SSE transcript. */
function collapseSse(raw: string): string {
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
  // A non-SSE body (some providers answer plain JSON) falls through unchanged.
  return out || raw;
}
