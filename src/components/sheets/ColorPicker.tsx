// A color button as Excel's ribbon has it: the main half applies the color
// last chosen (the bar under the icon shows which), the arrow opens the
// palette — theme colors in tints, the standard row, and any hex value.

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { normalizeColor, PALETTE, STANDARD_COLORS } from "@/lib/sheets/style";
import { cn } from "@/lib/utils";

export function ColorPicker({
  label,
  icon,
  initial,
  clearLabel,
  onPick,
  testId,
  onDone,
}: {
  label: string;
  icon: React.ReactNode;
  /** The color the main half applies before anything is chosen. */
  initial: string;
  /** "Automatic" for text, "No fill" for a fill. */
  clearLabel: string;
  onPick: (color: string | null) => void;
  testId: string;
  /** Give the keyboard back to the grid when the palette closes. */
  onDone?: () => void;
}) {
  const [last, setLast] = useState(initial);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const pick = (c: string | null) => {
    if (c) setLast(c);
    setOpen(false);
    onPick(c);
  };
  const customColor = normalizeColor(custom);
  return (
    <div className="flex items-center rounded hover:bg-muted" data-testid={testId}>
      <button
        type="button"
        className="flex h-7 w-7 flex-col items-center justify-center rounded-l"
        title={`${label} (${last})`}
        aria-label={`${label} ${last}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => pick(last)}
      >
        {icon}
        <span className="mt-0.5 h-1 w-4 rounded-sm" style={{ background: last }} />
      </button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-7 w-3.5 items-center justify-center rounded-r"
            aria-label={`${label}: more colors`}
            onMouseDown={(e) => e.preventDefault()}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-64 p-2"
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onDone?.();
          }}
        >
          <button
            type="button"
            className="mb-2 w-full rounded border border-border px-2 py-1 text-left text-xs hover:bg-muted"
            onClick={() => pick(null)}
          >
            {clearLabel}
          </button>
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Theme colors
          </p>
          <div className="grid grid-cols-10 gap-0.5" role="listbox" aria-label="Theme colors">
            {PALETTE[0].map((_, col) =>
              PALETTE.map((row, r) => (
                <Swatch
                  key={`${r}:${col}`}
                  color={row[col]}
                  onPick={pick}
                  style={{ gridRow: r + 1, gridColumn: col + 1 }}
                />
              )),
            )}
          </div>
          <p className="mb-1 mt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Standard colors
          </p>
          <div className="grid grid-cols-10 gap-0.5" role="listbox" aria-label="Standard colors">
            {STANDARD_COLORS.map((c) => (
              <Swatch key={c} color={c} onPick={pick} />
            ))}
          </div>
          <form
            className="mt-2 flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (customColor) pick(customColor);
            }}
          >
            <input
              type="color"
              aria-label="Choose any color"
              className="h-7 w-8 cursor-pointer rounded border border-input bg-background p-0.5"
              value={customColor ?? last}
              onChange={(e) => setCustom(e.target.value)}
            />
            <input
              aria-label="Hex color"
              placeholder="#1F4E79"
              className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-xs"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <button
              type="submit"
              disabled={!customColor}
              className="h-7 rounded border border-border px-2 text-xs hover:bg-muted disabled:opacity-40"
            >
              Apply
            </button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function Swatch({
  color,
  onPick,
  style,
}: {
  color: string;
  onPick: (c: string) => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={false}
      aria-label={color}
      title={color}
      className={cn("h-5 w-5 rounded-sm border border-black/10 hover:ring-2 hover:ring-primary")}
      style={{ background: color, ...style }}
      onClick={() => onPick(color)}
    />
  );
}
