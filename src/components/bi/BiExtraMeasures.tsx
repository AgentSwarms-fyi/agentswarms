// "More values" for bar, line, area and radar charts (R499): extra
// measures drawn as their own series — Sales and Profit by month as two
// lines. Fields mode fills this from its Values; in SQL mode it is picked
// here from the query's number columns. Owns no state.
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function BiExtraMeasures({
  columns,
  exclude,
  value,
  onChange,
}: {
  /** The query's number columns. */
  columns: string[];
  /** The chart's main value, which is always drawn. */
  exclude: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const options = columns.filter((c) => c !== exclude);
  if (options.length === 0) return null;
  return (
    <div className="col-span-2 space-y-1">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        More values (each its own series)
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
        Used when no field splits the chart into series. A radar makes each value a spoke.
      </p>
    </div>
  );
}
