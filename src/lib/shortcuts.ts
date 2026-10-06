// Single source of truth for every global keyboard shortcut — both what
// actually runs (useGlobalShortcuts) and what the help dialog displays. One
// list means the two can never say something different than what actually
// happens, the same reasoning NAV_GROUPS already applies to the sidebar and
// command palette.
import { BarChart3, Bot, BookOpen, LayoutDashboard, MessageSquare, Network } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type ShortcutCategory = "General" | "Navigation" | "Sidebar & window";

export type ShortcutDef = {
  /** Rendered as separate <kbd> keys, in order. */
  keys: string[];
  description: string;
  category: ShortcutCategory;
  /** True for "press one, release, then press the next" (the G-nav
   * shortcuts) — rendered with a "then" between keys. False (the default)
   * means a simultaneous combo, held together — e.g. Ctrl/⌘+K — which
   * "then" would misdescribe as two separate keystrokes. */
  sequential?: boolean;
};

// "Ctrl/⌘" reads correctly on both platforms without picking one — spelling
// out the actual OS-specific key happens once, in KeyCombo (ShortcutsHelpDialog).
export const SHORTCUTS: ShortcutDef[] = [
  {
    keys: ["Ctrl/⌘", "K"],
    description: "Open the command palette — jump to any page or action",
    category: "General",
  },
  {
    keys: ["Ctrl/⌘", ","],
    description: "Open Settings",
    category: "General",
  },
  {
    keys: ["?"],
    description: "Show this shortcuts help",
    category: "General",
  },
  {
    keys: ["Esc"],
    description: "Close the open dialog or menu",
    category: "General",
  },
  {
    keys: ["Ctrl/⌘", "B"],
    description: "Toggle the sidebar",
    category: "Sidebar & window",
  },
  {
    keys: ["Ctrl/⌘", "\\"],
    description: "Toggle the sidebar (alternate)",
    category: "Sidebar & window",
  },
  {
    keys: ["G", "D"],
    description: "Go to Dashboard",
    category: "Navigation",
    sequential: true,
  },
  {
    keys: ["G", "A"],
    description: "Go to Agent Builder",
    category: "Navigation",
    sequential: true,
  },
  {
    keys: ["G", "S"],
    description: "Go to Agent Swarms",
    category: "Navigation",
    sequential: true,
  },
  {
    keys: ["G", "C"],
    description: "Go to Agent Chat",
    category: "Navigation",
    sequential: true,
  },
  {
    keys: ["G", "B"],
    description: "Go to BI Workspace",
    category: "Navigation",
    sequential: true,
  },
  {
    keys: ["G", "K"],
    description: "Go to Knowledge Base",
    category: "Navigation",
    sequential: true,
  },
];

export const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  "General",
  "Navigation",
  "Sidebar & window",
];

/**
 * The "G then <letter>" destinations — Gmail/Linear/GitHub-style sequential
 * navigation. Reuses the exact URLs NAV_GROUPS points at (appNav.ts), so a
 * page moving there can't silently strand this list on a dead route.
 */
export const GO_TO_SHORTCUTS: { key: string; url: string; label: string; icon: LucideIcon }[] = [
  { key: "d", url: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "a", url: "/agents", label: "Agent Builder", icon: Bot },
  { key: "s", url: "/swarms", label: "Agent Swarms", icon: Network },
  { key: "c", url: "/playground", label: "Agent Chat", icon: MessageSquare },
  { key: "b", url: "/bi", label: "BI Workspace", icon: BarChart3 },
  { key: "k", url: "/knowledge", label: "Knowledge Base", icon: BookOpen },
];

/**
 * Set once the shortcuts list has opened by itself. The name is the old
 * "Don't show this again" flag's, so whoever ticked that is not shown it again.
 */
export const SHORTCUTS_SEEN_KEY = "agentswarms.shortcuts-help.dismissed";

/**
 * Whether the shortcuts list opens by itself on this load: once, on the first
 * visit, and never again however it was closed. "?" opens it any time.
 *
 * It was shown on every fresh load until "Don't show this again" was ticked,
 * taking the keyboard from whatever page had just opened. It is marked shown
 * as it opens, so a tab closed with the list still up does not bring it back.
 * Storage that cannot be read or written cannot keep "once", so the list
 * stays closed rather than opening on every load.
 */
export function firstVisitShowsShortcuts(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
): boolean {
  try {
    if (!storage || storage.getItem(SHORTCUTS_SEEN_KEY) === "true") return false;
    storage.setItem(SHORTCUTS_SEEN_KEY, "true");
    return true;
  } catch {
    return false;
  }
}
