// Qdrant as the vector index, for deployments that need retrieval to survive
// losing the database — or to outgrow it.
//
// It holds VECTORS AND TWO IDS and nothing else. No chunk text, no document
// name, no user id. That is a deliberate limit, not an omission:
//
//   - the keyword half of hybrid retrieval is Postgres full-text search over
//     `kb_chunks`, and it keeps working untouched;
//   - a Qdrant that loses its volume is re-indexed from Postgres in one pass
//     rather than restored from a backup nobody was taking;
//   - and a store that holds no text cannot leak one. What comes back is a
//     list of uuids, which are then fetched through the caller's own Supabase
//     client where row-level security applies.
//
// Talked to over its REST API rather than through a client library: the six
// calls used here are stable, and a dependency that has to be upgraded in step
// with the server is a poor trade for saving forty lines.

import {
  redactEndpoint,
  VECTOR_DIMS,
  type VectorMatch,
  type VectorPoint,
  type VectorStore,
  type VectorStoreInfo,
} from "./types";

const DEFAULT_COLLECTION = "agentswarms_kb_chunks";
const TIMEOUT_MS = 20_000;
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

/** Payload keys. Short, because every point carries them. */
const KB = "kb";
const DOC = "doc";

export type QdrantConfig = {
  url: string;
  apiKey?: string;
  collection: string;
  /**
   * Copies of each shard. Only meaningful on a Qdrant CLUSTER — a single node
   * has one copy whatever this says, which is why `info()` reports what the
   * collection ACTUALLY has rather than what was asked for.
   */
  replication: number;
  shards: number;
};

/** Read the deployment's Qdrant settings, or say why there are none. */
export function qdrantConfig(env: Record<string, string | undefined>): QdrantConfig | null {
  const url = env.QDRANT_URL?.trim();
  if (!url) return null;
  const num = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
  };
  return {
    url: url.replace(/\/$/, ""),
    apiKey: env.QDRANT_API_KEY?.trim() || undefined,
    collection: env.QDRANT_COLLECTION?.trim() || DEFAULT_COLLECTION,
    // 1, not 2. A single-node Qdrant is the common case and asking it for two
    // copies of a shard it cannot place is a confusing start; a cluster is
    // told explicitly. The admin page shows the real number either way.
    replication: num(env.QDRANT_REPLICATION, 1),
    shards: num(env.QDRANT_SHARDS, 1),
  };
}

class QdrantError extends Error {}

async function call(
  cfg: QdrantConfig,
  path: string,
  init: RequestInit & { allow404?: boolean } = {},
): Promise<unknown> {
  const { allow404, ...rest } = init;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${cfg.url}${path}`, {
        ...rest,
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey ? { "api-key": cfg.apiKey } : {}),
          ...(rest.headers ?? {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404 && allow404) return null;
      if (res.status === 401 || res.status === 403) {
        throw new QdrantError(
          "Qdrant rejected the credentials. Set QDRANT_API_KEY to a key the server accepts, " +
            "or unset it if the server has no API key configured.",
        );
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
          lastErr = new QdrantError(`Qdrant HTTP ${res.status}`);
          // A node restarting or a shard moving; both resolve in seconds.
          await new Promise((r) => setTimeout(r, 250 * attempt));
          continue;
        }
        throw new QdrantError(`Qdrant HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
      }
      return (await res.json().catch(() => ({}))) as unknown;
    } catch (e) {
      if (e instanceof QdrantError) throw e;
      lastErr = e;
      if (attempt === MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw new QdrantError(
    `Qdrant at ${redactEndpoint(cfg.url)} is unreachable: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

type CollectionInfo = {
  result?: {
    config?: {
      params?: {
        vectors?: { size?: number; distance?: string };
        replication_factor?: number;
        shard_number?: number;
      };
    };
    points_count?: number;
  };
};

/**
 * Create the collection if it is not there, and refuse to use one that is the
 * wrong shape.
 *
 * The width check matters more than it looks: a collection created for a
 * 768-dimensional model accepts no 1536-dimensional vector, and Qdrant's own
 * error for that arrives per-point during an index run rather than at startup.
 * Failing here says which two numbers disagree, once.
 */
async function ensureCollection(cfg: QdrantConfig): Promise<void> {
  const existing = (await call(cfg, `/collections/${cfg.collection}`, {
    allow404: true,
  })) as CollectionInfo | null;

  if (existing?.result) {
    const size = existing.result.config?.params?.vectors?.size;
    if (typeof size === "number" && size !== VECTOR_DIMS) {
      throw new QdrantError(
        `Qdrant collection "${cfg.collection}" stores ${size}-dimensional vectors but this ` +
          `deployment writes ${VECTOR_DIMS}. Point QDRANT_COLLECTION at a different name, or ` +
          `delete that collection and re-index.`,
      );
    }
  } else {
    await createCollection(cfg);
  }

  // ALWAYS, not only after creating one. FOUND FROM THE UI: a collection that
  // existed but had no payload index was never repaired, because the "it is
  // already there" path returned before this ran — and `payload_schema: {}`
  // means every filtered search is a full scan of the collection, which is the
  // one thing the filter exists to avoid. Creating an index that is already
  // there is a no-op, so doing it every time costs one call per process.
  for (const field of [KB, DOC]) {
    await call(cfg, `/collections/${cfg.collection}/index?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
    });
  }
}

async function createCollection(cfg: QdrantConfig): Promise<void> {
  try {
    await call(cfg, `/collections/${cfg.collection}`, {
      method: "PUT",
      body: JSON.stringify({
        vectors: { size: VECTOR_DIMS, distance: "Cosine" },
        replication_factor: cfg.replication,
        shard_number: cfg.shards,
      }),
    });
  } catch (e) {
    // FOUND FROM THE UI. Two requests that both find no collection both create
    // one, and the loser gets `409 Collection already exists` — which surfaced
    // as "Unreachable" on a Qdrant that was working perfectly. One page load
    // issuing two calls is enough to hit it; two app replicas make it routine.
    // Somebody else creating the thing we were about to create is success.
    if (!(e instanceof QdrantError) || !/already exists/i.test(e.message)) throw e;
  }
}

/**
 * Ensured once per process per collection, and a failure is never cached so a
 * fix takes effect without a restart.
 *
 * Keyed at MODULE scope rather than per store instance, because a store is
 * built per request: caching inside the instance meant every request checked
 * the collection again, which is both a wasted round trip and how two of them
 * raced to create it.
 */
const ENSURED = new Map<string, Promise<void>>();

function onceEnsured(cfg: QdrantConfig) {
  const key = `${cfg.url}/${cfg.collection}`;
  return () => {
    const existing = ENSURED.get(key);
    if (existing) return existing;
    const started = ensureCollection(cfg).catch((e) => {
      ENSURED.delete(key);
      throw e;
    });
    ENSURED.set(key, started);
    return started;
  };
}

/** How many points to send in one request. */
const UPSERT_BATCH = 256;

export function qdrantStore(cfg: QdrantConfig): VectorStore {
  const ensure = onceEnsured(cfg);

  return {
    kind: "qdrant",

    async search({ embedding, knowledgeBaseIds, limit }): Promise<VectorMatch[]> {
      if (knowledgeBaseIds.length === 0 || limit <= 0) return [];
      await ensure();
      const body = {
        vector: embedding,
        limit,
        // THE ACL. Without this filter a search returns the nearest chunks in
        // the whole deployment, and the knowledge base a caller may read stops
        // being the knowledge base a caller does read.
        filter: { must: [{ key: KB, match: { any: knowledgeBaseIds } }] },
        with_payload: false,
        with_vector: false,
      };
      const res = (await call(cfg, `/collections/${cfg.collection}/points/search`, {
        method: "POST",
        body: JSON.stringify(body),
      })) as { result?: { id?: string; score?: number }[] };
      return (res.result ?? [])
        .filter((r): r is { id: string; score?: number } => typeof r.id === "string")
        .map((r) => ({ id: r.id, score: r.score ?? 0 }));
    },

    async upsert(points: VectorPoint[]): Promise<void> {
      if (points.length === 0) return;
      await ensure();
      for (const p of points) {
        if (p.embedding.length !== VECTOR_DIMS) {
          throw new QdrantError(
            `chunk ${p.id} has a ${p.embedding.length}-dimensional vector; the store holds ` +
              `${VECTOR_DIMS}`,
          );
        }
      }
      for (let i = 0; i < points.length; i += UPSERT_BATCH) {
        const batch = points.slice(i, i + UPSERT_BATCH);
        await call(cfg, `/collections/${cfg.collection}/points?wait=true`, {
          method: "PUT",
          body: JSON.stringify({
            points: batch.map((p) => ({
              id: p.id,
              vector: p.embedding,
              payload: { [KB]: p.knowledgeBaseId, [DOC]: p.documentId },
            })),
          }),
        });
      }
    },

    async deleteByDocuments(documentIds: string[]): Promise<void> {
      if (documentIds.length === 0) return;
      await ensure();
      await call(cfg, `/collections/${cfg.collection}/points/delete?wait=true`, {
        method: "POST",
        body: JSON.stringify({ filter: { must: [{ key: DOC, match: { any: documentIds } }] } }),
      });
    },

    async deleteByKnowledgeBases(knowledgeBaseIds: string[]): Promise<void> {
      if (knowledgeBaseIds.length === 0) return;
      await ensure();
      await call(cfg, `/collections/${cfg.collection}/points/delete?wait=true`, {
        method: "POST",
        body: JSON.stringify({ filter: { must: [{ key: KB, match: { any: knowledgeBaseIds } }] } }),
      });
    },

    async info(): Promise<VectorStoreInfo> {
      const base: VectorStoreInfo = {
        kind: "qdrant",
        endpoint: redactEndpoint(cfg.url),
        ok: false,
      };
      try {
        await ensure();
        const [root, coll] = await Promise.all([
          call(cfg, "/").catch(() => null),
          call(cfg, `/collections/${cfg.collection}`),
        ]);
        const c = (coll as CollectionInfo).result;
        return {
          ...base,
          ok: true,
          points: c?.points_count,
          replication: c?.config?.params?.replication_factor,
          version: (root as { version?: string } | null)?.version,
        };
      } catch (e) {
        return { ...base, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
