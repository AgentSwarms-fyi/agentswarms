// "More values" for bar, line, area and radar charts (R499): extra
// measures drawn as their own series — Sales and Profit by month as two
// lines. Since R506 a combo draws each as bars or a line, and a pivot nests
// them under every column. Fields mode fills this from its Values; in SQL
// mode it is picked here from the query's number columns. Owns no state.
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function BiExtraMeasures({
  type,
  columns,
  exclude,
  value,
  onChange,
}: {
  type: string;
  /** The query's number columns. */
  columns: string[];
  /** The chart's main values, which are always drawn. */
  exclude: string[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const options = columns.filter((c) => !exclude.includes(c));
  if (options.length === 0) return null;
  return (
    <div className="col-span-2 space-y-1">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {type === "combo" || type === "matrix"
          ? "More values"
          : "More values (each its own series)"}
      </Label>
      <div className="flex flex-wrap gap-1">
        {options.map((c) => {
          const on = value.includes(c);
          return (
            <button
              key={c}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((x) => x !== c) : [...value, c])}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px]",
                on
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {c}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground">
        {type === "combo"
          ? "Each is drawn as bars; the options below make any of them a line."
          : type === "matrix"
            ? "Each value gets its own column under every column heading."
            : "Used when no field splits the chart into series. A radar makes each value a spoke."}
      </p>
    </div>
  );
}
