// The profile form (R282, sweep 8). It kept no record of what was saved, so a
// link or a closed tab left its edits behind without a word. Reading it found
// worse: a failed read was taken for "no profile yet", so the form opened blank
// and Save would write the blanks over the stored profile.
//
// The form moved into ProfileSettingsPanel, shared by the Account page and the
// Settings page, when the settings work (PR #77) was merged; R282's fixes moved
// with it. The page keeps the one piece that is its own: once the account is
// deleted, leaving does not ask about the form. Not rendered in unit tests; the
// wiring is pinned by reading it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const src = read("src/components/settings/ProfileSettingsPanel.tsx");
const page = read("src/routes/_authenticated/account.tsx");

describe("the profile form", () => {
  it("records the form fields as loaded and as saved, not the avatar", () => {
    const form = src.slice(
      src.indexOf("function profileForm("),
      src.indexOf("export function ProfileSettingsPanel("),
    );
    for (const f of [
      "first_name",
      "last_name",
      "display_name",
      "role",
      "designation",
      "organization",
      "bio",
    ]) {
      expect(form).toContain(`p.${f} ?? ""`);
    }
    expect(form).not.toContain("avatar_url");
    expect(src).toContain(
      "const unsaved = profile !== null && savedAs !== null && profileForm(profile) !== savedAs;",
    );
    expect(src).toMatch(/setProfile\(loaded\);\s*setSavedAs\(profileForm\(loaded\)\);/);
  });

  it("records a save only once it came back, and keeps an edit typed meanwhile", () => {
    expect(src).toMatch(
      /if \(error\) throw error;[^]*?const sentForm = profileForm\(profile\);\s*setProfile\(\(p\) => \(p && profileForm\(p\) === sentForm \? stored : p\)\);\s*setSavedAs\(profileForm\(stored\)\);/,
    );
  });

  it("does not offer a blank form when the profile could not be read", () => {
    expect(src).toMatch(
      /const \{ data, error \} = await supabase\s*\.from\("profiles"\)[^]*?if \(error\) \{\s*setProfileError\(error\.message\);\s*setProfileLoading\(false\);\s*return;\s*\}/,
    );
    // The error is checked before the form is rendered.
    expect(src.indexOf("if (profileError !== null) {")).toBeGreaterThan(-1);
    expect(src.indexOf("if (profileError !== null) {")).toBeLessThan(
      src.indexOf("if (profileLoading || !profile) {"),
    );
    expect(src).toContain('data-testid="profile-load-error"');
  });

  it("asks before a link or the tab drops unsaved edits, except once the account is gone", () => {
    expect(src).toMatch(
      /useBlocker\(\{\s*shouldBlockFn: async \(\) =>\s*!goneRef\?\.current &&\s*!\(await confirmAsk\(\{\s*title: "Discard the changes to your profile\?",[^]*?enableBeforeUnload: unsaved,\s*disabled: !unsaved,\s*\}\);/,
    );
    // The blocker is a hook: it runs before either early return.
    expect(src.indexOf("useBlocker({")).toBeLessThan(src.indexOf("if (profileError !== null) {"));
    expect(page).toMatch(/accountGoneRef\.current = true;\s*navigate\(\{ to: "\/" \}\);/);
    expect(page).toContain("<ProfileSettingsPanel goneRef={accountGoneRef} />");
  });

  it("says when something is unsaved", () => {
    expect(src).toMatch(/\{unsaved && \(\s*<span[^>]*data-testid="profile-unsaved"/);
  });
});
