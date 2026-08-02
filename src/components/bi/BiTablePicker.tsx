// The table multi-select above the SQL box: pick one or more, get a JOIN skeleton.
//
// Extracted from BiBuilderPane. It needs four of that component's values, so
// it is a genuinely separable piece rather than the same coupling written out
// as a prop list. It renders the list and reports clicks; which tables exist,
// and what selecting one does to the query, both stay in the parent.
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { SourceTable } from "@/lib/biBuilder";

export function BiTablePicker({
  sourceTables,
  selectedTables,
  schemaLoading,
  preparedTables,
  toggleTable,
}: {
  sourceTables: SourceTable[];
  selectedTables: string[];
  schemaLoading: boolean;
  /** Tables with a prep flow, badged so a user knows the rows are transformed. */
  preparedTables: Set<string> | undefined;
  toggleTable: (name: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tables — select one or more to join
        </Label>
        {schemaLoading && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> loading…
          </span>
        )}
      </div>
      <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-border/60 p-1.5">
        {sourceTables.length === 0 && !schemaLoading && (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            No tables available for this source.
          </p>
        )}
        {sourceTables.map((t) => {
          const checked = selectedTables.includes(t.name);
          return (
            <div key={t.name} className="rounded px-1 py-0.5 hover:bg-muted/60">
              <Label className="flex cursor-pointer items-center gap-2 py-0.5 font-mono text-[11px] font-normal">
                <Checkbox checked={checked} onCheckedChange={() => toggleTable(t.name)} />
                <span className="truncate">{t.name}</span>
                {preparedTables?.has(t.name) && (
                  <Badge variant="secondary" className="shrink-0 px-1 text-[9px]">
                    prep
                  </Badge>
                )}
              </Label>
              {checked && (
                <p
                  className="ml-6 truncate text-[9px] text-muted-foreground"
                  title={t.cols.join(", ")}
                >
                  {t.cols.slice(0, 8).join(" · ")}
                  {t.cols.length > 8 ? ` · +${t.cols.length - 8} more` : ""}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {selectedTables.length > 1 && (
        <p className="text-[10px] text-muted-foreground">
          A JOIN skeleton was written below — adjust the join keys if needed.
        </p>
      )}
    </div>
  );
}
