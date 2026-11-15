// A shared dataset's columns, as the browser lists them (R491).
//
// The database half is proved against a real Postgres, as each user's own JWT,
// by deploy/ci/rds-like/shared-dataset-checks.mjs (run by both migration
// harnesses). These hold the browser half: sqlEngine.hydrateFromSupabase over a
// fake database, before and after migration 20261115000000, and the shape of
// that migration.
//
// The bug this pins: for a dataset shared under a column mask whose row filter
// admits no rows, hydration had no masked rows to read the columns from and
// fell back to `columns`, the OWNER's list. Every masked column's name then
// reached the SQL page's table list and chat prompt, and BI's.
import { readFileSync, readdirSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { contractingStatements } from "../../deploy/ci/migrations/schema-compat.mjs";

type Answer = { data: unknown; error: { code?: string; message: string } | null };

const h = vi.hoisted(() => ({
  direct: [] as Array<Record<string, unknown>>,
  shares: { data: [], error: null } as {
    data: unknown;
    error: { code?: string; message: string } | null;
  },
  sharedRows: {} as Record<string, unknown[]>,
  registered: [] as Array<{ name: string; columns: Array<{ name: string }>; rows: unknown[] }>,
  dropped: [] as string[],
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const b = {
      validator: () => b,
      inputValidator: () => b,
      handler: () => async () => ({ ok: true }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => ({
    select: (_cols: string, opts?: { head?: boolean }) => {
      if (table === "user_data_tables") {
        return { not: () => ({ order: async () => ({ data: h.direct, error: null }) }) };
      }
      if (opts?.head) return { eq: async () => ({ count: 1, error: null }) };
      return {
        eq: () => ({
          order: () => ({ range: async () => ({ data: [{ row: { mine: 1 } }], error: null }) }),
        }),
      };
    },
  });
  return {
    supabase: {
      from,
      rpc: async (name: string, args?: { _table_id: string }) => {
        if (name === "shared_datasets") return h.shares;
        if (name === "shared_dataset_rows") {
          return { data: h.sharedRows[args!._table_id] ?? [], error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
      auth: {
        getSession: async () => ({
          data: { session: { access_token: "tok", user: { id: "me" } } },
        }),
      },
    },
  };
});
vi.mock("@/utils/datasetRows.functions", () => ({
  datasetRowsGoThroughServer: async () => ({ ok: true, through: false }),
  readDatasetWindow: async () => ({ ok: true, rows: [] }),
  readSharedDataset: async () => ({ ok: true, rows: [] }),
  writeDatasetBatch: async () => ({ ok: true }),
}));
vi.mock("@/lib/browserDuckdb", () => ({
  dropBrowserTable: async (name: string) => {
    h.dropped.push(name);
  },
  isBrowserTableRegistered: () => false,
  prewarmBrowserEngine: async () => {},
  registerBrowserTables: async (
    t: Array<{ name: string; columns: Array<{ name: string }>; rows: unknown[] }>,
  ) => {
    h.registered.push(...t);
  },
  runBrowserSql: async () => ({ rows: [], columns: [] }),
}));

const { hydrateFromSupabase } = await import("@/lib/sqlEngine");
const { isMissingFunction, mergeSharedDatasets, readSharedDatasets, sharedColumns } =
  await import("@/lib/sharedDatasetList");

const col = (name: string, type = "string") => ({ name, type });
const OWNER_COLUMNS = [col("region"), col("salary", "number"), col("employee")];
const MASKED_COLUMNS = [col("region"), col("employee")];
const MISSING: Answer = {
  data: null,
  error: {
    code: "PGRST202",
    message:
      "Could not find the function public.shared_datasets without parameters in the schema cache",
  },
};

const dataset = (over: Record<string, unknown> = {}) => ({
  id: "own",
  name: "orders",
  source_filename: null,
  columns: [col("order_id", "number")],
  is_sample: false,
  user_id: "me",
  data_loaded_at: null,
  parquet_bytes: null,
  created_at: "2026-11-01T00:00:00Z",
  ...over,
});
/** A dataset someone else owns, shared with "me" under a mask on salary. */
const payroll = (columns: unknown, over: Record<string, unknown> = {}) =>
  dataset({ id: "pay", name: "payroll", user_id: "owner", columns, ...over });

const metaOf = async (name: string) => {
  const all = await hydrateFromSupabase();
  return { all, meta: all.find((t) => t.name === name) };
};
const names = (cols: Array<{ name: string }> | undefined) => cols?.map((c) => c.name);

beforeEach(() => {
  h.direct = [dataset()];
  h.shares = { data: [], error: null };
  h.sharedRows = {};
  h.registered = [];
  h.dropped = [];
});

describe("a share whose row filter admits no rows", () => {
  it("is listed with the columns its mask leaves, from the database", async () => {
    // Migrated: the direct read has no masked share; shared_datasets() does.
    h.shares = { data: [payroll(MASKED_COLUMNS)], error: null };
    const { meta } = await metaOf("payroll");
    expect(names(meta?.columns)).toEqual(["region", "employee"]);
    expect(meta?.row_count).toBe(0);
    const reg = h.registered.find((t) => t.name === "payroll");
    expect(names(reg?.columns)).toEqual(["region", "employee"]);
  });

  it("names none of the owner's columns on a database from before the migration", async () => {
    // The direct read still serves the share then, with the OWNER's list. This
    // is the fallback that named every masked column.
    h.direct = [dataset(), payroll(OWNER_COLUMNS)];
    h.shares = MISSING;
    const { meta } = await metaOf("payroll");
    expect(meta).toBeDefined();
    expect(meta?.columns).toEqual([]);
    // No table without a column: none is registered, and any old one is gone.
    expect(h.registered.find((t) => t.name === "payroll")).toBeUndefined();
    expect(h.dropped).toContain("payroll");
  });

  it("lists the owner's datasets whole either way", async () => {
    h.direct = [dataset(), payroll(OWNER_COLUMNS)];
    h.shares = MISSING;
    const { meta } = await metaOf("orders");
    expect(names(meta?.columns)).toEqual(["order_id"]);
  });
});

describe("a share with rows", () => {
  it("names the columns the masked rows carry, before the migration", async () => {
    h.direct = [dataset(), payroll(OWNER_COLUMNS)];
    h.shares = MISSING;
    h.sharedRows = { pay: [{ region: "west", employee: "A" }] };
    const { meta } = await metaOf("payroll");
    expect(names(meta?.columns)).toEqual(["region", "employee"]);
  });

  it("and after it", async () => {
    h.shares = { data: [payroll(MASKED_COLUMNS)], error: null };
    h.sharedRows = { pay: [{ region: "west", employee: "A" }] };
    const { meta } = await metaOf("payroll");
    expect(names(meta?.columns)).toEqual(["region", "employee"]);
  });
});

describe("the list", () => {
  it("has a share that is in both reads once, as the function gives it", async () => {
    // A share with no mask is still in the direct read after the migration.
    h.direct = [dataset(), payroll(OWNER_COLUMNS)];
    h.shares = { data: [payroll(MASKED_COLUMNS)], error: null };
    const { all, meta } = await metaOf("payroll");
    expect(all.filter((t) => t.name === "payroll")).toHaveLength(1);
    expect(names(meta?.columns)).toEqual(["region", "employee"]);
  });

  it("leaves out a share's in-flight upload", async () => {
    h.shares = { data: [payroll(MASKED_COLUMNS, { id: "up", name: "__upload_x" })], error: null };
    const { all } = await metaOf("payroll");
    expect(all.map((t) => t.name)).toEqual(["orders"]);
  });

  it("is not read as empty when the shares cannot be listed", async () => {
    h.shares = { data: null, error: { code: "57014", message: "statement timeout" } };
    await expect(hydrateFromSupabase()).rejects.toThrow(
      "could not list the datasets shared with you: statement timeout",
    );
  });
});

describe("the helpers", () => {
  it("tell a missing function from a failure", () => {
    expect(isMissingFunction(MISSING.error)).toBe(true);
    expect(isMissingFunction({ code: "42883", message: "x" })).toBe(true);
    expect(isMissingFunction({ message: "function public.shared_datasets() does not exist" })).toBe(
      true,
    );
    expect(isMissingFunction({ code: "57014", message: "statement timeout" })).toBe(false);
    expect(isMissingFunction(null)).toBe(false);
  });

  it("read a missing function as null, and throw anything else", async () => {
    const sb = (answer: Answer) => ({ rpc: async () => answer }) as never;
    expect(await readSharedDatasets(sb(MISSING))).toBeNull();
    expect(await readSharedDatasets(sb({ data: [{ id: "x" }], error: null }))).toEqual([
      { id: "x" },
    ]);
    await expect(
      readSharedDatasets(sb({ data: null, error: { message: "permission denied" } })),
    ).rejects.toThrow("permission denied");
  });

  it("merge by id, the function's row winning", () => {
    const direct = [
      { id: "a", v: "direct" },
      { id: "b", v: "direct" },
    ];
    expect(mergeSharedDatasets(direct, null)).toBe(direct);
    expect(
      mergeSharedDatasets(direct, [
        { id: "b", v: "fn" },
        { id: "c", v: "fn" },
      ]),
    ).toEqual([
      { id: "a", v: "direct" },
      { id: "b", v: "fn" },
      { id: "c", v: "fn" },
    ]);
  });

  it("list a share's columns only from what can be trusted", () => {
    expect(sharedColumns(OWNER_COLUMNS, [], true)).toEqual(OWNER_COLUMNS);
    expect(sharedColumns(OWNER_COLUMNS, [], false)).toEqual([]);
    expect(sharedColumns(OWNER_COLUMNS, [{ region: 1, employee: 2 }], false)).toEqual(
      MASKED_COLUMNS,
    );
  });
});

describe("migration 20261115000000", () => {
  const FILE = "20261115000000_shared_dataset_columns.sql";
  const SQL = readFileSync(`supabase/migrations/${FILE}`, "utf8");

  it("has a version no other migration has", () => {
    const versions = readdirSync("supabase/migrations").map((f) => f.split("_")[0]);
    expect(versions.filter((v) => v === "20261115000000")).toHaveLength(1);
  });

  it("contracts nothing, so it carries no contract line", () => {
    expect(contractingStatements(SQL)).toEqual([]);
    expect(SQL).not.toMatch(/^\s*--\s*contract:/m);
  });

  it("serves a share's row directly only when its mask hides nothing", () => {
    expect(SQL).toContain(
      'DROP POLICY IF EXISTS "Shared data tables are readable" ON public.user_data_tables;',
    );
    expect(SQL).toMatch(
      /CREATE POLICY "Shared data tables are readable when nothing is masked"\s+ON public\.user_data_tables FOR SELECT\s+TO authenticated\s+USING \(NOT is_sample AND user_id <> auth\.uid\(\) AND public\.shared_dataset_unmasked\(id\)\);/,
    );
  });

  it("matches a mask without regard to case or surrounding space, as the app does", () => {
    expect(SQL).toContain("SELECT DISTINCT lower(btrim(x, E' \\t\\r\\n\\f\\v'))");
    expect(SQL).toContain("WHERE lower(k) = ANY (mask)");
    expect(SQL).toContain("lower(COALESCE(e.c ->> 'name', e.c #>> '{}')) = ANY (_mask)");
  });

  it("lets no client ask for a mask, and no signed-out caller for anything", () => {
    expect(SQL).toContain(
      "REVOKE ALL ON FUNCTION public.dataset_grant_mask(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;",
    );
    for (const fn of [
      "shared_dataset_rows(uuid)",
      "shared_dataset_columns(uuid)",
      "shared_datasets()",
      "shared_dataset_unmasked(uuid)",
    ]) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon;`);
      expect(SQL).toContain(
        `GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated, service_role;`,
      );
    }
  });
});
