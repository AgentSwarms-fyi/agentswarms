// POST /api/etl/generate — AI-drafted ETL Python.
//
// Same contract as /api/skills/generate: authenticated, BYOK (the caller picks
// which of THEIR connected providers writes the code, model governance
// applies through the same picker), and the model must answer through a
// forced tool call so the response is structured rather than scraped out of
// prose. Two modes in one endpoint: a fresh draft from a brief, or a refine
// pass over the pipeline's current code.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import {
  resolveOpenAICompatTransport,
  getProviderDefaultModel,
} from "@/utils/providers/credentials.server";
import { isBiCompatProvider } from "@/utils/providers/modelChoice";
import type { ProviderId } from "@/utils/providers/types";

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

const SYSTEM_PROMPT = `You are AgentSwarms' ETL engineer. You write production Python for the platform's pipeline runner.

THE RUNTIME CONTRACT — every script you produce MUST follow it:
- Define \`entrypoint(inputs=None)\` and return a JSON-able metrics dict (at minimum {"rows_loaded": <int>}). The runner calls it and records the return value.
- Top-level code does imports only; all work happens inside entrypoint().
- Load with dlt. The destination is S3-compatible object storage; build it exactly like this:
    import dlt
    from dlt.destinations import filesystem
    dest = filesystem(
        bucket_url=os.environ['ETL_DEST_BUCKET_URL'],
        credentials={
            'aws_access_key_id': os.environ.get('ETL_DEST_ACCESS_KEY_ID', ''),
            'aws_secret_access_key': os.environ.get('ETL_DEST_SECRET_ACCESS_KEY', ''),
            'endpoint_url': os.environ.get('ETL_DEST_ENDPOINT_URL') or None,
        },
    )
- NEVER write a credential literal into the code. Credentials only ever come from os.environ. Extra user-configured variables may exist; reference them with os.environ.get and a clear error if missing.
- Prefer pandas for transforms; ibis (duckdb backend) when SQL fits better.
- Print progress with print(); keep it terse. Print '[etl] ' + json.dumps(metrics) before returning.
- List every pip package the code imports (beyond stdlib) in requirements. dlt needs the filesystem extra: "dlt[filesystem]>=1.3".

You MUST call the \`emit_pipeline\` tool exactly once. No text outside the tool call.`;

export const Route = createFileRoute("/api/etl/generate")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: corsHeaders }),
      POST: async ({ request }) => {
        try {
          const auth = request.headers.get("authorization") || "";
          const token = auth.replace(/^Bearer\s+/i, "");
          if (!token) return json({ error: "Unauthorized" }, 401);

          const userClient = createClient(
            (process.env.SUPABASE_URL || import.meta.env.VITE_SUPABASE_URL)!,
            import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY!,
            { global: { headers: { Authorization: `Bearer ${token}` } } },
          );
          const {
            data: { user },
          } = await userClient.auth.getUser();
          if (!user) return json({ error: "Unauthorized" }, 401);

          const body = (await request.json().catch(() => ({}))) as {
            brief?: unknown;
            current_code?: unknown;
            provider?: unknown;
            model?: unknown;
          };
          const brief = typeof body.brief === "string" ? body.brief.trim() : "";
          if (!brief) return json({ error: "brief is required" }, 400);
          if (brief.length > 4000) return json({ error: "brief is too long" }, 400);
          const currentCode =
            typeof body.current_code === "string" ? body.current_code.slice(0, 60_000) : "";

          const provider =
            typeof body.provider === "string" && body.provider ? body.provider : "openrouter";
          if (!isBiCompatProvider(provider)) {
            return json({ error: `Provider "${provider}" can't be used here.` }, 400);
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

          const userMsg = currentCode
            ? `Refine this pipeline. Instruction:\n${brief}\n\nCurrent code:\n\`\`\`python\n${currentCode}\n\`\`\``
            : `Write a new pipeline. Brief:\n${brief}`;

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
                { role: "user", content: userMsg },
              ],
              tools: [
                {
                  type: "function",
                  function: {
                    name: "emit_pipeline",
                    description: "Return the pipeline draft.",
                    parameters: {
                      type: "object",
                      properties: {
                        code: {
                          type: "string",
                          description: "Complete Python script following the runtime contract.",
                        },
                        requirements: {
                          type: "string",
                          description: "pip requirements, one per line.",
                        },
                        notes: {
                          type: "string",
                          description:
                            "1-3 sentences: what the pipeline does and anything the user must configure (secrets, paths).",
                        },
                      },
                      required: ["code", "requirements", "notes"],
                    },
                  },
                },
              ],
              tool_choice: { type: "function", function: { name: "emit_pipeline" } },
              temperature: 0.2,
              max_tokens: 4000,
            }),
          });
          if (!resp.ok) {
            const detail = (await resp.text()).slice(0, 300);
            return json({ error: `Model call failed (${resp.status}): ${detail}` }, 502);
          }
          const out = (await resp.json()) as {
            choices?: {
              message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] };
            }[];
          };
          const call = out.choices?.[0]?.message?.tool_calls?.find(
            (t) => t.function?.name === "emit_pipeline",
          );
          if (!call?.function?.arguments) {
            return json({ error: "The model returned no pipeline. Try a different model." }, 502);
          }
          let draft: { code?: unknown; requirements?: unknown; notes?: unknown };
          try {
            draft = JSON.parse(call.function.arguments);
          } catch {
            return json({ error: "The model returned malformed JSON. Try again." }, 502);
          }
          const code = typeof draft.code === "string" ? draft.code : "";
          if (!code.includes("def entrypoint")) {
            return json({ error: "The draft has no entrypoint(inputs) function. Try again." }, 502);
          }
          return json({
            code,
            requirements: typeof draft.requirements === "string" ? draft.requirements : "",
            notes: typeof draft.notes === "string" ? draft.notes : "",
            model,
          });
        } catch (e) {
          return json({ error: (e as Error).message }, 500);
        }
      },
    },
  },
});
