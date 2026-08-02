// Seeding the sample agents exactly once.
//
// FOUND IN THE DATABASE, not by reading: the signed-in account had two copies
// of "Sample · Graph RAG Explorer (Acme Corp)", carrying the same sample tag
// and the same created_at to the second. Two rows written in the same second
// is not a missing idempotency check — the seed HAS one, matching on a tag
// embedded in the description. It is a check-then-act race:
//
//     read the user's agents  ->  work out which samples are missing  ->  insert
//
// Two overlapping calls both read the same "missing" set and both insert. The
// caller's sessionStorage guard did not help, because it was written AFTER its
// await: the whole seeding duration was an open window, and React StrictMode
// double-invokes effects in development.
//
// The fix is single-flight inside the function, so it protects every caller
// rather than relying on each one to guard correctly. Two separate BROWSER TABS
// still race; only a database constraint closes that, which needs a migration.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lib = readFileSync("src/lib/sampleAgentsWithSkills.ts", "utf8");
const caller = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");

/** Source with comments stripped — assertions must read code, not prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the seed collapses concurrent calls", () => {
  it("keeps a module-level in-flight promise", () => {
    expect(code(lib)).toMatch(/let seedInFlight: Promise<number> \| null = null/);
  });

  it("reuses the in-flight promise instead of starting a second seed", () => {
    expect(code(lib)).toMatch(/seedInFlight \?\?= ensureSampleAgents\(\)/);
  });

  it("clears it when the seed settles, so a later call can retry", () => {
    // Without the reset, one failed seed would poison every later attempt.
    const fn = code(lib).slice(code(lib).indexOf("export function ensureSampleAgentsForUser"));
    expect(fn.slice(0, 300)).toMatch(/\.finally\(\(\) => \{\s*seedInFlight = null;\s*\}\)/);
  });

  it("does the actual work in a separate, non-exported function", () => {
    // If callers could reach the unguarded version the guard would be optional.
    expect(code(lib)).toMatch(/async function ensureSampleAgents\(\): Promise<number>/);
    expect(code(lib)).not.toMatch(/export async function ensureSampleAgents\b/);
  });
});

describe("the caller claims its guard before awaiting", () => {
  it("sets the session flag before the seed call, not after", () => {
    const c = code(caller);
    const flagAt = c.indexOf('sessionStorage.setItem(seedFlag, "1")');
    const seedAt = c.indexOf("await ensureSampleAgentsForUser()");
    expect(flagAt, "the session flag is never set").toBeGreaterThan(0);
    expect(seedAt, "the seed is never called").toBeGreaterThan(0);
    expect(flagAt, "the guard is still written after the work it guards").toBeLessThan(seedAt);
  });

  it("does not write the flag twice", () => {
    // The post-await write became dead once the pre-await one existed.
    const writes = [...code(caller).matchAll(/sessionStorage\.setItem\(seedFlag/g)];
    expect(writes).toHaveLength(1);
  });

  it("survives a storage failure rather than skipping the seed", () => {
    // Private browsing throws on setItem; the seed must still run.
    const c = code(caller);
    const region = c.slice(
      c.indexOf("const seedFlag"),
      c.indexOf("await ensureSampleAgentsForUser"),
    );
    expect(region).toMatch(/try \{/);
  });
});
