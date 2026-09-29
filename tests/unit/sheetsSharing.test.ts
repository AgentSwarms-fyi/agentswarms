// Sheets sharing (Phase G). A workbook is shared with people or IAM groups,
// as a viewer or an editor; a viewer's share can leave sheets out and keep
// only some rows. The server decides everything a browser receives:
// src/utils/sheets/access.server.ts. Here: how shares combine, how a grid
// sheet's rows are cut, the table restriction run on DuckDB through every
// read built on a table sheet, what a share may say, who may do what, and
// that every Sheets server function asks.
import { readFileSync } from "node:fs";

import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GridData } from "@/lib/sheets/engine";
import { compileColumnFormula } from "@/lib/sheets/sql/compile";
import {
  buildTableRelation,
  pageSql,
  valuesSql,
  workbookTables,
  type OtherTable,
  type TableConfig,
} from "@/lib/sheets/sql/tableQuery";

// ── A fake of the tables the resolver reads ──
type Row = Record<string, unknown>;
const db = {
  sheet_workbooks: [] as Row[],
  sheet_workbook_shares: [] as Row[],
  iam_group_members: [] as Row[],
  sheet_tabs: [] as Row[],
  fail: null as string | null,
};
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: keyof typeof db) => {
      const tests: ((r: Row) => boolean)[] = [];
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => (tests.push((r) => r[k] === v), b),
        in: (k: string, vs: unknown[]) => (tests.push((r) => vs.includes(r[k])), b),
        limit: () => b,
        // PostgREST's or=(and(principal_type.eq.user,principal_id.eq.X),and(...in.(a,b)))
        or: (expr: string) => {
          const user = /principal_type\.eq\.user,principal_id\.eq\.([\w-]+)/.exec(expr)?.[1];
          const groups = /principal_id\.in\.\(([^)]*)\)/.exec(expr)?.[1]?.split(",") ?? [];
          tests.push(
            (r) =>
              (r.principal_type === "user" && r.principal_id === user) ||
              (r.principal_type === "group" && groups.includes(r.principal_id as string)),
          );
          return b;
        },
        maybeSingle: () =>
          b.then((res: { data: Row[] }) => ({ ...res, data: res.data[0] ?? null })),
        then: (res: (v: { data: Row[]; error: unknown }) => unknown) =>
          Promise.resolve(
            db.fail && table === "iam_group_members"
              ? { data: null as unknown as Row[], error: { message: db.fail } }
              : { data: (db[table] as Row[]).filter((r) => tests.every((t) => t(r))), error: null },
          ).then(res),
      };
      return b;
    },
  },
}));

const access = await import("@/utils/sheets/access.server");
const { shareProblem } = await import("@/utils/sheetsShares.functions");
const { combineShares, filterGridRows, restrictedConfig } = access;

const OWNER = "u-owner";
const ANA = "u-ana";
const BEN = "u-ben";
const WB = "wb-1";

beforeEach(() => {
  db.fail = null;
  db.sheet_workbooks = [{ id: WB, user_id: OWNER }];
  db.iam_group_members = [{ user_id: BEN, group_id: "g-sales" }];
  db.sheet_workbook_shares = [];
  db.sheet_tabs = [];
});

// ── How shares combine ──

describe("several shares give the widest access, exactly", () => {
  const viewer = (row_filters: Row | null, hidden_sheets: string[] | null = null) => ({
    role: "viewer" as const,
    row_filters: row_filters as never,
    hidden_sheets,
  });

  it("an editor share wins over any viewer share", () => {
    const c = combineShares([
      viewer({ orders: { column: "region", values: ["West"] } }),
      { role: "editor", row_filters: null, hidden_sheets: null },
    ]);
    expect(c?.role).toBe("editor");
    expect(c?.filters.size).toBe(0);
  });

  it("a sheet is left out only if every share leaves it out", () => {
    const c = combineShares([viewer(null, ["Costs", "Notes"]), viewer(null, ["costs"])]);
    expect([...c!.hidden]).toEqual(["costs"]);
  });

  it("a row is kept if any share keeps it, even when their filters name different columns", () => {
    const c = combineShares([
      viewer({ Orders: { column: "region", values: ["West"] } }),
      viewer({ orders: { column: "plan", values: ["pro"] } }),
    ]);
    // Both filters, each able to keep a row: not "every row" (the draft's
    // fallback, which showed everything when the columns differed).
    expect(c!.filters.get("orders")).toEqual([
      { column: "region", values: ["West"] },
      { column: "plan", values: ["pro"] },
    ]);
  });

  it("a share that leaves a sheet unfiltered makes it unfiltered", () => {
    const c = combineShares([
      viewer({ orders: { column: "region", values: ["West"] } }),
      viewer(null),
    ]);
    expect(c!.filters.has("orders")).toBe(false);
  });

  it("no share, no access", () => {
    expect(combineShares([])).toBeNull();
  });
});

// ── A grid sheet's rows ──

describe("a filtered viewer's grid sheet", () => {
  const grid: GridData = {
    cells: {
      "0,0": { i: "Sales by region" },
      "1,0": { i: "Region" },
      "1,1": { i: "Amount" },
      "2,0": { i: "West" },
      "2,1": { i: "10" },
      "3,0": { i: "east" },
      "3,1": { i: "20" },
      "4,0": { i: "'WEST" },
      "4,1": { i: "30", s: { b: true } },
      "5,0": { i: "Total" },
      "5,1": { i: "=SUMPRODUCT(B3:B5)", c: 60 },
      "6,1": { i: "=B3*2", c: 20 },
    },
    rowHeights: { "3": 40, "2": 22 },
    hiddenRows: [9],
    filter: { range: "A2:B6", cols: {}, hidden: [3] },
  };
  const west = { column: "A", values: ["west"], header: 2 };

  it("keeps the header rows and the rows the filter keeps, without case", () => {
    const g = filterGridRows(grid, [west]);
    expect(Object.keys(g.cells).sort()).toEqual(["0,0", "1,0", "1,1", "2,0", "2,1", "4,0", "4,1"]);
    expect(g.cells["4,1"]).toEqual({ i: "30", s: { b: true } });
  });

  it("hides the rows it left out, and drops their sizes and the owner's filter state", () => {
    const g = filterGridRows(grid, [west]);
    expect(g.hiddenRows).toEqual([3, 5, 6, 9]);
    expect(g.rowHeights).toEqual({ "2": 22 });
    expect(g.filter?.hidden).toBeUndefined();
  });

  it("drops a kept cell's saved Excel value, which can total the rows left out", () => {
    const g = filterGridRows(
      {
        cells: {
          "0,0": { i: "Region" },
          "1,0": { i: "West" },
          "1,1": { i: "=SUMPRODUCT(X)", c: 999 },
        },
      },
      [{ column: "A", values: ["West"] }],
    );
    expect(g.cells["1,1"]).toEqual({ i: "=SUMPRODUCT(X)" });
  });

  it("any of several filters keeps a row", () => {
    const g = filterGridRows(grid, [west, { column: "B", values: ["20"], header: 2 }]);
    expect(Object.keys(g.cells)).toContain("3,1");
    expect(Object.keys(g.cells)).toContain("2,1");
    expect(Object.keys(g.cells)).not.toContain("5,0");
  });

  it("a filter that matches nothing leaves only the header", () => {
    const g = filterGridRows(grid, [{ column: "A", values: ["north"], header: 2 }]);
    expect(Object.keys(g.cells).sort()).toEqual(["0,0", "1,0", "1,1"]);
  });

  it("a filter on no column letter keeps no data row (refused at sharing, never widened here)", () => {
    const g = filterGridRows(grid, [{ column: "Region", values: ["West"], header: 2 }]);
    expect(Object.keys(g.cells).sort()).toEqual(["0,0", "1,0", "1,1"]);
  });
});

// ── A table sheet's rows, on DuckDB ──

describe("a filtered viewer's table sheet, through every read built on it", () => {
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run("CREATE SCHEMA sales");
    await conn.run(`CREATE TABLE sales.orders AS SELECT * FROM (VALUES
      (1, 'West', 'pro', 10.0), (2, 'East', 'free', 20.0), (3, 'West', 'free', 30.0),
      (4, 'North', 'pro', 40.0)) v(id, region, plan, amount)`);
    await conn.run(`CREATE TABLE sales.customers AS SELECT * FROM (VALUES
      (1, 'Acme'), (2, 'Globex'), (3, 'Initech'), (4, 'Umbrella')) v(order_id, name)`);
  });
  afterAll(() => conn?.closeSync());

  const orders: TableConfig = {
    source: { kind: "lakehouse", schema: "sales", table: "orders" },
    columns: [
      { name: "id", type: "INTEGER" },
      { name: "region", type: "VARCHAR" },
      { name: "plan", type: "VARCHAR" },
      { name: "amount", type: "DOUBLE" },
    ],
    calculated: [],
    sort: [],
    filters: [],
    hidden: [],
    widths: {},
  };
  const viewerOfWest: access.WorkbookAccess = {
    role: "viewer",
    workbookId: WB,
    ownerId: OWNER,
    hidden: new Set(),
    filters: new Map([["orders", [{ column: "region", values: ["West"] }]]]),
    viewingAs: null,
  };
  const rows = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson();

  it("a page holds only the kept rows, and its total counts only them", async () => {
    const cfg = restrictedConfig(viewerOfWest, "Orders", orders);
    const rel = buildTableRelation(cfg, { name: "Orders" });
    const got = await rows(pageSql(rel, cfg, { offset: 0, limit: 100 }));
    expect(got.map((r) => r.region)).toEqual(["West", "West"]);
    expect(Number(got[0].__total)).toBe(2);
  });

  it("the sheet's own filters narrow further; they never widen", async () => {
    const cfg = restrictedConfig(viewerOfWest, "Orders", {
      ...orders,
      filters: [{ column: "region", op: "eq", value: "East" }],
    });
    const rel = buildTableRelation(cfg, { name: "Orders" });
    expect(await rows(pageSql(rel, cfg, { offset: 0, limit: 100 }))).toEqual([]);
  });

  it("a filter's value list offers only the kept rows' values", async () => {
    const cfg = restrictedConfig(viewerOfWest, "Orders", orders);
    const rel = buildTableRelation(cfg, { name: "Orders" });
    const got = await rows(valuesSql(rel, cfg, "region"));
    expect(got.map((r) => r.v)).toEqual(["West"]);
  });

  it("a grid formula over the table totals only the kept rows (formulas ignore view filters, not shares)", async () => {
    const others = (n: string): OtherTable | undefined =>
      n.toLowerCase() === "orders"
        ? { name: "Orders", config: restrictedConfig(viewerOfWest, "Orders", orders) }
        : undefined;
    const tables = workbookTables(others);
    const { sql } = compileColumnFormula("=SUM(Orders[amount])", {
      columns: [],
      self: "(SELECT 1)",
      row: "p",
      table: tables.resolve,
    });
    const got = await rows(`WITH ${tables.ctes.join(",\n")}\nSELECT ${sql} AS v`);
    expect(Number(got[0].v)).toBe(40);
  });

  it("a pivot of the table groups only the kept rows", async () => {
    const pivot: TableConfig = {
      ...orders,
      source: {
        kind: "pivot",
        from: "Orders",
        rows: ["region"],
        values: [{ column: "amount", agg: "sum" }],
      },
      columns: [],
    };
    const rel = buildTableRelation(pivot, {
      name: "ByRegion",
      others: (n) =>
        n.toLowerCase() === "orders"
          ? { name: "Orders", config: restrictedConfig(viewerOfWest, "Orders", orders) }
          : undefined,
    });
    const got = await rows(pageSql(rel, pivot, { offset: 0, limit: 100 }));
    expect(got.map((r) => [r.region, Number(r.sum_amount)])).toEqual([["West", 40]]);
  });

  it("a filter on the pivot itself keeps only those groups", async () => {
    const pivot: TableConfig = {
      ...orders,
      source: {
        kind: "pivot",
        from: "Orders",
        rows: ["plan"],
        values: [{ column: "amount", agg: "sum" }],
      },
      columns: [],
      restrict: [{ column: "plan", op: "in", values: ["pro"] }],
    };
    const rel = buildTableRelation(pivot, {
      name: "ByPlan",
      others: (n) =>
        n.toLowerCase() === "orders" ? { name: "Orders", config: orders } : undefined,
    });
    const got = await rows(pageSql(rel, pivot, { offset: 0, limit: 100 }));
    expect(got.map((r) => [r.plan, Number(r.sum_amount)])).toEqual([["pro", 50]]);
  });

  it("a lookup from another sheet into the table finds only kept rows", async () => {
    const customers: TableConfig = {
      ...orders,
      source: { kind: "lakehouse", schema: "sales", table: "customers" },
      columns: [
        { name: "order_id", type: "INTEGER" },
        { name: "name", type: "VARCHAR" },
      ],
      calculated: [
        { name: "region", formula: '=XLOOKUP([@order_id], Orders[id], Orders[region], "hidden")' },
      ],
    };
    const rel = buildTableRelation(customers, {
      name: "Customers",
      others: (n) =>
        n.toLowerCase() === "orders"
          ? { name: "Orders", config: restrictedConfig(viewerOfWest, "Orders", orders) }
          : undefined,
    });
    const got = await rows(pageSql(rel, customers, { offset: 0, limit: 100 }));
    expect(got.map((r) => r.region)).toEqual(["West", "hidden", "West", "hidden"]);
  });

  it("two shares' filters on different columns keep either's rows, and no others", async () => {
    const both: access.WorkbookAccess = {
      ...viewerOfWest,
      filters: new Map([
        [
          "orders",
          [
            { column: "region", values: ["West"] },
            { column: "plan", values: ["pro"] },
          ],
        ],
      ]),
    };
    const cfg = restrictedConfig(both, "Orders", orders);
    const rel = buildTableRelation(cfg, { name: "Orders" });
    const got = await rows(pageSql(rel, cfg, { offset: 0, limit: 100 }));
    expect(got.map((r) => Number(r.id))).toEqual([1, 3, 4]);
  });

  it("a filter naming a column the table no longer has is refused, not widened", () => {
    const cfg = restrictedConfig(
      {
        ...viewerOfWest,
        filters: new Map([["orders", [{ column: "territory", values: ["West"] }]]]),
      },
      "Orders",
      orders,
    );
    expect(() => buildTableRelation(cfg, { name: "Orders" })).toThrow(/no column "territory"/);
  });

  it("the owner and editors read every row", () => {
    const owner: access.WorkbookAccess = { ...viewerOfWest, role: "owner", filters: new Map() };
    expect(restrictedConfig(owner, "Orders", orders).restrict).toBeUndefined();
  });

  it("a browser cannot send a restriction, or take one away: the schema refuses the field", async () => {
    const { tableConfigSchema } = await import("@/utils/sheets/schemas");
    expect(() => tableConfigSchema.parse({ ...orders, restrict: [] })).toThrow(/restrict/);
  });
});

// ── What a share may say ──

describe("a share is checked against the workbook as it is", () => {
  const sheets = [
    { name: "Orders", kind: "table", columns: ["id", "region"], source: "sales.orders" },
    { name: "Summary", kind: "grid", columns: null, source: null },
  ];
  it("a filter on a column the table sheet has, or a grid column letter", () => {
    expect(shareProblem(sheets, { orders: { column: "region", values: ["West"] } }, [])).toBeNull();
    expect(shareProblem(sheets, { summary: { column: "B", values: ["x"] } }, [])).toBeNull();
  });
  it("refuses what would look like protection and do nothing", () => {
    expect(shareProblem(sheets, { orders: { column: "territory", values: ["W"] } }, [])).toMatch(
      /no column/,
    );
    expect(shareProblem(sheets, { costs: { column: "a", values: ["x"] } }, [])).toMatch(
      /no sheet named/,
    );
    expect(shareProblem(sheets, { summary: { column: "Region", values: ["x"] } }, [])).toMatch(
      /by its letter/,
    );
    expect(shareProblem(sheets, {}, ["Costs"])).toMatch(/no sheet named "Costs"/);
  });
  it("a share must leave a sheet in", () => {
    expect(shareProblem(sheets, {}, ["orders", "summary"])).toMatch(/at least one sheet/);
  });
});

// ── Who may do what ──

describe("who may do what", () => {
  it("the owner may do anything; no one else without a share gets anything", async () => {
    expect((await access.requireAccess(OWNER, WB, "own")).ok).toBe(true);
    const none = await access.requireAccess(ANA, WB, "view");
    expect(none).toMatchObject({ ok: false, missing: true });
  });

  it("a person's own share, and a share to a group they are in", async () => {
    db.sheet_workbook_shares = [
      {
        workbook_id: WB,
        principal_type: "user",
        principal_id: ANA,
        role: "viewer",
        row_filters: null,
        hidden_sheets: ["costs"],
      },
      {
        workbook_id: WB,
        principal_type: "group",
        principal_id: "g-sales",
        role: "editor",
        row_filters: null,
        hidden_sheets: null,
      },
    ];
    const ana = await access.requireAccess(ANA, WB, "view");
    expect(ana.ok && ana.access.role).toBe("viewer");
    expect(ana.ok && [...ana.access.hidden]).toEqual(["costs"]);
    const ben = await access.requireAccess(BEN, WB, "edit");
    expect(ben.ok && ben.access.role).toBe("editor");
  });

  it("a viewer can't change it; an editor can't do the owner's part", async () => {
    db.sheet_workbook_shares = [
      {
        workbook_id: WB,
        principal_type: "user",
        principal_id: ANA,
        role: "viewer",
        row_filters: null,
        hidden_sheets: null,
      },
      {
        workbook_id: WB,
        principal_type: "user",
        principal_id: BEN,
        role: "editor",
        row_filters: null,
        hidden_sheets: null,
      },
    ];
    expect(await access.requireAccess(ANA, WB, "edit")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/to view/),
    });
    expect(await access.requireAccess(BEN, WB, "own", { doing: "delete it" })).toMatchObject({
      ok: false,
      error: "Only the workbook's owner can delete it",
    });
  });

  it("another workbook's share gives nothing here", async () => {
    db.sheet_workbook_shares = [
      {
        workbook_id: "wb-2",
        principal_type: "user",
        principal_id: ANA,
        role: "editor",
        row_filters: null,
        hidden_sheets: null,
      },
    ];
    expect((await access.requireAccess(ANA, WB, "view")).ok).toBe(false);
  });

  it("when the groups can't be read, access is refused rather than guessed", async () => {
    db.fail = "timeout";
    expect(await access.requireAccess(BEN, WB, "view")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/timeout/),
    });
  });

  it("the owner may look at it as a share sees it, and change nothing from there; no one else may", async () => {
    db.sheet_workbook_shares = [
      {
        id: "s-1",
        workbook_id: WB,
        principal_type: "user",
        principal_id: ANA,
        role: "viewer",
        row_filters: { orders: { column: "region", values: ["West"] } },
        hidden_sheets: null,
      },
    ];
    const as = await access.requireAccess(OWNER, WB, "view", { asShare: "s-1" });
    expect(as.ok && as.access.role).toBe("viewer");
    expect(as.ok && as.access.filters.get("orders")).toEqual([
      { column: "region", values: ["West"] },
    ]);
    expect(await access.requireAccess(OWNER, WB, "edit", { asShare: "s-1" })).toMatchObject({
      ok: false,
    });
    expect(await access.requireAccess(ANA, WB, "view", { asShare: "s-1" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Only the workbook's owner/),
    });
    // Seen as an EDITOR share sees it, still nothing changes from there: the
    // page is read-only, and so is the server.
    db.sheet_workbook_shares.push({
      id: "s-2",
      workbook_id: WB,
      principal_type: "user",
      principal_id: BEN,
      role: "editor",
      row_filters: null,
      hidden_sheets: null,
    });
    const asEditor = await access.requireAccess(OWNER, WB, "view", { asShare: "s-2" });
    expect(asEditor.ok && asEditor.access.role).toBe("editor");
    expect(await access.requireAccess(OWNER, WB, "edit", { asShare: "s-2" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/as a share sees it/),
    });
  });

  it("a sheet left out is not there at all: not sent, not looked up", async () => {
    db.sheet_workbook_shares = [
      {
        workbook_id: WB,
        principal_type: "user",
        principal_id: ANA,
        role: "viewer",
        row_filters: null,
        hidden_sheets: ["costs"],
      },
    ];
    db.sheet_tabs = [
      {
        id: "t-costs",
        workbook_id: WB,
        name: "Costs",
        kind: "table",
        position: 0,
        version: 1,
        table_config: {
          source: { kind: "lakehouse", schema: "s", table: "c" },
          columns: [],
          calculated: [],
          sort: [],
          filters: [],
          hidden: [],
          widths: {},
        },
      },
      {
        id: "t-orders",
        workbook_id: WB,
        name: "Orders",
        kind: "table",
        position: 1,
        version: 1,
        table_config: {
          source: { kind: "lakehouse", schema: "s", table: "o" },
          columns: [],
          calculated: [],
          sort: [],
          filters: [],
          hidden: [],
          widths: {},
        },
      },
    ];
    const t = await access.requireTab(ANA, "t-costs", "view");
    expect(t).toMatchObject({
      ok: false,
      error: expect.stringMatching(/does not exist, or is not shared/),
    });
    const a = await access.requireAccess(ANA, WB, "view");
    const others = await access.othersFor(a.ok ? a.access : (null as never), "");
    expect([...others.keys()]).toEqual(["orders"]);
  });
});

// ── Every Sheets server function asks ──

describe("every Sheets server function asks the resolver", () => {
  /** Functions that are not about one workbook, and what guards them instead. */
  const NOT_ONE_WORKBOOK: Record<string, string> = {
    sheetsList: "lists the caller's own and sharedWithMe",
    sheetsCreate: "makes a new workbook of the caller's",
    sheetsBackfillPreviews: "reads only the caller's own sheets (user_id)",
    sheetsTableSources: "lists the lakehouse tables the caller can read",
    sheetsConnectionTables: "reads a connection the caller may use",
    sheetsCatalogAssets: "reads the catalog as the caller",
    sheetsRegisterTable: "a schema the caller owns",
    sheetsShareGroups: "lists groups",
  };
  const files = [
    "src/utils/sheets.functions.ts",
    "src/utils/sheetsTables.functions.ts",
    "src/utils/sheetsPublish.functions.ts",
    "src/utils/sheetsVersions.functions.ts",
    "src/utils/sheetsShares.functions.ts",
    "src/utils/sheetsAssist.functions.ts",
  ];
  const bodies = new Map<string, string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const parts = src.split(/export const (\w+) = createServerFn/);
    for (let i = 1; i < parts.length; i += 2) bodies.set(parts[i], parts[i + 1]);
  }

  it("each one about a workbook resolves the caller's access to it", () => {
    const unguarded = [...bodies]
      .filter(([name]) => !(name in NOT_ONE_WORKBOOK))
      .filter(([, body]) => !/\brequire(Access|Tab)\(/.test(body) && !/\baddTableTab\(/.test(body))
      .map(([name]) => name);
    expect(unguarded).toEqual([]);
    // The list above names only functions that exist.
    for (const name of Object.keys(NOT_ONE_WORKBOOK)) expect(bodies.has(name), name).toBe(true);
  });

  it("imports into the lakehouse, and refreshing one, are the owner's", () => {
    for (const name of ["sheetsImportFromConnection", "sheetsImportCsv", "sheetsRefreshImport"]) {
      expect(bodies.get(name), name).toMatch(/require(Access|Tab)\([^)]*"own"/);
    }
    // A catalog table from a database is imported: the owner's too.
    expect(bodies.get("sheetsOpenCatalogAsset")).toMatch(/requireAccess\([^)]*"own"/);
  });

  it("deleting a workbook and managing its shares are the owner's", () => {
    for (const name of [
      "sheetsDelete",
      "sheetsSharesList",
      "sheetsShareSet",
      "sheetsShareRemove",
    ]) {
      expect(bodies.get(name), name).toMatch(/requireAccess\([^)]*"own"/);
    }
  });

  it("reads of a table sheet force the viewer's restriction and use the hidden-aware lookups", () => {
    for (const name of ["sheetsTablePage", "sheetsTableValues", "sheetsTableExport"]) {
      const b = bodies.get(name)!;
      expect(b, name).toMatch(/restrictedConfig\(\s*access,\s*tab\.name,/);
      expect(b, name).toMatch(/othersFor\(access, tab\.id\)/);
    }
    expect(bodies.get("sheetsTableCalls")).toMatch(/othersFor\(got\.access, ""\)/);
  });

  it("nothing in them decides access by matching the caller's id to a sheet's owner", () => {
    for (const [name, body] of bodies) {
      if (name in NOT_ONE_WORKBOOK) continue;
      expect(body, name).not.toMatch(
        /\.eq\("user_id", (caller|who)\.userId\)[\s\S]{0,40}sheet_tabs/,
      );
      expect(body, name).not.toMatch(
        /from\("sheet_tabs"\)[\s\S]{0,300}\.eq\("user_id", (caller|who)\.userId\)/,
      );
    }
  });

  it("opening a workbook sends each sheet as this caller may have it, and no thumbnail to a restricted viewer", () => {
    const get = bodies.get("sheetsGet")!;
    expect(get).toMatch(/all\.map\(\(t\) => tabFor\(access, t\)\)\.filter/);
    expect(get).toMatch(/tabs: shown,/);
    expect(get).toMatch(
      /const restricted =\s*access\.role === "viewer" && \(access\.hidden\.size > 0 \|\| access\.filters\.size > 0\);/,
    );
    const list = bodies.get("sheetsList")!;
    expect(list).toMatch(/preview: restricted \? null : keptPreview/);
  });

  it("opening a table can't say it was imported (R129)", () => {
    expect(bodies.get("sheetsAddTableTab")).toMatch(
      /o\.kind === "lakehouse" \|\| o\.kind === "catalog"/,
    );
  });
});
