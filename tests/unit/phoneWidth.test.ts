// Pages fit a phone's screen (found in R518's UI test at 375 px: seven list
// pages ran off the right edge because one card with a long model id set the
// width of the page).
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("a page fits a phone", () => {
  const css = read("src/styles.css");

  it("gives a grid with breakpoint-only columns one column that fits, below the breakpoint", () => {
    const rule =
      '.grid[class*=":grid-cols-"]:not([class^="grid-cols-"]):not([class*=" grid-cols-"])';
    const at = css.indexOf(rule);
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at, at + 200)).toContain("grid-template-columns: minmax(0, 1fr);");
    // In the base layer: unlayered, it would beat sm:grid-cols-2 at every width.
    const base = css.indexOf("@layer base {");
    expect(base).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(base);
    const before = css.slice(base, at);
    const opened = (before.match(/\{/g) ?? []).length;
    const closed = (before.match(/\}/g) ?? []).length;
    expect(opened - closed, "the rule sits inside @layer base").toBeGreaterThanOrEqual(1);
  });

  it("lets every page's content column shrink beside its flex siblings", () => {
    const dir = path.join(root, "src/routes/_authenticated");
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      // The page shell: a flex row whose first child is the page itself.
      for (const m of src.matchAll(/<div className="flex">\s*<div className="([^"]*)">/g)) {
        const cls = m[1].split(/\s+/);
        if (cls.includes("flex-1") && !cls.includes("min-w-0")) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
