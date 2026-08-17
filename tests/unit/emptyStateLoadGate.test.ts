// An empty state must not be reachable before the data has loaded.
//
// `xs.length === 0` is true on the first paint for a reason that has nothing to
// do with the account: nothing has been fetched yet. A page that renders its
// empty state from that condition alone tells every user, every visit, that
// their data is gone — and then contradicts itself a second later.
//
// Observed: /agents rendered "No agents yet — Create your first agent" on an
// account with seven agents. The obvious response to that screen is to make
// an eighth.
//
// This is asserted by SOURCE INSPECTION rather than by rendering, because the
// pages are route components wired to Supabase and a session; standing all
// that up would test the mocks. The rule being enforced is narrow and
// syntactic: a file that renders an empty state must also branch on a load
// signal somewhere in its JSX.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/** Does this file render an "there is nothing here" message at all? */
const rendersEmptyState = (s: string) => /<EmptyState/.test(s) || /No [a-z]+ yet/.test(s);

/**
 * Does a load signal reach the JSX?
 *
 * Four shapes count, and all four are in use in this codebase:
 *   - a boolean flag branched on:      `{loading ? … }`, `{loaded && … }`
 *   - an early return:                 `if (loading) return <Skeleton/>`
 *   - a nullable result, early return: `if (!runs) return <Skeleton/>`
 *   - a nullable result, inline:       `{secrets === null ? <Skeleton/> : …}`
 *
 * The last two are why this is not simply "declares a boolean called loading".
 * analytics_.observability.tsx and secrets.tsx both use `null` to mean "not
 * fetched yet" and are correct; an earlier, narrower version of this rule
 * reported secrets.tsx, and a rule that cries wolf gets deleted rather than
 * heeded.
 *
 * A fifth shape was added when notebooks.tsx moved to lib/listClaim: the load
 * signal reaches the JSX through a computed verdict rather than a raw boolean,
 * so none of the four patterns above matched and this rule reported a page
 * that had just been made STRICTER. listClaim gates on the error as well as on
 * the load — the four shapes above do not — so recognising it is not a
 * loosening. It is matched by name rather than by shape precisely because that
 * one module is the rule, and it carries its own tests and mutation coverage.
 */
function gatesOnLoad(s: string): boolean {
  return (
    /\{\s*!?\s*[\w.]*(?:oading|oaded|ending)[\w.]*\s*(\?|&&)/.test(s) ||
    /if\s*\(\s*[^)]*(?:oading|oaded|ending)[^)]*\)\s*\{?\s*return/.test(s) ||
    /if\s*\(\s*[^)]*!\s*\w+\s*\)\s*\{?\s*return\s*\(?\s*<?\s*(?:div|Skeleton|Loader)/.test(s) ||
    // `x === null ?` / `x == null ?` / `!x ?` directly in the render.
    /(?:\w+\s*===?\s*null|!\s*\w+)\s*\?\s*\(?\s*</.test(s) ||
    // The verdict from lib/listClaim, which subsumes all four.
    /listClaim\s*\(/.test(s)
  );
}

describe("pages never show an empty state before loading finishes", () => {
  const files = walk(resolve("src/routes/_authenticated")).filter((f) =>
    rendersEmptyState(readFileSync(f, "utf8")),
  );

  it("finds the pages that have empty states at all", () => {
    // A guard on the guard: if this drops to zero the rule below passes
    // vacuously and would stay green through any regression.
    expect(files.length).toBeGreaterThan(10);
  });

  it("every one of them distinguishes 'empty' from 'not loaded yet'", () => {
    const offenders = files
      .filter((f) => !gatesOnLoad(readFileSync(f, "utf8")))
      .map((f) => f.replace(/\\/g, "/").split("/_authenticated/")[1]);

    expect(
      offenders,
      "these render 'nothing here' on the first paint, before any fetch has returned:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
