// Makes an agent from one of the agent templates (src/lib/realTemplates.ts):
// the agent, its knowledge base with the template's documents, and the one
// example approval some templates show (R530; the route is
// src/routes/api/templates.provision.ts).
//
// `sb` is the caller's own client, so RLS scopes every write. Every READ also
// names the caller: RLS lets a client see more than its own rows in places
// (every sample knowledge base, for one), and a lookup by name alone would
// have taken a sample knowledge base of the same name as the template's
// (found in R530, reading this before the gallery called it again).
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  getRealTemplate,
  templateAgentName,
  TEMPLATE_ID_COLUMN,
  type RealTemplate,
} from "@/lib/realTemplates";
import { embedAndStoreDocuments } from "@/utils/tools/embedding.server";
import { resolveEmbedArgs } from "@/utils/tools/embedTarget.server";

type Db = SupabaseClient<Database>;

export type ProvisionResult =
  | {
      ok: true;
      agentId: string;
      knowledgeBaseId: string | null;
      templateId: string;
      /** The caller already had it; it was opened, not made again or changed. */
      reused: boolean;
    }
  | { ok: false; status: number; error: string };

async function ensureKnowledgeBase(
  db: Db,
  userId: string,
  t: RealTemplate,
): Promise<string | null> {
  if (t.seedDocuments.length === 0) return null;
  const kbName = `Demo · ${t.title}`;

  const { data: existing } = await db
    .from("knowledge_bases")
    .select("id")
    .eq("user_id", userId)
    .eq("name", kbName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: kb, error } = await db
    .from("knowledge_bases")
    .insert({
      user_id: userId,
      name: kbName,
      description: `The documents of the "${t.title}" template.`,
    })
    .select("id")
    .single();
  if (error || !kb) return null;

  const inserted: Array<{
    id: string;
    knowledge_base_id: string;
    user_id: string | null;
    is_sample: boolean | null;
    content: string | null;
  }> = [];
  for (const d of t.seedDocuments) {
    const { data: row } = await db
      .from("knowledge_documents")
      .insert({
        user_id: userId,
        knowledge_base_id: kb.id,
        name: d.name,
        content: d.content,
        metadata: { source: "template_seed", template_id: t.id },
      })
      .select("id, knowledge_base_id, user_id, is_sample, content")
      .single();
    if (row) inserted.push(row);
  }
  // Embedded now so the agent can search them on its first question. Best
  // effort: without an embedding model the documents are still there, and the
  // knowledge base page can embed them later.
  const embed = inserted.length > 0 ? await resolveEmbedArgs(userId) : null;
  if (embed) {
    try {
      await embedAndStoreDocuments({ sb: db, docs: inserted, ...embed, userId });
    } catch (err) {
      console.warn("[templates.provision] embedding failed:", err);
    }
  }
  return kb.id;
}

async function ensureApprovalSeed(db: Db, userId: string, agentId: string, t: RealTemplate) {
  if (!t.approvalSeed) return;
  const { data: existing } = await db
    .from("approvals")
    .select("id")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .eq("action_type", t.approvalSeed.action_type)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  if (existing) return;
  // An example to approve or refuse; nothing acts on its action type, so
  // deciding it changes only the approval itself.
  await db.from("approvals").insert({
    user_id: userId,
    agent_id: agentId,
    agent_name: t.title,
    action_title: t.approvalSeed.action_title,
    action_type: t.approvalSeed.action_type,
    risk_level: t.approvalSeed.risk_level,
    description: t.approvalSeed.description,
    payload: t.approvalSeed.payload as never,
    status: "pending",
  });
}

/** The caller's agent made from this template, if they have one. */
export async function findTemplateAgent(
  db: Db,
  userId: string,
  templateId: string,
): Promise<{ id: string; knowledge_base_id: string | null } | null> {
  const { data } = await db
    .from("agents")
    .select("id, knowledge_base_id")
    .eq("user_id", userId)
    .eq(TEMPLATE_ID_COLUMN as "id", templateId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function provisionAgentTemplate(
  db: Db,
  userId: string,
  templateId: string,
): Promise<ProvisionResult> {
  const t = getRealTemplate(templateId);
  if (!t) return { ok: false, status: 404, error: "There is no agent template by that name." };

  // Using a template twice opens the agent made the first time. It used to
  // write the template over it again, discarding whatever the person had
  // changed since.
  const existing = await findTemplateAgent(db, userId, t.id);
  if (existing) {
    return {
      ok: true,
      agentId: existing.id,
      knowledgeBaseId: existing.knowledge_base_id,
      templateId: t.id,
      reused: true,
    };
  }

  const kbId = t.existingKnowledgeBaseId || (await ensureKnowledgeBase(db, userId, t));

  // A template that declares web search gets both built-in web tools: the
  // prompts ask for pages as well as searches.
  const hasWebTool = t.tools.some((x) => x.type === "web_search");
  const builtInTools: Record<string, boolean> = { ...(t.extraBuiltInTools ?? {}) };
  const toolConfigs: Record<string, Record<string, string>> = {};
  if (hasWebTool) {
    builtInTools.web_search = true;
    builtInTools.web_browse = true;
    toolConfigs.web_search = { provider: "firecrawl_builtin" };
    toolConfigs.web_browse = { provider: "firecrawl_builtin" };
  }
  // Vector search over the knowledge base, unless the template chose graph
  // search only.
  if (kbId && !builtInTools.kb_graph_search) builtInTools.kb_search = true;
  const tools: Record<string, unknown> = {
    knowledgeBaseIds: kbId ? [kbId] : [],
    humanApproval: t.tools.some((x) => x.type === "human_approval"),
    guardrails: t.guardrails,
    templateId: t.id,
    builtInTools,
    toolConfigs,
  };
  if (t.skillTourId) tools.skillTourId = t.skillTourId;

  const { data: agent, error } = await db
    .from("agents")
    .insert({
      user_id: userId,
      name: templateAgentName(t),
      // The template's id is kept in tools.templateId (below), where the
      // lookups read it; the description is for people.
      description: t.tagline,
      system_prompt: t.systemPrompt,
      llm_provider: t.provider,
      llm_model: t.modelId,
      temperature: t.temperature,
      max_tokens: t.guardrails.maxTokens,
      knowledge_base_id: kbId,
      tools: tools as never,
      is_active: true,
    })
    .select("id")
    .single();
  if (error || !agent) {
    return { ok: false, status: 500, error: error?.message || "The agent could not be made." };
  }

  await ensureApprovalSeed(db, userId, agent.id, t);
  return { ok: true, agentId: agent.id, knowledgeBaseId: kbId, templateId: t.id, reused: false };
}
