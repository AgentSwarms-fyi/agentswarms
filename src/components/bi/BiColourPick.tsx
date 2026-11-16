// A colour field (R500): preset swatches, any other colour, and "theme
// colour" to clear it.
//
// FOUND IN R500's UI test: a bare <input type="color"> shows SOME colour when
// nothing is set — black for the canvas, white for text — and choosing that
// same colour changes nothing, so no change fires and it can never be chosen.
// Black was exactly the canvas colour wanted. The swatches set a colour in one
// click whatever the picker shows.
import { hexColor } from "@/lib/biDashboards";
import { cn } from "@/lib/utils";

const PRESETS: [string, string][] = [
  ["#000000", "Black"],
  ["#ffffff", "White"],
  ["#e10600", "Racing red"],
  ["#d4af37", "Gold"],
  ["#9ca3af", "Grey"],
  ["#111827", "Charcoal"],
];

export function BiColourPick({
  label,
  value,
  onChange,
  presets = PRESETS,
  className,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  presets?: [string, string][];
  className?: string;
}) {
  const current = hexColor(value);
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {presets.map(([hex, name]) => (
        <button
          key={hex}
          type="button"
          title={name}
          aria-label={`${label}: ${name}`}
          aria-pressed={current?.toLowerCase() === hex}
          onClick={() => onChange(hex)}
          className={cn(
            "h-6 w-6 rounded-md border",
            current?.toLowerCase() === hex
              ? "border-primary ring-1 ring-primary"
              : "border-border/70",
          )}
          style={{ background: hex }}
        />
      ))}
      <label
        title="Any colour"
        className="relative h-6 w-6 cursor-pointer overflow-hidden rounded-md border border-border/70"
        style={{
          background:
            current && !presets.some(([h]) => h === current.toLowerCase())
              ? current
              : "conic-gradient(#e10600, #ff8000, #ffd400, #27f4d2, #3671c6, #e10600)",
        }}
      >
        <input
          type="color"
          aria-label={label}
          value={current ?? "#808080"}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <button
        type="button"
        disabled={!current}
        onClick={() => onChange(undefined)}
        className="ml-1 text-[10px] text-muted-foreground underline disabled:no-underline disabled:opacity-60"
      >
        {current ? "Theme colour" : "Theme colour (in use)"}
      </button>
    </div>
  );
}
