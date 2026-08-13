// Drill-through: "Explore underlying data" for a widget.
//
// Every narrowing the reader can see — the widget's own filters, the drill
// level they clicked into, the dashboard cross-filter — is pushed into the
// QUERY, and the row cap is applied after it. That ordering is the whole
// feature: capping first and filtering the result in the browser (what this
// did before) answers a different question and prints the answer as a fact.
// See src/lib/biDrillThrough.ts for the query building and why it refuses.
//
// Editor-only: viewers of shared/public dashboards see snapshots, so the
// row-level-security filters that apply to them never reach this path.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2, SearchCode } from "lucide-react";

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
import {
  buildDrillThroughSql,
  DRILL_THROUGH_ROW_CAP,
  explorePredicates,
  numericColumnsFrom,
  readCount,
  unresolvablePredicates,
} from "@/lib/biDrillThrough";
import type { DrillEntry } from "@/lib/biChartMath";
import type { BiCrossFilter, BiWidget } from "@/lib/biDashboards";

/** First table referenced by the widget's SQL (handles `t`, "t", schema.t). */
export function extractBaseTable(sql: string | undefined): string | null {
  if (!sql) return null;
  const m = sql.match(/\bfrom\s+[`"[]?([\w.$]+)[`"\]]?/i);
  return m?.[1] ?? null;
}

export function BiExploreDialog({
  widget,
  context,
  drillPath,
  onClose,
}: {
  /** Non-null opens the dialog. */
  widget: BiWidget | null;
  /** Active dashboard cross-filter. */
  context: BiCrossFilter;
  /** Where this widget's chart is drilled to right now. */
  drillPath?: DrillEntry[];
  onClose: () => void;
}) {
  const { session } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [mode, setMode] = useState<"raw" | "aggregated">("raw");
  const [narrow, setNarrow] = useState(true);

  const table = extractBaseTable(widget?.sql);
  const predicates = useMemo(
    () => explorePredicates(drillPath ?? [], context),
    [drillPath, context],
  );
  const activePredicates = useMemo(() => (narrow ? predicates : []), [narrow, predicates]);

  /** One query, whichever engine the widget is wired to. */
  const run = useCallback(
    async (sql: string, cap: number) => {
      if (widget?.source?.kind === "warehouse") {
        const token = session?.access_token;
        if (!token) throw new Error("Sign in to query the warehouse.");
        return await runWarehouseQuery(token, widget.source.connection_id, sql);
      }
      if (table && !isTableRegistered(table)) await hydrateFromSupabase();
      return await runQueryUnlimited(sql, cap);
    },
    [widget, table, session?.access_token],
  );

  const load = useCallback(async () => {
    if (!widget?.sql) return;
    setLoading(true);
    setError(null);
    setTotal(null);
    setTruncated(false);
    const plan = buildDrillThroughSql({
      widgetSql: widget.sql,
      predicates: activePredicates,
      numericColumns: numericColumnsFrom(widget.rows ?? []),
      // One over the cap: if it comes back, there is more behind it.
      cap: DRILL_THROUGH_ROW_CAP + 1,
    });
    if (!plan) {
      setError("This widget has no query to trace back to rows.");
      setLoading(false);
      return;
    }
    setMode(plan.mode);
    try {
      const res = await run(plan.rows, DRILL_THROUGH_ROW_CAP + 1);
      const over = res.rows.length > DRILL_THROUGH_ROW_CAP;
      setColumns(res.columns);
      setRows(over ? res.rows.slice(0, DRILL_THROUGH_ROW_CAP) : res.rows);
      setTruncated(over);
      if (over) {
        // Only now is a COUNT worth its round trip — and only now is the
        // number in the header not simply the row count on screen.
        try {
          const c = await run(plan.count, 1);
          setTotal(readCount(c.rows));
        } catch {
          setTotal(null); // "more than the cap" is still true and still honest.
        }
      } else {
        setTotal(res.rows.length);
      }
    } catch (e) {
      // The likeliest cause is a predicate naming a column that exists only in
      // the widget's SELECT list (`DATE_TRUNC(...) AS month`). Find out for
      // certain rather than blaming the engine's message.
      const engineError = (e as Error).message;
      let explained: string | null = null;
      if (activePredicates.length > 0) {
        try {
          const probe = await run(
            buildDrillThroughSql({ widgetSql: widget.sql, predicates: [], cap: 1 })!.rows,
            1,
          );
          const missing = unresolvablePredicates(activePredicates, probe.columns);
          if (missing.length > 0) {
            explained =
              `Cannot trace this back to rows: ${missing.map((m) => m.column).join(", ")} ` +
              `${missing.length === 1 ? "is" : "are"} computed by the widget's query, so the ` +
              `rows underneath have no such column. Turn off narrowing to see the ` +
              `widget's rows unfiltered.`;
          }
        } catch {
          /* Probe failed too — report the original error. */
        }
      }
      setError(explained ?? engineError);
      setRows([]);
      setColumns([]);
    } finally {
      setLoading(false);
    }
  }, [widget, activePredicates, run]);

  useEffect(() => {
    if (widget) {
      void load();
    } else {
      setColumns([]);
      setRows([]);
      setError(null);
      setTotal(null);
      setTruncated(false);
      setNarrow(true);
    }
    // `load` already closes over everything that should re-query.
  }, [widget, load]);

  const exportName = `${table ?? "data"}-underlying`;
  const countLabel = loading
    ? "Loading…"
    : truncated
      ? `Showing ${rows.length.toLocaleString()} of ${
          total === null ? "more than that" : total.toLocaleString()
        } matching rows`
      : `${rows.length.toLocaleString()} matching rows`;

  return (
    <Dialog open={widget !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SearchCode className="h-4 w-4 text-primary" /> Underlying data
            {table && <code className="text-xs font-normal text-muted-foreground">{table}</code>}
          </DialogTitle>
          <DialogDescription>
            {mode === "raw"
              ? `Live rows beneath “${widget?.title}”, with the widget's own filters applied.`
              : `Live rows from “${widget?.title}” — its query combines results, so these are the ` +
                `widget's own rows rather than the rows underneath them.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          {predicates.length > 0 && (
            <Badge
              variant={narrow ? "secondary" : "outline"}
              className="cursor-pointer gap-1 text-[11px]"
              onClick={() => setNarrow((v) => !v)}
              title={narrow ? "Click to drop the narrowing" : "Click to narrow again"}
            >
              {narrow ? "" : "Not narrowed · "}
              {predicates.map((p) => `${p.column}: ${p.value}`).join(" · ")}
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground">{countLabel}</span>
          <div className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => downloadCsv(columns, rows, exportName)}
              disabled={loading || rows.length === 0}
              title={
                truncated ? `Exports the ${rows.length.toLocaleString()} rows shown` : undefined
              }
            >
              <Download className="h-3 w-3" /> CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() =>
                void downloadXlsx(columns, rows, exportName, { sheet: table ?? "data" })
              }
              disabled={loading || rows.length === 0}
              title={
                truncated ? `Exports the ${rows.length.toLocaleString()} rows shown` : undefined
              }
            >
              <Download className="h-3 w-3" /> Excel
            </Button>
          </div>
        </div>

        {truncated && (
          <p className="text-[11px] text-muted-foreground">
            Capped at {DRILL_THROUGH_ROW_CAP.toLocaleString()} rows — these are the first that came
            back, in no particular order, not a ranked sample.
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60">
          {loading ? (
            <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Querying {table}…
            </div>
          ) : error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No rows.</p>
          ) : (
            <div className="h-[50vh]">
              <WidgetDataTable columns={columns} rows={rows} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
