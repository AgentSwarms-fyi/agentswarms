import { cn } from "@/lib/utils";
import { nameLength } from "@/lib/visibleName";

/** "37 / 120" under a limited field; red once the text is over the limit. */
export function CharCount({
  value,
  max,
  className,
}: {
  value: string;
  max: number;
  className?: string;
}) {
  const n = nameLength(value);
  return (
    <p
      className={cn(
        "text-right text-[11px] tabular-nums",
        n > max ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {n} / {max}
    </p>
  );
}
