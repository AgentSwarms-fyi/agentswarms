// A guard that only the button honours (sweep 5, from R211 on).
//
// FOUND IN R211: the Lakehouse editor's Run button was disabled={running},
// and Ctrl+Enter in the editor called the same run() with no check. In the
// fixture table analytics.r211_double, one INSERT and two quick Ctrl+Enters
// wrote two rows. A survey of every keyboard path into a write found fourteen
// such gaps; each round of the sweep moves its handlers into the list below.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sharedFlight, singleFlight } from "@/lib/singleFlight";

describe("singleFlight", () => {
  it("runs once for two calls in the same tick", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = singleFlight(async () => {
      runs += 1;
      await gate;
    });
    const a = run();
    const b = run();
    release();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
  });

  it("runs again once the first run has finished, even after a failure", async () => {
    let runs = 0;
    const run = singleFlight(async (fail: boolean) => {
      runs += 1;
      if (fail) throw new Error("refused");
    });
    await expect(run(true)).rejects.toThrow("refused");
    await run(false);
    await run(false);
    expect(runs).toBe(3);
  });

  it("passes its arguments through", async () => {
    const seen: string[] = [];
    const run = singleFlight(async (s: string) => {
      seen.push(s);
    });
    await run("INSERT INTO t VALUES (1)");
    expect(seen).toEqual(["INSERT INTO t VALUES (1)"]);
  });
});

// R213: a notebook cell, and the kernel start, are keyed single flights where
// a second call joins the first and gets its result.
describe("sharedFlight", () => {
  it("runs once for two calls on one key, and both get that run's result", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = sharedFlight(
      (id: string) => id,
      async () => {
        runs += 1;
        await gate;
        return `n = ${runs}`;
      },
    );
    const a = run("cell-1");
    const b = run("cell-1");
    release();
    expect(await Promise.all([a, b])).toEqual(["n = 1", "n = 1"]);
    expect(runs).toBe(1);
  });

  it("never holds one key behind another", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = sharedFlight(
      (id: string) => id,
      async (id: string) => {
        started.push(id);
        await gate;
      },
    );
    const a = run("cell-1");
    const b = run("cell-2");
    expect(started).toEqual(["cell-1", "cell-2"]);
    release();
    await Promise.all([a, b]);
  });

  it("runs a key again once its run has settled, even after a synchronous throw", async () => {
    let runs = 0;
    const run = sharedFlight(
      () => "kernel",
      (fail: boolean) => {
        runs += 1;
        if (fail) throw new Error("refused");
        return Promise.resolve(runs);
      },
    );
    await expect(run(true)).rejects.toThrow("refused");
    expect(await run(false)).toBe(2);
    expect(await run(false)).toBe(3);
  });
});

/** Handlers a keyboard path and a button share, each now single-flight. */
const GUARDED: { file: string; fn: string; key: RegExp }[] = [
  // R211: Ctrl+Enter ran a statement twice; Enter drafted SQL twice.
  {
    file: "src/routes/_authenticated/lakehouse.tsx",
    fn: "run",
    key: /e\.key === "Enter"\) \{\s*e\.preventDefault\(\);\s*void run\(\);/,
  },
  {
    file: "src/routes/_authenticated/lakehouse.tsx",
    fn: "generate",
    key: /e\.key === "Enter" && void generate\(\)/,
  },
  // R212: a double Enter minted two live SCIM tokens with one label, and only
  // the second secret was ever shown.
  {
    file: "src/routes/_authenticated/admin.iam.tsx",
    fn: "mint",
    key: /if \(e\.key === "Enter"\) void mint\(\);/,
  },
  // R213: a double Ctrl+Enter ran the Workbench query twice (two history
  // rows); a double Shift+Enter ran a notebook cell twice on the kernel.
  {
    file: "src/routes/_authenticated/data-sql.tsx",
    fn: "handleRun",
    key: /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === "Enter"\) \{\s*e\.preventDefault\(\);\s*void handleRun\(\);/,
  },
  {
    file: "src/routes/_authenticated/notebooks.py.$pyNotebookId.tsx",
    fn: "runCell",
    key: /cellRunKey\(\(\) => void runCell\(cell\)\)/,
  },
  // R214: a double Enter in a name field made two of the thing named — or,
  // where the table has a unique name, one and a raw "duplicate key" error.
  {
    file: "src/routes/_authenticated/sheets.tsx",
    fn: "create",
    key: /if \(e\.key === "Enter"\) void create\(\);/,
  },
  {
    file: "src/routes/_authenticated/bi.tsx",
    fn: "submitCreate",
    key: /e\.key === "Enter" && void submitCreate\(\)/,
  },
  {
    file: "src/routes/_authenticated/bi.tsx",
    fn: "addFolder",
    key: /if \(e\.key === "Enter"\) void addFolder\(\);/,
  },
  {
    file: "src/routes/_authenticated/etl.tsx",
    fn: "create",
    key: /e\.key === "Enter" && void create\(\)/,
  },
  {
    file: "src/routes/_authenticated/mcp-builder.tsx",
    fn: "create",
    key: /if \(e\.key === "Enter"\) void create\(\);/,
  },
  {
    file: "src/routes/_authenticated/evaluations.tsx",
    fn: "newDataset",
    key: /e\.key === "Enter" && void newDataset\(\)/,
  },
  {
    file: "src/components/bi/ReportsTab.tsx",
    fn: "create",
    key: /e\.key === "Enter" && void create\(\)/,
  },
  {
    file: "src/components/bi/BiWorkspaceManager.tsx",
    fn: "create",
    key: /e\.key === "Enter" && void create\(\)/,
  },
  {
    file: "src/components/bi/AddToDashboardDialog.tsx",
    fn: "submit",
    key: /e\.key === "Enter" && void submit\(\)/,
  },
];

describe("every surveyed keyboard path", () => {
  it.each(GUARDED)(
    "$file: $fn is single-flight, and is what the key calls",
    ({ file, fn, key }) => {
      const src = readFileSync(file, "utf8");
      expect(src).toMatch(new RegExp(`const ${fn} = use(SingleFlight|SharedFlight)\\(`));
      expect(src).toMatch(key);
    },
  );

  it("starts the notebook kernel once for every run that arrives while it starts", () => {
    const src = readFileSync("src/routes/_authenticated/notebooks.py.$pyNotebookId.tsx", "utf8");
    expect(src).toContain("const ensureKernel = useSharedFlight(");
    // The old wrapper, which saw Shift+Enter only after the editor had
    // inserted its newline, is gone.
    expect(src).not.toMatch(/e\.key === "Enter" && e\.shiftKey/);
  });

  it("clears the MCP builder's busy flag however its create ends", () => {
    // R214: the create set `creating`, awaited, then cleared it; a call that
    // threw left the button disabled until the page was reloaded.
    const src = readFileSync("src/routes/_authenticated/mcp-builder.tsx", "utf8");
    const body = src.slice(src.indexOf("const create = useSingleFlight("));
    expect(body.slice(0, body.indexOf("\n  });"))).toMatch(
      /\} finally \{\s*setCreating\(false\);\s*\}/,
    );
  });
});
