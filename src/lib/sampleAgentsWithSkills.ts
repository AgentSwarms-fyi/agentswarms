// Curated, ready-to-chat sample agents that showcase the Skill Library.
//
// Each entry maps to a real public.agents row. We tag the row in two ways:
//   - description ends with " [skill-sample:<id>]" so we can detect / upgrade
//     it later without creating duplicates (same trick as the demo starter).
//   - tools.skillTourId carries the same id so the Playground tour overlay
//     can pick it up at runtime.
//
// The skills referenced here are the read-only sample skills shipped in
// src/lib/sampleSkills.ts. Their ids start with "sample:" — chat.ts knows
// how to resolve those without hitting the agent_skills table.

import { supabase } from "@/integrations/supabase/client";
import { SAMPLE_SKILL_BY_ID } from "@/lib/sampleSkills";

export type SampleAgentTourStep = {
  id: string;
  title: string;
  body: string;
  // Suggested user message for this step. The Playground exposes a one-click
  // "Use suggested prompt" button.
  suggestedPrompt?: string;
};

export type SampleAgentWithSkills = {
  /** Stable id used in description tag + tools.skillTourId. */
  id: string;
  name: string;
  /** Short description (the "[skill-sample:<id>]" tag is appended automatically). */
  description: string;
  systemPrompt: string;
  /** Sample-skill ids from SAMPLE_SKILLS. */
  skillIds: string[];
  /** Optional built-in tool toggles (e.g. { kb_graph_search: true }). */
  builtInTools?: Record<string, boolean>;
  /** Optional knowledge base ids to wire into the agent. */
  knowledgeBaseIds?: string[];
  /** Model id served via the instance default (OpenRouter) — no extra credentials required. */
  model?: string;
  temperature?: number;
  /** Steps shown in the right-side guided tour panel. */
  tour: {
    headline: string;
    subhead: string;
    steps: SampleAgentTourStep[];
  };
};

const DEFAULT_MODEL = "google/gemini-3-flash-preview";

export const SAMPLE_AGENTS_WITH_SKILLS: SampleAgentWithSkills[] = [
  {
    id: "sql-reviewer",
    name: "Sample · SQL Reviewer",
    description:
      "Reviews SQL for safety + performance. Demonstrates a single focused Skill driving the whole behaviour.",
    systemPrompt:
      "You are a senior database engineer. Be concise and direct. Stay strictly within SQL review — politely refuse unrelated tasks.",
    skillIds: ["sample:sql-analyst"],
    model: DEFAULT_MODEL,
    temperature: 0.2,
    tour: {
      headline: "One Skill, real behaviour",
      subhead:
        "This agent has a tiny system prompt. Almost everything you'll see comes from the attached 'SQL Analyst' skill.",
      steps: [
        {
          id: "fire-prompt",
          title: "Fire the suggested prompt",
          body: "Click the suggested prompt to ask for a review of a deliberately-bad query. Watch the agent follow the skill's exact output structure.",
          suggestedPrompt:
            "Review this query and tell me what's wrong:\n\nSELECT * FROM users WHERE created_at > '2024-01-01';\nUPDATE users SET premium = true;",
        },
        {
          id: "structure-check",
          title: "Notice the structure",
          body: "The reply should follow the skill's contract: identified issues, a rewritten query, and a short justification. That format isn't in the system prompt — it's coming from the skill.",
        },
        {
          id: "detach-test",
          title: "Try detaching the skill",
          body: "Open /agents → edit this agent → Skills → remove 'SQL Analyst' → save. Re-ask the same question. The agent will still answer, but the discipline (format, anti-patterns checklist) disappears. That's how you know the skill is doing real work.",
        },
      ],
    },
  },
  {
    id: "support-agent",
    name: "Sample · Support Agent (with Tone + Refusal)",
    description:
      "A friendly support assistant. Demonstrates stacking multiple Skills (tone + refusal policy + JSON discipline).",
    systemPrompt:
      "You are a customer support assistant for AgentSwarms. Help users understand the product. Never invent features. If you don't know, say so.",
    skillIds: ["sample:support-tone", "sample:json-only"],
    model: DEFAULT_MODEL,
    temperature: 0.4,
    tour: {
      headline: "Skills compose",
      subhead:
        "Two skills are attached. They control how the agent talks AND how it formats sensitive replies — without bloating the system prompt.",
      steps: [
        {
          id: "ask-friendly",
          title: "Ask a normal support question",
          body: "The reply should sound friendly and concrete — that's the 'Support Tone' skill at work. Without it, the same model is noticeably more clinical.",
          suggestedPrompt:
            "Hi! I'm completely new — what's the difference between an Agent and a Swarm here?",
        },
        {
          id: "ask-json",
          title: "Now ask for structured output",
          body: "Ask for the answer in JSON. The 'JSON Only' skill takes over and the agent will return strict, parseable JSON without any chatty wrapper text.",
          suggestedPrompt:
            "Give me a JSON object with two fields: 'agent' and 'swarm', each containing a 1-sentence definition.",
        },
        {
          id: "stack-effect",
          title: "Notice both skills are active simultaneously",
          body: "Skills don't conflict here — tone applies to natural-language replies, JSON discipline kicks in only when JSON is requested. That's the win over one giant prompt: rules stay independent and triggerable.",
        },
      ],
    },
  },
  {
    id: "research-synth",
    name: "Sample · Research Synthesizer",
    description:
      "Summarises sources into a structured brief. Demonstrates a Skill that enforces an output format.",
    systemPrompt:
      "You are a careful research assistant. Synthesize information accurately. If you don't have enough information to answer, say so explicitly.",
    skillIds: ["sample:research-synthesizer", "sample:step-by-step-debugger"],
    model: DEFAULT_MODEL,
    temperature: 0.3,
    tour: {
      headline: "Format-enforcing skills",
      subhead:
        "The 'Research Synthesizer' skill forces a TL;DR + bullets + open-questions structure. Pair it with the 'Step-by-step debugger' for a richer reasoning trail.",
      steps: [
        {
          id: "fire-prompt",
          title: "Ask it to synthesize a topic",
          body: "Click the suggested prompt. The agent will produce a brief in the exact 4-section format the skill prescribes.",
          suggestedPrompt:
            "Summarise the key trade-offs between RAG and long-context windows for production agent systems. Include open questions.",
        },
        {
          id: "explain-rigor",
          title: "Notice the rigor",
          body: "TL;DR, key points, evidence, open questions — the structure is consistent every single time. That's a contract, not a happy accident.",
        },
        {
          id: "edit-skill",
          title: "Make it yours",
          body: "Want a different output format? Open /skills, fork the sample into your own library, edit the markdown, and attach the new version to the agent. No system-prompt rewrite required.",
        },
      ],
    },
  },
  {
    id: "graph-rag-explorer",
    name: "Sample · Graph RAG Explorer (Acme Corp)",
    description:
      "Answers questions over a pre-built entity-relation knowledge graph. Demonstrates the kb_graph_search tool against the Acme Corp Graph RAG demo KB.",
    systemPrompt:
      "You are a Graph RAG analyst exploring the Acme Corp knowledge graph. " +
      "ALWAYS call the kb_graph_search tool first to retrieve a 1–2 hop subgraph around the entities mentioned in the user's question. " +
      "Quote the entity and relation names returned by the tool verbatim — never invent connections. " +
      "Structure replies as: (1) a short direct answer, (2) the supporting graph path (Entity → relation → Entity), and (3) any open questions if the graph is incomplete. " +
      "If the graph returns nothing, say so explicitly instead of guessing.",
    skillIds: [],
    builtInTools: { kb_graph_search: true },
    knowledgeBaseIds: ["094555b1-77db-4121-9cee-36b6e46a2990"],
    model: DEFAULT_MODEL,
    temperature: 0.2,
    tour: {
      headline: "Multi-hop Graph RAG in action",
      subhead:
        "This agent is wired to the 'Graph RAG Demo — Acme Corp' knowledge base with the kb_graph_search tool enabled. Try the prompts below to see entity-relation traversal, not just text similarity.",
      steps: [
        {
          id: "ask-people",
          title: "Step 1 — Ask about a person",
          body: "Start with a simple entity lookup. The agent will call kb_graph_search and return the people connected to Acme Corp along with their roles.",
          suggestedPrompt: "Who works at Acme Corp and what are their roles?",
        },
        {
          id: "ask-projects",
          title: "Step 2 — Traverse to projects",
          body: "Now ask a question that requires hopping from people → projects. The graph search returns the relations, and the agent follows them.",
          suggestedPrompt:
            "Which projects is the engineering team at Acme Corp working on, and who leads each one?",
        },
        {
          id: "ask-multi-hop",
          title: "Step 3 — Multi-hop reasoning",
          body: "Finish with a 2-hop question that pure vector search would struggle with. The agent should walk Person → Project → Technology and quote the path.",
          suggestedPrompt:
            "What technologies are used by projects led by Acme Corp's engineering managers?",
        },
        {
          id: "compare-vector",
          title: "Why graph beats plain RAG here",
          body: "Plain kb_search would return chunks containing the keywords. kb_graph_search returns a structured subgraph, so the agent can reason about relationships (who → leads → what → uses → which). Open the Knowledge → Graph tab on the Acme Corp KB to inspect the underlying entities and edges.",
        },
      ],
    },
  },
];

/** Markdown tag we append to `description` so we can detect/upgrade later. */
function tagFor(sampleId: string): string {
  return `[skill-sample:${sampleId}]`;
}

/** The first part of `description` (without the trailing tag). */
function descriptionWithTag(sample: SampleAgentWithSkills): string {
  return `${sample.description} ${tagFor(sample.id)}`;
}

export function isSkillSampleAgentDescription(desc: string | null | undefined): string | null {
  if (!desc) return null;
  const m = desc.match(/\[skill-sample:([a-z0-9-]+)\]/i);
  return m ? m[1] : null;
}

/**
 * Idempotently seed the sample agents for the current authenticated user.
 * Returns the number of agents inserted (0 if everything already existed).
 *
 * Skips silently if the user is not authenticated.
 */
/**
 * Collapses concurrent calls into one.
 *
 * The seed is a check-then-act: read the user's agents, work out which samples
 * are missing, insert those. Idempotent when calls are SEQUENTIAL, and not when
 * they overlap — both reads see the same "missing" set and both insert.
 *
 * That is not hypothetical. The account this was found on has two copies of
 * "Sample · Graph RAG Explorer (Acme Corp)" carrying the same tag and the same
 * created_at, to the second. React StrictMode double-invokes effects in dev,
 * and the caller's sessionStorage guard is written AFTER its await, so the
 * whole seeding duration is an open window.
 *
 * This closes it within one tab. Two tabs racing each other still needs a
 * database constraint — see the note in ensureSampleAgents below.
 */
let seedInFlight: Promise<number> | null = null;

export function ensureSampleAgentsForUser(): Promise<number> {
  seedInFlight ??= ensureSampleAgents().finally(() => {
    seedInFlight = null;
  });
  return seedInFlight;
}

/**
 * The seed itself.
 *
 * NOT SAFE AGAINST TWO BROWSER TABS. The only complete fix is a uniqueness
 * constraint in the database — the sample tag lives inside `description`, so
 * that means either a unique index on the extracted tag or a real column for
 * it. Worth doing; it needs a migration, so it is not done here.
 */
async function ensureSampleAgents(): Promise<number> {
  const { data: sess } = await supabase.auth.getSession();
  const userId = sess.session?.user?.id;
  if (!userId) return 0;

  // Pull every existing agent's description ONCE so we can match by tag.
  const { data: existing, error: fetchErr } = await supabase
    .from("agents")
    .select("id, description")
    .eq("user_id", userId);
  if (fetchErr) {
    console.warn("[sampleAgentsWithSkills] fetch failed:", fetchErr.message);
    return 0;
  }

  const existingTagIds = new Set<string>();
  for (const row of existing ?? []) {
    const id = isSkillSampleAgentDescription(row.description);
    if (id) existingTagIds.add(id);
  }

  const toInsert = SAMPLE_AGENTS_WITH_SKILLS.filter((s) => !existingTagIds.has(s.id));
  if (toInsert.length === 0) return 0;

  // Filter skill ids to ones we actually ship — protects against future
  // typos breaking the seed.
  const rows = toInsert.map((s) => {
    const validSkillIds = s.skillIds.filter((id) => SAMPLE_SKILL_BY_ID[id]);
    const tools = {
      builtInTools: { ...(s.builtInTools ?? {}) },
      toolConfigs: {},
      knowledgeBaseIds: [...(s.knowledgeBaseIds ?? [])],
      skillIds: validSkillIds,
      skillTourId: s.id,
    };
    return {
      user_id: userId,
      name: s.name,
      description: descriptionWithTag(s),
      system_prompt: s.systemPrompt,
      llm_provider: "openrouter" as const,
      llm_model: s.model || DEFAULT_MODEL,
      temperature: typeof s.temperature === "number" ? s.temperature : 0.4,
      max_tokens: 4096,
      tools: tools as unknown as never,
      is_active: true,
    };
  });

  const { error: insertErr } = await supabase.from("agents").insert(rows);
  if (insertErr) {
    console.warn("[sampleAgentsWithSkills] insert failed:", insertErr.message);
    return 0;
  }
  return rows.length;
}

export function getSampleAgentByTourId(
  id: string | null | undefined,
): SampleAgentWithSkills | null {
  if (!id) return null;
  return SAMPLE_AGENTS_WITH_SKILLS.find((s) => s.id === id) ?? null;
}
