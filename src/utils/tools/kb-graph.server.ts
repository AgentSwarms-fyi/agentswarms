// Graph RAG retrieval helper.
//
// Sits next to retrieveCitationsServer (the keyword RAG path) and answers
// the question: "given a query, which entities are involved and what are
// their 1-2 hop neighbours in the graph?"
//
// We never embed — match is lexical (normalized name + ILIKE on terms).
// That's fine for v1: extraction-time normalization gives most queries a
// direct hit, and 2-hop expansion picks up the rest.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "it",
  "as",
  "at",
  "by",
  "from",
  "what",
  "how",
  "why",
  "when",
  "who",
  "which",
  "do",
  "does",
  "did",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "me",
  "us",
  "them",
  "my",
  "your",
  "our",
  "their",
  "can",
  "will",
  "would",
  "should",
  "could",
  "whom",
  "about",
  "into",
  "over",
  "under",
]);

export type GraphEntity = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  mention_count: number;
};

export type GraphTriple = {
  source: string;
  predicate: string;
  target: string;
};

export type GraphContext = {
  subgraph: GraphTriple[];
  entityFacts: Array<{
    entity: string;
    type: string;
    description: string | null;
    snippets: Array<{ snippet: string; document: string | null }>;
  }>;
  citations: Array<{
    index: number;
    documentId: string | null;
    documentName: string;
    knowledgeBaseId: string;
    knowledgeBaseName: string;
    snippet: string;
  }>;
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function retrieveGraphContextServer(opts: {
  sb: SupabaseClient<Database>;
  agentId?: string | null;
  extraKbIds?: string[];
  query: string;
  maxNodes?: number;
}): Promise<GraphContext> {
  const { sb } = opts;
  const maxNodes = Math.max(5, Math.min(opts.maxNodes ?? 30, 60));

  // Resolve KB ids — agent's saved KB plus any extras passed by the swarm node.
  const kbIds: string[] = [];
  if (opts.agentId) {
    const { data: agent } = await sb
      .from("agents")
      .select("knowledge_base_id, tools")
      .eq("id", opts.agentId)
      .maybeSingle();
    if (agent) {
      const t = (agent.tools ?? {}) as { knowledgeBaseIds?: unknown };
      const fromTools = Array.isArray(t.knowledgeBaseIds)
        ? (t.knowledgeBaseIds as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      if (agent.knowledge_base_id) kbIds.push(agent.knowledge_base_id);
      kbIds.push(...fromTools);
    }
  }
  for (const id of opts.extraKbIds ?? []) {
    if (typeof id === "string" && id) kbIds.push(id);
  }
  const uniqKbIds = Array.from(new Set(kbIds));
  if (uniqKbIds.length === 0) {
    return { subgraph: [], entityFacts: [], citations: [] };
  }

  // Fetch KB labels for citation display.
  const { data: kbRows } = await sb.from("knowledge_bases").select("id, name").in("id", uniqKbIds);
  const kbName = new Map((kbRows ?? []).map((k) => [k.id, k.name]));

  // Tokenize query for lexical matching.
  const norm = normalize(opts.query);
  const terms = Array.from(new Set(norm.split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t))));
  if (terms.length === 0) {
    return { subgraph: [], entityFacts: [], citations: [] };
  }

  // Step 1 — find seed entities by exact normalized_name match OR fuzzy ILIKE.
  // We OR exact matches with substring matches; cap to keep the expansion
  // cheap.
  const orFilters: string[] = [];
  for (const t of terms) {
    orFilters.push(`normalized_name.eq.${t}`);
    orFilters.push(`normalized_name.ilike.%${t}%`);
  }
  const { data: seedRows } = await sb
    .from("kb_graph_entities")
    .select("id, name, type, description, mention_count, knowledge_base_id")
    .in("knowledge_base_id", uniqKbIds)
    .or(orFilters.join(","))
    .order("mention_count", { ascending: false })
    .limit(20);

  if (!seedRows || seedRows.length === 0) {
    return { subgraph: [], entityFacts: [], citations: [] };
  }

  const seedIds = seedRows.map((r) => r.id);

  // Step 2 — pull all relations touching the seeds (one hop).
  const { data: rel1 } = await sb
    .from("kb_graph_relations")
    .select("source_entity_id, target_entity_id, predicate, weight, document_id")
    .in("knowledge_base_id", uniqKbIds)
    .or(`source_entity_id.in.(${seedIds.join(",")}),target_entity_id.in.(${seedIds.join(",")})`)
    .limit(150);

  const allEntityIds = new Set<string>(seedIds);
  for (const r of rel1 ?? []) {
    allEntityIds.add(r.source_entity_id);
    allEntityIds.add(r.target_entity_id);
    if (allEntityIds.size > maxNodes) break;
  }

  // Step 3 — second hop from non-seed neighbours (lighter cap).
  const hop2Seeds = Array.from(allEntityIds)
    .filter((id) => !seedIds.includes(id))
    .slice(0, 10);
  let rel2: typeof rel1 = [];
  if (hop2Seeds.length > 0 && allEntityIds.size < maxNodes) {
    const { data } = await sb
      .from("kb_graph_relations")
      .select("source_entity_id, target_entity_id, predicate, weight, document_id")
      .in("knowledge_base_id", uniqKbIds)
      .or(
        `source_entity_id.in.(${hop2Seeds.join(",")}),target_entity_id.in.(${hop2Seeds.join(",")})`,
      )
      .limit(80);
    rel2 = data ?? [];
    for (const r of rel2) {
      if (allEntityIds.size >= maxNodes) break;
      allEntityIds.add(r.source_entity_id);
      allEntityIds.add(r.target_entity_id);
    }
  }

  // Fetch entity rows for everything we touched.
  const entityIds = Array.from(allEntityIds);
  const { data: entityRows } = await sb
    .from("kb_graph_entities")
    .select("id, name, type, description, knowledge_base_id")
    .in("id", entityIds);
  const eMap = new Map((entityRows ?? []).map((e) => [e.id, e]));

  // Build triples (dedupe).
  const triplesSet = new Set<string>();
  const triples: GraphTriple[] = [];
  for (const r of [...(rel1 ?? []), ...rel2]) {
    const s = eMap.get(r.source_entity_id);
    const t = eMap.get(r.target_entity_id);
    if (!s || !t) continue;
    const key = `${s.id}|${r.predicate}|${t.id}`;
    if (triplesSet.has(key)) continue;
    triplesSet.add(key);
    triples.push({ source: s.name, predicate: r.predicate, target: t.name });
  }

  // Pull mentions for entity facts (top 1 snippet per entity).
  const { data: mentions } = await sb
    .from("kb_graph_mentions")
    .select("entity_id, snippet, document_id")
    .in("entity_id", entityIds)
    .limit(200);

  const docIds = Array.from(
    new Set((mentions ?? []).map((m) => m.document_id).filter((d): d is string => !!d)),
  );
  const { data: docRows } = docIds.length
    ? await sb.from("knowledge_documents").select("id, name").in("id", docIds)
    : { data: [] as Array<{ id: string; name: string }> };
  const docName = new Map((docRows ?? []).map((d) => [d.id, d.name]));

  const factsByEntity = new Map<
    string,
    {
      entity: string;
      type: string;
      description: string | null;
      snippets: Array<{ snippet: string; document: string | null }>;
    }
  >();
  for (const id of entityIds) {
    const e = eMap.get(id);
    if (!e) continue;
    factsByEntity.set(id, {
      entity: e.name,
      type: e.type,
      description: e.description,
      snippets: [],
    });
  }
  for (const m of mentions ?? []) {
    const f = factsByEntity.get(m.entity_id);
    if (!f || f.snippets.length >= 2) continue;
    f.snippets.push({
      snippet: m.snippet,
      document: m.document_id ? (docName.get(m.document_id) ?? null) : null,
    });
  }

  // Citations — one per entity that had a snippet, capped.
  const citations: GraphContext["citations"] = [];
  let i = 1;
  for (const [eid, f] of factsByEntity) {
    if (f.snippets.length === 0) continue;
    const e = eMap.get(eid);
    if (!e) continue;
    const m = (mentions ?? []).find((mm) => mm.entity_id === eid);
    citations.push({
      index: i++,
      documentId: m?.document_id ?? null,
      documentName: m?.document_id ? (docName.get(m.document_id) ?? "Document") : "Document",
      knowledgeBaseId: e.knowledge_base_id,
      knowledgeBaseName: kbName.get(e.knowledge_base_id) || "Knowledge Base",
      snippet: f.snippets[0].snippet,
    });
    if (citations.length >= 8) break;
  }

  return {
    subgraph: triples,
    entityFacts: Array.from(factsByEntity.values())
      .filter((f) => f.snippets.length > 0)
      .slice(0, 25),
    citations,
  };
}
