// Stores the layout preferences in localStorage and applies the density to
// <html>. Pages read them with useLayoutPrefs (hooks/use-layout-prefs.ts);
// R346 moved this provider out of that module.
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_PREFS,
  LayoutPrefsContext,
  type DefaultSwarmView,
  type Density,
  type LayoutPrefs,
} from "@/hooks/use-layout-prefs";

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

export function LayoutPrefsProvider({ children }: { children: React.ReactNode }) {
  // Lazy init would read localStorage during the initial render, which
  // disagrees with the server (no `window`) and React reports as a
  // hydration error — same reasoning as ThemeProvider, in spirit. Start at defaults, reconcile once mounted.
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
