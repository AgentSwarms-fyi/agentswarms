import { useEffect, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { THEMES, useTheme, type Theme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

const ICONS: Record<Theme, typeof Sun> = {
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
  const { theme, setTheme } = useTheme();
  // Theme comes from localStorage — unknown during SSR and the first client
  // render. Rendering "native" until mounted avoids a hydration mismatch;
  // the real selection swaps in immediately after.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const active = mounted ? theme : "native";

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">Theme</h3>
        <p className="text-xs text-muted-foreground">
          Choose how AgentSwarms looks on this device. Applies immediately.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {THEMES.map((t) => {
          const Icon = ICONS[t.id];
          const isActive = active === t.id;
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
  );
}
