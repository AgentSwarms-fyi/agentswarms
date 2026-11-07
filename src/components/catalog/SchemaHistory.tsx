// How a table's columns have changed, newest first.
//
// A dropped column is the change that breaks the dashboard three teams away,
// and the first question afterwards is "when". This answers it from what the
// crawl recorded. A read that failed is said to have failed: "no changes" is a
// claim about the table, and a failed read cannot make it.
import { useEffect, useState } from "react";
import { History } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { isBreaking, summarizeChanges } from "@/lib/catalogSchemaDiff";
import { listSchemaVersions, type SchemaVersion } from "@/lib/dataCatalog";

export function SchemaHistory({ sourceId, fqn }: { sourceId: string; fqn: string }) {
  const [versions, setVersions] = useState<SchemaVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setVersions(null);
    setError(null);
    listSchemaVersions(sourceId, fqn).then(
      (v) => current && setVersions(v),
      (e: unknown) => current && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      current = false;
    };
  }, [sourceId, fqn]);

  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <History className="h-3 w-3" /> Schema history
      </p>
      {error ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          The history could not be read: {error}
        </p>
      ) : versions === null ? (
        <p className="text-[11px] text-muted-foreground">Reading…</p>
      ) : versions.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No change to these columns has been recorded. A change is recorded when a crawl sees one.
        </p>
      ) : (
        <ol className="space-y-2">
          {versions.map((v) => (
            <li key={v.id} className="rounded-md border border-border p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium">{summarizeChanges(v.changes)}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {isBreaking(v.changes) && (
                    <Badge
                      variant="outline"
                      className="h-4 border-amber-500/50 px-1 text-[9px] text-amber-600 dark:text-amber-400"
                      title="A removed or retyped column can break what reads this table."
                    >
                      Breaking
                    </Badge>
                  )}
                  <time
                    dateTime={v.recorded_at}
                    className="text-[10px] tabular-nums text-muted-foreground"
                  >
                    {new Date(v.recorded_at).toLocaleString()}
                  </time>
                </span>
              </div>
              <ul className="mt-1 space-y-0.5 font-mono text-[10.5px]">
                {v.changes.added.map((c) => (
                  <li key={`+${c.name}`} className="text-emerald-600 dark:text-emerald-400">
                    + {c.name} <span className="text-muted-foreground">{c.type}</span>
                  </li>
                ))}
                {v.changes.removed.map((c) => (
                  <li key={`-${c.name}`} className="text-rose-600 dark:text-rose-400">
                    − {c.name} <span className="text-muted-foreground">{c.type}</span>
                  </li>
                ))}
                {v.changes.retyped.map((c) => (
                  <li key={`~${c.name}`}>
                    ~ {c.name}{" "}
                    <span className="text-muted-foreground">
                      {c.from} → {c.to}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
