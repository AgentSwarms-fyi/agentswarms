// Workspace layout preferences: UI density and the default view /swarms
// opens to. Client-only, localStorage-backed — like theme, these are "how
// this browser likes to look," not account data worth a round-trip to
// Supabase. The provider that stores and applies them is
// components/LayoutPrefsProvider.tsx (R346: split out of this module).
import { createContext, useContext } from "react";

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

export type LayoutPrefs = {
  density: Density;
  defaultSwarmView: DefaultSwarmView;
};

export const DEFAULT_PREFS: LayoutPrefs = { density: "comfortable", defaultSwarmView: "gallery" };
export type LayoutPrefsContextValue = LayoutPrefs & {
  setDensity: (d: Density) => void;
  setDefaultSwarmView: (v: DefaultSwarmView) => void;
};

export const LayoutPrefsContext = createContext<LayoutPrefsContextValue | null>(null);

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
