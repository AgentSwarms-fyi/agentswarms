import { useEffect, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THEMES, useTheme, type Theme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

type Props = {
  /** Visual variant. "ghost" fits inside headers; "outline" stands out on plain backgrounds. */
  variant?: "ghost" | "outline";
  className?: string;
};

const ICONS: Record<Theme, typeof Sun> = {
  native: Monitor,
  dark: Moon,
  light: Sun,
};

/**
 * Theme picker.
 *
 * Was a two-state toggle, which stops working the moment there are three
 * options: a button that cycles gives no way to see what you are choosing, and
 * "AgentSwarms Native" is not something you can infer from an icon. The menu
 * names each one and marks the active entry.
 */
export function ThemeToggle({ variant = "ghost", className }: Props) {
  const { theme, setTheme } = useTheme();
  // The theme comes from localStorage, so it is unknown during SSR and on the
  // first client render. Rendering a fixed icon until mounted avoids a
  // hydration mismatch; the real one swaps in immediately after.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const active = mounted ? theme : "native";
  const Icon = ICONS[active] ?? Monitor;
  const activeLabel = THEMES.find((t) => t.id === active)?.label ?? "Theme";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant={variant}
          aria-label={mounted ? `Theme: ${activeLabel}` : "Theme"}
          title={mounted ? `Theme: ${activeLabel}` : "Theme"}
          className={className}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Theme
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {THEMES.map((t) => {
          const ItemIcon = ICONS[t.id];
          const isActive = mounted && theme === t.id;
          return (
            <DropdownMenuItem
              key={t.id}
              onSelect={() => setTheme(t.id)}
              className="gap-2"
              aria-current={isActive ? "true" : undefined}
            >
              <ItemIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{t.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{t.hint}</span>
              </span>
              <Check className={cn("h-4 w-4 shrink-0", isActive ? "opacity-100" : "opacity-0")} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
