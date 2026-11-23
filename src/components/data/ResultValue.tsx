// One value in a result grid: one line, and the whole of it on a click.
// Why every grid goes through this is in src/lib/cellPreview.ts.
import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cellFull, cellPreview, valueText } from "@/lib/cellPreview";
import { reportFailure } from "@/lib/silentFailureNet";
import { cn } from "@/lib/utils";

export function ResultValue({
  value,
  formatNumber,
  nullLabel = "null",
  className,
}: {
  value: unknown;
  /** How the grid writes numbers; without it a number is shown as it came. */
  formatNumber?: (n: number) => string;
  nullLabel?: ReactNode;
  className?: string;
}) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/70">{nullLabel}</span>;
  }
  if (typeof value === "number" && formatNumber) return <>{formatNumber(value)}</>;
  const p = cellPreview(value);
  if (!p.clipped) {
    return (
      <span className={cn("block max-w-[32rem] truncate", className)} title={p.text}>
        {p.text}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "block max-w-[32rem] truncate rounded-sm text-left underline decoration-muted-foreground/40 decoration-dotted underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            className,
          )}
          title="Show the whole value"
        >
          {p.text}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(36rem,90vw)] p-0">
        <WholeValue value={value} length={p.length} />
      </PopoverContent>
    </Popover>
  );
}

function WholeValue({ value, length }: { value: unknown; length: number }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(valueText(value))
      .then(() => setCopied(true))
      .catch((e) => reportFailure("copy the value", e));
  };
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs tabular-nums text-muted-foreground">
          {length.toLocaleString()} characters
        </span>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={copy}>
          {copied ? (
            <Check className="mr-1.5 h-3.5 w-3.5" />
          ) : (
            <Copy className="mr-1.5 h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-5 text-foreground">
        {cellFull(value)}
      </pre>
    </div>
  );
}
