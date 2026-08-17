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
  claim?: string | string[];
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
  {
    file: "src/routes/_authenticated/mcp.tsx",
    module: "19 — MCP Servers",
    what: "'0 connected' and '0 tools available' for an account with a server exposing seven",
    claim: ["countLabels", "listClaim"],
  },
  {
    file: "src/routes/_authenticated/model-registry.tsx",
    module: "20 — Model Registry",
    what: "'Browse 0 live models' and 'Last refreshed never' for 770 models synced three weeks ago",
    claim: ["countLabels", "listClaim"],
    viaServerFn: true,
  },
  {
    file: "src/routes/_authenticated/analytics.tsx",
    module: "21 — Analytics",
    what: "'No execution data yet' + a sample-data seeder, for an account holding 2,731 traces",
    claim: ["listClaim", "traceCountHeadline"],
  },
  {
    file: "src/routes/_authenticated/analytics_.observability.tsx",
    module: "22 — Swarm Traces",
    what: "'0 swarm runs' + 'No swarm runs yet' for an account holding 26",
  },
  {
    file: "src/components/observability/QualityTrends.tsx",
    module: "22 — Swarm Traces",
    what: "the onboarding card telling a user to add Evaluate nodes they already have",
    // No count and no list — the panel's whole vocabulary is skeleton /
    // error / onboarding / charts, so what it routes through is the error
    // branch that outranks the onboarding copy.
    claim: "loadError",
  },
  {
    file: "src/components/observability/TeamSpend.tsx",
    module: "21 — Analytics",
    what: "the spend breakdown: 'Loading…' for ever after a failed read",
    // No count and no list, so no listClaim: this section's whole vocabulary
    // is Loading / error / empty / rows, and the fix is an explicit error
    // branch that outranks the Loading state. The claim it routes through is
    // that error branch.
    claim: "loadError",
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
      const claims = [claimHelper ?? "listClaim"].flat();
      for (const claim of claims) {
        it(`routes what it claims through ${claim}`, () => {
          // Helper call — `listClaim(` — or a state guard the render branches
          // on — `loadError !== null`, `loadError ?`. Not a bare mention.
          const called = new RegExp(`\\b${claim}\\s*\\(`);
          const branched = new RegExp(`\\b${claim}\\s*(?:!==|===|==|!=|\\?|&&|\\|\\|)`);
          const src = read(file);
          expect(
            called.test(src) || branched.test(src),
            `${file} stopped using ${claim} — ${what} can return`,
          ).toBe(true);
        });
      }

      it("keeps the read's error rather than discarding it", () => {
        const src = read(file);
        // Either destructures `error` from the read, or holds it in state.
        const keepsIt =
          /setLoadError|setError|loadError|keysError|setReadState|readError/.test(src) &&
          /error:\s*readError|\berror\b/.test(src);
        expect(keepsIt, `${file} no longer keeps the read error — ${what}`).toBe(true);
      });

      it.runIf(viaServerFn)("handles the read's promise rejecting, not just ok:false", () => {
        // A server function rejects on a network failure. MEASURED on /secrets
        // before the fix: request rejected, skeleton still up four seconds
        // later, nothing on screen, and no Refresh control to retry with.
        //
        // Two shapes count, and both are in use: a `.catch()` on the promise
        // (/secrets) and a try/catch around the await (/model-registry). The
        // rule is "the rejection is handled", not "handled this one way" — an
        // earlier version named only `.catch` and would have reported a page
        // that handles it correctly.
        //
        // The check is FILE-scoped, which is its known limit: a page with an
        // unrelated catch elsewhere satisfies it. Mutation testing on
        // /model-registry confirmed that disabling only the catch KEYWORD
        // slips through, while the realistic refactor — dropping the handler,
        // and with it the setLoadError inside — is caught by the rule below.
        const src = read(file);
        const handlesRejection = /\.catch\s*\(/.test(src) || /\}\s*catch\s*[({]/.test(src);
        expect(handlesRejection, `${file} no longer catches a rejected read — ${what}`).toBe(true);
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
      it("records the error from a real value, not only clears it", () => {
        // Added after module 19's mutation run, where deleting the single
        // `setLoadError(error.message)` — restoring the exact defect — left
        // `setLoadError(null)` behind and every rule still passed. An error
        // state that is only ever cleared records nothing.
        const src = read(file);
        const recordsIt =
          /set\w*Error\s*\(\s*(?!null\s*\))[^)]+\)/.test(src) ||
          /set\w*State\s*\(\s*\{[^}]*error:\s*\w+[^}]*\}/.test(src);
        expect(recordsIt, `${file} only ever clears its error state — ${what}`).toBe(true);
      });

      it("clears the error once the read succeeds again", () => {
        // Otherwise a recovered page keeps showing a failure that is over,
        // and the Try again button appears to do nothing.
        const src = read(file);
        const clearsIt =
          /set\w*Error\s*\(\s*null\s*\)/.test(src) ||
          /set\w*State\s*\(\s*\{[^}]*error:\s*null[^}]*\}/.test(src) ||
          /error:\s*readError\s*\?/.test(src);
        expect(clearsIt, `${file} never clears its error state — ${what}`).toBe(true);
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
        // Two ways a page can name its read error: destructure it (`error: e`)
        // or hold it in state (`setLoadError(...)`). Both count.
        const destructured = [...src.matchAll(/\berror:\s*([a-z][A-Za-z0-9_]*)/g)]
          .map((m) => m[1])
          .filter((n) => !RESERVED.has(n));
        const heldInState = [...src.matchAll(/\bset([A-Z]\w*Error)\s*\(/g)].map((m) => m[1]);
        const names = [...destructured, ...heldInState];
        expect(names.length, `${file} names no read error at all — ${what}`).toBeGreaterThan(0);
        const dropped = [...new Set(destructured)].filter(
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
