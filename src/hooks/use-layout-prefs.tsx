// Workspace layout preferences: UI density and the default view /swarms
// opens to. Client-only, localStorage-backed — like theme, these are "how
// this browser likes to look," not account data worth a round-trip to
// Supabase.
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Density = "comfortable" | "compact";
export type DefaultSwarmView = "gallery" | "last-opened";

export const DENSITIES: { id: Density; label: string; hint: string }[] = [
  { id: "comfortable", label: "Comfortable", hint: "More breathing room" },
  { id: "compact", label: "Compact", hint: "Tighter spacing, more on screen" },
];

export const DEFAULT_SWARM_VIEWS: { id: DefaultSwarmView; label: string; hint: string }[] = [
  { id: "gallery", label: "Gallery", hint: "Browse all your swarms first" },
  { id: "last-opened", label: "Last opened", hint: "Jump straight back into the canvas" },
];

type LayoutPrefs = {
  density: Density;
  defaultSwarmView: DefaultSwarmView;
};

const DEFAULT_PREFS: LayoutPrefs = { density: "comfortable", defaultSwarmView: "gallery" };
const STORAGE_KEY = "agentswarms.layout-prefs.v1";

function isDensity(v: unknown): v is Density {
  return v === "comfortable" || v === "compact";
}
function isDefaultSwarmView(v: unknown): v is DefaultSwarmView {
  return v === "gallery" || v === "last-opened";
}

function readPrefs(): LayoutPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<LayoutPrefs>;
    return {
      density: isDensity(parsed.density) ? parsed.density : DEFAULT_PREFS.density,
      defaultSwarmView: isDefaultSwarmView(parsed.defaultSwarmView)
        ? parsed.defaultSwarmView
        : DEFAULT_PREFS.defaultSwarmView,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function applyDensity(density: Density) {
  if (typeof document === "undefined") return;
  // A single `data-density` attribute on <html>, read by the `--spacing`
  // override in styles.css. Tailwind v4's spacing utilities (p-*, gap-*,
  // m-*, size-*, ...) all resolve through that one variable, so this is a
  // genuinely app-wide effect from one CSS rule — not a per-component
  // retrofit that only shrinks the settings page itself.
  document.documentElement.dataset.density = density;
}

type LayoutPrefsContextValue = LayoutPrefs & {
  setDensity: (d: Density) => void;
  setDefaultSwarmView: (v: DefaultSwarmView) => void;
};

const LayoutPrefsContext = createContext<LayoutPrefsContextValue | null>(null);

export function LayoutPrefsProvider({ children }: { children: React.ReactNode }) {
  // Lazy init would read localStorage during the initial render, which
  // disagrees with the server (no `window`) and React reports as a
  // hydration error — same reasoning as ThemeProvider just above this file
  // in spirit. Start at defaults, reconcile once mounted.
  const [prefs, setPrefs] = useState<LayoutPrefs>(DEFAULT_PREFS);

  useEffect(() => {
    const stored = readPrefs();
    setPrefs(stored);
    applyDensity(stored.density);
  }, []);

  const setDensity = useCallback((density: Density) => {
    setPrefs((prev) => {
      const next = { ...prev, density };
      applyDensity(density);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage disabled — the choice still applies for this load, it
        // just won't be remembered next visit.
      }
      return next;
    });
  }, []);

  const setDefaultSwarmView = useCallback((defaultSwarmView: DefaultSwarmView) => {
    setPrefs((prev) => {
      const next = { ...prev, defaultSwarmView };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore — see setDensity.
      }
      return next;
    });
  }, []);

  return (
    <LayoutPrefsContext.Provider value={{ ...prefs, setDensity, setDefaultSwarmView }}>
      {children}
    </LayoutPrefsContext.Provider>
  );
}

export function useLayoutPrefs() {
  const ctx = useContext(LayoutPrefsContext);
  if (!ctx) {
    // Safe fallback so a stray usage outside the provider doesn't crash.
    return {
      ...DEFAULT_PREFS,
      setDensity: () => {},
      setDefaultSwarmView: () => {},
    };
  }
  return ctx;
}
