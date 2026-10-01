// A guard that only the button honours (sweep 5, from R211 on).
//
// FOUND IN R211: the Lakehouse editor's Run button was disabled={running},
// and Ctrl+Enter in the editor called the same run() with no check. In the
// fixture table analytics.r211_double, one INSERT and two quick Ctrl+Enters
// wrote two rows. A survey of every keyboard path into a write found fourteen
// such gaps; each round of the sweep moves its handlers into the list below.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { singleFlight } from "@/lib/singleFlight";

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
];

describe("every surveyed keyboard path", () => {
  it.each(GUARDED)(
    "$file: $fn is single-flight, and is what the key calls",
    ({ file, fn, key }) => {
      const src = readFileSync(file, "utf8");
      expect(src).toContain(`const ${fn} = useSingleFlight(`);
      expect(src).toMatch(key);
    },
  );
});
