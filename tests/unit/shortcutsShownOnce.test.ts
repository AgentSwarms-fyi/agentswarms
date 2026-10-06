// The keyboard shortcuts list opens by itself once, on the first visit.
//
// Since #77 it opened on every fresh load until "Don't show this again" was
// ticked, taking the keyboard from whatever page had just opened: reloading
// the Account page after closing it with Escape opened it again, and keys
// typed into the profile form went to the list instead. "?" still opens it
// any time.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHORTCUTS_SEEN_KEY, firstVisitShowsShortcuts } from "@/lib/shortcuts";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    items,
  };
}

describe("the shortcuts list on its own", () => {
  it("opens on the first visit, and not on the next", () => {
    const storage = memoryStorage();
    expect(firstVisitShowsShortcuts(storage)).toBe(true);
    expect(storage.items.get(SHORTCUTS_SEEN_KEY)).toBe("true");
    expect(firstVisitShowsShortcuts(storage)).toBe(false);
    expect(firstVisitShowsShortcuts(storage)).toBe(false);
  });

  it("stays closed for whoever ticked the old Don't show this again", () => {
    expect(SHORTCUTS_SEEN_KEY).toBe("agentswarms.shortcuts-help.dismissed");
    expect(firstVisitShowsShortcuts(memoryStorage({ [SHORTCUTS_SEEN_KEY]: "true" }))).toBe(false);
  });

  it("stays closed when storage cannot keep 'once'", () => {
    expect(firstVisitShowsShortcuts(null)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    expect(firstVisitShowsShortcuts(throwing)).toBe(false);
    const readOnly = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(firstVisitShowsShortcuts(readOnly)).toBe(false);
  });
});

describe("the wiring", () => {
  const hook = readFileSync("src/hooks/use-global-shortcuts.ts", "utf8");
  const dialog = readFileSync("src/components/ShortcutsHelpDialog.tsx", "utf8");
  const layout = readFileSync("src/components/AppLayout.tsx", "utf8");

  it("opens it on mount only when this is the first visit", () => {
    expect(hook).toContain("if (firstVisitShowsShortcuts(storage)) setHelpOpen(true);");
    expect(hook.match(/setHelpOpen\(true\)/g)).toHaveLength(2); // that, and "?"
  });

  it("has no Don't show this again left to tick", () => {
    expect(dialog).not.toContain("Don't show this again");
    expect(dialog).not.toContain("onNeverShowAgain");
    expect(layout).not.toContain("onNeverShowAgain");
  });
});
