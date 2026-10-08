// Stores the theme and accent a visitor picked, resolves "system" against
// the OS, and paints both onto <html>. Pages read them with useTheme
// (hooks/use-theme.ts); R346 moved this provider out of that module.
import { useCallback, useEffect, useState } from "react";
import {
  ACCENTS,
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  THEMES,
  ThemeContext,
  type Accent,
  type Theme,
  type ThemePreference,
} from "@/hooks/use-theme";

function resolveTheme(pref: ThemePreference): Theme {
  if (pref !== "system") return pref;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const STORAGE_KEY = "agentswarms.theme.v2";

const ACCENT_STORAGE_KEY = "agentswarms.accent.v1";

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
