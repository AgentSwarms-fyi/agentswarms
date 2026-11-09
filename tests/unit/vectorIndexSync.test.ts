// Keeping the external vector index in step with Postgres, by itself (R417).
//
// Found on a real install: its .env predated the Qdrant wiring, so the bundled
// Qdrant searched nothing. Wiring it is one line, and the line is dangerous on
// its own: a knowledge base that follows the instance default is searched
// wherever the default points, and an index that has never been written holds
// nothing — "a collection that returns nothing, with no error anywhere". So
// before an install is switched, the switch has to be safe:
//
//   - a knowledge base is searched in the index only once the index holds
//     exactly the vectors Postgres has for it, and in Postgres until then;
//   - one found out of step is repaired from Postgres, by id, without ever
//     being emptied and without calling an embedding provider;
//   - the scheduler sweeps every knowledge base on the index on its own clock.
//
// Postgres is a fake that answers the supabase-js chains sync.server.ts uses;
// the index is a fake with the IndexMaintenance calls. Both record what they
// were asked, which is what most of these assertions are about.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VECTOR_DIMS, type IndexMaintenance, type VectorStore } from "@/utils/vector/types";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: { kb_chunks: [] as Row[], knowledge_bases: [] as Row[] },
  index: null as unknown,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: "kb_chunks" | "knowledge_bases") {
    const st = {
      cols: "",
      count: false,
      head: false,
      eq: [] as [string, unknown][],
      notNull: [] as string[],
      inList: null as null | [string, unknown[]],
      order: null as null | string,
      range: null as null | [number, number],
    };
    const run = () => {
      let rows = h.db[table].filter(
        (r) =>
          st.eq.every(([c, v]) => r[c] === v) &&
          st.notNull.every((c) => r[c] !== null && r[c] !== undefined) &&
          (!st.inList || st.inList[1].includes(r[st.inList[0]])),
      );
      if (st.order) {
        const k = st.order;
        rows = [...rows].sort((a, b) => String(a[k]).localeCompare(String(b[k])));
      }
      const count = rows.length;
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
      if (st.head) return { data: null, count, error: null };
      const cols = st.cols.split(",").map((c) => c.trim());
      return {
        data: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))),
        count: st.count ? count : null,
        error: null,
      };
    };
    const b = {
      select(cols: string, opts?: { count?: string; head?: boolean }) {
        st.cols = cols;
        st.count = !!opts?.count;
        st.head = !!opts?.head;
        return b;
      },
      eq(c: string, v: unknown) {
        st.eq.push([c, v]);
        return b;
      },
      not(c: string, op: string, v: unknown) {
        if (op === "is" && v === null) st.notNull.push(c);
        return b;
      },
      in(c: string, vs: unknown[]) {
        st.inList = [c, vs];
        return b;
      },
      order(c: string) {
        st.order = c;
        return b;
      },
      range(a: number, z: number) {
        st.range = [a, z];
        return b;
      },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(res, rej);
      },
    };
    return b;
  }
  return { supabaseAdmin: { from } };
});

vi.mock("@/utils/vector/store.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/utils/vector/store.server")>();
  return { ...real, externalIndex: () => h.index };
});

const sync = await import("@/utils/vector/sync.server");

const vec = (i: number) =>
  Array.from({ length: VECTOR_DIMS }, (_, k) => (k === i % VECTOR_DIMS ? 1 : 0));
const asText = (v: number[]) => `[${v.join(",")}]`;

/** n chunks with embeddings (and `bare` without) in one knowledge base. */
function chunks(kb: string, n: number, bare = 0): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n + bare; i++) {
    rows.push({
      id: `${kb}-c${String(i).padStart(4, "0")}`,
      document_id: `${kb}-doc`,
      knowledge_base_id: kb,
      embedding: i < n ? asText(vec(i)) : null,
    });
  }
  return rows;
}

function fakeIndex() {
  const points = new Map<string, { kb: string; vec: number[] }>();
  const calls = {
    counts: 0,
    idLists: 0,
    upserted: [] as string[],
    deletedIds: [] as string[],
    deletedKbs: 0,
    failCounts: false,
    /** The fewest points any knowledge base held while being repaired. */
    lowWater: new Map<string, number>(),
  };
  const held = (kb: string) => [...points.values()].filter((p) => p.kb === kb).length;
  const note = (kb: string) =>
    calls.lowWater.set(kb, Math.min(calls.lowWater.get(kb) ?? Infinity, held(kb)));
  const idx: VectorStore & IndexMaintenance = {
    kind: "qdrant",
    async search() {
      return [];
    },
    async upsert(ps) {
      for (const p of ps) {
        points.set(p.id, { kb: p.knowledgeBaseId, vec: p.embedding });
        calls.upserted.push(p.id);
        note(p.knowledgeBaseId);
      }
    },
    async deleteByDocuments() {},
    async deleteByKnowledgeBases() {
      calls.deletedKbs += 1;
    },
    async info() {
      return { kind: "qdrant", endpoint: null, ok: true };
    },
    async countByKnowledgeBase(kb) {
      calls.counts += 1;
      if (calls.failCounts) throw new Error("Qdrant at http://qdrant:6333 is unreachable");
      return held(kb);
    },
    async idsByKnowledgeBase(kb) {
      calls.idLists += 1;
      note(kb);
      return [...points].filter(([, p]) => p.kb === kb).map(([id]) => id);
    },
    async deleteByIds(ids) {
      for (const id of ids) {
        const kb = points.get(id)?.kb;
        points.delete(id);
        calls.deletedIds.push(id);
        if (kb) note(kb);
      }
    },
  };
  /** Put these chunks' vectors in the index, as an ingest would have. */
  const mirror = (rows: Row[]) => {
    for (const r of rows) {
      if (r.embedding) points.set(String(r.id), { kb: String(r.knowledge_base_id), vec: [] });
    }
  };
  return { idx, points, calls, mirror, held };
}

const ENV_KEYS = [
  "VECTOR_STORE",
  "VECTOR_INDEX_CHECK_SECONDS",
  "VECTOR_INDEX_SYNC_MINUTES",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.VECTOR_STORE = "qdrant";
  delete process.env.VECTOR_INDEX_CHECK_SECONDS;
  delete process.env.VECTOR_INDEX_SYNC_MINUTES;
  h.db.kb_chunks = [];
  h.db.knowledge_bases = [];
  h.index = null;
  sync.resetIndexSync();
  // Nothing in here may reach the network: the vectors come from Postgres,
  // and an embedding provider is exactly what a repair must never call.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("the index sync made a network call");
    }),
  );
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("retrieval searches the index only for what it holds in full", () => {
  it("trusts a knowledge base whose vectors are all there", async () => {
    const f = fakeIndex();
    h.index = f.idx;
    h.db.kb_chunks = chunks("kbA", 5);
    f.mirror(h.db.kb_chunks);
    expect([...(await sync.knowledgeBasesOutOfStep(["kbA"]))]).toEqual([]);
  });

  it("sends one the index is missing vectors for to Postgres, and repairs it", async () => {
    // The install that was just switched: Postgres has three vectors, the
    // index one. Searching the index would find a third of the collection.
    const f = fakeIndex();
    h.index = f.idx;
    h.db.kb_chunks = chunks("kbA", 3);
    f.mirror(h.db.kb_chunks.slice(0, 1));
    expect([...(await sync.knowledgeBasesOutOfStep(["kbA"]))]).toEqual(["kbA"]);

    // Nobody calls repair: the check started one in the background.
    for (let i = 0; i < 100 && f.held("kbA") < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(f.held("kbA"), "no repair followed the check").toBe(3);
    expect(f.calls.upserted).toEqual(["kbA-c0001", "kbA-c0002"]);
    // Let its recount land before asking again.
    await sync.repairKnowledgeBase(f.idx, "kbA");
    // And the verdict it left is the one the next query reads.
    expect([...(await sync.knowledgeBasesOutOfStep(["kbA"]))]).toEqual([]);
  });

  it("does not trust an index it cannot count, and does not try to repair it", async () => {
    const f = fakeIndex();
    h.index = f.idx;
    h.db.kb_chunks = chunks("kbA", 2);
    f.mirror(h.db.kb_chunks);
    f.calls.failCounts = true;
    expect([...(await sync.knowledgeBasesOutOfStep(["kbA"]))]).toEqual(["kbA"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(f.calls.idLists, "a repair ran against an index that is down").toBe(0);
  });

  it("checks each knowledge base once while a check is running, and reuses a fresh verdict", async () => {
    const f = fakeIndex();
    h.index = f.idx;
    h.db.kb_chunks = chunks("kbA", 2);
    f.mirror(h.db.kb_chunks);
    await Promise.all([
      sync.knowledgeBasesOutOfStep(["kbA"]),
      sync.knowledgeBasesOutOfStep(["kbA"]),
      sync.knowledgeBasesOutOfStep(["kbA"]),
    ]);
    expect(f.calls.counts).toBe(1);
    await sync.knowledgeBasesOutOfStep(["kbA"]);
    expect(f.calls.counts).toBe(1);

    // Past VECTOR_INDEX_CHECK_SECONDS it is counted again.
    process.env.VECTOR_INDEX_CHECK_SECONDS = "60";
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    await sync.knowledgeBasesOutOfStep(["kbA"]);
    expect(f.calls.counts).toBe(2);
  });

  it("asks again within 30 s after a failed count, so a recovered index is used again", async () => {
    // Measured live (R417): Qdrant stopped, a question answered from Postgres,
    // Qdrant started — and with a five-minute verdict the index stayed bypassed
    // for five minutes. A failure is now retried after 30 s.
    const f = fakeIndex();
    h.index = f.idx;
    h.db.kb_chunks = chunks("kbA", 2);
    f.mirror(h.db.kb_chunks);
    f.calls.failCounts = true;
    expect([...(await sync.knowledgeBasesOutOfStep(["kbA"]))]).toEqual(["kbA"]);
    f.calls.failCounts = false;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 10_000);
    expect([...(await sync.knowledgeBasesOutOfStep(["kbA"]))], "retried too soon").toEqual(["kbA"]);
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    expect([...(await sync.knowledgeBasesOutOfStep(["kbA"]))]).toEqual([]);
  });

  it("trusts the index without asking when VECTOR_INDEX_CHECK_SECONDS is 0", async () => {
    const f = fakeIndex();
    h.index = f.idx;
    h.db.kb_chunks = chunks("kbA", 3);
    process.env.VECTOR_INDEX_CHECK_SECONDS = "0";
    expect([...(await sync.knowledgeBasesOutOfStep(["kbA"]))]).toEqual([]);
    expect(f.calls.counts).toBe(0);
  });

  it("has nothing to say on a deployment with no external index", async () => {
    h.db.kb_chunks = chunks("kbA", 3);
    expect([...(await sync.knowledgeBasesOutOfStep(["kbA"]))]).toEqual([]);
    const s = await sync.syncVectorIndex({ force: true });
    expect(s.knowledgeBases).toBe(0);
  });
});

describe("a repair copies from Postgres, by id, and never empties the collection", () => {
  it("removes a stale point and copies a missing one, touching nothing else", async () => {
    // A chunk deleted while the index was down leaves its point behind; one
    // embedded while it was down never got one. Same count, both wrong.
    const f = fakeIndex();
    h.index = f.idx;
    h.db.kb_chunks = chunks("kbA", 4);
    f.mirror(h.db.kb_chunks.slice(0, 3));
    f.points.set("kbA-gone", { kb: "kbA", vec: [] });
    expect(f.held("kbA")).toBe(4);

    const r = await sync.repairKnowledgeBase(f.idx, "kbA");
    expect(r).toEqual({ copied: 1, removed: 1 });
    expect(f.calls.upserted).toEqual(["kbA-c0003"]);
    expect(f.calls.deletedIds).toEqual(["kbA-gone"]);
    expect(f.calls.deletedKbs, "a repair forgot the whole collection").toBe(0);
    expect(
      f.calls.lowWater.get("kbA"),
      "the collection was emptied mid-repair",
    ).toBeGreaterThanOrEqual(3);
  });

  it("copies the stored vector itself, so nothing is embedded again", async () => {
    const f = fakeIndex();
    h.index = f.idx;
    h.db.kb_chunks = chunks("kbA", 2);
    await sync.repairKnowledgeBase(f.idx, "kbA");
    expect(f.points.get("kbA-c0001")?.vec).toEqual(vec(1));
    // fetch is stubbed to throw: an embedding call would have failed the repair.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("does not expect a chunk that has no embedding", async () => {
    // Keyword-only chunks never had a vector anywhere; counting them would
    // keep a collection out of step for ever.
    const f = fakeIndex();
    h.index = f.idx;
    h.db.kb_chunks = chunks("kbA", 2, 3);
    f.mirror(h.db.kb_chunks);
    expect([...(await sync.knowledgeBasesOutOfStep(["kbA"]))]).toEqual([]);
  });

  it("rewrites every vector when Re-index asks, and still removes the stale", async () => {
    const f = fakeIndex();
    h.index = f.idx;
    h.db.kb_chunks = chunks("kbA", 3);
    f.mirror(h.db.kb_chunks);
    f.points.set("kbA-gone", { kb: "kbA", vec: [] });
    const r = await sync.repairKnowledgeBase(f.idx, "kbA", { rewrite: true });
    expect(r).toEqual({ copied: 3, removed: 1 });
    expect(f.calls.deletedKbs).toBe(0);
  });

  it("pages through a collection bigger than one read", async () => {
    const f = fakeIndex();
    h.index = f.idx;
    h.db.kb_chunks = chunks("kbA", 2345);
    const r = await sync.repairKnowledgeBase(f.idx, "kbA");
    expect(r.copied).toBe(2345);
    expect(f.held("kbA")).toBe(2345);
  });
});

describe("the scheduler's sweep", () => {
  function twoCollections() {
    // kbA follows the instance default (the index); kbB chose Postgres.
    h.db.knowledge_bases = [
      { id: "kbA", retrieval_settings: null },
      { id: "kbB", retrieval_settings: { mode: "semantic", vector_store: "pgvector" } },
    ];
    h.db.kb_chunks = [...chunks("kbA", 3), ...chunks("kbB", 2)];
  }

  it("repairs every collection on the index, and only those", async () => {
    const f = fakeIndex();
    h.index = f.idx;
    twoCollections();
    const s = await sync.syncVectorIndex();
    expect(s).toMatchObject({
      knowledgeBases: 1,
      repaired: 1,
      copied: 3,
      inStep: 1,
      expected: 3,
      held: 3,
    });
    expect(f.held("kbB"), "a Postgres collection was copied into the index").toBe(0);
  });

  it("runs on its own clock, and when forced", async () => {
    const f = fakeIndex();
    h.index = f.idx;
    twoCollections();
    await sync.syncVectorIndex();
    const counted = f.calls.counts;
    await sync.syncVectorIndex();
    expect(f.calls.counts, "a sweep ran before VECTOR_INDEX_SYNC_MINUTES").toBe(counted);
    await sync.syncVectorIndex({ force: true });
    expect(f.calls.counts).toBeGreaterThan(counted);
  });

  it("never runs by itself when VECTOR_INDEX_SYNC_MINUTES is 0", async () => {
    const f = fakeIndex();
    h.index = f.idx;
    twoCollections();
    process.env.VECTOR_INDEX_SYNC_MINUTES = "0";
    expect((await sync.syncVectorIndex()).knowledgeBases).toBe(0);
    expect(f.calls.counts).toBe(0);
  });

  it("says so when it could not check, so the scheduler records a failure", async () => {
    const f = fakeIndex();
    h.index = f.idx;
    twoCollections();
    f.calls.failCounts = true;
    await expect(sync.syncVectorIndex()).rejects.toThrow(
      /^1 knowledge base\(s\) could not be checked or repaired: Qdrant at http:\/\/qdrant:6333 is unreachable$/,
    );
  });

  it("says it once per reason, not once per collection", async () => {
    // Live with Qdrant stopped: 21 collections, one reason, 21 ids on the row.
    const f = fakeIndex();
    h.index = f.idx;
    h.db.knowledge_bases = ["kbA", "kbB", "kbC"].map((id) => ({ id, retrieval_settings: null }));
    h.db.kb_chunks = [...chunks("kbA", 1), ...chunks("kbB", 1), ...chunks("kbC", 1)];
    f.calls.failCounts = true;
    await expect(sync.syncVectorIndex()).rejects.toThrow(
      /^3 knowledge base\(s\) could not be checked or repaired: Qdrant at http:\/\/qdrant:6333 is unreachable \(3 of them\)$/,
    );
  });

  it("is a step of the scheduler pass, folded like the others", async () => {
    const { readFileSync } = await import("node:fs");
    const pass = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
    // Through the pass's step guard since R463, which folds a failure.
    expect(pass).toMatch(
      /await step\(\s*"vector-index",\s*\(\) => import\("@\/utils\/vector\/sync\.server"\)\.then\(\(m\) => m\.syncVectorIndex\(\{ force \}\)\),/,
    );
  });
});

describe("retrieval is wired to it", () => {
  it("routes out-of-step collections to Postgres and falls back to Postgres when the index fails", async () => {
    const { readFileSync } = await import("node:fs");
    const kb = readFileSync("src/utils/tools/kb.server.ts", "utf8");
    expect(kb).toContain(
      'for (const id of await knowledgeBasesOutOfStep(onIndex)) routed.set(id, "pgvector");',
    );
    // An index that does not answer is searched in Postgres, not dropped to
    // keyword-only: Postgres has every vector.
    expect(kb).toMatch(
      /return search\.catch\(\(e\) => \{[\s\S]{0,300}return pgvectorStore\(sb\)\.search\(args\);/,
    );
  });
});
