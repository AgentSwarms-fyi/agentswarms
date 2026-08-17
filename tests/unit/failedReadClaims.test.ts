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

/**
 * file → the read whose failure used to render as an empty account.
 *
 * `claim` is the helper the page must route its claim through. It defaults to
 * listClaim because that is the count-and-empty-state shape, which is what the
 * first four conversions were. Module 16 needed a second one: /integrations has
 * no count and no empty state, so its false claim was made by OMISSION — a
 * connected provider rendering exactly like an unconfigured one. The rule being
 * pinned is unchanged; only the vocabulary the page uses to state it differs,
 * and lib/integrationStatusClaim carries its own tests and mutation coverage.
 */
const CONVERTED: {
  file: string;
  module: string;
  what: string;
  claim?: string;
  /**
   * The read goes through a TanStack server function rather than a direct
   * Supabase call. It matters because the two fail differently: supabase-js
   * hands a network failure back as `error`, but a server function REJECTS,
   * and a `.then` with no `.catch` swallows that completely. Measured on
   * /secrets: the skeleton stayed up indefinitely with no toast, no error and
   * an unhandled rejection in the console.
   */
  viaServerFn?: boolean;
}[] = [
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
  {
    file: "src/routes/_authenticated/integrations.tsx",
    module: "16 — Integrations",
    what: "connected providers rendering as never-configured, with no error at all",
    claim: "providerBadge",
  },
  {
    file: "src/routes/_authenticated/secrets.tsx",
    module: "18 — Secrets",
    what: "'No secrets yet. Create one…' for an account holding two, after the toast expired",
    viaServerFn: true,
  },
];

const read = (f: string) => readFileSync(resolve(f), "utf8");

describe("pages that must not report a failed read as an empty account", () => {
  it("has something to check", () => {
    // Guard on the guard: an empty list would make everything below vacuous.
    expect(CONVERTED.length).toBeGreaterThan(0);
  });

  for (const { file, module, what, claim: claimHelper, viaServerFn } of CONVERTED) {
    describe(`${file}  (module ${module})`, () => {
      const claim = claimHelper ?? "listClaim";
      it(`routes what it claims through ${claim}`, () => {
        expect(read(file), `${file} stopped using ${claim} — ${what} can return`).toMatch(
          new RegExp(`${claim}\\s*\\(`),
        );
      });

      it("keeps the read's error rather than discarding it", () => {
        const src = read(file);
        // Either destructures `error` from the read, or holds it in state.
        const keepsIt =
          /setLoadError|setError|loadError|keysError|setReadState|readError/.test(src) &&
          /error:\s*readError|\berror\b/.test(src);
        expect(keepsIt, `${file} no longer keeps the read error — ${what}`).toBe(true);
      });

      it.runIf(viaServerFn)("handles the read's promise rejecting, not just ok:false", () => {
        // A server function rejects on a network failure; `.then` alone drops
        // it. MEASURED on /secrets before the fix: request rejected, skeleton
        // still up four seconds later, nothing on screen, and no Refresh
        // control on the page to retry with.
        expect(read(file), `${file} no longer catches a rejected read — ${what}`).toMatch(
          /\.catch\s*\(/,
        );
      });

      it("never empties the list without also setting an error", () => {
        // The defect in one line. Setting the list to [] is how a page stops
        // showing a skeleton; doing it without recording WHY is how it comes
        // to claim the account is empty. Added after a mutation showed that
        // dropping the setLoadError beside setSecrets([]) restored the exact
        // S1 this module fixed while the suite stayed green.
        const lines = read(file).split("\n");
        const orphans: string[] = [];
        lines.forEach((line, i) => {
          if (!/\bset[A-Z]\w*\(\[\]\)/.test(line)) return;
          const near = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
          if (!/set\w*(Error|State)\s*\(/.test(near)) orphans.push(line.trim());
        });
        expect(orphans, `${file} empties its list with no error set — ${what}`).toEqual([]);
      });
      it("uses every read error it names, rather than binding and dropping it", () => {
        // Added after mutation testing. The rule above is satisfied by the
        // mere PRESENCE of a setter name, so reverting integrations.tsx to
        // `setReadState({ loaded: true, error: null })` — which is exactly the
        // defect module 16 fixed — survived the whole suite. An error that is
        // destructured and then never mentioned again is an error that was
        // discarded, which is the campaign's defect stated in one line.
        const src = read(file);
        const RESERVED = new Set(["string", "null", "undefined", "boolean", "number", "unknown"]);
        const names = [...src.matchAll(/\berror:\s*([a-z][A-Za-z0-9_]*)/g)]
          .map((m) => m[1])
          .filter((n) => !RESERVED.has(n));
        expect(names.length, `${file} names no read error at all — ${what}`).toBeGreaterThan(0);
        const dropped = [...new Set(names)].filter(
          (n) => (src.match(new RegExp("\\b" + n + "\\b", "g")) || []).length < 2,
        );
        expect(dropped, `${file} binds ${dropped.join(", ")} and never uses it — ${what}`).toEqual(
          [],
        );
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
