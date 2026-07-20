// Visual frame for one dashboard widget: header (title + actions) and a
// body that renders the chart snapshot, a data table, or markdown text.
// Used by the BI project editor, the read-only shared view, and the public
// published page.
import { BarChart3, Table2, Type } from "lucide-react";
import { BiChartRender, fmtBiNumber } from "@/components/bi/BiChartRender";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import type { BiWidget } from "@/lib/biDashboards";

function WidgetDataTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
}) {
  return (
    <div className="h-full overflow-auto rounded border border-border/50">
      <table className="w-full text-left">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                className="sticky top-0 bg-muted px-2 py-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border/40">
              {columns.map((c) => (
                <td key={c} className="px-2 py-1 font-mono text-[10px]">
                  {row[c] === null || row[c] === undefined ? (
                    <span className="text-muted-foreground">null</span>
                  ) : typeof row[c] === "number" ? (
                    fmtBiNumber(row[c])
                  ) : (
                    String(row[c])
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BiWidgetCard({
  widget,
  actions,
}: {
  widget: BiWidget;
  /** Extra header controls (edit/remove menu) injected by the editor. */
  actions?: React.ReactNode;
}) {
  const isText = widget.kind === "text";
  const chart = widget.chart ?? { type: "table" as const };
  const rows = widget.rows ?? [];
  const columns = widget.columns ?? [];
  const Icon = isText ? Type : chart.type === "table" ? Table2 : BarChart3;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/50 px-3">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={widget.narrative ? `${widget.title}\n\n${widget.narrative}` : widget.title}
        >
          {widget.title}
        </span>
        {actions}
      </div>
      <div className="min-h-0 flex-1 p-2">
        {isText ? (
          <div className="h-full overflow-y-auto px-1 text-sm">
            <MarkdownMessage content={widget.text ?? ""} />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            No data snapshot — run or refresh this widget to load data.
          </div>
        ) : chart.type === "table" ? (
          <WidgetDataTable columns={columns} rows={rows} />
        ) : (
          <BiChartRender chart={chart} rows={rows} fill />
        )}
      </div>
    </div>
  );
}
