// The AI Analyst's what-if callback must be rebuilt when the governed catalog
// arrives (R272). It read `catalog` without listing it, so a thread opened
// before the catalog had loaded kept the empty one: the step's model had no
// parameters, and varying an assumption was refused as "Nothing changed".
// The page is not rendered in unit tests; this reads its source, as the other
// wiring tests do.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "src/routes/_authenticated/ai-analyst.tsx"), "utf8");

/** The body and the dependency list of `const <name> = useCallback(...)`. */
function callback(name: string): { body: string; deps: string[] } {
  const start = src.indexOf(`const ${name} = useCallback(`);
  expect(start, name).toBeGreaterThan(-1);
  // The callback ends at the first "\n  );" after it, the hook's own close.
  const end = src.indexOf("\n  );", start);
  const text = src.slice(start, end);
  const open = text.lastIndexOf("[");
  const deps = text
    .slice(open + 1, text.lastIndexOf("]"))
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return { body: text.slice(0, open), deps };
}

describe("runScenarioAt", () => {
  const { body, deps } = callback("runScenarioAt");

  it("lists the catalog it reads", () => {
    expect(body).toContain("catalog.find(");
    expect(deps).toContain("catalog");
  });

  it("lists every value of the page it reads, and nothing it does not", () => {
    for (const name of [
      "thread",
      "token",
      "resolveScope",
      "persistTurns",
      "runSemanticFn",
      "catalog",
    ]) {
      expect(body, name).toMatch(new RegExp(`\\b${name}\\b`));
      expect(deps, name).toContain(name);
    }
    for (const name of ["scoreRowsFn", "forecastFn", "scorable", "allModels"]) {
      expect(body, name).not.toMatch(new RegExp(`\\b${name}\\b`));
      expect(deps, name).not.toContain(name);
    }
  });
});
