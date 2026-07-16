// POST /api/kb/build-graph
//
// Builds a Graph RAG knowledge graph for a knowledge base by extracting
// entities and relations from each document via OpenRouter.
//
// MODEL: hardcoded to `google/gemini-2.5-flash` for v1 (fast + cheap, JSON
// mode reliable). A user-facing model picker will be added later.
//
// Steps:
//   1. Verify caller owns the KB (sample KBs cannot be rebuilt by users).
//   2. Wipe any existing graph for this KB.
//   3. Stream docs in chunks (~3k chars), prompting Gemini to return JSON
//      { entities:[{name,type,description}], relations:[{source,predicate,target}] }.
//   4. Normalize, upsert entities (mention_count++), dedupe relations,
//      store one snippet per mention.
//   5. Update knowledge_bases.kb_graph_status = 'ready'.
//
// Hard caps to bound cost:
//   - 200 docs max per build
//   - 3 chunks per doc max
//   - 50 entities + 80 relations per chunk

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  OPENROUTER_CHAT_URL,
  getOpenRouterApiKey,
} from "@/utils/providers/openrouterDefault.server";

const Body = z.object({
  knowledge_base_id: z.string().uuid(),
});

const EXTRACTION_MODEL = "google/gemini-2.5-flash";
const CHUNK_SIZE = 3000;
const MAX_DOCS = 200;
const MAX_CHUNKS_PER_DOC = 3;
const MAX_ENTITIES_PER_CHUNK = 50;
const MAX_RELATIONS_PER_CHUNK = 80;

const ALLOWED_TYPES = [
  "person",
  "org",
  "product",
  "concept",
  "location",
  "event",
  "other",
] as const;

type ExtractedEntity = { name: string; type: string; description?: string };
type ExtractedRelation = { source: string; predicate: string; target: string };
type ExtractionResult = { entities: ExtractedEntity[]; relations: ExtractedRelation[] };

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chunkText(text: string, size: number, max: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length && chunks.length < max; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function snippetFor(text: string, term: string, radius = 140): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx === -1)
    return text
      .slice(0, radius * 2)
      .replace(/\s+/g, " ")
      .trim();
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  return (
    (start > 0 ? "…" : "") +
    text.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < text.length ? "…" : "")
  );
}

async function extractFromChunk(chunk: string, apiKey: string): Promise<ExtractionResult> {
  const prompt = `Extract entities and relations from the text below.

Rules:
- Only include things explicitly stated in the text.
- Entity types must be one of: ${ALLOWED_TYPES.join(", ")}.
- Predicates should be short verb phrases in snake_case (e.g. works_on, depends_on, owned_by, leads, member_of, founded_by, replaced, in_scope_for).
- Both source and target of each relation MUST appear in the entities list.
- Skip pronouns, generic terms, and dates as standalone entities.
- Return strictly valid JSON matching this shape:
{
  "entities": [{"name": "string", "type": "person|org|product|concept|location|event|other", "description": "short string"}],
  "relations": [{"source": "string", "predicate": "snake_case_verb", "target": "string"}]
}

TEXT:
${chunk}`;

  const res = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a precise information extraction system that returns only valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Gemini extraction failed [${res.status}]: ${txt.slice(0, 200)}`);
  }

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content?.trim() || "{}";

  let parsed: ExtractionResult;
  try {
    parsed = JSON.parse(content) as ExtractionResult;
  } catch {
    return { entities: [], relations: [] };
  }

  const entities = (Array.isArray(parsed.entities) ? parsed.entities : [])
    .filter((e) => e && typeof e.name === "string" && e.name.trim().length > 0)
    .slice(0, MAX_ENTITIES_PER_CHUNK)
    .map((e) => ({
      name: e.name.trim(),
      type: ALLOWED_TYPES.includes(e.type as (typeof ALLOWED_TYPES)[number]) ? e.type : "other",
      description:
        typeof e.description === "string" ? e.description.trim().slice(0, 280) : undefined,
    }));

  const relations = (Array.isArray(parsed.relations) ? parsed.relations : [])
    .filter(
      (r) =>
        r &&
        typeof r.source === "string" &&
        typeof r.target === "string" &&
        typeof r.predicate === "string" &&
        r.source.trim() &&
        r.target.trim() &&
        r.predicate.trim(),
    )
    .slice(0, MAX_RELATIONS_PER_CHUNK)
    .map((r) => ({
      source: r.source.trim(),
      predicate: r.predicate.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 60),
      target: r.target.trim(),
    }));

  return { entities, relations };
}

export const Route = createFileRoute("/api/kb/build-graph")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("Authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token) return Response.json({ error: "Not signed in" }, { status: 401 });

        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Invalid request body" },
            { status: 400 },
          );
        }

        const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const openRouterKey = getOpenRouterApiKey();
        if (!supabaseUrl || !serviceKey) {
          return Response.json({ error: "Backend misconfigured" }, { status: 500 });
        }
        if (!openRouterKey) {
          return Response.json(
            { error: "AI gateway is not configured. Contact support." },
            { status: 500 },
          );
        }

        const userClient = createClient(supabaseUrl, process.env.SUPABASE_PUBLISHABLE_KEY || "", {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: userRes } = await userClient.auth.getUser();
        const user = userRes?.user;
        if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

        const admin = createClient(supabaseUrl, serviceKey);

        // Verify ownership.
        const { data: kb } = await admin
          .from("knowledge_bases")
          .select("id, user_id, is_sample")
          .eq("id", body.knowledge_base_id)
          .maybeSingle();
        if (!kb) return Response.json({ error: "Knowledge base not found" }, { status: 404 });
        if (kb.is_sample) {
          return Response.json(
            { error: "Sample knowledge bases come pre-built. Create your own to rebuild a graph." },
            { status: 403 },
          );
        }
        if (kb.user_id !== user.id) {
          return Response.json({ error: "Not authorized" }, { status: 403 });
        }

        // Mark building.
        await admin
          .from("knowledge_bases")
          .update({ kb_graph_status: "building", kb_graph_error: null })
          .eq("id", body.knowledge_base_id);

        // Wipe prior graph (entities cascade to relations + mentions).
        await admin
          .from("kb_graph_entities")
          .delete()
          .eq("knowledge_base_id", body.knowledge_base_id);

        // Load docs.
        const { data: docs } = await admin
          .from("knowledge_documents")
          .select("id, name, content")
          .eq("knowledge_base_id", body.knowledge_base_id)
          .limit(MAX_DOCS);

        if (!docs || docs.length === 0) {
          await admin
            .from("knowledge_bases")
            .update({ kb_graph_status: "error", kb_graph_error: "No documents to extract from." })
            .eq("id", body.knowledge_base_id);
          return Response.json(
            { error: "No documents in this knowledge base. Add documents first." },
            { status: 422 },
          );
        }

        // Aggregate per-KB.
        const entityMap = new Map<
          string, // key = `${normalized}|${type}`
          {
            name: string;
            normalized: string;
            type: string;
            description: string | null;
            mention_count: number;
          }
        >();
        const relationSet = new Map<
          string, // key = `${srcKey}|${predicate}|${tgtKey}`
          {
            srcKey: string;
            tgtKey: string;
            predicate: string;
            document_id: string | null;
            weight: number;
          }
        >();
        type PendingMention = { entityKey: string; document_id: string; snippet: string };
        const mentions: PendingMention[] = [];

        let chunksProcessed = 0;
        let chunksFailed = 0;

        for (const doc of docs) {
          const text = (doc.content || "").trim();
          if (!text) continue;
          const chunks = chunkText(text, CHUNK_SIZE, MAX_CHUNKS_PER_DOC);

          for (const chunk of chunks) {
            try {
              const { entities, relations } = await extractFromChunk(chunk, openRouterKey);
              chunksProcessed += 1;

              const localKey = new Map<string, string>(); // raw name -> entity key
              for (const e of entities) {
                const norm = normalize(e.name);
                if (!norm) continue;
                const key = `${norm}|${e.type}`;
                localKey.set(e.name, key);
                const existing = entityMap.get(key);
                if (existing) {
                  existing.mention_count += 1;
                  if (!existing.description && e.description) existing.description = e.description;
                } else {
                  entityMap.set(key, {
                    name: e.name,
                    normalized: norm,
                    type: e.type,
                    description: e.description ?? null,
                    mention_count: 1,
                  });
                }
                mentions.push({
                  entityKey: key,
                  document_id: doc.id,
                  snippet: snippetFor(chunk, e.name),
                });
              }

              for (const r of relations) {
                const srcKey = localKey.get(r.source);
                const tgtKey = localKey.get(r.target);
                if (!srcKey || !tgtKey) continue;
                const k = `${srcKey}|${r.predicate}|${tgtKey}`;
                const existing = relationSet.get(k);
                if (existing) {
                  existing.weight += 1;
                } else {
                  relationSet.set(k, {
                    srcKey,
                    tgtKey,
                    predicate: r.predicate,
                    document_id: doc.id,
                    weight: 1,
                  });
                }
              }
            } catch (err) {
              chunksFailed += 1;
              console.warn(`[build-graph] chunk failed: ${(err as Error).message}`);
            }
          }
        }

        if (entityMap.size === 0) {
          await admin
            .from("knowledge_bases")
            .update({
              kb_graph_status: "error",
              kb_graph_error: `Extraction returned no entities (${chunksFailed} chunks failed).`,
            })
            .eq("id", body.knowledge_base_id);
          return Response.json(
            {
              error:
                "Extraction returned no entities. Documents may be too short or extraction quota was hit.",
            },
            { status: 422 },
          );
        }

        // Insert entities.
        const entityRows = Array.from(entityMap.entries()).map(([key, v]) => ({
          key,
          row: {
            knowledge_base_id: body.knowledge_base_id,
            user_id: user.id,
            name: v.name,
            normalized_name: v.normalized,
            type: v.type,
            description: v.description,
            mention_count: v.mention_count,
            is_sample: false,
          },
        }));

        const { data: insertedEntities, error: entErr } = await admin
          .from("kb_graph_entities")
          .insert(entityRows.map((r) => r.row))
          .select("id, normalized_name, type");
        if (entErr || !insertedEntities) {
          await admin
            .from("knowledge_bases")
            .update({
              kb_graph_status: "error",
              kb_graph_error: entErr?.message || "Failed to insert entities",
            })
            .eq("id", body.knowledge_base_id);
          return Response.json(
            { error: entErr?.message || "Failed to insert entities" },
            { status: 500 },
          );
        }

        const keyToId = new Map<string, string>();
        for (const e of insertedEntities) {
          keyToId.set(`${e.normalized_name}|${e.type}`, e.id);
        }

        // Insert relations (resolve keys to ids).
        const relRows = Array.from(relationSet.values())
          .map((r) => {
            const sId = keyToId.get(r.srcKey);
            const tId = keyToId.get(r.tgtKey);
            if (!sId || !tId || sId === tId) return null;
            return {
              knowledge_base_id: body.knowledge_base_id,
              user_id: user.id,
              source_entity_id: sId,
              target_entity_id: tId,
              predicate: r.predicate,
              weight: r.weight,
              document_id: r.document_id,
              is_sample: false,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);

        let relInserted = 0;
        if (relRows.length > 0) {
          const { error: relErr } = await admin.from("kb_graph_relations").insert(relRows);
          if (relErr) {
            console.warn(`[build-graph] relations insert error: ${relErr.message}`);
          } else {
            relInserted = relRows.length;
          }
        }

        // Insert mentions (cap to ~3 per entity).
        const perEntity = new Map<string, number>();
        const mentionRows = mentions
          .map((m) => {
            const id = keyToId.get(m.entityKey);
            if (!id) return null;
            const cur = perEntity.get(id) ?? 0;
            if (cur >= 3) return null;
            perEntity.set(id, cur + 1);
            return {
              entity_id: id,
              document_id: m.document_id,
              snippet: m.snippet,
              is_sample: false,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        if (mentionRows.length > 0) {
          await admin.from("kb_graph_mentions").insert(mentionRows);
        }

        await admin
          .from("knowledge_bases")
          .update({
            kb_graph_status: "ready",
            kb_graph_built_at: new Date().toISOString(),
            kb_graph_error: null,
          })
          .eq("id", body.knowledge_base_id);

        return Response.json({
          ok: true,
          entities: insertedEntities.length,
          relations: relInserted,
          mentions: mentionRows.length,
          chunks_processed: chunksProcessed,
          chunks_failed: chunksFailed,
          model: EXTRACTION_MODEL,
        });
      },
    },
  },
});
