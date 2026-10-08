// Server functions declare their input with validator(), not the deprecated
// inputValidator() (R349).
//
// TanStack Start 1.168 renamed createServerFn().inputValidator() to
// validator(); the old name still works, and its compiler warns once per call.
// The app had 396 of them, so every build printed about 1,170 deprecation
// lines (client and server passes, and the SSR one), and a new warning in the
// build log had to be found among them. The two names are one function at
// run time (start-client-core's createServerFn sets both from the same
// setValidator), so the rename changes no behaviour. This keeps the old name
// from coming back.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("server function input validation", () => {
  const files = sources("src");

  it("uses validator(), never the deprecated inputValidator()", () => {
    const old = files.filter((f) => readFileSync(f, "utf8").includes(".inputValidator("));
    expect(old).toEqual([]);
  });

  it("the installed TanStack Start has validator() and marks inputValidator() deprecated", () => {
    const types = readFileSync(
      "node_modules/@tanstack/start-client-core/dist/esm/createServerFn.d.ts",
      "utf8",
    );
    expect(types).toMatch(/validator: ValidatorFn</);
    expect(types).toMatch(
      /\/\*\* @deprecated Use `validator` instead\. \*\/\s*inputValidator: ValidatorFn</,
    );
  });
});
