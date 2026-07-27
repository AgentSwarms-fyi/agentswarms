// POST /api/skills/generate
// Authenticated endpoint that asks an LLM to draft a structured skill.md
// from a short user brief. Returns { name, description, body, tags } so the
// SkillEditorDialog can pre-fill the manual form.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import {
  resolveOpenAICompatTransport,
  getProviderDefaultModel,
} from "@/utils/providers/credentials.server";
import { isBiCompatProvider } from "@/utils/providers/modelChoice";
import type { ProviderId } from "@/utils/providers/types";

// Last-resort model when the caller picked a provider but no model and the
// integration carries no default. Only meaningful for OpenRouter.
const FALLBACK_MODEL = "openai/gpt-4o-mini";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const SYSTEM_PROMPT = `You are AgentSwarms' Skill Author. The user gives you a short brief describing a capability they want an AI agent to have. You must produce ONE focused "skill.md" — an Anthropic-style markdown file that teaches an LLM agent **when** and **how** to apply this capability.

A great skill is:
- Narrow (one job, not ten).
- Operational (numbered steps the agent can follow).
- Honest (says what NOT to do).

You MUST call the \`emit_skill\` tool exactly once. Do not write any text outside the tool call.

The body MUST contain, in order:
1. A YAML frontmatter block with \`name\` and \`description\`.
2. \`## When to use\` — when this skill should activate.
3. \`## Instructions\` — numbered steps the agent must follow.
4. \`## Examples\` — at least one short worked example.
5. \`## Constraints\` — bulleted list of rules the agent must NOT break.

Tags should be 1-4 short lowercase keywords (e.g. "engineering", "support").`;

export const Route = createFileRoute("/api/skills/generate")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: corsHeaders }),
      POST: async ({ request }) => {
        try {
          const auth = request.headers.get("authorization") || "";
          const token = auth.replace(/^Bearer\s+/i, "");
          if (!token) return json({ error: "Unauthorized" }, 401);

          // Verify the caller — RLS would block any DB write anyway, but we
          // also gate the AI call so anonymous traffic can't burn credits.
          const userClient = createClient(
            import.meta.env.VITE_SUPABASE_URL!,
            import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY!,
            { global: { headers: { Authorization: `Bearer ${token}` } } },
          );
          const {
            data: { user },
          } = await userClient.auth.getUser();
          if (!user) return json({ error: "Unauthorized" }, 401);

          const body = (await request.json().catch(() => ({}))) as {
            brief?: unknown;
            provider?: unknown;
            model?: unknown;
          };
          const brief = typeof body.brief === "string" ? body.brief.trim() : "";
          if (!brief) return json({ error: "brief is required" }, 400);
          if (brief.length > 2000) return json({ error: "brief is too long" }, 400);

          // BYOK: the caller chooses which of THEIR connected integrations
          // drafts the skill. OpenRouter stays the default because it is the
          // zero-config path with an operator env fallback.
          const provider =
            typeof body.provider === "string" && body.provider ? body.provider : "openrouter";
          if (!isBiCompatProvider(provider)) {
            return json({ error: `Provider "${provider}" can't be used to generate skills.` }, 400);
          }

          const transport = await resolveOpenAICompatTransport({
            userId: user.id,
            provider: provider as ProviderId,
          });
          if (!transport || (!transport.apiKey && provider !== "ollama")) {
            return json(
              {
                error:
                  `${provider} isn't configured. Connect it under Integrations` +
                  (provider === "openrouter"
                    ? " (or ask the operator to set OPENROUTER_API_KEY)."
                    : "."),
              },
              503,
            );
          }

          // Model precedence: explicit choice → the integration's default →
          // the OpenRouter-only fallback.
          let model = typeof body.model === "string" && body.model ? body.model : "";
          if (!model)
            model = (await getProviderDefaultModel(user.id, provider as ProviderId)) ?? "";
          if (!model && provider === "openrouter") model = FALLBACK_MODEL;
          if (!model) {
            return json(
              { error: `Choose a model — ${provider} has no default model configured.` },
              400,
            );
          }

          const resp = await fetch(transport.endpointUrl, {
            method: "POST",
            headers: {
              ...(transport.apiKey ? { Authorization: `Bearer ${transport.apiKey}` } : {}),
              "Content-Type": "application/json",
              ...(transport.organizationId
                ? { "OpenAI-Organization": transport.organizationId }
                : {}),
              ...(transport.extraHeaders ?? {}),
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: `Brief:\n${brief}` },
              ],
              tools: [
                {
                  type: "function",
                  function: {
                    name: "emit_skill",
                    description: "Return the structured skill draft.",
                    parameters: {
                      type: "object",
                      properties: {
                        name: { type: "string", description: "Short title, max 6 words." },
                        description: {
                          type: "string",
                          description: "One sentence describing what the skill teaches.",
                        },
                        body: {
                          type: "string",
                          description:
                            "The full skill.md markdown including frontmatter and the When to use / Instructions / Examples / Constraints sections.",
                        },
                        tags: {
                          type: "array",
                          items: { type: "string" },
                          description: "1-4 short lowercase keywords.",
                        },
                      },
                      required: ["name", "description", "body", "tags"],
                      additionalProperties: false,
                    },
                  },
                },
              ],
              tool_choice: { type: "function", function: { name: "emit_skill" } },
            }),
          });

          if (resp.status === 429) {
            return json({ error: "Rate limited — please try again in a minute." }, 429);
          }
          if (resp.status === 402) {
            return json(
              { error: `Payment required from ${provider} — check the credit on that account.` },
              402,
            );
          }
          if (!resp.ok) {
            const txt = await resp.text();
            console.error("Skill generation gateway error:", resp.status, txt);
            return json({ error: "AI gateway error" }, 502);
          }

          const data = (await resp.json()) as {
            choices?: Array<{
              message?: {
                tool_calls?: Array<{
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };

          const call = data.choices?.[0]?.message?.tool_calls?.[0];
          if (!call?.function?.arguments) {
            return json({ error: "No skill returned" }, 502);
          }

          let parsed: { name: string; description: string; body: string; tags: string[] };
          try {
            parsed = JSON.parse(call.function.arguments);
          } catch {
            return json({ error: "Malformed skill payload" }, 502);
          }

          return json({
            name: String(parsed.name || "").slice(0, 80),
            description: String(parsed.description || "").slice(0, 200),
            body: String(parsed.body || ""),
            tags: Array.isArray(parsed.tags)
              ? parsed.tags.filter((t) => typeof t === "string").slice(0, 6)
              : [],
          });
        } catch (e) {
          console.error("Skill generation failed:", e);
          return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
        }
      },
    },
  },
});
