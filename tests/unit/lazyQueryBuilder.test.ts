// A discarded Supabase query builder never reaches the database.
//
// PostgREST builders are lazy. The request is issued inside .then(), so this:
//
//   void supabaseAdmin.from("t").update({ x: 1 }).eq("id", id);
//
// evaluates an object, throws it away, and calls nothing. It type-checks, it
// lints, it runs without error, and the row simply never changes. MEASURED
// against the live database: after four mirrored requests the column that
// statement was meant to stamp was still null.
//
// The repo's fire-and-forget stamps are written with a terminal `.then(…)`
// precisely because that is what runs them — the `void` only marks the
// floating promise for the linter. This checks that every discarded builder
// has one, because the difference between the working form and the silent
// one is nine characters at the end of a statement nobody reads twice.
//
// `void someAsyncFn()` is a different thing and is not in scope here: calling
// an async function runs its body whether or not anyone awaits the result.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * The statement beginning at `start`, up to the `;` that ends it.
 *
 * Tracked by depth rather than by the first `;`, because a builder's arguments
 * routinely contain object literals and arrow functions with semicolons of
 * their own, and stopping at the first one would read half a statement and
 * find no `.then` in either half.
 */
function statementAt(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

describe("a discarded query builder still has to run", () => {
  const files = walk(resolve("src"));

  it("scans a source tree that is actually there", () => {
    // Guarding the guard: a walk that returned nothing would make every
    // assertion below pass by finding no code at all.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith("serve.server.ts"))).toBe(true);
  });

  it("every `void <builder>` ends in a .then that issues the request", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // The supabase clients are the lazy ones. Matched by the `void` that
      // discards them rather than by the call, since an awaited builder and a
      // returned one are both fine.
      const re = /\bvoid\s+(supabaseAdmin|supabase)\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const stmt = statementAt(src, m.index);
        if (!/\.then\s*\(/.test(stmt)) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${file.replace(resolve("."), "").slice(1)}:${line}`);
        }
      }
    }
    expect(
      offenders,
      `discarded builders with no .then (they call nothing):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("and the check can tell the two forms apart", () => {
    // A mutation check in miniature: if statementAt or the regex stopped
    // working, the assertion above would pass on anything. These are the two
    // shapes it exists to separate.
    const broken = `void supabaseAdmin\n  .from("t")\n  .update({ a: 1 })\n  .eq("id", id);`;
    const working = `void supabaseAdmin\n  .from("t")\n  .update({ a: 1 })\n  .eq("id", id)\n  .then(() => {});`;
    expect(/\.then\s*\(/.test(statementAt(broken, 0))).toBe(false);
    expect(/\.then\s*\(/.test(statementAt(working, 0))).toBe(true);
    // And a semicolon inside an argument must not end the statement early.
    const nested = `void supabaseAdmin.rpc("f", { x: (() => { let a = 1; return a; })() }).then(() => {});`;
    expect(/\.then\s*\(/.test(statementAt(nested, 0))).toBe(true);
  });
});
