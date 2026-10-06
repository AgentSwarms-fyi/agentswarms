// R220: `useAuth()` hands out a new `user` (and `session`) object on every
// auth event, and a session refresh is one (about hourly, and when a tab
// regains focus near expiry). A hook keyed on the object runs again each time.
//
// FOUND IN R220: the Knowledge Bases page reloaded the connected providers in
// an effect keyed on `[user]`. The new Set ran the embedding default again,
// and the default only stood back once a PROVIDER had been picked, so a model
// picked under the default provider (openai/text-embedding-3-large) read
// openai/text-embedding-3-small after a refresh. The next upload or re-index
// would have embedded with the model the user did not choose.
//
// This keeps the knowledge page's fix and is the guard for the next one, as
// R125's token sweep is for the token: every other hook keyed on the user
// object was read and found to re-read a list or a status, never to put
// something back over what the user is editing.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

/** A dependency list: from a closing "}," through "[...]" to its ")". */
const DEPS = /\}\s*,\s*(?:\/\/[^\n]*\n\s*)*\[([^\]]*)\]\s*,?\s*\)/g;
const AUTH_OBJECT = /^(user|session)$/;

function items(list: string): string[] {
  return list
    .split(",")
    .map((x) => x.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean);
}

/**
 * Hooks keyed on the user or session object, file by file, each read for
 * R220. A new one, or one more in any of these files, fails below: read it,
 * and if its re-run can replace something the user is editing, key it on
 * `user?.id` (or `useTokenRef`'s `signedIn`); if it only re-reads what the user
 * sees, raise the count here.
 */
const REVIEWED: Record<string, number> = {
  // Re-reads pending approvals.
  "src/components/ApprovalInbox.tsx": 1,
  // Settings (PR #77), read when it was merged: the month's spend and cap,
  // shown only.
  "src/components/settings/AccountSettingsPanel.tsx": 1,
  // The API key list. A reload swaps the list for a spinner; the create form
  // and the once-shown new key are separate state and stay as they are.
  "src/components/settings/ApiKeysSettingsPanel.tsx": 1,
  // Re-reads the signed-in user's profile for the avatar and name.
  "src/components/UserMenu.tsx": 1,
  "src/components/observability/QualityTrends.tsx": 1,
  // The runs list's loader.
  "src/components/swarms/RecentRunsPanel.tsx": 1,
  // `persist` is called from handlers only; nothing runs when it changes.
  "src/components/swarms/SwarmChatDialog.tsx": 1,
  "src/components/swarms/SwarmGallery.tsx": 1,
  "src/routes/_authenticated/analytics.tsx": 1,
  "src/routes/_authenticated/analytics_.observability.tsx": 1,
  // Re-reads the budget; every field saves as it is typed, so nothing unsaved
  // is on screen to lose.
  "src/routes/_authenticated/budgets.tsx": 1,
  // Re-reads the server list and resubscribes to its changes.
  "src/routes/_authenticated/mcp.tsx": 1,
  "src/routes/_authenticated/notebooks.tsx": 1,
  // Also keyed on the token; reviewed in R125's sweep.
  "src/routes/_authenticated/traces.tsx": 1,
};

function authKeyedHooks(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        let n = 0;
        for (const m of read(p).matchAll(new RegExp(DEPS.source, "g")))
          if (items(m[1]).some((x) => AUTH_OBJECT.test(x))) n++;
        if (n) out[p.split("\\").join("/")] = n;
      }
    }
  };
  walk("src");
  return out;
}

describe("the embedding model a user picks survives a session refresh (R220)", () => {
  const src = read("src/routes/_authenticated/knowledge.tsx");

  it("reloads the connected providers when the user changes, not their object", () => {
    expect(src).toMatch(
      /const userId = user\?\.id;\s*useEffect\(\(\) => \{\s*if \(userId\) loadConnectedProviders\(\);/,
    );
    expect(authKeyedHooks()["src/routes/_authenticated/knowledge.tsx"]).toBeUndefined();
  });

  it("stops the embedding default once a model is picked, not only a provider", () => {
    const at = src.indexOf('<Label className="pt-1">Embedding Model</Label>');
    expect(at).toBeGreaterThan(-1);
    const picker = src.slice(at, src.indexOf("</Select>", at));
    expect(picker).toMatch(/onValueChange=\{\(v\) => \{\s*setEmbedChoiceTouched\(true\);/);
    expect(src).toContain("if (embedChoiceTouched) return;");
  });
});

describe("every hook keyed on the user object has been read", () => {
  it("no file has one that was not reviewed", () => {
    const unreviewed = Object.entries(authKeyedHooks())
      .filter(([file, n]) => n > (REVIEWED[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} (reviewed ${REVIEWED[file] ?? 0})`);
    expect(unreviewed).toEqual([]);
  });

  it("matches the object, not its id or other names", () => {
    const hit = (s: string) =>
      [...s.matchAll(new RegExp(DEPS.source, "g"))].filter((m) =>
        items(m[1]).some((x) => AUTH_OBJECT.test(x)),
      ).length;
    // Every sample has a body ending in "}", as the hooks the sweep reads do,
    // so a miss below is the name test refusing it, not the shape.
    expect(hit("useEffect(() => {\n  load();\n}, [user]);")).toBe(1);
    expect(
      hit("useCallback(\n  async () => {\n    x();\n  },\n  // why\n  [session, id],\n);"),
    ).toBe(1);
    expect(hit("useEffect(() => {\n  load();\n}, [user?.id]);")).toBe(0);
    expect(hit("useEffect(() => {\n  load();\n}, [userId, users]);")).toBe(0);
  });
});
