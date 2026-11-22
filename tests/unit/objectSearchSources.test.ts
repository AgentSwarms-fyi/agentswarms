// Where search reads names from. Three promises are held here:
//   - it reads columns that exist, by name, and never a credential or a body;
//   - a kind whose read fails is reported, and the others still load;
//   - sharing rules survive: a masked dataset share is found through the
//     function, an unpublished ontology of somebody else's is not listed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { OBJECT_KINDS } from "@/lib/objectKinds";
import {
  columnsOf,
  entryFromRow,
  INDEX_CAP,
  likeEscape,
  loadObjectIndex,
  looksSealed,
  NEVER_READ,
  searchCappedKinds,
  TABLE_SOURCES,
} from "@/utils/objectSearch/sources.server";

const REPO = path.resolve(__dirname, "../..");
const types = readFileSync(path.join(REPO, "src/integrations/supabase/types.ts"), "utf8");

/** The columns of a table, from the generated database types. */
function columnsInTypes(table: string): Set<string> {
  const at = types.indexOf(`      ${table}: {`);
  if (at < 0) throw new Error(`no such table in the generated types: ${table}`);
  const row = types.slice(at, types.indexOf("Insert:", at));
  return new Set([...row.matchAll(/^\s+([a-z_0-9]+)\??:/gm)].map((m) => m[1]));
}

type Row = Record<string, unknown>;
type Call = { table: string; select?: string; not?: unknown[]; ilike?: unknown[]; limit?: number };

/** A stand-in for the database client: rows per table, or an error. */
function fakeClient(tables: Record<string, Row[] | Error>) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table };
    calls.push(call);
    const q = {
      select(cols: string) {
        call.select = cols;
        return q;
      },
      not(...args: unknown[]) {
        call.not = args;
        return q;
      },
      ilike(...args: unknown[]) {
        call.ilike = args;
        return q;
      },
      order() {
        return q;
      },
      limit(n: number) {
        call.limit = n;
        const rows = tables[table];
        return Promise.resolve(
          rows instanceof Error
            ? { data: null, error: { message: rows.message } }
            : { data: (rows ?? []).slice(0, n), error: null },
        );
      },
    };
    return q;
  };
  return { client: { from } as never, calls };
}

const ME = "me";

describe("the sources", () => {
  it("cover every kind kept in the database, once", () => {
    const kinds = TABLE_SOURCES.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    // Semantic models and their metrics have their own reader; lakehouse
    // tables are listed by the lake.
    const elsewhere = new Set(["semantic_model", "metric", "lakehouse_table"]);
    for (const k of OBJECT_KINDS) {
      expect(kinds.includes(k.id) || elsewhere.has(k.id), k.id).toBe(true);
    }
  });

  it("read only columns that exist", () => {
    for (const s of TABLE_SOURCES) {
      const have = columnsInTypes(s.table);
      for (const col of columnsOf(s).split(", ")) {
        expect(have.has(col), `${s.table}.${col}`).toBe(true);
      }
    }
    const semantic = columnsInTypes("semantic_models");
    for (const col of ["id", "name", "label", "description", "updated_at", "user_id", "metrics"]) {
      expect(semantic.has(col), `semantic_models.${col}`).toBe(true);
    }
  });

  it("never read a credential or an object's contents", () => {
    for (const s of TABLE_SOURCES) {
      const cols = columnsOf(s).split(", ");
      expect(cols, s.table).not.toContain("*");
      for (const banned of NEVER_READ) {
        expect(cols.includes(banned), `${s.table}.${banned}`).toBe(false);
      }
    }
    // The two tables that hold one: named, so a rename is noticed.
    expect(columnsInTypes("mcp_servers").has("auth_token")).toBe(true);
    expect(columnsInTypes("embed_keys").has("key")).toBe(true);
    const src = readFileSync(path.join(REPO, "src/utils/objectSearch/sources.server.ts"), "utf8");
    expect(src).not.toMatch(/select\(\s*["'`]\*/);
  });
});

describe("one row", () => {
  const agents = TABLE_SOURCES.find((s) => s.kind === "agent")!;

  it("becomes a name, a description and whose it is", () => {
    const row = {
      id: "a1",
      name: " Triage ",
      description: "",
      updated_at: "2026-11-01",
      user_id: ME,
    };
    expect(entryFromRow(agents, row, ME)).toEqual({
      kind: "agent",
      id: "a1",
      name: "Triage",
      detail: undefined,
      updatedAt: "2026-11-01",
      mine: true,
    });
    expect(entryFromRow(agents, { ...row, user_id: "other" }, ME)?.mine).toBe(false);
    // Nothing to show without a name or an id.
    expect(entryFromRow(agents, { ...row, name: "  " }, ME)).toBeNull();
    expect(entryFromRow(agents, { ...row, id: null }, ME)).toBeNull();
  });
});

describe("the index", () => {
  it("loads every kind side by side and names the one that failed", async () => {
    const { client } = fakeClient({
      agents: [{ id: "a1", name: "Triage", updated_at: "2026-11-01", user_id: ME }],
      swarms: new Error("permission denied"),
      bi_dashboards: [
        { id: "d1", name: "Sales", description: "Q3", updated_at: null, user_id: "x" },
      ],
    });
    const index = await loadObjectIndex(client, ME);
    expect(index.failed).toEqual(["swarm"]);
    expect(index.capped).toEqual([]);
    expect(index.entries.map((e) => `${e.kind}:${e.name}:${e.mine}`).sort()).toEqual([
      "agent:Triage:true",
      "dashboard:Sales:false",
    ]);
  });

  it("says which kinds it could not hold in full", async () => {
    const many = Array.from({ length: INDEX_CAP + 5 }, (_, i) => ({
      id: `p${i}`,
      title: `Prompt ${i}`,
      updated_at: "2026-11-01",
      user_id: ME,
    }));
    const { client, calls } = fakeClient({ user_prompts: many });
    const index = await loadObjectIndex(client, ME);
    expect(index.capped).toEqual(["prompt"]);
    expect(index.entries).toHaveLength(INDEX_CAP);
    expect(calls.find((c) => c.table === "user_prompts")?.limit).toBe(INDEX_CAP);
  });

  it("hides a staged upload, and somebody else's ontology until it is published", async () => {
    const { client, calls } = fakeClient({
      user_data_tables: [
        { id: "t1", name: "orders", updated_at: null, user_id: ME, is_sample: true },
      ],
      ontologies: [
        { id: "o1", name: "Mine, draft", user_id: ME, published_version: null },
        { id: "o2", name: "Theirs, draft", user_id: "x", published_version: null },
        { id: "o3", name: "Theirs, published", user_id: "x", published_version: 2 },
      ],
    });
    const index = await loadObjectIndex(client, ME);
    expect(calls.find((c) => c.table === "user_data_tables")?.not).toEqual([
      "name",
      "like",
      "__upload_%",
    ]);
    expect(index.entries.find((e) => e.kind === "dataset")).toMatchObject({ sample: true });
    expect(
      index.entries
        .filter((e) => e.kind === "ontology")
        .map((e) => e.name)
        .sort(),
    ).toEqual(["Mine, draft", "Theirs, published"]);
  });

  it("finds a metric by its own name inside its model", async () => {
    const { client } = fakeClient({
      semantic_models: [
        {
          id: "m1",
          name: "saas_sales_model",
          label: "SaaS sales",
          description: "Orders",
          updated_at: "2026-11-01",
          user_id: ME,
          metrics: [
            { name: "total_sales", label: "Total sales", description: "Sum of sales" },
            { name: "orders" },
            { label: "no name" },
          ],
        },
      ],
    });
    const index = await loadObjectIndex(client, ME);
    expect(index.entries.find((e) => e.kind === "semantic_model")).toMatchObject({
      id: "m1",
      name: "SaaS sales",
      detail: "saas_sales_model — Orders",
    });
    expect(index.entries.filter((e) => e.kind === "metric")).toEqual([
      {
        kind: "metric",
        id: "saas_sales_model.total_sales",
        name: "Total sales",
        detail: "in SaaS sales — Sum of sales",
        updatedAt: "2026-11-01",
        mine: true,
        parentId: "m1",
      },
      {
        kind: "metric",
        id: "saas_sales_model.orders",
        name: "orders",
        detail: "in SaaS sales",
        updatedAt: "2026-11-01",
        mine: true,
        parentId: "m1",
      },
    ]);
  });

  it("adds shares only the server can list, without repeating one it already has", async () => {
    const { client } = fakeClient({
      user_data_tables: [{ id: "t1", name: "orders", updated_at: null, user_id: "x" }],
    });
    const index = await loadObjectIndex(client, ME, {
      // t1 is an unmasked share the direct read returned; t2 is masked and is
      // only in the function's answer.
      sharedDatasets: async () => [
        { id: "t1", name: "orders" },
        { id: "t2", name: "payroll" },
      ],
      sharedWorkbooks: async () => [
        { kind: "workbook", id: "w1", name: "Budget", mine: false, updatedAt: null },
      ],
    });
    expect(index.entries.filter((e) => e.kind === "dataset").map((e) => e.id)).toEqual([
      "t1",
      "t2",
    ]);
    expect(index.entries.find((e) => e.id === "t2")).toMatchObject({
      mine: false,
      name: "payroll",
    });
    expect(index.entries.find((e) => e.kind === "workbook")?.name).toBe("Budget");
    expect(index.failed).toEqual([]);
  });

  it("reports a share list that could not be read as that kind failing", async () => {
    const { client } = fakeClient({});
    const index = await loadObjectIndex(client, ME, {
      sharedDatasets: async () => {
        throw new Error("could not list the datasets shared with you");
      },
      sharedWorkbooks: async () => {
        throw new Error("could not read what is shared with you");
      },
    });
    expect(index.failed.sort()).toEqual(["dataset", "workbook"]);
  });
});

describe("an older name in a kind too large for the index", () => {
  it("is asked for by name, with what was typed taken literally", async () => {
    const { client, calls } = fakeClient({
      user_prompts: [{ id: "p1", title: "100%_done", updated_at: null, user_id: ME }],
    });
    const got = await searchCappedKinds(client, ME, "100%_", ["prompt"]);
    expect(got.map((e) => e.name)).toEqual(["100%_done"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].ilike).toEqual(["title", "%100\\%\\_%"]);
    expect(likeEscape("a\\b")).toBe("a\\\\b");
    // One letter is not a search.
    expect(await searchCappedKinds(client, ME, "a", ["prompt"])).toEqual([]);
  });
});

// Found from the UI: saved analyses keep their title sealed under the owner's
// key, and the first search page listed one as "ck1:eef4de9bca22:1Iy0…".
describe("a name stored sealed", () => {
  const SEALED = "ck1:eef4de9bca22:1Iy0zErXwZ+cA2wv:tPRJwZJoHX7elRkY72m7";
  const thread = (id: string, title: string) => ({
    id,
    title,
    analyst_id: "a1",
    updated_at: "2026-11-01",
    user_id: ME,
  });

  it("is recognised by its shape, and nothing else is", () => {
    expect(looksSealed(SEALED)).toBe(true);
    expect(looksSealed("ck1: my notes")).toBe(false);
    expect(looksSealed("Checkout: Q3")).toBe(false);
    expect(looksSealed(undefined)).toBe(false);
  });

  it("is opened by its kind's opener, and left out when it cannot be", async () => {
    const { client } = fakeClient({
      ai_analyst_threads: [thread("t1", SEALED), thread("t2", SEALED), thread("t3", "plain title")],
    });
    const index = await loadObjectIndex(client, ME, {
      openName: {
        analysis: async (row) => {
          if (row.id === "t2") throw new Error("the key is unavailable");
          return row.name === SEALED ? "Daily sales in 2025" : row.name;
        },
      },
    });
    expect(index.entries.map((e) => `${e.id}:${e.name}:${e.parentId}`)).toEqual([
      "t1:Daily sales in 2025:a1",
      "t3:plain title:a1",
    ]);
    // No analyst by that id was listed, so there is nothing to say it is with.
    expect(index.entries.every((e) => e.detail === undefined)).toBe(true);
  });

  it("says which analyst an analysis was run with", async () => {
    const { client } = fakeClient({
      ai_analysts: [{ id: "a1", name: "saas_sales analyst", model: "m", user_id: ME }],
      ai_analyst_threads: [thread("t1", "Daily sales")],
    });
    const index = await loadObjectIndex(client, ME);
    expect(index.entries.find((e) => e.kind === "analysis")).toMatchObject({
      name: "Daily sales",
      detail: "with saas_sales analyst",
      parentId: "a1",
    });
  });

  it("is never listed sealed, opener or not, in a name or a description", async () => {
    const { client } = fakeClient({
      ai_analyst_threads: [thread("t1", SEALED)],
      agents: [{ id: "a1", name: "Triage", description: SEALED, updated_at: null, user_id: ME }],
    });
    const index = await loadObjectIndex(client, ME);
    expect(index.entries).toEqual([
      { kind: "agent", id: "a1", name: "Triage", detail: undefined, updatedAt: null, mine: true },
    ]);
  });

  it("is not asked for by name: the database cannot match what it cannot read", async () => {
    const { client, calls } = fakeClient({});
    await searchCappedKinds(client, ME, "sales", ["analysis", "prompt"], ["analysis"]);
    expect(calls.map((c) => c.table)).toEqual(["user_prompts"]);
  });
});
