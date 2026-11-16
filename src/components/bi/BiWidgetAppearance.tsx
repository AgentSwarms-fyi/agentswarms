// A widget's Appearance submenu (R500): accent, card surface, and the title —
// shown or hidden, its size and colour. Dashboards built on a dark canvas want
// cards with no frame and headings in the brand colour ("2026 Driver
// Standings" in red over a table), which the three card styles could not give.
// Owns no state; every choice is written through `onChange` at once.
import { Palette } from "lucide-react";

import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { WIDGET_ACCENTS, hexColor, type BiWidgetTheme } from "@/lib/biDashboards";
import { cn } from "@/lib/utils";
import { BiColourPick } from "@/components/bi/BiColourPick";

const label =
  "px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";

const CARDS: [NonNullable<BiWidgetTheme["card"]>, string][] = [
  ["default", "Default"],
  ["tint", "Accent tint"],
  ["glass", "Glass (over image)"],
  ["none", "No card — sits on the canvas"],
];

const TITLE_SIZES: [NonNullable<BiWidgetTheme["titleSize"]>, string][] = [
  ["sm", "S"],
  ["md", "M"],
  ["lg", "L"],
  ["xl", "XL"],
];

export function BiWidgetAppearance({
  theme,
  onChange,
}: {
  theme: BiWidgetTheme | undefined;
  onChange: (patch: Partial<BiWidgetTheme>) => void;
}) {
  const t = theme ?? {};
  const accentHex = hexColor(t.accent);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Palette className="mr-2 h-3.5 w-3.5" /> Appearance
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-56">
          <p className={label}>Accent</p>
          <div className="grid grid-cols-5 gap-1 px-2 pb-1.5">
            {Object.entries(WIDGET_ACCENTS).map(([id, a]) => (
              <button
                key={id}
                type="button"
                title={a.label}
                aria-label={`Accent ${a.label}`}
                onClick={() => onChange({ accent: id === "default" ? undefined : id })}
                className={cn(
                  "h-6 rounded-md border",
                  (t.accent ?? "default") === id ? "border-foreground" : "border-border/60",
                )}
                style={{ background: a.color || "var(--primary)" }}
              />
            ))}
          </div>

          <BiColourPick
            label="Accent colour"
            value={accentHex}
            onChange={(c) => onChange({ accent: c })}
            className="px-2 pb-1.5"
          />

          <p className={label}>Card style</p>
          {CARDS.map(([c, text]) => (
            <DropdownMenuItem
              key={c}
              onClick={() => onChange({ card: c === "default" ? undefined : c })}
              className={(t.card ?? "default") === c ? "font-semibold" : undefined}
            >
              {text}
            </DropdownMenuItem>
          ))}

          <p className={label}>Title</p>
          <DropdownMenuItem onClick={() => onChange({ hideTitle: t.hideTitle ? undefined : true })}>
            {t.hideTitle ? "Show the title" : "Hide the title"}
          </DropdownMenuItem>
          {!t.hideTitle && (
            <div className="flex items-center gap-1 px-2 pb-2 pt-1">
              {TITLE_SIZES.map(([s, text]) => (
                <button
                  key={s}
                  type="button"
                  aria-label={`Title size ${text}`}
                  aria-pressed={(t.titleSize ?? "sm") === s}
                  onClick={() => onChange({ titleSize: s === "sm" ? undefined : s })}
                  className={cn(
                    "h-6 min-w-7 rounded-md border px-1 text-[11px]",
                    (t.titleSize ?? "sm") === s
                      ? "border-foreground font-semibold"
                      : "border-border/60 text-muted-foreground",
                  )}
                >
                  {text}
                </button>
              ))}
            </div>
          )}
          {!t.hideTitle && (
            <BiColourPick
              label="Title colour"
              value={t.titleColor}
              onChange={(c) => onChange({ titleColor: c })}
              className="px-2 pb-2"
            />
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}
