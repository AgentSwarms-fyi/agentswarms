// Typechecking depends on a generated file, so CI has to generate it.
//
// THE BUG THESE WERE WRITTEN FOR. `src/routeTree.gen.ts` is produced by the
// TanStack Router plugin during `vite dev` / `vite build`, and it is gitignored
// deliberately — tracking it put a meaningless 3,000-line diff on nearly every
// branch. But `src/router.tsx` imports it, so a checkout that has never run the
// dev server cannot typecheck. That is precisely what CI is, and CI ran
// Typecheck BEFORE Build, so the artifact never existed when it was needed:
//
//   src/router.tsx(2): Cannot find module './routeTree.gen'
//   src/routes/[index].tsx(3): Argument of type '"/index"' is not assignable
//     to parameter of type 'undefined'          … and ~40 more like it
//
// Every one of those cascading errors names an innocent route file, because
// without the tree each typed navigate() loses its route union. The pipeline
// failed this way on commits that changed nothing but a banner image, so the
// signal read as "the repo is broken" rather than "a step is missing".
//
// Reordering to build-first does NOT fix it: the generator writes only when its
// output differs from what is already on disk, so a stale file survives a full
// build. The dependency has to be satisfied explicitly.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
const script = readFileSync(resolve("scripts/generate-routes.mjs"), "utf8");
const gitignore = readFileSync(resolve(".gitignore"), "utf8");

describe("the generated route tree", () => {
  it("is still gitignored, so the dependency is real", () => {
    // If someone starts tracking it these guards become noise — but they would
    // also stop being load-bearing, so the assertion should be revisited rather
    // than silently passing.
    expect(gitignore).toContain("src/routeTree.gen.ts");
  });

  it("has a script that generates it", () => {
    expect(pkg.scripts["generate:routes"]).toBe("node scripts/generate-routes.mjs");
  });

  it("is generated BEFORE typecheck in CI, not after", () => {
    const gen = ci.indexOf("name: Generate route tree");
    const tsc = ci.indexOf("name: Typecheck");
    expect(gen, "CI has no route-tree generation step").toBeGreaterThan(-1);
    expect(tsc).toBeGreaterThan(-1);
    expect(gen, "generation must come before typecheck").toBeLessThan(tsc);
    expect(ci).toContain("run: npm run generate:routes");
  });

  it("the local typecheck script generates it too", () => {
    // A contributor running the typecheck on a fresh clone hits the same wall
    // CI did; making the script self-sufficient is what stops that.
    expect(pkg.scripts.typecheck).toContain("generate:routes");
    expect(pkg.scripts.typecheck).toContain("tsc --noEmit");
  });

  it("emits the react-start footer the Start plugin adds", () => {
    // The plain router generator stops short of this block; the Start plugin
    // appends it. Reproduced through the generator's public
    // `routeTreeFileFooter` option — NOT by deep-importing the plugin's
    // internals, which are absent from its exports map.
    //
    // Verified by deleting the file and regenerating: byte-identical to the
    // copy a real `vite build` produced.
    expect(script).toContain("routeTreeFileFooter");
    for (const line of [
      "import type { getRouter } from './router.tsx'",
      "import type { startInstance } from './start.ts'",
      "declare module '@tanstack/react-start'",
      "config: Awaited<ReturnType<typeof startInstance.getOptions>>",
    ]) {
      expect(script, `footer line missing: ${line}`).toContain(line);
    }
  });

  it("does not deep-import plugin internals", () => {
    // `@tanstack/start-plugin-core` exports only "." and "./utils"; reaching
    // into dist/esm/start-router-plugin/… would work today and break on any
    // refactor, with no type error to warn about it.
    expect(script).not.toContain("start-plugin-core/dist");
    expect(script).toContain('from "@tanstack/router-generator"');
  });
});
