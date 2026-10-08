import { useEffect, useState } from "react";
import { Check, Laptop, Monitor, Moon, Sun } from "lucide-react";
import { ACCENTS, THEMES, useTheme, type ThemePreference } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

const ICONS: Record<ThemePreference, typeof Sun> = {
  system: Laptop,
  native: Monitor,
  dark: Moon,
  light: Sun,
};

/**
 * A larger, card-based version of ThemeToggle's picker — more at home in a
 * settings panel than a header dropdown. Reads/writes the same ThemeProvider
 * state, so a change here is reflected everywhere else immediately
 * (including the header's own ThemeToggle).
 */
export function AppearanceSettingsPanel() {
  const { theme, setTheme, resolvedTheme, accent, setAccent } = useTheme();
  // Theme/accent come from localStorage — unknown during SSR and the first
  // client render. Rendering the defaults until mounted avoids a hydration
  // mismatch; the real selections swap in immediately after.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const activeTheme = mounted ? theme : "native";
  const activeAccent = mounted ? accent : "teal";
  // Same branch applyAccent() uses in ThemeProvider.tsx: everything except a
  // resolved "dark" gets the light-content variant (native's workspace is
  // light-styled too) — so the swatch always shows the color that will
  // actually apply, not a color picked without knowing the active theme.
  const swatchVariant = mounted && resolvedTheme === "dark" ? "dark" : "light";

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Theme</h3>
          <p className="text-xs text-muted-foreground">
            Choose how AgentSwarms looks on this device, or match your OS. Applies immediately.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {THEMES.map((t) => {
            const Icon = ICONS[t.id];
            const isActive = activeTheme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTheme(t.id)}
                aria-pressed={isActive}
                className={cn(
                  "relative flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors",
                  isActive
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-border hover:border-primary/40 hover:bg-muted/40",
                )}
              >
                <div className="flex w-full items-center justify-between">
                  <Icon
                    className={cn("h-4 w-4", isActive ? "text-primary" : "text-muted-foreground")}
                  />
                  {isActive && <Check className="h-4 w-4 text-primary" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{t.label}</p>
                  <p className="text-xs text-muted-foreground">{t.hint}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Accent color</h3>
          <p className="text-xs text-muted-foreground">
            The color behind buttons, links, and active states. Independent of the theme above.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {ACCENTS.map((a) => {
            const isActive = activeAccent === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setAccent(a.id)}
                aria-pressed={isActive}
                aria-label={a.label}
                title={a.label}
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full border-2 transition-transform hover:scale-105",
                  isActive ? "border-foreground" : "border-transparent",
                )}
              >
                <span
                  className="h-7 w-7 rounded-full"
                  style={{ backgroundColor: a[swatchVariant] }}
                />
                <span className="sr-only">{a.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
