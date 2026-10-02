// What a vector store has to be able to do, and nothing else.
//
// Retrieval has always been pgvector inside the same Postgres that holds
// everything else. That is the right default — one thing to run, one thing to
// back up, and the ACL is the row-level security already protecting the rows.
//
// It is not the right ONLY option, for one reason: an HNSW index wants RAM,
// and in the default shape it wants it from the same instance serving traces,
// audit, BI results and every OLTP query. Past a few million chunks the index
// is the largest thing in there and the way to feed it is to resize the whole
// database. An external store is a place to put it that scales on its own.
//
// It is NOT a way to survive losing Postgres. Every hit is hydrated from
// `kb_chunks` — see rule 1 below — so a database outage takes retrieval with
// it wherever the vectors live (and takes login with it too). The availability
// that is real runs the other way: losing the external store degrades
// retrieval to keyword search, because the text never left Postgres.
//
// So this is the seam. It is deliberately small — search, upsert, delete,
// health — because a wide interface is one that only its first implementation
// can satisfy.
//
// TWO RULES THAT ARE NOT NEGOTIABLE, and are the reason the seam sits here
// rather than further out:
//
//   1. POSTGRES REMAINS THE SYSTEM OF RECORD. An external store holds VECTORS
//      and an id. The chunk text, its parent, the document it came from and
//      who may read it stay in `kb_chunks`. So the keyword half of hybrid
//      retrieval keeps working unchanged, and a store that loses its data is
//      re-indexed rather than restored.
//   2. A STORE NEVER DECIDES WHO MAY READ WHAT. Callers pass knowledge-base
//      ids that have ALREADY been authorised, the store filters to them, and
//      the rows are then fetched back through the caller's own client — where
//      RLS applies a second time. An external store cannot leak a document by
//      returning an id it should not have, because the id alone is not the
//      answer.

/** The stores that can be selected. */
export const VECTOR_STORES = ["pgvector", "qdrant"] as const;
export type VectorStoreKind = (typeof VECTOR_STORES)[number];

/**
 * The width every stored vector has.
 *
 * Fixed rather than per-collection: `kb_chunks.embedding` is `vector(1536)`
 * and `padToStoreWidth` already brings a narrower local model up to it, so a
 * second, disagreeing width would only be a way for one store to hold vectors
 * the other cannot. A test pins this against the embedder's own constant.
 */
export const VECTOR_DIMS = 1536;

/** One hit: which chunk, and how close. */
export type VectorMatch = {
  /** `kb_chunks.id` — a uuid, which is also the point id in the store. */
  id: string;
  /** Cosine similarity in [-1, 1]; 1 is identical. */
  score: number;
};

/** A vector on its way in. */
export type VectorPoint = {
  id: string;
  /** Length must be VECTOR_DIMS. */
  embedding: number[];
  knowledgeBaseId: string;
  documentId: string;
};

/** What the admin page shows about the store in use. */
export type VectorStoreInfo = {
  kind: VectorStoreKind;
  /** Where it lives, with any credential stripped. Null for pgvector. */
  endpoint: string | null;
  ok: boolean;
  /** Why not, when `ok` is false. */
  error?: string;
  /** Vectors held, when the store can say cheaply. */
  points?: number;
  /**
   * Copies of each vector across nodes. 1 means losing a node loses
   * availability until it returns.
   */
  replication?: number;
  /** Version string the store reports, when it offers one. */
  version?: string;
};

/**
 * The seam.
 *
 * Every method takes knowledge-base ids the CALLER has already authorised —
 * see rule 2 above. An implementation that ignores `knowledgeBaseIds` in
 * `search` is a document leak, so the conformance test asserts filtering
 * rather than trusting it.
 */
export type VectorStore = {
  kind: VectorStoreKind;
  /**
   * Nearest `limit` chunks to `embedding`, restricted to those knowledge
   * bases. Ordered best first.
   */
  search(args: {
    embedding: number[];
    knowledgeBaseIds: string[];
    limit: number;
  }): Promise<VectorMatch[]>;
  /** Insert or replace. Called after the rows are committed, never before. */
  upsert(points: VectorPoint[]): Promise<void>;
  /** Forget every vector belonging to these documents. */
  deleteByDocuments(documentIds: string[]): Promise<void>;
  /** Forget every vector in these knowledge bases. */
  deleteByKnowledgeBases(knowledgeBaseIds: string[]): Promise<void>;
  /** Cheap enough to call from a page load. Never throws. */
  info(): Promise<VectorStoreInfo>;
};

/**
 * Which store this deployment uses.
 *
 * Unset, misspelt or unknown all mean pgvector. An operator who types
 * `qrant` gets the working default rather than a broken deployment, and the
 * admin page shows which store is actually in use so the typo is visible.
 */
export function resolveStoreKind(raw: string | undefined): VectorStoreKind {
  const v = (raw ?? "").trim().toLowerCase();
  return (VECTOR_STORES as readonly string[]).includes(v) ? (v as VectorStoreKind) : "pgvector";
}

/**
 * An endpoint safe to show in the UI.
 *
 * A Qdrant URL can carry credentials (`https://user:pass@host`), and this
 * string is rendered on the admin page and returned by a server function, so
 * the userinfo is dropped rather than trusted not to be there. A string that
 * is not a URL comes back as-is: it is already going to be reported as
 * unreachable, and hiding it would hide the typo.
 */
export function redactEndpoint(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}
