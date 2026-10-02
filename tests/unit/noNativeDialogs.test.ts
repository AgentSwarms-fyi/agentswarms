// No destructive action may depend on a dialog the browser can switch off.
//
// FOUND FROM THE UI. Dropping a lakehouse table did nothing at all: no dialog,
// no toast, no console error, no network request. The button called the native
// `window.confirm()`, and a browser that suppresses dialogs makes that return
// `false` silently. Chrome offers precisely this — after a couple of dialogs it
// shows "prevent this page from creating additional dialogs", and one tick
// disables every destructive button in the product at once. A suppressed
// dialog and a broken feature are indistinguishable from the outside.
//
// The action was never broken: the same drop succeeded the moment confirm()
// returned true. Only the asking was.
//
// 21 confirm() call sites and 2 prompt() sites had the same flaw. The prompt
// ones were worse: the analyst feedback box collected a REQUIRED reason that
// way, so a suppressed prompt recorded an empty one and the flag lost the only
// thing that made it useful to the next reader.
//
// This test is the guard. It reads source, because the failure is a call that
// never happens — there is no runtime behaviour to assert on.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** Strip comments and string literals: this file's own prose says "confirm(". */
function code(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

const FILES = sourceFiles("src");

describe("native browser dialogs", () => {
  it("are not used to ask the user anything", () => {
    // `confirmAsk` / `promptAsk` render the app's own dialog, which cannot be
    // suppressed and cannot be mistaken for a dead button.
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = code(readFileSync(f, "utf8"));
      for (const m of src.matchAll(/(?<![.\w])(?:window\.)?(confirm|prompt|alert)\s*\(/g)) {
        // A file that declares its own helper of that name is calling its own
        // helper -- kbQa.server.ts has a local `prompt(passage)` that builds an
        // LLM prompt and has nothing to do with the browser. Only a call the
        // file did not define, or an explicit `window.` one, is the hazard.
        const name = m[1];
        const declaresOwn =
          src.includes(`function ${name}(`) ||
          src.includes(`const ${name} =`) ||
          src.includes(`let ${name} =`);
        if (declaresOwn && !m[0].startsWith("window.")) continue;
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders, `use confirmAsk/promptAsk instead:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the replacement is mounted, or every call would reject", () => {
    // A helper nobody mounted is the same silent nothing in a new costume, so
    // the host is mounted once at the root beside the Toaster.
    const root = readFileSync("src/routes/__root.tsx", "utf8");
    expect(root).toContain("<ConfirmHost />");
    expect(root).toContain('from "@/components/ui/confirm-dialog"');
  });

  it("refuses rather than resolving false when unmounted", () => {
    // The tempting default — resolve false — silently recreates the original
    // bug. A rejection at least reaches a catch and a toast.
    const host = readFileSync("src/components/ui/confirm-dialog.tsx", "utf8");
    expect(host).toMatch(/if \(!deliver\) return reject\(/);
  });

  it("still asks somewhere: the destructive buttons kept their confirmation", () => {
    // The lazy way to make the assertion above pass is to delete the question
    // entirely. Dropping a table or a schema must still ask.
    const lake = readFileSync("src/routes/_authenticated/lakehouse.tsx", "utf8");
    expect(lake).toContain("await confirmAsk({");
    expect((lake.match(/await confirmAsk\(\{/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
