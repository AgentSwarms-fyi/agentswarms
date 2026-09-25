// R123: Ctrl+B in Sheets made cells bold AND opened or closed the app's
// sidebar, which reflowed the grid under the pointer on every press. The
// sidebar's shortcut now leaves alone a key that what has focus handled.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isSidebarShortcut } from "@/lib/sidebarShortcut";

const key = (k: string, extra: Partial<Parameters<typeof isSidebarShortcut>[0]> = {}) => ({
  key: k,
  ctrlKey: true,
  metaKey: false,
  defaultPrevented: false,
  ...extra,
});

describe("the sidebar's shortcut", () => {
  it("toggles on Ctrl+B, Cmd+B and Ctrl+\\ when nothing else took the key", () => {
    expect(isSidebarShortcut(key("b"))).toBe(true);
    expect(isSidebarShortcut(key("b", { ctrlKey: false, metaKey: true }))).toBe(true);
    expect(isSidebarShortcut(key("\\"))).toBe(true);
  });

  it("leaves a key alone that a spreadsheet or editor already handled (bold)", () => {
    expect(isSidebarShortcut(key("b", { defaultPrevented: true }))).toBe(false);
  });

  it("is not B alone, or another letter", () => {
    expect(isSidebarShortcut(key("b", { ctrlKey: false }))).toBe(false);
    expect(isSidebarShortcut(key("i"))).toBe(false);
  });

  it("is the check the sidebar's window listener uses", () => {
    const src = readFileSync("src/components/ui/sidebar.tsx", "utf8");
    const listener = src.slice(src.indexOf("const handleKeyDown = (event: KeyboardEvent)"));
    expect(listener.slice(0, 200)).toContain("if (isSidebarShortcut(event))");
  });
});
