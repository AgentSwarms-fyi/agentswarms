// One oversized dataset failed every server-side query its owner ran (R487).
//
// FOUND WHILE DOCUMENTING THE TWO CAPS IN R485. The server loaded EVERY dataset
// the user could read before running a statement over local data — not the
// tables the statement named — and refused the whole load as soon as one of
// them was over its per-table row cap:
//
//   * utils/bi/refresh.server `loadLocalTables`, behind every scheduled widget
//     refresh, data alert, analyst step and semantic query on local data, with
//     BI_LOCAL_ROWS_PER_TABLE_CAP (default 20,000). A shared dataset never uses
//     the Parquet mirror, so ONE shared dataset over 20,000 rows was enough to
//     fail all of them for that user, including widgets that never read it.
//   * utils/tools/sql.server `loadUserTables`, behind the sql_query and
//     list_data_tables agent tools, with SQL_TOOL_MAX_ROWS (default 200,000),
//     unless the agent had a table allow-list.
//
// The refusal itself is right and stays: a capped dataset is never answered
// from its first rows. What changes is its reach — an oversized dataset fails
// the queries that read it, and nothing else.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  // Both caps at 3, so a five-row table is "oversized". SQL_TOOL_MAX_ROWS is
  // read when its module loads, which is why this runs hoisted.
  const saved = {
    tool: process.env.SQL_TOOL_MAX_ROWS,
    bi: process.env.BI_LOCAL_ROWS_PER_TABLE_CAP,
  };
  process.env.SQL_TOOL_MAX_ROWS = "3";
  process.env.BI_LOCAL_ROWS_PER_TABLE_CAP = "3";
  return {
    saved,
    /** Every dataset scan, by table id, in order. */
    scans: [] as string[],
    rows: {} as Record<string, Record<string, unknown>[]>,
    tables: [] as {
      id: string;
      name: string;
      columns: { name: string; type: "number" | "string" | "date" }[];
      user_id: string;
      is_sample: boolean;
      data_loaded_at: string | null;
      parquet_synced_at: string | null;
    }[],
    shared: new Set<string>(),
  };
});

/** A builder that answers every link with itself and resolves to `result`. */
function chain(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "not", "or", "eq", "order", "in"]) q[m] = () => q;
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(ok, bad);
  return q;
}

const fakeDb = {
  from(table: string) {
    if (table !== "user_data_tables") throw new Error(`unexpected read of ${table}`);
    return chain({ data: h.tables, error: null });
  },
};

// A getter, because the factory is hoisted above `fakeDb`.
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return fakeDb;
  },
}));

// The scan honours its cap the way the real one does: at most `cap` rows, and
// `truncated` when there was more.
vi.mock("@/utils/data/datasetRows.server", () => ({
  scanDatasetRows: async (tableId: string, cap: number) => {
    h.scans.push(tableId);
    const all = h.rows[tableId] ?? [];
    return { rows: all.slice(0, cap), truncated: all.length > cap };
  },
}));

// No mirror anywhere: every dataset goes down the row path, as a shared one
// always does. The rest of the module stays real, since the engine uses it.
vi.mock("@/utils/data/parquet.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/data/parquet.server")>()),
  localParquetPath: async () => null,
}));

vi.mock("@/utils/data/sharedDatasets.server", () => ({
  grantedDatasetIds: async () => new Set(h.shared),
  // The grant admits everything: masking is not what this file is about.
  restrictSharedDataset: async (
    _sb: unknown,
    _id: string,
    _viewer: string,
    columns: unknown[],
    rows: unknown[],
  ) => ({ columns, rows }),
}));

vi.mock("@/utils/iam.server", () => ({
  resolveGrantedResourceIds: async () => new Set(h.shared),
}));

vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));

import { localSqlRunnerForUser, runLocalSqlForUser } from "@/utils/bi/refresh.server";
import { describeUserTables, runListDataTables, runSqlQuery } from "@/utils/tools/sql.server";
import type { AgentToolContext } from "@/utils/tools/registry.server";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const SMALL = "11111111-1111-4111-8111-111111111111";
const BIG = "22222222-2222-4222-8222-222222222222";

const NUM = [{ name: "n", type: "number" as const }];

function table(id: string, name: string, userId = OWNER) {
  return {
    id,
    name,
    columns: NUM,
    user_id: userId,
    is_sample: false,
    data_loaded_at: null,
    parquet_synced_at: null,
  };
}

/** Two datasets: `small` is the user's own, `big` is over the cap. */
function twoDatasets(bigOwner: "own" | "shared") {
  h.tables.length = 0;
  h.tables.push(table(SMALL, "small"), table(BIG, "big", bigOwner === "own" ? OWNER : OTHER));
  h.shared.clear();
  if (bigOwner === "shared") h.shared.add(BIG);
  h.rows = {
    [SMALL]: [{ n: 1 }, { n: 2 }, { n: 3 }],
    [BIG]: [{ n: 10 }, { n: 20 }, { n: 30 }, { n: 40 }, { n: 50 }],
  };
}

beforeEach(() => {
  h.scans.length = 0;
});

afterAll(() => {
  for (const [k, v] of [
    ["SQL_TOOL_MAX_ROWS", h.saved.tool],
    ["BI_LOCAL_ROWS_PER_TABLE_CAP", h.saved.bi],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const total = (rows: Record<string, unknown>[]) => Number(rows[0]?.total);

describe("server-side SQL over local data (refresh, alerts, semantic queries)", () => {
  for (const bigOwner of ["own", "shared"] as const) {
    describe(`with an oversized ${bigOwner} dataset beside a small one`, () => {
      beforeEach(() => twoDatasets(bigOwner));

      it("answers a query that reads only the small one", async () => {
        const res = await runLocalSqlForUser(OWNER, "SELECT SUM(n) AS total FROM small");
        expect(total(res.rows)).toBe(6);
        expect(h.scans, "the oversized dataset was read for a query that never names it").toEqual([
          SMALL,
        ]);
      });

      it("still refuses a query that reads the oversized one, naming the setting", async () => {
        await expect(runLocalSqlForUser(OWNER, "SELECT SUM(n) AS total FROM big")).rejects.toThrow(
          /"big" has more than 3 rows[\s\S]*BI_LOCAL_ROWS_PER_TABLE_CAP[\s\S]*refusing to refresh from a prefix/,
        );
      });

      it("refuses a join that reads both, rather than answering over a prefix", async () => {
        await expect(
          runLocalSqlForUser(
            OWNER,
            "SELECT COUNT(*) AS total FROM small s JOIN big b ON s.n * 10 = b.n",
          ),
        ).rejects.toThrow(/BI_LOCAL_ROWS_PER_TABLE_CAP/);
      });
    });
  }

  describe("what counts as reading a dataset", () => {
    beforeEach(() => twoDatasets("own"));

    it("is not a mention in a comment or a string literal", async () => {
      const res = await runLocalSqlForUser(
        OWNER,
        "SELECT SUM(n) AS total, 'big' AS label FROM small -- not from big\n/* nor big */",
      );
      expect(total(res.rows)).toBe(6);
      expect(h.scans).toEqual([SMALL]);
    });

    it("is a quoted reference, whatever its case", async () => {
      await expect(
        runLocalSqlForUser(OWNER, 'SELECT COUNT(*) AS total FROM "BIG"'),
      ).rejects.toThrow(/BI_LOCAL_ROWS_PER_TABLE_CAP/);
    });

    it("is the second table of a comma join, which a FROM/JOIN scan would miss", async () => {
      await expect(
        runLocalSqlForUser(OWNER, "SELECT COUNT(*) AS total FROM small, big"),
      ).rejects.toThrow(/BI_LOCAL_ROWS_PER_TABLE_CAP/);
    });

    it("is a reference inside a subquery", async () => {
      await expect(
        runLocalSqlForUser(
          OWNER,
          "SELECT SUM(n) AS total FROM small WHERE n IN (SELECT n / 10 FROM big)",
        ),
      ).rejects.toThrow(/BI_LOCAL_ROWS_PER_TABLE_CAP/);
    });
  });

  describe("the batching runner semantic validation uses", () => {
    beforeEach(() => twoDatasets("shared"));

    it("reads each dataset at most once across its queries, and only those named", async () => {
      const run = await localSqlRunnerForUser(OWNER);
      for (let i = 0; i < 3; i++) {
        expect(total((await run("SELECT SUM(n) AS total FROM small")).rows)).toBe(6);
      }
      expect(h.scans).toEqual([SMALL]);
    });

    it("fails only the queries that read the oversized one, and does not re-read it", async () => {
      const run = await localSqlRunnerForUser(OWNER);
      await expect(run("SELECT COUNT(*) AS total FROM big")).rejects.toThrow(
        /BI_LOCAL_ROWS_PER_TABLE_CAP/,
      );
      expect(total((await run("SELECT SUM(n) AS total FROM small")).rows)).toBe(6);
      await expect(run("SELECT MAX(n) AS total FROM big")).rejects.toThrow(
        /BI_LOCAL_ROWS_PER_TABLE_CAP/,
      );
      expect(h.scans.filter((id) => id === BIG)).toHaveLength(1);
    });
  });
});

describe("the sql_query and list_data_tables agent tools", () => {
  // Headless, the case where the shared dataset is read with the service role.
  const ctx = (): AgentToolContext =>
    ({ sb: fakeDb, userId: OWNER, scopeUserId: OWNER }) as unknown as AgentToolContext;

  for (const bigOwner of ["own", "shared"] as const) {
    describe(`with an oversized ${bigOwner} dataset beside a small one`, () => {
      beforeEach(() => twoDatasets(bigOwner));

      it("sql_query answers a query that reads only the small one", async () => {
        const out = JSON.parse(
          await runSqlQuery(ctx(), { sql: "SELECT SUM(n) AS total FROM small" }),
        ) as { rows?: Record<string, unknown>[]; error?: string };
        expect(out.error).toBeUndefined();
        expect(total(out.rows ?? [])).toBe(6);
        expect(h.scans).toEqual([SMALL]);
      });

      it("sql_query still refuses the oversized one, naming the setting", async () => {
        await expect(
          runSqlQuery(ctx(), { sql: "SELECT COUNT(*) AS total FROM big" }),
        ).rejects.toThrow(/"big" has more than 3 rows[\s\S]*SQL_TOOL_MAX_ROWS/);
      });

      it("list_data_tables still lists every table, and says which one is too large", async () => {
        const out = JSON.parse(await runListDataTables(ctx())) as {
          tables: {
            name: string;
            row_count: number | null;
            columns: { name: string }[];
            note?: string;
          }[];
        };
        expect(out.tables.map((t) => t.name)).toEqual(["small", "big"]);
        const [small, big] = out.tables;
        expect(small.row_count).toBe(3);
        expect(small.note).toBeUndefined();
        // Not a count of the rows it happened to read before stopping: that
        // number would be the cap, presented as the size of the table.
        expect(big.row_count).toBeNull();
        expect(big.columns.map((c) => c.name)).toEqual(["n"]);
        expect(big.note).toMatch(/more than 3 rows[\s\S]*SQL_TOOL_MAX_ROWS/);
      });

      it("the schema summary names both tables rather than failing", async () => {
        const out = await describeUserTables(ctx());
        expect(out).toContain("small(n:number) — 3 rows");
        expect(out).toMatch(/big\(n:number\) — more than 3 rows/);
      });
    });
  }
});
