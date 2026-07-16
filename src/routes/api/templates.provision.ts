// Idempotently provisions a real, runnable agent + knowledge base + seed documents
// from a template id into the authenticated user's workspace.
//
// Same caller flow as /api/chat: the client sends the user's Supabase access token
// in the Authorization header. We use the publishable key + that token so RLS
// scopes everything to the user automatically.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getRealTemplate, type RealTemplate } from "@/lib/realTemplates";
import { embedAndStoreDocuments } from "@/utils/tools/embedding.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

function getUserSupabase(authToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${authToken}` } },
  });
}

// Stable description tag we put in agents.description so we can detect an
// already-provisioned demo agent for this user + template.
function tagFor(templateId: string) {
  return `[demo:${templateId}]`;
}

async function ensureKnowledgeBase(
  sb: ReturnType<typeof createClient<Database>>,
  userId: string,
  template: RealTemplate,
): Promise<string | null> {
  if (template.seedDocuments.length === 0) return null;

  const kbName = `Demo · ${template.title}`;

  // Look for an existing one we created earlier.
  const { data: existing } = await sb
    .from("knowledge_bases")
    .select("id, name")
    .eq("name", kbName)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: kb, error: kbErr } = await sb
    .from("knowledge_bases")
    .insert({
      user_id: userId,
      name: kbName,
      description: `Auto-provisioned for the "${template.title}" template demo.`,
    })
    .select("id")
    .single();
  if (kbErr || !kb) return null;

  const docs = template.seedDocuments.map((d) => ({
    user_id: userId,
    knowledge_base_id: kb.id,
    name: d.name,
    content: d.content,
    metadata: { source: "template_seed", template_id: template.id },
  }));
  const insertedDocs: Array<{
    id: string;
    knowledge_base_id: string;
    user_id: string | null;
    is_sample: boolean | null;
    content: string | null;
  }> = [];
  if (docs.length > 0) {
    for (const doc of docs) {
      const { data: row } = await sb
        .from("knowledge_documents")
        .insert(doc)
        .select("id, knowledge_base_id, user_id, is_sample, content")
        .single();
      if (row) insertedDocs.push(row);
    }
  }
  // Embed seeded docs so RAG works immediately for the demo. Best-effort.
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && insertedDocs.length > 0) {
    try {
      await embedAndStoreDocuments({ sb, docs: insertedDocs, openaiKey });
    } catch (err) {
      console.warn("[templates.provision] embedding failed:", err);
    }
  }
  return kb.id;
}

async function ensureApprovalSeed(
  sb: ReturnType<typeof createClient<Database>>,
  userId: string,
  agentId: string,
  template: RealTemplate,
) {
  if (!template.approvalSeed) return;
  // Avoid creating duplicate approval seeds for the same agent.
  const { data: existing } = await sb
    .from("approvals")
    .select("id")
    .eq("agent_id", agentId)
    .eq("action_type", template.approvalSeed.action_type)
    .eq("status", "pending")
    .maybeSingle();
  if (existing) return;

  await sb.from("approvals").insert({
    user_id: userId,
    agent_id: agentId,
    agent_name: template.title,
    action_title: template.approvalSeed.action_title,
    action_type: template.approvalSeed.action_type,
    risk_level: template.approvalSeed.risk_level,
    description: template.approvalSeed.description,
    payload: template.approvalSeed.payload as never,
    status: "pending",
  });
}

export const Route = createFileRoute("/api/templates/provision")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),

      POST: async ({ request }) => {
        try {
          const auth = request.headers.get("authorization");
          if (!auth?.startsWith("Bearer ")) {
            return json(401, { error: "Authentication required" });
          }
          const token = auth.slice(7);
          const sb = getUserSupabase(token);
          if (!sb) return json(500, { error: "Server is not configured" });

          const { data: claimsData, error: claimsErr } = await sb.auth.getClaims(token);
          if (claimsErr || !claimsData?.claims?.sub) {
            return json(401, { error: "Invalid auth token" });
          }
          const userId = claimsData.claims.sub;

          const body = (await request.json()) as { templateId?: string };
          if (!body.templateId || typeof body.templateId !== "string") {
            return json(400, { error: "templateId is required" });
          }
          const template = getRealTemplate(body.templateId);
          if (!template) return json(404, { error: "Template not found" });

          // 1. Look for an existing demo agent for this user + template.
          const tag = tagFor(template.id);
          const { data: existingAgent } = await sb
            .from("agents")
            .select("id, name, description, knowledge_base_id")
            .like("description", `%${tag}%`)
            .maybeSingle();

          // 2. Build / reuse the knowledge base.
          // Templates may pin an existing (e.g. shared sample) KB via
          // existingKnowledgeBaseId — in that case we skip seeding.
          const kbId =
            template.existingKnowledgeBaseId ||
            existingAgent?.knowledge_base_id ||
            (await ensureKnowledgeBase(sb, userId, template));

          // 3. Insert or reuse the agent.
          const baseDescription = `${template.tagline}\n\n${tag}`;
          // If the template declares a web_search tool, enable BOTH built-in
          // web tools (web_search + web_browse) by default — many templates
          // call web_browse via the same "web_search" capability declaration.
          // Defaults to firecrawl_builtin which uses the workspace-wide
          // FIRECRAWL_API_KEY (Firecrawl connector) with a DuckDuckGo fallback.
          const hasWebTool = template.tools.some((t) => t.type === "web_search");
          const builtInTools: Record<string, boolean> = { ...(template.extraBuiltInTools ?? {}) };
          const toolConfigs: Record<string, Record<string, string>> = {};
          if (hasWebTool) {
            builtInTools.web_search = true;
            builtInTools.web_browse = true;
            toolConfigs.web_search = { provider: "firecrawl_builtin" };
            toolConfigs.web_browse = { provider: "firecrawl_builtin" };
          }
          if (kbId && !builtInTools.kb_graph_search) {
            // Default to kb_search unless the template explicitly opted into
            // graph search only (graph templates skip the vector retriever).
            builtInTools.kb_search = true;
          }
          const tools: Record<string, unknown> = {
            knowledgeBaseIds: kbId ? [kbId] : [],
            humanApproval: template.tools.some((t) => t.type === "human_approval"),
            guardrails: template.guardrails,
            templateId: template.id,
            builtInTools,
            toolConfigs,
          };
          if (template.skillTourId) {
            tools.skillTourId = template.skillTourId;
          }

          let agentId: string;
          if (existingAgent) {
            agentId = existingAgent.id;
            // Keep config in sync if the template has been updated.
            await sb
              .from("agents")
              .update({
                name: `Demo · ${template.title}`,
                description: baseDescription,
                system_prompt: template.systemPrompt,
                llm_provider: template.provider,
                llm_model: template.modelId,
                temperature: template.temperature,
                max_tokens: template.guardrails.maxTokens,
                knowledge_base_id: kbId,
                tools: tools as never,
                is_active: true,
              })
              .eq("id", agentId);
          } else {
            const { data: newAgent, error: agentErr } = await sb
              .from("agents")
              .insert({
                user_id: userId,
                name: `Demo · ${template.title}`,
                description: baseDescription,
                system_prompt: template.systemPrompt,
                llm_provider: template.provider,
                llm_model: template.modelId,
                temperature: template.temperature,
                max_tokens: template.guardrails.maxTokens,
                knowledge_base_id: kbId,
                tools: tools as never,
                is_active: true,
              })
              .select("id")
              .single();
            if (agentErr || !newAgent) {
              return json(500, { error: agentErr?.message || "Failed to create agent" });
            }
            agentId = newAgent.id;
          }

          // 4. Seed an approval row if the template defines one.
          await ensureApprovalSeed(sb, userId, agentId, template);

          return json(200, {
            agentId,
            knowledgeBaseId: kbId,
            templateId: template.id,
            reused: !!existingAgent,
          });
        } catch (e) {
          console.error("provision route error:", e);
          return json(500, { error: e instanceof Error ? e.message : "Unknown error" });
        }
      },
    },
  },
});
