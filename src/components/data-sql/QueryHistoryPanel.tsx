// Recent SQL, per user — click to put a statement back in the editor.
//
// Failures are listed alongside successes on purpose: "what was that query
// that errored" is the single most common reason to open a history panel.
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, History, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { describeFreshness } from "@/lib/biFreshness";
import {
  clearQueryHistory,
  deleteQueryHistoryEntry,
  loadQueryHistory,
  previewSql,
  type QueryHistoryEntry,
} from "@/lib/queryHistory";
import { cn } from "@/lib/utils";

export function QueryHistoryPanel({
  userId,
  /** Bumped by the workbench after each run so the list refreshes. */
  nonce,
  onPick,
}: {
  userId: string | undefined;
  nonce: number;
  onPick: (entry: QueryHistoryEntry) => void;
}) {
  const [entries, setEntries] = useState<QueryHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!userId) return;
    try {
      setEntries(await loadQueryHistory(50));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload, nonce]);

  if (!userId) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        <History className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recent queries
        </span>
        <div className="flex-1" />
        {entries.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            onClick={async () => {
              try {
                await clearQueryHistory(userId);
                setEntries([]);
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {loading ? (
        <p className="px-1 text-xs text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          Queries you run appear here, so you can get one back after clearing the editor.
        </p>
      ) : (
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {entries.map((e) => (
            <div
              key={e.id}
              className={cn(
                "group/hist cursor-pointer rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 transition-colors hover:border-primary/50",
                e.error && "border-l-2 border-l-destructive/60",
              )}
              onClick={() => onPick(e)}
              title={e.sql}
            >
              <p className="truncate font-mono text-[11px]">{previewSql(e.sql)}</p>
              <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-muted-foreground">
                {e.error ? (
                  <span className="flex items-center gap-0.5 text-destructive/80">
                    <AlertCircle className="h-2.5 w-2.5" /> failed
                  </span>
                ) : (
                  <span className="tabular-nums">
                    {(e.row_count ?? 0).toLocaleString()} rows
                    {e.duration_ms != null && ` · ${e.duration_ms}ms`}
                  </span>
                )}
                <span>·</span>
                <span className="truncate">{e.connection_name ?? "local"}</span>
                <div className="flex-1" />
                <span className="shrink-0">{describeFreshness(e.created_at)?.relative}</span>
                <button
                  type="button"
                  className="shrink-0 opacity-0 transition-opacity hover:text-destructive group-hover/hist:opacity-100"
                  title="Remove from history"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void deleteQueryHistoryEntry(e.id)
                      .then(() => setEntries((prev) => prev.filter((x) => x.id !== e.id)))
                      .catch((err: Error) => toast.error(err.message));
                  }}
                >
                  <Trash2 className="h-2.5 w-2.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
