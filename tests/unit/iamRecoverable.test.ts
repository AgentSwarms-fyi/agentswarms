// The IAM page's failed-load state must be recoverable.
//
// Module 30 of the adversarial pass. This page is the best-behaved read path
// in the campaign: all seven of its server-fn reads are checked, the error is
// held and displayed, and every list stays null on failure behind one early
// return — so no false "no users" or "no grants" is possible. On an
// access-control page that matters more than anywhere else, and it was already
// right.
//
// What it lacked was a way out. MEASURED with iamListUsers 403'd: three
// skeletons and a line of red text, and no control of any kind — the Refresh
// button lives in the main view below, which the gate makes unreachable. A
// browser reload was the only recovery.
//
// Source tripwires by necessity: this is a 2,400-line superadmin route driven
// by seven server functions, so rendering it here would test mocks. Each
// assertion below pins a property verified live in the browser.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = () => readFileSync(resolve("src/routes/_authenticated/admin.iam.tsx"), "utf8");

describe("IAM failed-load state", () => {
  it("offers a retry when the load failed", () => {
    const s = src();
    // The gate must branch on a settled error before falling through to bare
    // skeletons, and that branch must call reload.
    expect(s).toMatch(/if \(error && !loading\) \{/);
    const gate = s.slice(
      s.indexOf("if (error && !loading) {"),
      s.indexOf("if (error && !loading) {") + 1400,
    );
    expect(gate).toMatch(/Try again/);
    expect(gate).toMatch(/onClick=\{reload\}/);
  });

  it("says the access rules are still enforced", () => {
    // The reassurance is load-bearing on this page: a superadmin who thinks
    // IAM is down may start re-granting access that never lapsed.
    expect(src()).toMatch(/still enforced/);
  });

  it("distinguishes a settled failure from a load in flight", () => {
    // `error && !loading` — an error latched from a PREVIOUS attempt must not
    // replace the skeleton of the retry that is currently running.
    expect(src()).toMatch(/error && !loading/);
    expect(src()).not.toMatch(
      /if \(error\) \{\s*return \(\s*<div className="p-6">\s*<div\s*role="alert"/,
    );
  });

  it("still checks every one of its seven reads", () => {
    // The property that made this page a good citizen in the first place.
    const s = src();
    for (const v of ["u", "g", "r", "gr", "res", "st"]) {
      expect(
        s.includes(`if (!${v}.ok) return setError(${v}.error);`),
        `${v}.ok is no longer checked`,
      ).toBe(true);
    }
  });

  it("keeps the lists null on failure so no empty state can speak", () => {
    // The early return gates every list; if a setter ever moved above the
    // checks, a failed read could render "no users" on an IAM page.
    const s = src();
    const checksAt = s.indexOf("if (!u.ok) return setError(u.error)");
    const setterAt = s.indexOf("setUsers(u.users)");
    expect(checksAt).toBeGreaterThan(-1);
    expect(setterAt).toBeGreaterThan(checksAt);
  });
});

// ── Module 31, Developer runtime (components/admin/RuntimeTab) ──────────
//
// The same defect one step worse. MEASURED with nbRuntimeGetState 403'd: the
// error went to a TOAST only, `state` stayed null, and the gate rendered two
// skeletons for ever — so once the toast expired there was no error text and
// no retry anywhere, on the page that governs whether the Python runtime is
// enabled and who may use it. IAM at least left a line of red text.
describe("Developer runtime failed-load state", () => {
  const rt = () => readFileSync(resolve("src/components/admin/RuntimeTab.tsx"), "utf8");

  it("keeps the read error in state, not only in a toast", () => {
    const s = rt();
    expect(s).toMatch(/const \[loadError, setLoadError\]/);
    // both failure shapes must record it: an ok:false reply and a rejection
    expect(s).toMatch(/toast\.error\(res\.error\);\s*setLoadError\(res\.error\);/);
    expect(s).toMatch(/\.catch\(\(e: unknown\) => \{/);
  });

  it("offers a retry instead of skeletons that never resolve", () => {
    const s = rt();
    const branch = s.indexOf("if (loadError !== null) {");
    expect(branch, "the error branch is gone").toBeGreaterThan(-1);
    const gate = s.slice(branch, branch + 900);
    expect(gate).toMatch(/Try again/);
    expect(gate).toMatch(/onClick=\{load\}/);
  });

  it("says the runtime configuration is still in force", () => {
    // A superadmin who thinks the runtime page is broken may re-enable or
    // re-grant settings that never lapsed.
    expect(rt()).toMatch(/still in force/);
  });

  it("shows the error above the skeleton gate", () => {
    const s = rt();
    const errorBranch = s.indexOf("if (loadError !== null) {");
    const skeletonGate = s.indexOf("if (!state || !form) {");
    expect(skeletonGate).toBeGreaterThan(-1);
    expect(errorBranch).toBeLessThan(skeletonGate);
  });
});
