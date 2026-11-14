// Two more listings that named a shared dataset's masked columns (R489).
//
// Found while fixing the sql_query tool description, by looking for every place
// that hands a dataset's column list to a non-owner. Both read
// user_data_tables.columns under the caller's JWT. RLS returns a dataset shared
// with the caller, but that row's `columns` is the OWNER's list:
//
//   gatherDocContext          the doc-gen planner's context. The sample rows
//                             were masked (shared_dataset_rows), the column
//                             list beside them was not.
//   semanticListLocalSources  the semantic-model source picker, and the
//                             "generate with AI" prompt built from it.
//
// What is real: both server functions, the IAM grant reads, the mask. What is
// fake: the database and the server-function wrapper.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.SUPABASE_URL ??= "http://localhost:54321";
  process.env.SUPABASE_PUBLISHABLE_KEY ??= "test-publishable-key";
  return {
    grants: [] as Record<string, unknown>[],
    failGrantRead: false,
  };
});

const VIEWER = "00000000-0000-4000-8000-0000000000a1";
const OWNER = "00000000-0000-4000-8000-0000000000b2";
const OWN_ID = "11111111-1111-4111-8111-111111111111";
const SHARED_ID = "22222222-2222-4222-8222-222222222222";

const TABLES = [
  {
    id: OWN_ID,
    name: "orders",
    columns: [
      { name: "order_id", type: "number" },
      { name: "amount", type: "number" },
    ],
    user_id: VIEWER,
    is_sample: false,
    updated_at: "2026-11-01T00:00:00Z",
  },
  {
    id: SHARED_ID,
    name: "payroll",
    columns: [
      { name: "region", type: "string" },
      { name: "salary", type: "number" },
      { name: "employee", type: "string" },
    ],
    user_id: OWNER,
    is_sample: false,
    updated_at: "2026-11-02T00:00:00Z",
  },
];

/** A PostgREST stand-in for the reads these two functions make. */
function fakeSb() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }),
    },
    rpc(name: string) {
      // shared_dataset_rows applies the mask in Postgres: no salary here.
      if (name !== "shared_dataset_rows") throw new Error(`unexpected rpc ${name}`);
      return chain(() => ({ data: [{ region: "west", employee: "A" }], error: null }));
    },
    from(table: string) {
      let inFilter: unknown[] | null = null;
      const q = chain(() => {
        if (table === "user_data_tables") return { data: TABLES, error: null };
        if (table === "iam_group_members") return { data: [], error: null };
        if (table === "iam_resource_grants") {
          if (h.failGrantRead) return { data: null, error: { message: "connection reset" } };
          return {
            data: h.grants.filter((g) => !inFilter || inFilter.includes(g.resource_id)),
            error: null,
          };
        }
        throw new Error(`unexpected read of ${table}`);
      });
      q.in = (_k: string, vs: unknown[]) => ((inFilter = vs), q);
      return q;
    },
  };
}

function chain(result: () => unknown) {
  const q: Record<string, unknown> & { in?: unknown } = {};
  for (const m of ["select", "eq", "order", "limit", "not", "or", "maybeSingle"]) q[m] = () => q;
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve().then(result).then(ok, bad);
  return q as Record<string, unknown> & { in: (k: string, vs: unknown[]) => unknown };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeSb() }));

// A server function is its handler, validated.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      validator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (fn: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        fn({ data: validate(opts.data) }),
    };
    return b;
  },
}));

vi.mock("@/utils/tools/kb.server", () => ({ retrieveCitationsServer: async () => [] }));

vi.mock("@/utils/data/datasetRows.server", () => ({
  sampleDatasetRows: async () => [{ order_id: 1, amount: 10 }],
}));

import { gatherDocContext } from "@/utils/docGen.functions";
import { semanticListLocalSources } from "@/utils/semantic.functions";

const maskSalary = () => ({
  resource_type: "data_table",
  resource_id: SHARED_ID,
  principal_type: "user",
  principal_id: VIEWER,
  row_filter: null,
  column_mask: ["salary"],
});

type DocResult = {
  ok: boolean;
  context: { tables: { name: string; columns: string[]; sample: string }[] };
};

async function docTables() {
  const call = gatherDocContext as unknown as (o: { data: unknown }) => Promise<DocResult>;
  const res = await call({ data: { access_token: "t", prompt: "payroll and orders by region" } });
  expect(res.ok).toBe(true);
  return new Map(res.context.tables.map((t) => [t.name, t]));
}

async function semanticSources() {
  const call = semanticListLocalSources as unknown as (o: {
    data: unknown;
  }) => Promise<{ name: string; columns: { name: string; type: string }[] }[]>;
  const res = await call({ data: { accessToken: "t" } });
  return new Map(res.map((s) => [s.name, s.columns.map((c) => c.name)]));
}

beforeEach(() => {
  h.grants = [maskSalary()];
  h.failGrantRead = false;
});

describe("doc-gen context lists a shared dataset's columns through its mask", () => {
  it("leaves the masked column out, keeps the rest", async () => {
    const tables = await docTables();
    expect(tables.get("payroll")?.columns).toEqual(["region", "employee"]);
    // Own table: whole.
    expect(tables.get("orders")?.columns).toEqual(["order_id", "amount"]);
  });

  it("lists no columns of the shared dataset when its grant cannot be read", async () => {
    h.failGrantRead = true;
    const tables = await docTables();
    expect(tables.get("payroll")?.columns).toEqual([]);
    expect(tables.get("orders")?.columns).toEqual(["order_id", "amount"]);
  });
});

describe("the semantic-model source picker lists a shared dataset through its mask", () => {
  it("leaves the masked column out, keeps the rest", async () => {
    const sources = await semanticSources();
    expect(sources.get("payroll")).toEqual(["region", "employee"]);
    expect(sources.get("orders")).toEqual(["order_id", "amount"]);
  });

  it("lists no columns of the shared dataset when its grant cannot be read", async () => {
    h.failGrantRead = true;
    const sources = await semanticSources();
    expect(sources.get("payroll")).toEqual([]);
    expect(sources.get("orders")).toEqual(["order_id", "amount"]);
  });
});
