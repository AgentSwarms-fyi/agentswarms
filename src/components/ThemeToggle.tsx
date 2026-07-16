import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";

type Props = {
  /** Visual variant. "ghost" fits inside headers; "outline" stands out on plain backgrounds. */
  variant?: "ghost" | "outline";
  className?: string;
};

export function ThemeToggle({ variant = "ghost", className }: Props) {
  const { theme, toggle } = useTheme();
  // Avoid SSR/CSR hydration mismatch: theme is only known on the client
  // (it depends on localStorage). Render a stable neutral icon during SSR
  // and the first client render, then swap once mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && theme === "dark";
  const label = mounted
    ? isDark
      ? "Switch to light theme"
      : "Switch to dark theme"
    : "Toggle theme";
  return (
    <Button
      type="button"
      size="icon"
      variant={variant}
      onClick={toggle}
      aria-label={label}
      title={label}
      className={className}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
