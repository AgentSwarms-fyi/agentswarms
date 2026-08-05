// POST /api/embed/chat — streaming chat for embedded agents and swarm nodes.
//
// Design principle: the embed client sends ONLY conversation messages (plus
// the embed key and, for swarms, a node id). Every piece of behavioural
// config — system prompt, provider, model, temperature, knowledge bases,
// re-ranker, guardrails — is loaded server-side from the OWNER's stored
// rows and cannot be overridden by the visitor. Workspace tools (SQL, web,
// MCP, n8n…) are hard-disabled in embeds; retrieval (RAG) over the wired
// knowledge bases is the one capability that runs, scoped to the KB ids on
// the embedded resource.
//
// The response is OpenAI-style SSE (same contract as /api/chat), optionally
// prefixed with an `event: citations` preamble, so the embed chat UI and
// the swarm runtime parse it with their existing code.

import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { touchEmbedKey, validateEmbedKey } from "@/utils/embed.server";
import { rateLimitedGlobal } from "@/utils/rateLimit.server";
import { clientIp, clientUserAgent } from "@/utils/requestMeta.server";
import { budgetMessage, getBudgetDecision } from "@/utils/budgetGuard.server";
import { recordGatewayCall } from "@/utils/observability/recordGatewayUsage.server";
import { resolveOpenAICompatTransport } from "@/utils/providers/credentials.server";
import type { ProviderId } from "@/utils/providers/types";
import {
  buildGroundingPrompt,
  retrieveCitationsServer,
  type Citation,
} from "@/utils/tools/kb.server";
import { generateEmbedWidget } from "@/utils/embedBi.server";
import {
  applyOutputGuardrails,
  evaluateInputGuardrails,
  parseGuardrails,
  type Guardrails,
} from "@/utils/guardrails";

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

// Constant judge prompts — must match src/lib/swarmRuntime.ts semantics for
// condition and router nodes (the runtime sends only the node id; we decide
// the system prompt from the stored node's kind).
const CONDITION_SYSTEM = "You are a strict binary classifier. Reply only YES or NO.";
const ROUTER_SYSTEM =
  "You are a strict routing classifier. Reply with exactly one route name from the provided list — no other text.";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string | Array<Record<string, unknown>>;
};

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const textPart = m.content.find((p) => p.type === "text") as { text?: string } | undefined;
    return textPart?.text ?? "";
  }
  return "";
}

function sseOnce(text: string, status = 200): Response {
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` + "data: [DONE]\n\n";
  return new Response(payload, {
    status,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders },
  });
}

// buildGroundingPrompt is shared with /api/chat — see kb.server.ts. A local
// copy here dropped retrieved text into the system prompt without defanging
// the SOURCES delimiters, and this route is the public, unauthenticated one.

type ResolvedConfig = {
  label: string;
  systemPrompt: string;
  provider: ProviderId;
  model: string;
  temperature: number;
  maxTokens: number;
  kbIds: string[];
  reranker?: { provider: string; model: string };
  guardrails: Guardrails;
  /** Agent-only: generate a visual BI widget alongside the answer. */
  biVisuals: boolean;
  /**
   * The agent's `sql_query` table allow-list, carried here because the BI
   * widget runs the owner's data for an ANONYMOUS visitor. Empty/absent means
   * unrestricted, exactly as it does for the chat tool.
   */
  sqlTableNames: string[];
};

/** The saved shape is tools.toolConfigs.sql_query.table_names (see api/chat). */
function readSqlTableNames(tools: unknown): string[] {
  const cfg = (tools as { toolConfigs?: { sql_query?: { table_names?: unknown } } } | null)
    ?.toolConfigs?.sql_query?.table_names;
  return Array.isArray(cfg)
    ? cfg.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
}

/** Load the effective config for this embed call from the owner's rows. */
async function resolveConfig(
  keyRow: { resource_type: string; resource_id: string; user_id: string },
  nodeId: string | undefined,
): Promise<{ ok: true; cfg: ResolvedConfig } | { ok: false; status: number; error: string }> {
  if (keyRow.resource_type === "agent") {
    const { data: agent } = await supabaseAdmin
      .from("agents")
      .select(
        "id, user_id, name, system_prompt, llm_provider, llm_model, temperature, max_tokens, knowledge_base_id, tools",
      )
      .eq("id", keyRow.resource_id)
      .maybeSingle();
    if (!agent || agent.user_id !== keyRow.user_id) {
      return { ok: false, status: 404, error: "The embedded agent no longer exists." };
    }
    const tools = (agent.tools ?? {}) as {
      knowledgeBaseIds?: unknown;
      reranker?: { provider?: string; model?: string };
      guardrails?: unknown;
      biVisuals?: unknown;
    };
    const kbIds = [
      ...(agent.knowledge_base_id ? [agent.knowledge_base_id] : []),
      ...(Array.isArray(tools.knowledgeBaseIds)
        ? tools.knowledgeBaseIds.filter((s): s is string => typeof s === "string")
        : []),
    ];
    return {
      ok: true,
      cfg: {
        label: agent.name,
        systemPrompt: agent.system_prompt ?? "",
        provider: (agent.llm_provider || "openrouter") as ProviderId,
        model: agent.llm_model || "openai/gpt-4o-mini",
        temperature: typeof agent.temperature === "number" ? agent.temperature : 0.4,
        maxTokens: typeof agent.max_tokens === "number" ? agent.max_tokens : 4096,
        kbIds: [...new Set(kbIds)],
        reranker:
          tools.reranker?.provider && tools.reranker.model
            ? { provider: tools.reranker.provider, model: tools.reranker.model }
            : undefined,
        guardrails: parseGuardrails(tools.guardrails),
        biVisuals: !!tools.biVisuals,
        sqlTableNames: readSqlTableNames(agent.tools),
      },
    };
  }

  // swarm node
  if (!nodeId) return { ok: false, status: 400, error: "nodeId is required for swarm embeds." };
  const { data: swarm } = await supabaseAdmin
    .from("swarms")
    .select("id, user_id, name, nodes")
    .eq("id", keyRow.resource_id)
    .maybeSingle();
  if (!swarm || swarm.user_id !== keyRow.user_id) {
    return { ok: false, status: 404, error: "The embedded swarm no longer exists." };
  }
  const nodes = (Array.isArray(swarm.nodes) ? swarm.nodes : []) as Array<{
    id?: string;
    data?: Record<string, unknown>;
  }>;
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, status: 404, error: "Swarm node not found." };
  const d = (node.data ?? {}) as {
    kind?: string;
    label?: string;
    systemPrompt?: string;
    provider?: string;
    model?: string;
    temperature?: number;
    knowledgeBaseId?: string | null;
    reranker?: { provider?: string; model?: string } | null;
    guardrails?: Record<string, unknown>;
    agentId?: string;
  };

  // Judge nodes use fixed classifier prompts; agent nodes their saved prompt.
  let systemPrompt = d.systemPrompt ?? "";
  if (d.kind === "condition") systemPrompt = CONDITION_SYSTEM;
  else if (d.kind === "router") systemPrompt = ROUTER_SYSTEM;

  // A node linked to a saved agent inherits its KB + guardrails baseline.
  let agentKbId: string | null = null;
  let agentGuardrailsRaw: unknown;
  let agentReranker: { provider?: string; model?: string } | undefined;
  if (d.agentId) {
    const { data: linked } = await supabaseAdmin
      .from("agents")
      .select("user_id, knowledge_base_id, tools")
      .eq("id", d.agentId)
      .maybeSingle();
    if (linked && linked.user_id === keyRow.user_id) {
      agentKbId = linked.knowledge_base_id;
      const t = (linked.tools ?? {}) as {
        guardrails?: unknown;
        reranker?: { provider?: string; model?: string };
      };
      agentGuardrailsRaw = t.guardrails;
      agentReranker = t.reranker;
    }
  }

  const kbIds = [
    ...(d.knowledgeBaseId ? [d.knowledgeBaseId] : []),
    ...(agentKbId ? [agentKbId] : []),
  ];
  const reranker = d.reranker?.provider && d.reranker.model ? d.reranker : agentReranker;
  // Node guardrails are merged OVER the linked agent's — same as /api/chat.
  const mergedGuardrails = parseGuardrails({
    ...((agentGuardrailsRaw as Record<string, unknown>) ?? {}),
    ...(d.guardrails ?? {}),
  });

  return {
    ok: true,
    cfg: {
      label: `${swarm.name} · ${d.label ?? nodeId}`,
      systemPrompt,
      provider: (d.provider || "openrouter") as ProviderId,
      model: d.model || "google/gemini-3-flash-preview",
      temperature: typeof d.temperature === "number" ? d.temperature : 0.4,
      maxTokens: 8192,
      kbIds: [...new Set(kbIds)],
      reranker:
        reranker?.provider && reranker.model
          ? { provider: reranker.provider, model: reranker.model }
          : undefined,
      guardrails: mergedGuardrails,
      biVisuals: false,
      // Swarm nodes never generate a widget (biVisuals is false above), but the
      // node's own allow-list is carried anyway so enabling it later cannot
      // reintroduce the bypass by forgetting this line.
      sqlTableNames: Array.isArray(
        (d as { toolConfigs?: { sql_table_names?: unknown } }).toolConfigs?.sql_table_names,
      )
        ? (d as { toolConfigs: { sql_table_names: unknown[] } }).toolConfigs.sql_table_names.filter(
            (s): s is string => typeof s === "string" && s.trim().length > 0,
          )
        : [],
    },
  };
}

export const Route = createFileRoute("/api/embed/chat")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: corsHeaders }),
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          embedKey?: string;
          parentOrigin?: string;
          previewToken?: string;
          nodeId?: string;
          messages?: ChatMessage[];
        };
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return json({ error: "messages array is required" }, 400);
        }
        if (body.messages.length > 60 || JSON.stringify(body.messages).length > 200_000) {
          return json({ error: "Conversation too large for an embed." }, 413);
        }
        if (await rateLimitedGlobal(`chat:${body.embedKey ?? "?"}`, 30)) {
          return json({ error: "Rate limited — please slow down." }, 429);
        }

        const v = await validateEmbedKey({
          key: body.embedKey,
          parentOrigin: body.parentOrigin,
          previewToken: body.previewToken,
          ip: clientIp(request),
          userAgent: clientUserAgent(request),
          request,
        });
        if (!v.ok) return json({ error: v.error }, v.status);
        const keyRow = v.row;
        if (keyRow.resource_type === "bi_dashboard") {
          return json({ error: "This embed key is for a dashboard, not a chat." }, 400);
        }

        const resolved = await resolveConfig(keyRow, body.nodeId);
        if (!resolved.ok) return json({ error: resolved.error }, resolved.status);
        const cfg = resolved.cfg;

        // Model governance applies to embeds too. This surface executes the
        // OWNER's stored model on behalf of anonymous strangers, and it was
        // the one LLM gateway with no rules check at all — so an owner whose
        // access an admin had revoked (or who never had any, under deny-by-
        // default) kept a public endpoint running that model indefinitely.
        {
          const { getEffectiveModelRules, isModelAllowed } = await import("@/utils/iam.server");
          const rules = await getEffectiveModelRules(supabaseAdmin, keyRow.user_id);
          if (!isModelAllowed(rules, cfg.provider, cfg.model)) {
            return json(
              {
                error:
                  "This assistant is temporarily unavailable — its model is not permitted by the workspace's policy.",
              },
              403,
            );
          }
        }

        // Visitors keep only user/assistant roles — system is server-owned.
        const history: ChatMessage[] = body.messages.filter(
          (m) => m && (m.role === "user" || m.role === "assistant"),
        );
        const userText = lastUserText(history);

        // Input guardrails (the owner's policy applies to strangers first).
        const inputDecision = evaluateInputGuardrails(userText, cfg.guardrails);
        if (!inputDecision.allowed) {
          return sseOnce(
            inputDecision.reason ?? "Your message was blocked by this agent's policy.",
          );
        }
        if (inputDecision.outboundText !== userText) {
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === "user" && typeof history[i].content === "string") {
              history[i] = { ...history[i], content: inputDecision.outboundText };
              break;
            }
          }
        }

        // RAG over the resource's wired knowledge bases (owner-scoped ids).
        let citations: Citation[] = [];
        if (cfg.kbIds.length > 0 && userText) {
          try {
            citations = await retrieveCitationsServer({
              sb: supabaseAdmin,
              extraKbIds: cfg.kbIds,
              query: inputDecision.outboundText,
              topK: 5,
              userId: keyRow.user_id,
              reranker: cfg.reranker,
              // userId above is the KEY OWNER (it resolves embedding
              // credentials); the person asking is an anonymous visitor.
              // Without this flag, connector documents scoped 'private' or
              // 'source_acl' would be retrievable by anyone with the embed URL.
              principal: { anonymous: true },
            });
          } catch (e) {
            console.warn("[embed chat] RAG failed:", (e as Error).message);
          }
        }
        const systemPrompt = buildGroundingPrompt(citations, cfg.systemPrompt);

        // Budget gate. Anonymous visitors spend the OWNER's credits here, so
        // this is the surface where a per-credential cap matters most. Refuse
        // in-band (SSE) so the embedded chat shows the message instead of a
        // silent failure.
        const budget = await getBudgetDecision(keyRow.user_id, {
          type: "embed_key",
          id: keyRow.id,
        });
        if (budget.over) return sseOnce(budgetMessage(budget));

        const transport = await resolveOpenAICompatTransport({
          userId: keyRow.user_id,
          provider: cfg.provider,
        });
        if (!transport || (!transport.apiKey && cfg.provider !== "ollama")) {
          return json({ error: "This embed's AI provider is not configured." }, 503);
        }

        touchEmbedKey(keyRow, clientIp(request));
        const startedAt = Date.now();
        const upstreamCtrl = new AbortController();
        const timer = setTimeout(() => upstreamCtrl.abort(), 180_000);
        let upstream: Response;
        try {
          upstream = await fetch(transport.endpointUrl, {
            method: "POST",
            signal: upstreamCtrl.signal,
            headers: {
              "Content-Type": "application/json",
              ...(transport.apiKey ? { Authorization: `Bearer ${transport.apiKey}` } : {}),
              ...(transport.extraHeaders ?? {}),
            },
            body: JSON.stringify({
              model: cfg.model,
              messages: [
                ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
                ...history,
              ],
              temperature: cfg.temperature,
              max_tokens: cfg.maxTokens,
              stream: true,
            }),
          });
        } catch (e) {
          clearTimeout(timer);
          if ((e as Error).name === "AbortError") {
            return json({ error: "The model provider did not respond." }, 504);
          }
          throw e;
        }
        if (!upstream.ok || !upstream.body) {
          clearTimeout(timer);
          const errText = await upstream.text().catch(() => "");
          void recordGatewayCall({
            userId: keyRow.user_id,
            costScope: { type: "embed_key", id: keyRow.id },
            surface: `Embed: ${cfg.label}`,
            model: cfg.provider === "openrouter" ? cfg.model : `${cfg.provider}/${cfg.model}`,
            promptText: userText,
            latencyMs: Date.now() - startedAt,
            status: "error",
            errorMessage: `Upstream ${upstream.status}: ${errText.slice(0, 200)}`,
          });
          return json({ error: `Model provider error (${upstream.status}).` }, 502);
        }

        const gatewayModel =
          cfg.provider === "openrouter" ? cfg.model : `${cfg.provider}/${cfg.model}`;
        const bufferOutput = cfg.guardrails.enableOutputFilters;
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        // Accumulate assistant text (for the trace and, when output filters
        // are on, for post-hoc guardrail application before anything is
        // surfaced to the visitor).
        let assistantText = "";
        let sseBuffer = "";

        const consumeChunk = (chunkText: string) => {
          sseBuffer += chunkText;
          let idx: number;
          while ((idx = sseBuffer.indexOf("\n")) !== -1) {
            const line = sseBuffer.slice(0, idx).trim();
            sseBuffer = sseBuffer.slice(idx + 1);
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
            try {
              const p = JSON.parse(line.slice(6)) as {
                choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
              };
              const delta =
                p.choices?.[0]?.delta?.content ?? p.choices?.[0]?.message?.content ?? "";
              if (typeof delta === "string") assistantText += delta;
            } catch {
              /* keep-alives / comments */
            }
          }
        };

        const finishTrace = (status: "success" | "error") => {
          clearTimeout(timer);
          void recordGatewayCall({
            userId: keyRow.user_id,
            costScope: { type: "embed_key", id: keyRow.id },
            surface: `Embed: ${cfg.label}`,
            model: gatewayModel,
            promptText: userText,
            responseText: assistantText,
            latencyMs: Date.now() - startedAt,
            status,
          });
        };

        const reader = upstream.body.getReader();

        if (bufferOutput) {
          // Guardrailed: consume fully, filter, then emit once.
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) consumeChunk(decoder.decode(value, { stream: true }));
            }
          } catch (e) {
            finishTrace("error");
            return json({ error: `Stream error: ${(e as Error).message}` }, 502);
          }
          finishTrace("success");
          const decision = applyOutputGuardrails(assistantText, cfg.guardrails, {
            hadCitations: citations.length > 0,
          });
          const finalText = decision.blocked
            ? "The response was withheld by this agent's guardrails."
            : decision.text;
          let payload = "";
          if (citations.length > 0) {
            payload += `event: citations\ndata: ${JSON.stringify({ citations })}\n\n`;
          }
          payload += `data: ${JSON.stringify({ choices: [{ delta: { content: finalText } }] })}\n\n`;
          if (cfg.biVisuals && !decision.blocked) {
            const widget = await generateEmbedWidget({
              ownerId: keyRow.user_id,
              provider: cfg.provider,
              model: cfg.model,
              question: userText,
              sqlTableNames: cfg.sqlTableNames,
            });
            if (widget) payload += `event: widget\ndata: ${JSON.stringify({ widget })}\n\n`;
          }
          payload += "data: [DONE]\n\n";
          return new Response(payload, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              ...corsHeaders,
            },
          });
        }

        // Streaming passthrough with a citations preamble + trace tee.
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            if (citations.length > 0) {
              controller.enqueue(
                encoder.encode(`event: citations\ndata: ${JSON.stringify({ citations })}\n\n`),
              );
            }
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                  consumeChunk(decoder.decode(value, { stream: true }));
                  controller.enqueue(value);
                }
              }
              // Visual BI answer: after the text, append a widget generated from
              // the owner's data (best-effort, never breaks the answer stream).
              if (cfg.biVisuals) {
                try {
                  const widget = await generateEmbedWidget({
                    ownerId: keyRow.user_id,
                    provider: cfg.provider,
                    model: cfg.model,
                    question: userText,
                    sqlTableNames: cfg.sqlTableNames,
                  });
                  if (widget) {
                    controller.enqueue(
                      encoder.encode(`event: widget\ndata: ${JSON.stringify({ widget })}\n\n`),
                    );
                  }
                } catch {
                  /* widget is optional */
                }
              }
              finishTrace("success");
              controller.close();
            } catch (e) {
              finishTrace("error");
              controller.error(e);
            }
          },
          cancel() {
            finishTrace("success");
            void reader.cancel();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            ...corsHeaders,
          },
        });
      },
    },
  },
});
