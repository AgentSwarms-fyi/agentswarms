// POST /api/embed — resolve + BI "Ask AI" for iframe embeds.
//
// Actions (JSON body, action field):
//   resolve — validate an embed key against the embedding page's origin and
//     return a SANITIZED payload for the embedded resource. Agent and swarm
//     system prompts, tool configs, KB wiring etc. never leave the server;
//     /api/embed/chat re-derives them per call from the stored rows.
//   ask — BI dashboards only (and only when the key has allow_ai): answer a
//     viewer question over the dashboard's stored widget snapshots, using
//     the OWNER's provider credentials and the dashboard's reader model.
//
// Auth is the embed key itself (a capability token scoped to one resource +
// domain allow-list) — see src/utils/embed.server.ts.

import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sanitizePublicPages, sanitizePublicWidgets } from "@/lib/biDashboards";
import { resolveDeployedGraph } from "@/lib/swarmPublish";
import { touchEmbedKey, validateEmbedKey } from "@/utils/embed.server";
import { rateLimitedGlobal } from "@/utils/rateLimit.server";
import { budgetMessage, getBudgetDecision } from "@/utils/budgetGuard.server";
import { clientIp, clientUserAgent } from "@/utils/requestMeta.server";
import { recordGatewayCall, extractUsage } from "@/utils/observability/recordGatewayUsage.server";
import {
  getProviderDefaultModel,
  resolveOpenAICompatTransport,
} from "@/utils/providers/credentials.server";
import { parseModelChoice } from "@/utils/providers/modelChoice";
import type { ProviderId } from "@/utils/providers/types";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// Node fields that are safe to ship to an anonymous embed viewer. System
// prompts, tools, tool configs, KB ids, rerankers, guardrails and memory
// settings stay server-side; /api/embed/chat re-loads them by node id.
const SAFE_NODE_FIELDS = [
  "label",
  "kind",
  "avatar",
  "provider",
  "model",
  "inputs",
  "outputVar",
  "routerPrompt",
  "conditionPrompt",
  "loopCount",
  "maxLoops",
] as const;

function sanitizeSwarmNodes(nodes: unknown): Record<string, unknown>[] {
  if (!Array.isArray(nodes)) return [];
  return (nodes as Record<string, unknown>[]).map((n) => {
    const data = (n.data ?? {}) as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const f of SAFE_NODE_FIELDS) {
      if (data[f] !== undefined) safe[f] = data[f];
    }
    return { id: n.id, type: n.type, position: n.position ?? { x: 0, y: 0 }, data: safe };
  });
}

export const Route = createFileRoute("/api/embed")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: corsHeaders }),
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          action?: string;
          key?: string;
          parentOrigin?: string;
          previewToken?: string;
          question?: string;
        };

        if (body.action !== "resolve" && body.action !== "ask") {
          return json({ error: "Unknown action" }, 400);
        }
        if (
          await rateLimitedGlobal(
            `${body.action}:${body.key ?? "?"}`,
            body.action === "ask" ? 10 : 60,
          )
        ) {
          return json({ error: "Rate limited — please slow down." }, 429);
        }

        const v = await validateEmbedKey({
          key: body.key,
          parentOrigin: body.parentOrigin,
          previewToken: body.previewToken,
          ip: clientIp(request),
          userAgent: clientUserAgent(request),
          request,
        });
        if (!v.ok) return json({ error: v.error }, v.status);
        const keyRow = v.row;

        // ── resolve ────────────────────────────────────────────────────
        if (body.action === "resolve") {
          touchEmbedKey(keyRow, clientIp(request));

          if (keyRow.resource_type === "agent") {
            const { data: agent } = await supabaseAdmin
              .from("agents")
              .select("id, name, description, user_id")
              .eq("id", keyRow.resource_id)
              .maybeSingle();
            if (!agent || agent.user_id !== keyRow.user_id) {
              return json({ error: "The embedded agent no longer exists." }, 404);
            }
            return json({
              type: "agent",
              name: agent.name,
              description: agent.description,
            });
          }

          if (keyRow.resource_type === "swarm") {
            const { data: swarm } = await supabaseAdmin
              .from("swarms")
              .select(
                "id, name, description, nodes, edges, user_id, published_nodes, published_edges, published_at",
              )
              .eq("id", keyRow.resource_id)
              .maybeSingle();
            if (!swarm || swarm.user_id !== keyRow.user_id) {
              return json({ error: "The embedded swarm no longer exists." }, 404);
            }
            // An embed on someone else's website is a deployed surface like any
            // other, so it serves the PUBLISHED graph. Embeds created before
            // publishing existed have no snapshot and keep serving the draft.
            const deployed = resolveDeployedGraph(swarm);
            const nodes = sanitizeSwarmNodes(deployed.nodes);
            if (nodes.some((n) => (n.data as { kind?: string }).kind === "approval")) {
              return json(
                {
                  error:
                    "This swarm contains a human-approval step and cannot run in an embed. Remove the approval gate or embed a different swarm.",
                },
                422,
              );
            }
            return json({
              type: "swarm",
              name: swarm.name,
              description: swarm.description,
              nodes,
              edges: Array.isArray(deployed.edges) ? deployed.edges : [],
            });
          }

          // bi_dashboard
          const { data: dash } = await supabaseAdmin
            .from("bi_dashboards")
            .select(
              "id, name, description, widgets, layout, pages, filters, theme, updated_at, ai_model, user_id",
            )
            .eq("id", keyRow.resource_id)
            .maybeSingle();
          if (!dash || dash.user_id !== keyRow.user_id) {
            return json({ error: "The embedded dashboard no longer exists." }, 404);
          }
          // Usage analytics: embed views are stamped with the service role.
          void supabaseAdmin
            .rpc("bi_touch_view", { _dashboard_id: dash.id })
            .then(() => {})
            .then(undefined, () => {});
          // Hydrate row snapshots from the results store (anonymous viewers
          // have no session for its RLS), then sanitise as before.
          const { hydrateDashboardAdmin } = await import("@/utils/bi/results.server");
          const hydratedDash = await hydrateDashboardAdmin(dash.id, dash);
          return json({
            type: "bi_dashboard",
            name: hydratedDash.name,
            description: hydratedDash.description,
            widgets: sanitizePublicWidgets(hydratedDash.widgets),
            layout: hydratedDash.layout,
            pages: sanitizePublicPages(hydratedDash.pages),
            filters: dash.filters,
            theme: dash.theme,
            updated_at: dash.updated_at,
            allowAi: keyRow.allow_ai,
          });
        }

        // ── ask (BI dashboards with allow_ai) ──────────────────────────
        if (keyRow.resource_type !== "bi_dashboard" || !keyRow.allow_ai) {
          return json({ error: "AI analyst is not enabled for this embed." }, 403);
        }
        const question = (body.question ?? "").trim().slice(0, 2000);
        if (!question) return json({ error: "question required" }, 400);

        // Budget gate. This action makes a real model call and bills the OWNER
        // through recordGatewayCall with costScope { type: "embed_key" } — the
        // same scope /api/embed/chat meters against — but it never asked
        // whether that budget had anything left. So an owner who set a cap saw
        // it enforced on embedded CHAT and silently not on embedded ASK, on the
        // same key, spending from the same pot. Anonymous visitors are the ones
        // spending, which is exactly where a per-credential cap is supposed to
        // hold.
        const budget = await getBudgetDecision(keyRow.user_id, {
          type: "embed_key",
          id: keyRow.id,
        });
        if (budget.over) return json({ error: budgetMessage(budget) }, 402);

        // Context comes from the STORED dashboard — never from the client.
        const { data: dash } = await supabaseAdmin
          .from("bi_dashboards")
          .select("name, widgets, ai_model, user_id")
          .eq("id", keyRow.resource_id)
          .maybeSingle();
        if (!dash || dash.user_id !== keyRow.user_id) {
          return json({ error: "The embedded dashboard no longer exists." }, 404);
        }
        const widgets = (Array.isArray(dash.widgets) ? dash.widgets : []) as {
          title?: string;
          kind?: string;
          columns?: string[];
          rows?: Record<string, unknown>[];
          text?: string;
        }[];
        const context = widgets
          .slice(0, 16)
          .map((w) => {
            if (w.kind === "text") return `NOTE "${w.title}":\n${(w.text ?? "").slice(0, 800)}`;
            const cols = (w.columns ?? []).join(", ");
            const sample = JSON.stringify((w.rows ?? []).slice(0, 15));
            return `WIDGET "${w.title}"\nCOLUMNS: ${cols}\nROWS (sample of ${w.rows?.length ?? 0}): ${sample}`;
          })
          .join("\n\n");

        // Reader model chosen by the publisher; owner credentials execute it.
        const choice = parseModelChoice(dash.ai_model);
        const provider = (choice?.provider ?? "openrouter") as ProviderId;
        const transport = await resolveOpenAICompatTransport({
          userId: keyRow.user_id,
          provider,
        });
        if (!transport || (!transport.apiKey && provider !== "ollama")) {
          return json({ error: "The AI analyst is not configured for this dashboard." }, 503);
        }
        let model = choice?.model || "";
        if (!model) model = (await getProviderDefaultModel(keyRow.user_id, provider)) ?? "";
        if (!model && provider === "openrouter") {
          model = process.env.OPENROUTER_DEFAULT_MODEL || "google/gemini-2.5-flash";
        }
        if (!model) return json({ error: "The AI analyst is not configured." }, 503);

        touchEmbedKey(keyRow, clientIp(request));
        const startedAt = Date.now();
        const upstreamCtrl = new AbortController();
        const timer = setTimeout(() => upstreamCtrl.abort(), 90_000);
        let r: Response;
        try {
          r = await fetch(transport.endpointUrl, {
            method: "POST",
            signal: upstreamCtrl.signal,
            headers: {
              "Content-Type": "application/json",
              ...(transport.apiKey ? { Authorization: `Bearer ${transport.apiKey}` } : {}),
              ...(transport.extraHeaders ?? {}),
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: "system",
                  content:
                    "You are a BI analyst answering questions about a published dashboard. " +
                    "Use ONLY the widget data provided — never invent numbers. If the data cannot answer the " +
                    "question, say so briefly and name what data would be needed. Answer in tight markdown " +
                    "with specific figures, rounded for readability. " +
                    'Output JSON only: { "answer": "<markdown>" }.',
                },
                {
                  role: "user",
                  content: `DASHBOARD DATA:\n${context}\n\nQUESTION: ${question}\n\nReturn JSON: { "answer": "..." }`,
                },
              ],
              response_format: { type: "json_object" },
              temperature: 0.1,
            }),
          });
        } catch (e) {
          if ((e as Error).name === "AbortError") {
            return json({ error: "The AI analyst timed out. Try again." }, 504);
          }
          throw e;
        } finally {
          clearTimeout(timer);
        }
        if (!r.ok) {
          const errText = await r.text().catch(() => "");
          console.warn(`[embed ask] upstream ${r.status}: ${errText.slice(0, 200)}`);
          return json({ error: `AI analyst error (${r.status}).` }, 502);
        }
        const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = data.choices?.[0]?.message?.content ?? "{}";
        const usage = extractUsage(data);
        void recordGatewayCall({
          userId: keyRow.user_id,
          costScope: { type: "embed_key", id: keyRow.id },
          surface: `Embed Ask: ${dash.name}`,
          model: provider === "openrouter" ? model : `${provider}/${model}`,
          promptText: question,
          responseText: text,
          tokensIn: usage?.tokensIn,
          tokensOut: usage?.tokensOut,
          latencyMs: Date.now() - startedAt,
          status: "success",
        });
        const cleaned = text
          .trim()
          .replace(/^```(?:json)?/i, "")
          .replace(/```$/, "")
          .trim();
        try {
          const parsed = JSON.parse(cleaned) as { answer?: string };
          return json({ answer: parsed.answer ?? cleaned });
        } catch {
          return json({ answer: cleaned.slice(0, 4000) });
        }
      },
    },
  },
});
