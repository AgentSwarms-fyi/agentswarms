// What changed between two versions, as a reviewer reads it: grouped by kind,
// breaking changes first and marked, each with what still refers to it.
import { AlertTriangle, Minus, Pencil, Plus } from "lucide-react";
import type { Change, SpecDiff } from "@/lib/ontology/diff";
import { cn } from "@/lib/utils";

const ELEMENT_LABEL: Record<Change["element"], string> = {
  model: "Model",
  objectType: "Object types",
  property: "Properties",
  metric: "Metrics",
  linkType: "Links",
  valueType: "Value types",
  interface: "Interfaces",
  rule: "Rules",
  actionType: "Actions",
};

export function ChangeList({ diff, compact = false }: { diff: SpecDiff; compact?: boolean }) {
  if (!diff.changes.length) {
    return <p className="text-sm text-muted-foreground">No differences.</p>;
  }
  const groups = new Map<Change["element"], Change[]>();
  for (const c of [...diff.changes].sort((a, b) => Number(b.breaking) - Number(a.breaking))) {
    groups.set(c.element, [...(groups.get(c.element) ?? []), c]);
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-md bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">
          +{diff.added} added
        </span>
        <span className="rounded-md bg-rose-500/10 px-2 py-1 text-rose-700 dark:text-rose-300">
          −{diff.removed} removed
        </span>
        <span className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-800 dark:text-amber-300">
          ~{diff.changed} changed
        </span>
        {diff.breaking > 0 && (
          <span className="flex items-center gap-1 rounded-md border border-rose-500/40 px-2 py-1 font-medium text-rose-700 dark:text-rose-300">
            <AlertTriangle className="h-3.5 w-3.5" /> {diff.breaking} breaking
          </span>
        )}
      </div>
      <div className={cn("space-y-3 overflow-y-auto pr-1", compact ? "max-h-64" : "max-h-[60vh]")}>
        {[...groups].map(([element, items]) => (
          <section key={element}>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {ELEMENT_LABEL[element]}
            </h4>
            <ul className="space-y-1">
              {items.map((c) => (
                <li
                  key={`${c.kind}-${c.path}`}
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 text-xs",
                    c.breaking ? "border-rose-500/40 bg-rose-500/5" : "border-border",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {c.kind === "added" ? (
                      <Plus className="h-3.5 w-3.5 text-emerald-600" />
                    ) : c.kind === "removed" ? (
                      <Minus className="h-3.5 w-3.5 text-rose-600" />
                    ) : (
                      <Pencil className="h-3.5 w-3.5 text-amber-600" />
                    )}
                    <span className="font-mono">{c.path}</span>
                    {c.breaking && (
                      <span className="ml-auto rounded bg-rose-500/15 px-1.5 text-[10px] font-semibold uppercase text-rose-700 dark:text-rose-300">
                        breaking
                      </span>
                    )}
                  </div>
                  {c.details.length > 0 && (
                    <ul className="mt-1 space-y-0.5 pl-5 text-muted-foreground">
                      {c.details.slice(0, 6).map((d) => (
                        <li key={d} className="break-words font-mono text-[11px]">
                          {d}
                        </li>
                      ))}
                    </ul>
                  )}
                  {c.usedBy.length > 0 && (
                    <p className="mt-1 pl-5 text-[11px] text-rose-700 dark:text-rose-300">
                      Still used by: {c.usedBy.join(", ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
