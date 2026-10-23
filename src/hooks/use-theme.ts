// The theme a page reads: the choices, the context and useTheme. The
// provider that stores and paints it is components/ThemeProvider.tsx
// (R346: split, so each module exports one kind of thing).
import { createContext, useContext } from "react";

export type Theme = "light" | "dark" | "native";
/** What's actually stored/selected: one of the three real themes, or
 * "system" — which isn't a theme of its own, it's "resolve to dark or light
 * by asking the OS," live, forever (see the matchMedia listener below). */
export type ThemePreference = Theme | "system";

/** Order shown in the picker, and the labels the UI uses. */
export const THEMES: { id: ThemePreference; label: string; hint: string }[] = [
  { id: "system", label: "System", hint: "Match your OS setting (dark or light)" },
  { id: "native", label: "AgentSwarms Native", hint: "Dark chrome, light workspace" },
  { id: "dark", label: "Dark", hint: "Dark throughout" },
  { id: "light", label: "Light", hint: "Light throughout" },
];

// Accent color: an independent axis from Theme (light/dark/native chrome).
// Each preset holds the same lightness/chroma as this app's tuned default
// `--primary` for that mode — only the hue changes — so contrast against
// `--primary-foreground` stays as good as the default at every hue instead
// of needing a second foreground table.
export type Accent = "teal" | "blue" | "purple" | "rose" | "amber" | "green";

export const ACCENTS: { id: Accent; label: string; light: string; dark: string }[] = [
  { id: "teal", label: "Teal", light: "oklch(0.52 0.12 205)", dark: "oklch(0.72 0.13 195)" },
  { id: "blue", label: "Blue", light: "oklch(0.52 0.12 250)", dark: "oklch(0.72 0.13 250)" },
  { id: "purple", label: "Purple", light: "oklch(0.52 0.12 300)", dark: "oklch(0.72 0.13 300)" },
  { id: "rose", label: "Rose", light: "oklch(0.55 0.15 20)", dark: "oklch(0.72 0.13 20)" },
  { id: "amber", label: "Amber", light: "oklch(0.55 0.14 70)", dark: "oklch(0.75 0.13 75)" },
  { id: "green", label: "Green", light: "oklch(0.52 0.12 145)", dark: "oklch(0.72 0.13 145)" },
];
/** "teal" reproduces this app's built-in default hue exactly — "no override." */
export const DEFAULT_ACCENT: Accent = "teal";

export type ThemeContextValue = {
  /** The stored preference — may be "system". Use this to drive a picker's
   * "which option is selected" state. */
  theme: ThemePreference;
  setTheme: (t: ThemePreference) => void;
  /** What's actually painted right now — "system" already resolved to dark
   * or light. Use this for anything that needs the real, current theme
   * (e.g. picking an icon). */
  resolvedTheme: Theme;
  /** Advances through THEMES in order. Kept so existing callers still work. */
  toggle: () => void;
  accent: Accent;
  setAccent: (a: Accent) => void;
};

export const ThemeContext = createContext<ThemeContextValue | null>(null);

/** The theme a first-time visitor gets. */
export const DEFAULT_THEME: ThemePreference = "native";

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Safe fallback so a stray usage outside the provider doesn't crash —
    // returns dark and a no-op toggle.
    return {
      theme: "light" as ThemePreference,
      setTheme: () => {},
      resolvedTheme: "light" as Theme,
      toggle: () => {},
      accent: DEFAULT_ACCENT,
      setAccent: () => {},
    };
  }
  return ctx;
}
