// The sql_query tool's DESCRIPTION honours a shared dataset's column mask (R489).
//
// The registry lists every visible table, with its columns, into the tool
// description so the model can write SQL without a round trip. The list came
// from user_data_tables.columns, which is the OWNER's full column list. For a
// dataset shared with the caller under a column mask, that put the names of
// the masked columns into the prompt on every turn, while the data path
// (readUserTable, restrictSharedDataset) refused to serve them. On a headless
// run ctx.sb is service-role, so nothing in the database stopped it either.
//
// What is real here: the registry, scopeToVisibleTables, the IAM grant reads,
// the mask intersection. What is fake: the database, answering the reads the
// way PostgREST would.
import { beforeEach, describe, expect, it } from "vitest";

import { resolveAgentTools, type AgentToolContext } from "@/utils/tools/registry.server";

const VIEWER = "00000000-0000-4000-8000-0000000000a1";
const OWNER = "00000000-0000-4000-8000-0000000000b2";
const STRANGER = "00000000-0000-4000-8000-0000000000c3";
const OWN_ID = "11111111-1111-4111-8111-111111111111";
const SHARED_ID = "22222222-2222-4222-8222-222222222222";
const SAMPLE_ID = "33333333-3333-4333-8333-333333333333";

type Col = { name: string; type: "number" | "string" | "date" };
type Grant = {
  resource_type: string;
  resource_id: string;
  principal_type: "user" | "group";
  principal_id: string;
  row_filter: unknown;
  column_mask: string[] | null;
};

const TABLES: {
  id: string;
  name: string;
  columns: Col[];
  user_id: string | null;
  is_sample: boolean;
}[] = [
  {
    id: OWN_ID,
    name: "orders",
    columns: [
      { name: "order_id", type: "number" },
      { name: "amount", type: "number" },
    ],
    user_id: VIEWER,
    is_sample: false,
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
  },
  {
    id: SAMPLE_ID,
    name: "sample_sales",
    columns: [{ name: "units", type: "number" }],
    user_id: null,
    is_sample: true,
  },
];

const db = {
  grants: [] as Grant[],
  /** The applicable-grants read (the one filtered by resource id) reports an error. */
  failGrantRead: false,
};

/**
 * A PostgREST stand-in: every link chains, the builder is awaitable, and the
 * filters the code under test relies on (`eq`, `in`) are applied.
 */
function fakeSb() {
  return {
    from(table: string) {
      const eqs: [string, unknown][] = [];
      let inFilter: [string, unknown[]] | null = null;
      const result = () => {
        if (table === "user_data_tables") return { data: TABLES, error: null };
        if (table === "iam_group_members") return { data: [], error: null };
        if (table === "data_warehouse_connections") return { data: [], error: null };
        if (table === "iam_resource_grants") {
          if (inFilter && db.failGrantRead) {
            return { data: null, error: { message: "connection reset" } };
          }
          let rows = db.grants.filter((g) =>
            eqs.every(([k, v]) => (g as Record<string, unknown>)[k] === v),
          );
          if (inFilter) {
            const [k, vs] = inFilter;
            rows = rows.filter((g) => vs.includes((g as Record<string, unknown>)[k]));
          }
          return { data: rows, error: null };
        }
        throw new Error(`unexpected read of ${table}`);
      };
      const q: Record<string, unknown> = {};
      for (const m of ["select", "not", "or", "order", "limit"]) q[m] = () => q;
      q.eq = (k: string, v: unknown) => (eqs.push([k, v]), q);
      q.in = (k: string, vs: unknown[]) => ((inFilter = [k, vs]), q);
      q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve().then(result).then(ok, bad);
      return q;
    },
  };
}

function grant(column_mask: string[] | null, principal_id = VIEWER): Grant {
  return {
    resource_type: "data_table",
    resource_id: SHARED_ID,
    principal_type: "user",
    principal_id,
    row_filter: null,
    column_mask,
  };
}

/** The sql_query description as resolveAgentTools builds it. */
async function sqlDescription(headless: boolean): Promise<string> {
  const ctx: AgentToolContext = {
    userId: VIEWER,
    sb: fakeSb() as never,
    // Headless: service-role client, RLS off, scopeUserId is the boundary.
    ...(headless ? { scopeUserId: VIEWER } : {}),
  };
  const resolved = await resolveAgentTools(ctx, { enabledTools: ["sql_query"] });
  const tool = resolved.tools.find((t) => t.function.name === "sql_query");
  expect(tool, "sql_query is registered").toBeTruthy();
  return tool!.function.description;
}

beforeEach(() => {
  db.grants = [];
  db.failGrantRead = false;
});

describe("the sql_query description applies a shared dataset's column mask", () => {
  for (const headless of [true, false]) {
    const path = headless ? "headless (service role)" : "interactive (RLS)";

    it(`leaves the masked column out, keeps the rest — ${path}`, async () => {
      db.grants = [grant(["salary"])];
      const d = await sqlDescription(headless);
      expect(d).toContain("payroll(");
      expect(d).toContain("region:string");
      expect(d).toContain("employee:string");
      expect(d).not.toMatch(/salary/i);
      // Own and sample tables are not shared: listed whole.
      expect(d).toContain("orders(order_id:number, amount:number)");
      expect(d).toContain("sample_sales(units:number)");
    });
  }

  it("matches the mask without regard to case, like the data path", async () => {
    db.grants = [grant(["SALARY"])];
    const d = await sqlDescription(true);
    expect(d).not.toMatch(/salary/i);
    expect(d).toContain("region:string");
  });

  it("hides a column only when EVERY grant hides it (masks intersect)", async () => {
    db.grants = [grant(["salary", "employee"]), grant(["salary"])];
    const d = await sqlDescription(true);
    expect(d).not.toMatch(/salary/i);
    // Only one of the two grants hides `employee`, so it is visible.
    expect(d).toContain("employee:string");
  });

  it("lists every column of a shared dataset whose grant carries no mask", async () => {
    db.grants = [grant(null)];
    const d = await sqlDescription(true);
    expect(d).toContain("payroll(region:string, salary:number, employee:string)");
  });
});

describe("the sql_query description fails closed", () => {
  it("lists NO columns of a shared dataset when its grant cannot be read", async () => {
    db.grants = [grant(["salary"])];
    db.failGrantRead = true;
    const d = await sqlDescription(true);
    // Named, so the model can still ask for it and hear the real reason...
    expect(d).toContain("payroll(");
    // ...but none of its columns, masked or not.
    expect(d).not.toMatch(/salary/i);
    expect(d).not.toContain("region");
    expect(d).not.toContain("employee");
    // The tables that need no grant are unaffected.
    expect(d).toContain("orders(order_id:number, amount:number)");
    expect(d).toContain("sample_sales(units:number)");
  });

  it("lists NO columns when the viewer holds no applicable grant", async () => {
    // The interactive path: RLS returned the row, but the only grant on it
    // belongs to somebody else.
    db.grants = [grant(null, STRANGER)];
    const d = await sqlDescription(false);
    expect(d).toContain("payroll(");
    expect(d).not.toMatch(/salary/i);
    expect(d).not.toContain("region");
    expect(d).toContain("orders(order_id:number, amount:number)");
  });
});
