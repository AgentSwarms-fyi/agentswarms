// A number written in prose is a claim like any other.
//
// Three of these have now gone stale in turn: "12 of 22 warehouses and all 5
// apps" in the assets README, "five optional profiles" in two deployment
// documents, and "7 app sources" in the in-app data page — which said 7 while
// naming all seventeen four hundred lines further down. Each was true when
// written. None of the existing checkers looks at a count: they verify that a
// name resolves, not that a quantity is right.
//
// So the counts are read from the provider lists themselves and every claim
// in either corpus is held to them. The lists are the only source of truth —
// adding a connector changes them, and anything that disagrees fails here
// rather than being discovered by a reader.
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");

/** Names in an exported `const X: T[] = [ "a", "b" ]` list. */
function listOf(file: string, name: string): string[] {
  const src = rd(file);
  const at = src.indexOf(`export const ${name}`);
  expect(at, `${name} is gone from ${file}`).toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf("];", at));
  return [...body.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
}

const SAAS = listOf("src/utils/saas/types.ts", "SAAS_PROVIDERS");
const WAREHOUSES = listOf("src/utils/warehouse/types.ts", "WAREHOUSE_PROVIDERS");

/**
 * The built-in lakehouse is a warehouse provider and is NOT a connector to
 * something outside, so the documents count it separately — "22 databases and
 * warehouses ... and the built-in lakehouse". Keeping that distinction here is
 * what lets the check be exact rather than approximately right.
 */
const EXTERNAL_WAREHOUSES = WAREHOUSES.filter((p) => p !== "lakehouse");

const CORPUS = [
  "README.md",
  ...readdirSync("docs")
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
  ...readdirSync("src/routes")
    .filter((f) => f.startsWith("docs.") && f.endsWith(".tsx"))
    .map((f) => `src/routes/${f}`),
];

describe("the lists this is measured against", () => {
  it("are real, so an empty parse cannot make every claim true", () => {
    // Mutation-checked: an empty list made every assertion below pass.
    expect(SAAS.length).toBeGreaterThan(10);
    expect(EXTERNAL_WAREHOUSES.length).toBeGreaterThan(15);
    expect(WAREHOUSES).toContain("lakehouse");
  });
});

describe("every count written down matches the code", () => {
  it.each([
    [/(\d+) app sources/g, () => SAAS.length, "app sources"],
    [/(\d+) apps\b/g, () => SAAS.length, "apps"],
    [/(\d+) databases and warehouses/g, () => EXTERNAL_WAREHOUSES.length, "warehouses"],
    [
      /(\d+) database\/warehouse connectors/g,
      () => EXTERNAL_WAREHOUSES.length,
      "warehouse connectors",
    ],
    [
      /\*\*(\d+) connectors\*\*|\b(\d+) connectors\b/g,
      () => SAAS.length + EXTERNAL_WAREHOUSES.length,
      "connectors",
    ],
  ])("%s", (pattern, expected, label) => {
    const want = expected();
    const wrong: string[] = [];
    for (const file of CORPUS) {
      const text = rd(file);
      for (const m of text.matchAll(pattern)) {
        const got = Number(m[1] ?? m[2]);
        if (Number.isFinite(got) && got !== want) wrong.push(`${file}: "${m[0]}"`);
      }
    }
    expect(wrong, `${label} should be ${want} — wrong in: ${wrong.join(", ")}`).toEqual([]);
  });

  it("catches the one that was actually wrong", () => {
    // The in-app data page said 7 while naming all seventeen in the same file.
    // Named explicitly so a future reader can see what this is protecting.
    const page = rd("src/routes/docs.data.tsx");
    expect(page).toMatch(new RegExp(`${SAAS.length} app sources`));
    // The word boundary is load-bearing twice over. Without it the pattern
    // matches INSIDE "17 app sources" and fails on the corrected text. And
    // when this line was first written through a shell heredoc the backslash
    // was eaten, leaving a literal BACKSPACE before the 7 — a pattern no file
    // can contain, so the assertion passed while checking for nothing at all.
    expect(page).not.toMatch(/\b7 app sources/);
  });
});
