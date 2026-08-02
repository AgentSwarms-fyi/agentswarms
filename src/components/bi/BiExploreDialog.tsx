// Drill-through: "Explore underlying data" for a widget. Queries the
// widget's BASE table live (local AlaSQL dataset or the warehouse
// connection the widget is wired to), optionally narrowed by the active
// cross-filter context — so an aggregate bar becomes the raw rows behind
// it. Editor-only: viewers of shared/public dashboards see snapshots.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2, SearchCode, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WidgetDataTable } from "@/components/bi/BiWidgetCard";
import { useAuth } from "@/hooks/use-auth";
import { downloadCsv, downloadXlsx } from "@/lib/exportData";
import { hydrateFromSupabase, isTableRegistered, runQueryUnlimited } from "@/lib/sqlEngine";
import { runWarehouseQuery } from "@/lib/warehouseClient";
import type { BiCrossFilter, BiWidget } from "@/lib/biDashboards";

const EXPLORE_ROW_CAP = 1000;

/** First table referenced by the widget's SQL (handles `t`, "t", schema.t). */
export function extractBaseTable(sql: string | undefined): string | null {
  if (!sql) return null;
  const m = sql.match(/\bfrom\s+[`"[]?([\w.$]+)[`"\]]?/i);
  return m?.[1] ?? null;
}

export function BiExploreDialog({
  widget,
  context,
  onClose,
}: {
  /** Non-null opens the dialog. */
  widget: BiWidget | null;
  /** Active cross-filter — pre-applied when its column exists in the base table. */
  context: BiCrossFilter | null;
  onClose: () => void;
}) {
  const { session } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [applyContext, setApplyContext] = useState(true);

  const table = extractBaseTable(widget?.sql);

  const load = useCallback(async () => {
    if (!widget || !table) return;
    setLoading(true);
    setError(null);
    try {
      if (widget.source?.kind === "warehouse") {
        const token = session?.access_token;
        if (!token) throw new Error("Sign in to query the warehouse.");
        const res = await runWarehouseQuery(
          token,
          widget.source.connection_id,
          `SELECT * FROM ${table} LIMIT ${EXPLORE_ROW_CAP}`,
        );
        setColumns(res.columns);
        setRows(res.rows);
      } else {
        if (!isTableRegistered(table)) await hydrateFromSupabase();
        const res = await runQueryUnlimited(
          `SELECT * FROM "${table}" LIMIT ${EXPLORE_ROW_CAP}`,
          EXPLORE_ROW_CAP,
        );
        setColumns(res.columns);
        setRows(res.rows);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [widget, table, session?.access_token]);

  useEffect(() => {
    if (widget) {
      setApplyContext(true);
      void load();
    } else {
      setColumns([]);
      setRows([]);
      setError(null);
    }
  }, [widget, load]);

  // Context narrowing happens client-side over the fetched base rows, so it
  // works identically for every source and never trips SQL quoting.
  const contextApplies = Boolean(context && columns.includes(context.column));
  const view = useMemo(() => {
    if (!context || !applyContext || !contextApplies) return rows;
    return rows.filter((r) => String(r[context.column]) === context.value);
  }, [rows, context, applyContext, contextApplies]);

  const exportName = `${table ?? "data"}-underlying`;

  return (
    <Dialog open={widget !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SearchCode className="h-4 w-4 text-primary" /> Underlying data
            {table && <code className="text-xs font-normal text-muted-foreground">{table}</code>}
          </DialogTitle>
          <DialogDescription>
            Live rows from the table behind “{widget?.title}” — not the widget's aggregated
            snapshot. Capped at {EXPLORE_ROW_CAP.toLocaleString()} rows.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          {context && contextApplies && (
            <Badge
              variant={applyContext ? "secondary" : "outline"}
              className="cursor-pointer gap-1 text-[11px]"
              onClick={() => setApplyContext((v) => !v)}
              title={applyContext ? "Click to show all rows" : "Click to re-apply"}
            >
              {context.column}: {context.value}
              {applyContext && <X className="h-2.5 w-2.5" />}
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground">
            {loading ? "Loading…" : `${view.length.toLocaleString()} rows`}
          </span>
          <div className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => downloadCsv(columns, view, exportName)}
              disabled={loading || view.length === 0}
            >
              <Download className="h-3 w-3" /> CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() =>
                void downloadXlsx(columns, view, exportName, { sheet: table ?? "data" })
              }
              disabled={loading || view.length === 0}
            >
              <Download className="h-3 w-3" /> Excel
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60">
          {loading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Querying {table}…
            </div>
          ) : error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : view.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No rows.</p>
          ) : (
            <div className="h-[50vh]">
              <WidgetDataTable columns={columns} rows={view} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
