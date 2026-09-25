// The Sheets gallery: a workbook's thumbnail (the corner of its first grid
// sheet as it reads: values, bold, fills, widths), the search that finds a
// workbook by its name, description or a sheet's name, the orders it can be
// listed in, and the server functions that keep and build thumbnails.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GridData } from "@/lib/sheets/engine";
import {
  buildPreview,
  matchSpans,
  previewSchema,
  searchWorkbooks,
  type CellShown,
  type GalleryItem,
} from "@/lib/sheets/preview";
import { BACKFILL_MAX_CELLS, previewOfTabs } from "@/utils/sheets/preview.server";

const text = (t: string): CellShown => ({ text: t, kind: t ? "text" : "empty", align: "left" });
const num = (t: string): CellShown => ({ text: t, kind: "number", align: "right" });
const fromInputs =
  (grid: GridData) =>
  (r: number, c: number): CellShown => {
    const i = grid.cells[`${r},${c}`]?.i ?? "";
    return /^-?\d/.test(i) ? num(i) : text(i);
  };

describe("the thumbnail of a sheet", () => {
  it("is the corner as it reads: values, alignment, bold, fill and color", () => {
    const grid: GridData = {
      cells: {
        "0,0": { i: "Region", s: { b: true, bg: "#1F4E79", color: "#FFFFFF" } },
        "0,1": { i: "Sales", s: { b: true } },
        "1,0": { i: "West" },
        "1,1": { i: "=B9*2" },
      },
    };
    const p = buildPreview("Q3", grid, (r, c) =>
      r === 1 && c === 1 ? num("1,250") : fromInputs(grid)(r, c),
    );
    expect(p.sheet).toBe("Q3");
    expect(p.rows[0][0]).toEqual({ t: "Region", b: 1, bg: "#1f4e79", fg: "#ffffff" });
    expect(p.rows[0][1]).toEqual({ t: "Sales", b: 1 });
    // The value, never the formula.
    expect(p.rows[1][1]).toEqual({ t: "1,250", a: "r" });
    expect(previewSchema.safeParse(p).success).toBe(true);
  });

  it("skips hidden and filtered-out rows and hidden columns, as the sheet does on screen", () => {
    const grid: GridData = {
      cells: {
        "0,0": { i: "a" },
        "1,0": { i: "b" },
        "2,0": { i: "c" },
        "3,0": { i: "d" },
        "0,1": { i: "x" },
        "0,2": { i: "y" },
      },
      hiddenRows: [1],
      hiddenCols: [1],
      filter: { range: "A1:A4", cols: {}, hidden: [2] },
    };
    const p = buildPreview("S", grid, fromInputs(grid));
    expect(p.rows.map((r) => r[0]?.t)).toEqual(["a", "d"]);
    expect(p.rows[0][1]?.t).toBe("y");
  });

  it("shows a merged cell's text once, in its top-left cell, and its fill across it", () => {
    const grid: GridData = { cells: { "0,0": { i: "Title" } }, merges: ["A1:C1"] };
    const p = buildPreview("S", grid, fromInputs(grid));
    expect(p.rows[0].slice(0, 3)).toEqual([{ t: "Title" }, null, null]);
    // What lies under the rest of a merge (Excel keeps it) is never shown.
    const filled: GridData = {
      cells: { "0,0": { i: "Title", s: { bg: "#DDEBF7" } }, "0,1": { i: "under" } },
      merges: ["A1:C1"],
    };
    const q = buildPreview("S", filled, fromInputs(filled));
    expect(q.rows[0].slice(0, 3)).toEqual([
      { t: "Title", bg: "#ddebf7" },
      { t: "", bg: "#ddebf7" },
      { t: "", bg: "#ddebf7" },
    ]);
  });

  it("drops trailing empty rows and columns, keeps three columns at least, and scales the widths", () => {
    const grid: GridData = { cells: { "0,0": { i: "only" } }, colWidths: { "0": 208 } };
    const p = buildPreview("S", grid, fromInputs(grid));
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toHaveLength(3);
    expect(p.widths).toEqual([0.5, 0.25, 0.25]);
  });

  it("stays small: 8 rows, 6 columns, 32 characters a cell, 3 charts", () => {
    const cells: GridData["cells"] = {};
    for (let r = 0; r < 20; r++)
      for (let c = 0; c < 20; c++) cells[`${r},${c}`] = { i: "x".repeat(50) };
    const charts = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      type: "line" as const,
      range: "A1:B3",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    }));
    const grid = { cells, charts } as unknown as GridData;
    const p = buildPreview("S", grid, fromInputs(grid));
    expect(p.rows).toHaveLength(8);
    expect(p.rows[0]).toHaveLength(6);
    expect(p.rows[0][0]!.t).toHaveLength(32);
    expect(p.charts).toEqual(["line", "line", "line"]);
    // The badge still counts all of them.
    expect(p.chartCount).toBe(5);
    expect(previewSchema.safeParse(p).success).toBe(true);
  });

  it("the schema refuses what a thumbnail never holds", () => {
    const ok = { v: 1, sheet: "S", rows: [[{ t: "a" }]], widths: [1], charts: [] };
    expect(previewSchema.safeParse(ok).success).toBe(true);
    expect(previewSchema.safeParse({ ...ok, rows: Array(9).fill([]) }).success).toBe(false);
    expect(previewSchema.safeParse({ ...ok, rows: [[{ t: "a", bg: "red" }]] }).success).toBe(false);
    expect(previewSchema.safeParse({ ...ok, rows: [[{ t: "a", onclick: "x" }]] }).success).toBe(
      false,
    );
    expect(previewSchema.safeParse({ ...ok, charts: ["gauge"] }).success).toBe(false);
  });
});

describe("a thumbnail built on the server", () => {
  const tab = (
    id: string,
    name: string,
    position: number,
    cells: GridData["cells"],
    kind: "grid" | "table" = "grid",
  ) => ({
    id,
    name,
    kind,
    position,
    grid: kind === "grid" ? { cells } : null,
  });

  it("computes formulas, across sheets too, with the engine the editor runs", () => {
    const p = previewOfTabs([
      tab("t2", "Rates", 1, { "0,0": { i: "0.5" } }),
      tab("t1", "Summary", 0, { "0,0": { i: "Total" }, "0,1": { i: "=SUM(4,6)*Rates!A1" } }),
    ])!;
    expect(p.sheet).toBe("Summary");
    expect(p.rows[0][0]).toEqual({ t: "Total" });
    expect(p.rows[0][1]).toEqual({ t: "5", a: "r" });
  });

  it("carries the colors conditional formatting gives the cells, over their own", () => {
    const p = previewOfTabs([
      {
        id: "t1",
        name: "Q",
        kind: "grid",
        position: 0,
        grid: {
          cells: { "0,0": { i: "20", s: { bg: "#FFFFFF" } }, "0,1": { i: "5" } },
          cond: [
            {
              id: "c1",
              ranges: ["A1:B1"],
              rule: {
                kind: "cell",
                op: "gt",
                a: "15",
                style: { bg: "#FFC7CE", color: "#9C0006", b: true },
              },
            },
          ],
        },
      },
    ])!;
    expect(p.rows[0][0]).toEqual({ t: "20", a: "r", b: 1, bg: "#ffc7ce", fg: "#9c0006" });
    expect(p.rows[0][1]).toEqual({ t: "5", a: "r" });
  });

  it("draws the first grid sheet, passing over a table sheet before it", () => {
    const p = previewOfTabs([
      tab("a", "Orders", 0, {}, "table"),
      tab("b", "Notes", 1, { "0,0": { i: "hello" } }),
    ])!;
    expect(p.sheet).toBe("Notes");
    expect(previewOfTabs([tab("a", "Orders", 0, {}, "table")])).toBeNull();
  });

  it("leaves a workbook too large to compute here with an empty thumbnail", () => {
    const cells: GridData["cells"] = {};
    for (let i = 0; i <= BACKFILL_MAX_CELLS; i++) cells[`${i},0`] = { i: "1" };
    const p = previewOfTabs([tab("a", "Big", 0, cells)])!;
    expect(p).toEqual({ v: 1, sheet: "Big", rows: [], widths: [], charts: [] });
  });
});

describe("search and order", () => {
  const wb = (name: string, extra: Partial<GalleryItem> = {}): GalleryItem => ({
    id: name,
    name,
    description: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    sheets: [],
    ...extra,
  });
  const list = [
    wb("Q10 plan", { updated_at: "2026-09-03T00:00:00Z", created_at: "2026-08-01T00:00:00Z" }),
    wb("Q2 plan", { updated_at: "2026-09-05T00:00:00Z", sheets: [{ name: "West", kind: "grid" }] }),
    wb("Café budget", { description: "Monthly costs", created_at: "2026-09-10T00:00:00Z" }),
    wb("Zürich offices", {
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    }),
  ];

  it("finds by name, description or a sheet's name; every word must be found", () => {
    expect(searchWorkbooks(list, "plan", "name").map((w) => w.name)).toEqual([
      "Q2 plan",
      "Q10 plan",
    ]);
    expect(searchWorkbooks(list, "west", "edited").map((w) => w.name)).toEqual(["Q2 plan"]);
    expect(searchWorkbooks(list, "plan west", "edited").map((w) => w.name)).toEqual(["Q2 plan"]);
    expect(searchWorkbooks(list, "monthly", "edited").map((w) => w.name)).toEqual(["Café budget"]);
    expect(searchWorkbooks(list, "cafe", "edited").map((w) => w.name)).toEqual(["Café budget"]);
    // An accent inside a word, too.
    expect(searchWorkbooks(list, "zurich", "edited").map((w) => w.name)).toEqual([
      "Zürich offices",
    ]);
    expect(searchWorkbooks(list, "plan east", "edited")).toEqual([]);
    expect(searchWorkbooks(list, "   ", "edited")).toHaveLength(4);
  });

  it("orders by last edit, by name (Q2 before Q10), or by creation, newest first", () => {
    expect(searchWorkbooks(list, "", "edited").map((w) => w.name)).toEqual([
      "Q2 plan",
      "Q10 plan",
      "Café budget",
      "Zürich offices",
    ]);
    expect(searchWorkbooks(list, "", "name").map((w) => w.name)).toEqual([
      "Café budget",
      "Q2 plan",
      "Q10 plan",
      "Zürich offices",
    ]);
    expect(searchWorkbooks(list, "", "created")[0].name).toBe("Café budget");
    // The list passed in is left as it was.
    expect(list[0].name).toBe("Q10 plan");
  });

  it("marks where the words fall, overlaps merged", () => {
    expect(matchSpans("Plan plan", "plan")).toEqual([
      [0, 4],
      [5, 9],
    ]);
    expect(matchSpans("abcdef", "abc cde")).toEqual([[0, 5]]);
    expect(matchSpans("abc", "")).toEqual([]);
  });
});

// ── The server functions, against an in-memory stand-in for the tables ──

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const b = {
    select: () => b,
    eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), b),
    in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), b),
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({
      data: (db[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null,
      error: null,
    }),
    then: (res: (v: unknown) => unknown) =>
      Promise.resolve({
        data: (db[table] ?? []).filter((r) => filters.every((f) => f(r))),
        error: null,
      }).then(res),
    upsert: async (row: Row) => {
      const list = (db[table] ??= []);
      const i = list.findIndex((r) => r.workbook_id === row.workbook_id);
      if (i >= 0) list[i] = { ...list[i], ...row };
      else list.push(row);
      return { error: null };
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (t: string) => query(t),
    auth: {
      getUser: async (token: string) => ({ data: { user: { id: token.slice(5) } }, error: null }),
    },
  },
}));
vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getPlatformResources: async () => ({
    sheetsMaxCells: 1000,
    sheetsPageRows: 100,
    sheetsImportMaxSheets: 10,
    sheetsExportMaxRows: 100,
  }),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      inputValidator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (h: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        h({ data: validate(opts.data) }),
    };
    return b;
  },
}));

const fns = await import("@/utils/sheets.functions");
const OWNER = "owner-1";
const WB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const preview = { v: 1 as const, sheet: "S", rows: [[{ t: "hi" }]], widths: [1], charts: [] };

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.sheet_workbooks = [
    {
      id: WB,
      user_id: OWNER,
      name: "Mine",
      description: null,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-02T00:00:00Z",
    },
    {
      id: OTHER,
      user_id: "someone",
      name: "Theirs",
      description: null,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-02T00:00:00Z",
    },
  ];
  db.sheet_tabs = [
    {
      id: "t1",
      workbook_id: WB,
      user_id: OWNER,
      name: "Plan",
      kind: "grid",
      position: 0,
      grid: { cells: { "0,0": { i: "=1+1" } } },
    },
    {
      id: "t2",
      workbook_id: OTHER,
      user_id: "someone",
      name: "Secret",
      kind: "grid",
      position: 0,
      grid: { cells: { "0,0": { i: "salary" } } },
    },
  ];
  db.sheet_workbook_previews = [];
});

describe("keeping a thumbnail", () => {
  it("keeps the owner's, in its own table (the workbook row is not touched)", async () => {
    const r = await fns.sheetsSetPreview({
      data: { access_token: `user:${OWNER}`, workbook_id: WB, preview },
    });
    expect(r).toEqual({ ok: true });
    expect(db.sheet_workbook_previews).toEqual([
      expect.objectContaining({ workbook_id: WB, user_id: OWNER, preview }),
    ]);
    expect(db.sheet_workbooks[0].updated_at).toBe("2026-09-02T00:00:00Z");
  });

  it("refuses someone else's workbook, and a thumbnail that is not one", async () => {
    const r = await fns.sheetsSetPreview({
      data: { access_token: `user:${OWNER}`, workbook_id: OTHER, preview },
    });
    expect(r).toEqual({ ok: false, error: "This workbook does not exist, or is not yours" });
    expect(() =>
      fns.sheetsSetPreview({
        data: {
          access_token: `user:${OWNER}`,
          workbook_id: WB,
          preview: { ...preview, rows: [[{ t: "<b>", style: "x" }]] },
        },
      }),
    ).toThrow();
    expect(db.sheet_workbook_previews).toEqual([]);
  });
});

describe("building missing thumbnails", () => {
  it("builds the caller's from their saved sheets, and keeps them", async () => {
    const r = (await fns.sheetsBackfillPreviews({
      data: { access_token: `user:${OWNER}`, ids: [WB] },
    })) as {
      ok: true;
      previews: Record<string, { rows: unknown[][] }>;
    };
    expect(r.previews[WB].rows[0][0]).toEqual({ t: "2", a: "r" });
    expect(db.sheet_workbook_previews.map((p) => p.workbook_id)).toEqual([WB]);
  });

  it("never reads another person's sheets", async () => {
    const r = await fns.sheetsBackfillPreviews({
      data: { access_token: `user:${OWNER}`, ids: [OTHER] },
    });
    expect(r).toEqual({ ok: true, previews: {} });
    expect(db.sheet_workbook_previews).toEqual([]);
  });

  it("leaves one that already has a thumbnail alone", async () => {
    db.sheet_workbook_previews = [{ workbook_id: WB, user_id: OWNER, preview }];
    const r = await fns.sheetsBackfillPreviews({
      data: { access_token: `user:${OWNER}`, ids: [WB] },
    });
    expect(r).toEqual({ ok: true, previews: {} });
    expect(db.sheet_workbook_previews[0].preview).toBe(preview);
  });

  it("asks for at most four at a time", () => {
    expect(() =>
      fns.sheetsBackfillPreviews({
        data: { access_token: `user:${OWNER}`, ids: Array(5).fill(WB) },
      }),
    ).toThrow();
  });
});

describe("the list", () => {
  it("carries each workbook's sheets in order and its thumbnail; one that is not a thumbnail reads as none", async () => {
    db.sheet_workbooks = [
      {
        ...db.sheet_workbooks[0],
        sheet_tabs: [
          { name: "B", kind: "table", position: 1 },
          { name: "A", kind: "grid", position: 0 },
        ],
        sheet_workbook_previews: { preview },
      },
      {
        ...db.sheet_workbooks[1],
        user_id: OWNER,
        sheet_tabs: [],
        sheet_workbook_previews: [{ preview: { v: 2 } }],
      },
    ];
    const r = (await fns.sheetsList({ data: { access_token: `user:${OWNER}` } })) as {
      ok: true;
      workbooks: { name: string; sheets: unknown; sheet_count: number; preview: unknown }[];
    };
    expect(r.workbooks[0]).toMatchObject({
      sheet_count: 2,
      sheets: [
        { name: "A", kind: "grid" },
        { name: "B", kind: "table" },
      ],
      preview,
    });
    expect(r.workbooks[1].preview).toBeNull();
  });
});
