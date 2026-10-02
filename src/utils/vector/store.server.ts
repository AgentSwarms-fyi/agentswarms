// Which store this deployment is using, and the one place that decides.
//
// Every caller asks here rather than reading the environment itself, so
// "pgvector unless Qdrant is configured AND selected" is written once. The
// asymmetry is on purpose: selecting `qdrant` without a URL is a mistake worth
// reporting, not worth silently working around, because the deployment that
// made it believes its vectors are somewhere they are not.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolveRetrievalSettings, type VectorStoreChoice } from "@/lib/kbRag";
import { pgvectorStore } from "./pgvector.server";
import { qdrantConfig, qdrantStore } from "./qdrant.server";
import { resolveStoreKind, type VectorStore, type VectorStoreKind } from "./types";

type Client = SupabaseClient<Database>;

/** What the operator asked for, whether or not it can be honoured. */
export function selectedStoreKind(): VectorStoreKind {
  return resolveStoreKind(process.env.VECTOR_STORE);
}

/**
 * The store to use for this request.
 *
 * `sb` is the CALLER'S client, and it is what makes pgvector's row-level
 * security apply. It is passed even on the Qdrant path because the fallback
 * below needs it too.
 */
export function vectorStore(sb: Client): VectorStore {
  return storeFor(selectedStoreKind(), sb);
}

/**
 * The adapter for a NAMED store, for callers that know which one they want —
 * a collection that chose its own index rather than following the instance.
 * Falling back to pgvector when Qdrant is asked for and not configured is the
 * same rule as the instance default, and is reported the same way.
 */
export function storeFor(kind: VectorStoreKind, sb: Client): VectorStore {
  if (kind !== "qdrant") return pgvectorStore(sb);
  const cfg = configuredQdrant();
  if (!cfg) {
    // Loud, and only here. Retrieval falling back to pgvector silently would
    // work — the vectors are still in `kb_chunks` — while every operator
    // reading the config believed the external store was in use.
    console.error(
      "[vector] VECTOR_STORE=qdrant but QDRANT_URL is not set; using pgvector. " +
        "Set QDRANT_URL, or unset VECTOR_STORE.",
    );
    return pgvectorStore(sb);
  }
  return qdrantStore(cfg);
}

/**
 * Qdrant's settings, or null when this deployment has none.
 *
 * Named one by one rather than handing over `process.env` wholesale: the
 * docs-freshness guard scans for literal `process.env.X` reads, so writing
 * them out is what makes each of these settings something the docs are
 * REQUIRED to mention. A bag passed by reference documents nothing.
 */
function configuredQdrant() {
  return qdrantConfig({
    QDRANT_URL: process.env.QDRANT_URL,
    QDRANT_API_KEY: process.env.QDRANT_API_KEY,
    QDRANT_COLLECTION: process.env.QDRANT_COLLECTION,
    QDRANT_REPLICATION: process.env.QDRANT_REPLICATION,
    QDRANT_SHARDS: process.env.QDRANT_SHARDS,
  });
}

/**
 * Whether an external store exists for a collection to be pointed at.
 *
 * A different question from which store this instance defaults to, and the
 * one that matters now that a collection chooses for itself: the cleanup and
 * rebuild paths ask this before touching a store, so a Postgres-only
 * deployment never logs a configuration error for a store it was never asked
 * to use, and a Qdrant-configured one is always cleaned even when its default
 * is Postgres.
 */
export function externalStoreConfigured(): boolean {
  return configuredQdrant() !== null;
}

export function vectorStoreIsExternal(kind: VectorStoreKind): boolean {
  return kind !== "pgvector";
}

/**
 * The store a COLLECTION uses, from what it chose and what the instance
 * defaults to. One function because the ingest path and the retrieval path
 * must agree: vectors written to one index and searched in another is a
 * collection that returns nothing, with no error anywhere.
 */
export function storeKindForChoice(choice: VectorStoreChoice | undefined): VectorStoreKind {
  if (!choice || choice === "default") return selectedStoreKind();
  return choice as VectorStoreKind;
}

/** Each collection's store, read from its saved retrieval settings. */
export async function storeKindByKnowledgeBase(
  sb: Client,
  knowledgeBaseIds: string[],
): Promise<Map<string, VectorStoreKind>> {
  const out = new Map<string, VectorStoreKind>();
  if (knowledgeBaseIds.length === 0) return out;
  try {
    const { data } = await sb
      .from("knowledge_bases")
      .select("id, retrieval_settings")
      .in("id", knowledgeBaseIds);
    for (const row of data ?? [])
      out.set(
        row.id,
        storeKindForChoice(resolveRetrievalSettings(row.retrieval_settings).vectorStore),
      );
  } catch {
    /* the instance default stands; a settings read must never break indexing */
  }
  for (const id of knowledgeBaseIds) if (!out.has(id)) out.set(id, selectedStoreKind());
  return out;
}
