// Client-reachable modules must not pull server code into the bundle.
//
// src/lib/kbRag.ts imported chunkText from utils/tools/embedding.server, and
// the knowledge route imports kbRag for its types — so the client graph reached
// a *.server.* module and TanStack's import protection failed the production
// build. Nothing before the build catches it: tsc is happy, lint is happy, and
// every test passes, because the module genuinely works when Node loads it.
//
// The build is the real guard and it runs in CI, but it runs LAST, after tests
// — so the feedback arrives minutes later and only on push. This is the same
// rule, checked in milliseconds.
//
// The rule is narrower than "no .server imports in lib", because three kinds
// are legitimate and present:
//   - a file that is ITSELF *.server.ts or *.functions.ts (server-side already)
//   - `import type { … }`, erased at build time and never in the bundle
//   - inline `{ type X }` specifiers, same reason
// What breaks the build is a VALUE import, and that is what is asserted.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Server-side by their own name; they are allowed to import server code. */
const isServerSide = (path: string) => /\.(server|functions)\.tsx?$/.test(path);

/** A value import from a *.server module, i.e. one that survives into a bundle. */
function serverValueImports(source: string): string[] {
  const out: string[] = [];
  // `[^;]` matters: with `[\s\S]*?` the match spans ACROSS statements. On a
  // file whose previous line imports something else, the lazy quantifier ran
  // from that earlier `import`, past its non-.server path, to this one — so the
  // captured clause began "{ supabase } from …" instead of "type { Citation }"
  // and a harmless type-only import was reported as a build breaker. A guard
  // that cries wolf gets deleted rather than heeded.
  const re = /import\s+([^;]*?)\s+from\s+["']([^"']*\.server)["']/g;
  for (const m of source.matchAll(re)) {
    const clause = m[1].trim();
    if (clause.startsWith("type ")) continue; // `import type { … }` — erased
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      const specifiers = braces[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // Every specifier prefixed with `type` means nothing reaches the bundle.
      if (specifiers.length > 0 && specifiers.every((s) => s.startsWith("type "))) continue;
    }
    out.push(m[2]);
  }
  return out;
}

describe("client-reachable modules do not import server code", () => {
  it("no non-server file under src/lib imports a *.server module by value", () => {
    const offenders: string[] = [];
    for (const file of walk(resolve("src/lib"))) {
      if (isServerSide(file)) continue;
      for (const imported of serverValueImports(readFileSync(file, "utf8"))) {
        offenders.push(`${file.replace(/\\/g, "/").split("/src/")[1]} -> ${imported}`);
      }
    }
    expect(
      offenders,
      "these reach the client bundle and will fail `npm run build`:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  it("recognises a type-only import as harmless", () => {
    // src/lib/embedClient.ts imports a Citation type from kb.server and is
    // fine. If this stopped being true the rule above would start crying wolf,
    // and a rule that cries wolf gets deleted rather than heeded.
    expect(serverValueImports('import type { Citation } from "@/utils/tools/kb.server";')).toEqual(
      [],
    );
    expect(serverValueImports('import { type A, type B } from "@/utils/tools/kb.server";')).toEqual(
      [],
    );
  });

  it("catches the shape that actually broke the build", () => {
    expect(
      serverValueImports(
        'import { chunkText, type ChunkStrategy } from "@/utils/tools/embedding.server";',
      ),
    ).toEqual(["@/utils/tools/embedding.server"]);
  });
});
