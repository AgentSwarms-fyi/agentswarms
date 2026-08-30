// POST /api/lakehouse/generate — NL→SQL for the lakehouse.
//
// Same contract as /api/etl/generate: authenticated, BYOK (the caller's own
// provider + model, governance through the same picker), forced tool call so
// the SQL comes back structured. The model sees ONLY the schemas the caller
// can access — the schema context is built through the same accessibility
// check the query chokepoint enforces, so the model cannot leak table names
// the user could not read anyway. The generated SQL is NOT executed here;
// the UI shows it for review and runs it through the governed query RPC,
// where every rule (single statement, schema access, no table functions)
// applies to AI SQL exactly as it does to typed SQL.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import {
  resolveOpenAICompatTransport,
  getProviderDefaultModel,
} from "@/utils/providers/credentials.server";
import { isBiCompatProvider } from "@/utils/providers/modelChoice";
import type { ProviderId } from "@/utils/providers/types";
import { auditEvent } from "@/utils/audit.server";
import { accessibleSchemas, lakehouseConnection } from "@/utils/lakehouse/core.server";

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

const SYSTEM_PROMPT = `You are AgentSwarms' lakehouse analyst. You translate a question into ONE DuckDB SQL statement over the schemas provided.

Rules the platform will enforce on your output — break them and the query is refused:
- Exactly one statement, SELECT/WITH only (never INSERT/UPDATE/DDL unless the user explicitly asks to change data, in which case a single INSERT/UPDATE/DELETE is allowed).
- Every table reference must be schema-qualified (schema.table) and only use schemas from the provided context.
- No table functions (read_parquet, read_csv, …) — query tables only.
- DuckDB SQL dialect. Prefer explicit column lists over * for final answers; cast decimals for display only when asked.

You MUST call the \`emit_sql\` tool exactly once. No text outside the tool call.`;

export const Route = createFileRoute("/api/lakehouse/generate")({
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
            question?: unknown;
            provider?: unknown;
            model?: unknown;
          };
          const question = typeof body.question === "string" ? body.question.trim() : "";
          if (!question) return json({ error: "question is required" }, 400);
          if (question.length > 2000) return json({ error: "question is too long" }, 400);

          // Schema context: only what this user can query anyway.
          const allowed = await accessibleSchemas(user.id);
          if (!allowed.length) {
            return json({ error: "You have no lakehouse schemas yet — create one first." }, 400);
          }
          const c = await lakehouseConnection();
          let context = "";
          try {
            const names = allowed.map((s) => `'${s.name}'`).join(", ");
            const cols = await (
              await c.run(
                `SELECT table_schema, table_name, column_name, data_type
                 FROM information_schema.columns
                 WHERE table_catalog='lake' AND table_schema IN (${names})
                 ORDER BY table_schema, table_name, ordinal_position`,
              )
            ).getRows();
            const byTable = new Map<string, string[]>();
            for (const r of cols) {
              const key = `${String(r[0])}.${String(r[1])}`;
              const list = byTable.get(key) ?? [];
              list.push(`${String(r[2])} ${String(r[3])}`);
              byTable.set(key, list);
            }
            context = [...byTable.entries()]
              .slice(0, 200)
              .map(([table, colList]) => `${table}(${colList.join(", ")})`)
              .join("\n");
          } finally {
            c.closeSync();
          }
          if (!context) {
            return json({ error: "Your schemas have no tables yet — create or import one." }, 400);
          }

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
              { error: `${provider} isn't configured. Connect it under Integrations.` },
              503,
            );
          }
          let model = typeof body.model === "string" && body.model ? body.model : "";
          if (!model)
            model = (await getProviderDefaultModel(user.id, provider as ProviderId)) ?? "";
          if (!model && provider === "openrouter") model = FALLBACK_MODEL;
          if (!model) {
            return json({ error: `Choose a model — ${provider} has no default configured.` }, 400);
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
                {
                  role: "user",
                  content: `Schemas you may use:\n${context}\n\nQuestion: ${question}`,
                },
              ],
              tools: [
                {
                  type: "function",
                  function: {
                    name: "emit_sql",
                    description: "Return the SQL statement answering the question",
                    parameters: {
                      type: "object",
                      properties: {
                        sql: { type: "string", description: "One DuckDB SQL statement" },
                        explanation: {
                          type: "string",
                          description: "One sentence on what the query does",
                        },
                      },
                      required: ["sql"],
                    },
                  },
                },
              ],
              tool_choice: { type: "function", function: { name: "emit_sql" } },
              temperature: 0.1,
              max_tokens: 1500,
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
            (t) => t.function?.name === "emit_sql",
          );
          if (!call?.function?.arguments) {
            return json({ error: "The model returned no SQL. Try a different model." }, 502);
          }
          let draft: { sql?: unknown; explanation?: unknown };
          try {
            draft = JSON.parse(call.function.arguments);
          } catch {
            return json({ error: "The model returned malformed JSON. Try again." }, 502);
          }
          const sql = typeof draft.sql === "string" ? draft.sql.trim() : "";
          if (!sql) return json({ error: "The model returned empty SQL. Try again." }, 502);
          auditEvent({
            userId: user.id,
            action: "lakehouse.nl2sql",
            resourceType: "lakehouse",
            resourceName: model,
            detail: { question: question.slice(0, 300) },
          });
          return json({
            sql,
            explanation: typeof draft.explanation === "string" ? draft.explanation : "",
            model,
          });
        } catch (e) {
          return json({ error: (e as Error).message }, 500);
        }
      },
    },
  },
});
