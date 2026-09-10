// Which store this deployment is using, and the one place that decides.
//
// Every caller asks here rather than reading the environment itself, so
// "pgvector unless Qdrant is configured AND selected" is written once. The
// asymmetry is on purpose: selecting `qdrant` without a URL is a mistake worth
// reporting, not worth silently working around, because the deployment that
// made it believes its vectors are somewhere they are not.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
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
  if (selectedStoreKind() !== "qdrant") return pgvectorStore(sb);
  // Named one by one rather than handing over `process.env` wholesale: the
  // docs-freshness guard scans for literal `process.env.X` reads, so writing
  // them out is what makes each of these settings something the docs are
  // REQUIRED to mention. A bag passed by reference documents nothing.
  const cfg = qdrantConfig({
    QDRANT_URL: process.env.QDRANT_URL,
    QDRANT_API_KEY: process.env.QDRANT_API_KEY,
    QDRANT_COLLECTION: process.env.QDRANT_COLLECTION,
    QDRANT_REPLICATION: process.env.QDRANT_REPLICATION,
    QDRANT_SHARDS: process.env.QDRANT_SHARDS,
  });
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
 * True when chunk rows must also be written to a store outside Postgres.
 *
 * The ingest path asks this instead of asking which store it is: pgvector
 * needs no second write and every future store will.
 */
export function usesExternalStore(): boolean {
  return vectorStoreIsExternal(selectedStoreKind());
}

export function vectorStoreIsExternal(kind: VectorStoreKind): boolean {
  return kind !== "pgvector";
}
