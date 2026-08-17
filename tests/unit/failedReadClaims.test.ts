// Pages that have been taught not to report a failed read as an empty account.
//
// The adversarial campaign keeps finding one defect: a Supabase read is
// destructured for `data` only (or its error is toasted and dropped), `data` is
// null on failure, and `data ?? []` becomes an empty state that says "you have
// none". A sweep found 43 such reads across 27 files, so these are being
// converted module by module with live evidence rather than in one blind pass.
//
// This file pins the ones already converted. It is deliberately a LIST rather
// than a rule over every page: asserting it of files not yet audited would fail
// for ~20 pages whose behaviour nobody has measured, and a red suite that
// everyone learns to ignore protects nothing. Add a row when a module's pass
// converts it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** file → the read whose failure used to render as an empty account. */
const CONVERTED: { file: string; module: string; what: string }[] = [
  {
    file: "src/routes/_authenticated/notebooks.tsx",
    module: "13 — Developer workspace",
    what: "the notebook list: badge 0 + 'No notebooks yet' for an account holding three",
  },
  {
    file: "src/routes/_authenticated/prompts.tsx",
    module: "14 — Prompt Library",
    what: "saved prompts: 'My Prompts (0)' + 'You haven't saved any prompts yet.'",
  },
  {
    file: "src/routes/_authenticated/skills.tsx",
    module: "15 — Skill Library",
    what: "saved skills: 'My skills (0)' + 'You haven't created any skills yet.'",
  },
  {
    file: "src/components/notebooks/PublishNotebookDialog.tsx",
    module: "13 — Developer workspace",
    what: "the notebook's API keys: 'Loading…' for ever after a failed read",
  },
];

const read = (f: string) => readFileSync(resolve(f), "utf8");

describe("pages that must not report a failed read as an empty account", () => {
  it("has something to check", () => {
    // Guard on the guard: an empty list would make everything below vacuous.
    expect(CONVERTED.length).toBeGreaterThan(0);
  });

  for (const { file, module, what } of CONVERTED) {
    describe(`${file}  (module ${module})`, () => {
      it("routes its count and empty state through listClaim", () => {
        expect(read(file), `${file} stopped using listClaim — ${what} can return`).toMatch(
          /listClaim\s*\(/,
        );
      });

      it("keeps the read's error rather than discarding it", () => {
        const src = read(file);
        // Either destructures `error` from the read, or holds it in state.
        const keepsIt =
          /setLoadError|setError|loadError|keysError/.test(src) &&
          /error:\s*readError|\berror\b/.test(src);
        expect(keepsIt, `${file} no longer keeps the read error — ${what}`).toBe(true);
      });

      it("does not print a fetched collection's raw .length as its count", () => {
        const src = read(file);
        // Only STATE counts, never module constants. `BUILT_IN_PROMPTS.length`
        // and `SAMPLE_SKILLS.length` are ship-with-the-app arrays that cannot
        // fail to load, so printing their length is honest — an earlier version
        // of this rule flagged both, and a rule that cries wolf gets ignored
        // rather than heeded. SCREAMING_SNAKE identifiers are therefore exempt
        // by construction: the pattern requires a lowercase first letter.
        const printsFetchedLength = /\(\{\s*[a-z]\w*\.length\s*\}\)/.test(src);
        expect(
          printsFetchedLength,
          `${file} prints a fetched collection's raw .length as its count — ${what}`,
        ).toBe(false);
      });
    });
  }
});
