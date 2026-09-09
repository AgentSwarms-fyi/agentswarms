import { createContext, useCallback, useContext, useEffect, useState } from "react";

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

function resolveTheme(pref: ThemePreference): Theme {
  if (pref !== "system") return pref;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

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

type ThemeContextValue = {
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

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "agentswarms.theme.v2";
const ACCENT_STORAGE_KEY = "agentswarms.accent.v1";

/** The theme a first-time visitor gets. */
export const DEFAULT_THEME: ThemePreference = "native";

function readInitialTheme(): ThemePreference {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    // An explicit past choice always wins, including "dark" — changing the
    // default must not silently restyle someone who already picked one.
    if (saved === "light" || saved === "dark" || saved === "native" || saved === "system") {
      return saved;
    }
  } catch {
    // ignore (private mode etc.)
  }
  return DEFAULT_THEME;
}

function readInitialAccent(): Accent {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  try {
    const saved = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    if (ACCENTS.some((a) => a.id === saved)) return saved as Accent;
  } catch {
    // ignore
  }
  return DEFAULT_ACCENT;
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("dark", "native");
  if (theme === "dark") root.classList.add("dark");
  else if (theme === "native") root.classList.add("native");
  // Native's CONTENT is light, so the browser should paint light form
  // controls and scrollbars. Its dark chrome is our own tokens, not the UA's
  // business — telling the UA "dark" here would darken every native widget on
  // a light page.
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
}

function applyAccent(accent: Accent, theme: Theme) {
  if (typeof document === "undefined") return;
  const preset = ACCENTS.find((a) => a.id === accent) ?? ACCENTS[0];
  // "native"'s workspace content is light-styled, same as "light" — only its
  // dark chrome (sidebar/header) differs, and that's handled for free: those
  // elements redeclare --primary themselves in styles.css (`.native
  // [data-sidebar="sidebar"], .native [data-app-header]`), a rule scoped
  // directly to them that wins over whatever inherits down from this inline
  // override on <html>, exactly like it already wins over .native's own
  // unscoped default. Nothing here needs to know that rule exists.
  document.documentElement.style.setProperty(
    "--primary",
    theme === "dark" ? preset.dark : preset.light,
  );
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Lazy init so SSR sees "dark" (matches the html className) and the client
  // immediately reconciles to whatever the user previously chose. Safe for
  // this specific element only because RootShell puts suppressHydrationWarning
  // on <html> — the class/style mutations here are DOM-imperative, not
  // React-rendered JSX output, so there's nothing for hydration to diff.
  const [theme, setThemeState] = useState<ThemePreference>(() => readInitialTheme());
  const [resolvedTheme, setResolvedTheme] = useState<Theme>(() => resolveTheme(theme));
  const [accent, setAccentState] = useState<Accent>(() => readInitialAccent());

  // On mount, force a sync in case the inline boot script set the class
  // differently than our state (e.g. user has localStorage = light).
  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyTheme(resolved);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }

    // Only "system" needs to keep watching — the other three are a fixed
    // choice until the user picks something else.
    if (theme !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next = resolveTheme("system");
      setResolvedTheme(next);
      applyTheme(next);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [theme]);

  // Accent depends on the RESOLVED theme (light vs. dark preset), so it has
  // to re-apply whenever either changes — picking Dark (or a "System" that
  // resolves to dark) while Rose is selected should switch to Rose's dark
  // variant, not silently drop back to teal.
  useEffect(() => {
    applyAccent(accent, resolvedTheme);
    try {
      window.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
    } catch {
      // ignore
    }
  }, [accent, resolvedTheme]);

  const setTheme = useCallback((t: ThemePreference) => setThemeState(t), []);
  const toggle = useCallback(
    () =>
      setThemeState((prev) => {
        const i = THEMES.findIndex((t) => t.id === prev);
        return THEMES[(i + 1) % THEMES.length].id;
      }),
    [],
  );
  const setAccent = useCallback((a: Accent) => setAccentState(a), []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme, toggle, accent, setAccent }}>
      {children}
    </ThemeContext.Provider>
  );
}

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
