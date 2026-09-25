// Sheets version history: automatic versions at most one per interval and
// pruned past the maximum (named ones kept), a restore that first keeps what
// is there and puts it back if the restore fails, a copy opened from a
// version, and the names all of these are written under.
//
// The server functions run here for real, against an in-memory stand-in for
// the three tables they touch.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { beforeRestoreLabel, copyName, utcShown, versionPhrase } from "@/lib/sheets/versionNames";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const fail = { insertInto: null as string | null, times: 0 };
let seq = 0;

/** Enough of PostgREST's builder for these functions: filters, order, limit, insert, delete, update. */
function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const orders: [string, boolean][] = [];
  let limit = Infinity;
  let op: "select" | "delete" | "update" = "select";
  let patch: Row = {};
  const rows = () => {
    let out = (db[table] ??= []).filter((r) => filters.every((f) => f(r)));
    for (const [col, asc] of [...orders].reverse())
      out = [...out].sort(
        (a, b) =>
          // Rows written in the same millisecond keep the order they were written in.
          (String(a[col]) < String(b[col])
            ? -1
            : String(a[col]) > String(b[col])
              ? 1
              : Number(a._seq) - Number(b._seq)) * (asc ? 1 : -1),
      );
    return out.slice(0, limit);
  };
  const run = () => {
    const hit = rows();
    if (op === "delete") db[table] = db[table].filter((r) => !hit.includes(r));
    if (op === "update") for (const r of hit) Object.assign(r, patch);
    return { data: op === "delete" ? null : hit.map((r) => ({ ...r })), error: null };
  };
  const b = {
    select: () => b,
    eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), b),
    in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), b),
    order: (col: string, o?: { ascending?: boolean }) => (
      orders.push([col, o?.ascending ?? true]),
      b
    ),
    limit: (n: number) => ((limit = n), b),
    delete: () => ((op = "delete"), b),
    update: (p: Row) => ((op = "update"), (patch = p), b),
    maybeSingle: async () => ({ data: run().data?.[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(res, rej),
    insert: (input: Row | Row[]) => {
      const list = (Array.isArray(input) ? input : [input]).map((r) => ({
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        _seq: ++seq,
        ...r,
      }));
      const failed = fail.insertInto === table && fail.times > 0;
      if (failed) fail.times--;
      else (db[table] ??= []).push(...list);
      const result = {
        data: failed ? null : list,
        error: failed ? { message: "disk full" } : null,
      };
      const done: any = Promise.resolve(result);
      done.select = () => ({
        single: async () => ({ data: result.data?.[0] ?? null, error: result.error }),
      });
      return done;
    },
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (t: string) => query(t),
    auth: {
      getUser: async (token: string) =>
        token.startsWith("user:")
          ? { data: { user: { id: token.slice(5) } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
  },
}));

const settings = { sheetsVersionIntervalMinutes: 30, sheetsVersionsMax: 3, sheetsMaxCells: 1000 };
vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getPlatformResources: async () => settings,
}));

// createServerFn as a plain call: validate, then run the handler.
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

const { takeVersion } = await import("@/utils/sheets/versions.server");
const fns = await import("@/utils/sheetsVersions.functions");
const { sheetsSaveGrid } = await import("@/utils/sheets.functions");

const WB = "11111111-1111-4111-8111-111111111111";
const OWNER = "owner-1";
const tab = (name: string, cells: Row, position = 0) => ({
  workbook_id: WB,
  user_id: OWNER,
  name,
  kind: "grid",
  position,
  grid: { cells },
  table_config: null,
});
const versions = () => db.sheet_workbook_versions ?? [];
const call = <T>(fn: (o: { data: unknown }) => T, data: Row) =>
  fn({ data: { access_token: `user:${OWNER}`, workbook_id: WB, ...data } });

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.sheet_workbooks = [{ id: WB, user_id: OWNER, name: "Budget" }];
  db.sheet_tabs = [tab("Plan", { "0,0": { i: "10" } })];
  fail.insertInto = null;
  fail.times = 0;
  settings.sheetsVersionIntervalMinutes = 30;
  settings.sheetsVersionsMax = 3;
  vi.useRealTimers();
});

describe("automatic versions", () => {
  it("takes one, then none until the interval has passed", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-25T10:00:00Z"), toFake: ["Date"] });
    expect(await takeVersion(WB, OWNER, "auto", null)).toEqual({ taken: true });
    vi.setSystemTime(new Date("2026-09-25T10:29:00Z"));
    expect(await takeVersion(WB, OWNER, "auto", null)).toEqual({ taken: false });
    vi.setSystemTime(new Date("2026-09-25T10:31:00Z"));
    expect(await takeVersion(WB, OWNER, "auto", null)).toEqual({ taken: true });
    expect(versions().map((v) => v.kind)).toEqual(["auto", "auto"]);
    expect(versions()[0].snapshot).toEqual([
      expect.objectContaining({ name: "Plan", grid: { cells: { "0,0": { i: "10" } } } }),
    ]);
    expect(versions()[0]).toMatchObject({ sheet_count: 1, workbook_id: WB, created_by: OWNER });
  });

  it("a named version is taken whatever the interval, and never counts toward it", async () => {
    await takeVersion(WB, OWNER, "named", "Sent to finance");
    expect(await takeVersion(WB, OWNER, "auto", null)).toEqual({ taken: true });
    expect(await takeVersion(WB, OWNER, "named", "Again")).toEqual({ taken: true });
    expect(versions().map((v) => v.kind)).toEqual(["named", "auto", "named"]);
  });

  it("keeps the newest automatic versions up to the maximum, and every named one", async () => {
    settings.sheetsVersionIntervalMinutes = 0;
    await takeVersion(WB, OWNER, "named", "Keep me");
    for (let i = 0; i < 5; i++) {
      db.sheet_tabs[0].grid = { cells: { "0,0": { i: String(i) } } };
      await takeVersion(WB, OWNER, "auto", null);
    }
    const autos = versions().filter((v) => v.kind === "auto");
    expect(
      autos.map((v) => (v.snapshot as { grid: { cells: Row } }[])[0].grid.cells["0,0"]),
    ).toEqual([{ i: "2" }, { i: "3" }, { i: "4" }]);
    expect(
      versions()
        .filter((v) => v.kind === "named")
        .map((v) => v.label),
    ).toEqual(["Keep me"]);
  });
});

describe("saving a grid sheet", () => {
  const TAB = "44444444-4444-4444-8444-444444444444";
  const save = (i: string, base: number) =>
    sheetsSaveGrid({
      data: {
        access_token: `user:${OWNER}`,
        tab_id: TAB,
        base_version: base,
        grid: { cells: { "0,0": { i } } },
      },
    });
  beforeEach(() => {
    db.sheet_tabs = [{ ...tab("Plan", { "0,0": { i: "10" } }), id: TAB, version: 1 }];
  });

  it("takes an automatic version of the workbook as it saves", async () => {
    expect(await save("11", 1)).toEqual({ ok: true, version: 2 });
    expect(versions().map((v) => [v.kind, v.workbook_id])).toEqual([["auto", WB]]);
    expect((versions()[0].snapshot as { grid: unknown }[])[0].grid).toEqual({
      cells: { "0,0": { i: "11" } },
    });
    // The next save inside the interval takes none.
    expect(await save("12", 2)).toEqual({ ok: true, version: 3 });
    expect(versions()).toHaveLength(1);
  });

  it("a version that cannot be taken never fails the save", async () => {
    fail.insertInto = "sheet_workbook_versions";
    fail.times = 1;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await save("11", 1)).toEqual({ ok: true, version: 2 });
    expect(db.sheet_tabs[0].grid).toEqual({ cells: { "0,0": { i: "11" } } });
    expect(versions()).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("automatic version skipped"));
    warn.mockRestore();
  });
});

describe("restore", () => {
  it("keeps what is there as a version first, then puts the version's sheets back", async () => {
    await takeVersion(WB, OWNER, "named", "Sent to finance");
    const named = versions()[0];
    db.sheet_tabs = [tab("Plan", { "0,0": { i: "999" } }), tab("Extra", {}, 1)];
    const r = await call(fns.sheetsVersionRestore, {
      version_id: named.id,
      shown: "9/25/2026, 10:48:26 PM",
    });
    expect(r).toEqual({ ok: true });
    expect(db.sheet_tabs.map((t) => [t.name, t.grid])).toEqual([
      ["Plan", { cells: { "0,0": { i: "10" } } }],
    ]);
    const before = versions().find((v) => v.kind === "before_restore")!;
    expect(before.label).toBe("Before restoring “Sent to finance”");
    expect((before.snapshot as Row[]).map((t) => t.name)).toEqual(["Plan", "Extra"]);
  });

  it("a restore can be undone by restoring the version taken before it", async () => {
    await takeVersion(WB, OWNER, "named", "v1");
    db.sheet_tabs = [tab("Plan", { "0,0": { i: "999" } })];
    await call(fns.sheetsVersionRestore, { version_id: versions()[0].id, shown: "t1" });
    const before = versions().find((v) => v.kind === "before_restore")!;
    await call(fns.sheetsVersionRestore, {
      version_id: before.id,
      shown: "9/25/2026, 10:48:54 PM",
    });
    expect(db.sheet_tabs[0].grid).toEqual({ cells: { "0,0": { i: "999" } } });
    // Named by its time, not "Before restoring Before restoring v1".
    expect(versions().at(-1)!.label).toBe("Before restoring the version of 9/25/2026, 10:48:54 PM");
  });

  it("a failed restore puts the sheets that were there back", async () => {
    await takeVersion(WB, OWNER, "named", "v1");
    db.sheet_tabs = [tab("Now", { "0,0": { i: "keep" } })];
    fail.insertInto = "sheet_tabs";
    fail.times = 1;
    const r = await call(fns.sheetsVersionRestore, { version_id: versions()[0].id });
    expect(r).toEqual({ ok: false, error: "Could not restore: disk full" });
    expect(db.sheet_tabs.map((t) => [t.name, t.grid])).toEqual([
      ["Now", { cells: { "0,0": { i: "keep" } } }],
    ]);
  });

  it("refuses a workbook that is not the caller's, writing nothing", async () => {
    await takeVersion(WB, OWNER, "named", "v1");
    const r = await fns.sheetsVersionRestore({
      data: { access_token: "user:someone-else", workbook_id: WB, version_id: versions()[0].id },
    });
    expect(r).toEqual({ ok: false, error: "This workbook does not exist, or is not yours" });
    expect(versions()).toHaveLength(1);
    expect(db.sheet_tabs).toHaveLength(1);
  });

  it("refuses a version of another workbook", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    db.sheet_workbook_versions = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        workbook_id: other,
        kind: "named",
        label: "x",
        created_at: new Date().toISOString(),
        snapshot: [],
      },
    ];
    const r = await call(fns.sheetsVersionRestore, {
      version_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(r).toEqual({ ok: false, error: "That version no longer exists" });
    expect(db.sheet_tabs[0].name).toBe("Plan");
  });
});

describe("open a copy", () => {
  it("creates a new workbook from the version, named by the time the browser showed", async () => {
    await takeVersion(WB, OWNER, "auto", null);
    db.sheet_tabs[0].grid = { cells: { "0,0": { i: "changed" } } };
    const r = (await call(fns.sheetsVersionOpenCopy, {
      version_id: versions()[0].id,
      shown: "9/25/2026, 10:41:39 PM",
    })) as { ok: true; workbook_id: string };
    expect(r.ok).toBe(true);
    const copy = db.sheet_workbooks.find((w) => w.id === r.workbook_id)!;
    expect(copy.name).toBe("Budget (9/25/2026, 10:41:39 PM)");
    const copied = db.sheet_tabs.filter((t) => t.workbook_id === r.workbook_id);
    expect(copied.map((t) => t.grid)).toEqual([{ cells: { "0,0": { i: "10" } } }]);
    // This workbook is left as it is.
    expect(db.sheet_tabs.find((t) => t.workbook_id === WB)!.grid).toEqual({
      cells: { "0,0": { i: "changed" } },
    });
  });

  it("without the browser's time, says the time is UTC", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-25T18:41:39Z"), toFake: ["Date"] });
    await takeVersion(WB, OWNER, "auto", null);
    const r = (await call(fns.sheetsVersionOpenCopy, { version_id: versions()[0].id })) as {
      ok: true;
      workbook_id: string;
    };
    expect(db.sheet_workbooks.find((w) => w.id === r.workbook_id)!.name).toBe(
      "Budget (2026-09-25 18:41 UTC)",
    );
  });
});

describe("version names", () => {
  it("a named version by its name, any other by its time", () => {
    expect(versionPhrase({ kind: "named", label: "Q3" }, "t")).toBe("“Q3”");
    expect(versionPhrase({ kind: "auto", label: null }, "10:41 PM")).toBe(
      "the version of 10:41 PM",
    );
    expect(
      versionPhrase({ kind: "before_restore", label: "Before restoring “Q3”" }, "10:48 PM"),
    ).toBe("the version of 10:48 PM");
    expect(beforeRestoreLabel({ kind: "named", label: "x".repeat(300) }, "t")).toHaveLength(200);
    expect(copyName("Budget", { kind: "named", label: "Q3" }, "t")).toBe("Budget (Q3)");
    expect(utcShown("2026-09-25T18:41:39.000Z")).toBe("2026-09-25 18:41 UTC");
  });
});

describe("server helpers stay out of the browser bundle", () => {
  // A *.functions module is compiled for the browser with its handlers cut
  // out. A plain function it exports stays, with every server import it
  // uses: importing takeVersion from sheetsVersions.functions into
  // sheets.functions put the Supabase admin client in the browser bundle and
  // failed the build. Shared server code lives in *.server modules.
  it("a *.functions module imports only types from another", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".functions.ts")) files.push(p);
      }
    };
    walk("src");
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(
        /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+\.functions)"/g,
      )) {
        const typeOnly =
          !!m[1] || m[2].split(",").every((s) => !s.trim() || /^type\s/.test(s.trim()));
        if (!typeOnly) bad.push(`${f} ← ${m[3]}`);
      }
    }
    expect(files.length).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });
});
