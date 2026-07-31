# Extending agents: skills and tools

Two extension points, from lightest to heaviest:

| You want to…                                            | Use               | Code required |
| ------------------------------------------------------- | ----------------- | ------------- |
| Teach an agent a procedure, style, or domain method     | **Skill**         | none          |
| Give agents a new capability that calls an API / system | **Built-in tool** | one PR        |

## Skills (no code)

A skill is a small markdown file following the Anthropic `skill.md` convention —
front-matter (`name`, `description`) plus **When to use** / **Instructions** /
**Constraints** sections. At chat time, the skills attached to an agent are
composed into its effective system prompt.

- **Create one in the app**: **Skills** page → New skill → write the markdown.
  Stored per-user in `agent_skills` (RLS-scoped).
- **Attach it**: agent builder → Tools → Skills picker (`tools.skillIds` on the
  agent record). Per-request `body.skillIds` overrides it on `/api/chat`.
- **Ship one with the product**: add an entry to
  [`src/lib/sampleSkills.ts`](../src/lib/sampleSkills.ts) with an id prefixed
  `sample:`. Sample skills are read-only, always available to every user, and
  forkable from the Skills page.

Write skills like the built-ins: a crisp _When to use_ (and when NOT), a
numbered procedure, and hard constraints. Skills steer **behaviour**; they
cannot grant new powers — that's what tools are for.

## Built-in tools (one PR)

Everything lives in
[`src/utils/tools/registry.server.ts`](../src/utils/tools/registry.server.ts).
A tool is three things: a **definition** (OpenAI function-call JSON shown to
the model), a **handler** (`(ctx, args) => Promise<string>` — return a JSON
string, never throw), and a **gate** (the registry only advertises tools that
can actually run for this user). To add one:

1. **Define + implement** in `registry.server.ts` — follow `webSearchTool` /
   `runWebSearch`. Return errors as `JSON.stringify({ error })` so a failure
   never traps the tool loop. If the model supplies a URL or other reach-out
   target, validate it (see `assertPublicUrl` — SSRF).
2. **Register** in `resolveAgentTools()`: check the capability really exists
   (an integration row, an env key, at least one table…), then `tools.push` +
   `handlers.set`. Add the id to `TOOLABLE_IDS` so agents/swarm nodes can
   toggle it.
3. **Routing guidance**: add a line in `buildRoutingGuidance()` saying WHEN the
   model should pick your tool over the others. This is what keeps tool choice
   sane once several sources are connected.
4. **Expose the toggle**: add an entry to `BUILT_IN_TOOLS` in
   [`src/components/agents/AgentForm.tsx`](../src/components/agents/AgentForm.tsx)
   (label, description, category) and — if swarms should see it — the label map
   in [`src/lib/swarmExportTools.ts`](../src/lib/swarmExportTools.ts).
5. **Secrets**: never accept raw keys into the client. Per-agent keys go
   through `toolConfigs` (encrypted on the agent record); workspace keys are
   env vars; user-level connections belong on the Integrations page with
   config encrypted at rest (see the Firecrawl connector for the pattern).

The chat route (`/api/chat`) picks all of this up automatically — it calls
`resolveAgentTools()` and appends the routing guidance to the system prompt.
No changes needed there.

## How an agent picks between sources

When several sources are attached (data tables + knowledge bases + web + MCP),
the registry emits **TOOL ROUTING** guidance built from what is actually
enabled — e.g. _sql_query reads only the tables listed in its description; for
external/vendor/current information use web_search_. If you see an agent
reaching for the wrong source, tune `buildRoutingGuidance()` — not the
individual tool descriptions — so the fix applies everywhere at once.
