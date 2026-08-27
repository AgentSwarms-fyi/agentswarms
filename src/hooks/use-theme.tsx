import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "native";

/** Order shown in the picker, and the labels the UI uses. */
export const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: "native", label: "AgentSwarms Native", hint: "Dark chrome, light workspace" },
  { id: "dark", label: "Dark", hint: "Dark throughout" },
  { id: "light", label: "Light", hint: "Light throughout" },
];

type ThemeContextValue = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** Advances through THEMES in order. Kept so existing callers still work. */
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "agentswarms.theme.v2";

/** The theme a first-time visitor gets. */
export const DEFAULT_THEME: Theme = "native";

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    // An explicit past choice always wins, including "dark" — changing the
    // default must not silently restyle someone who already picked one.
    if (saved === "light" || saved === "dark" || saved === "native") return saved;
  } catch {
    // ignore (private mode etc.)
  }
  return DEFAULT_THEME;
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

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Lazy init so SSR sees "dark" (matches the html className) and the client
  // immediately reconciles to whatever the user previously chose.
  const [theme, setThemeState] = useState<Theme>(() => readInitialTheme());

  // On mount, force a sync in case the inline boot script set the class
  // differently than our state (e.g. user has localStorage = light).
  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggle = useCallback(
    () =>
      setThemeState((prev) => {
        const i = THEMES.findIndex((t) => t.id === prev);
        return THEMES[(i + 1) % THEMES.length].id;
      }),
    [],
  );

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Safe fallback so a stray usage outside the provider doesn't crash —
    // returns dark and a no-op toggle.
    return {
      theme: "light" as Theme,
      setTheme: () => {},
      toggle: () => {},
    };
  }
  return ctx;
}
