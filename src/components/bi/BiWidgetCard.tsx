// Visual frame for one dashboard widget: a quiet header (title + actions
// that appear on hover) and a body that renders the chart snapshot, a data
// table, or markdown text. Used by the BI project editor, the read-only
// shared view, and the public published page.
import { BarChart3, Network, Table2, Type } from "lucide-react";
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
  const numeric = new Set(columns.filter((c) => typeof rows[0]?.[c] === "number"));
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-left">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                className={`sticky top-0 z-10 border-b border-border/60 bg-card px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground ${
                  numeric.has(c) ? "text-right" : ""
                }`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/30 transition-colors hover:bg-muted/40">
              {columns.map((c) => (
                <td
                  key={c}
                  className={`px-2.5 py-1.5 text-xs ${
                    numeric.has(c) ? "text-right tabular-nums" : ""
                  }`}
                >
                  {row[c] === null || row[c] === undefined ? (
                    <span className="text-muted-foreground/60">—</span>
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
  onElementClick,
}: {
  widget: BiWidget;
  /** Extra header controls (edit/remove menu) injected by the editor. */
  actions?: React.ReactNode;
  /** Cross-filtering: bar/slice clicks bubble up as (column, value). */
  onElementClick?: (column: string, value: string) => void;
}) {
  const isText = widget.kind === "text";
  const chart = widget.chart ?? { type: "table" as const };
  const rows = widget.rows ?? [];
  const columns = widget.columns ?? [];
  // Ontology widgets render from the spec inside `chart` — no row snapshot.
  const isOntology = chart.type === "ontology";
  const Icon = isText ? Type : isOntology ? Network : chart.type === "table" ? Table2 : BarChart3;

  return (
    <div className="group/widget flex h-full w-full flex-col overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm transition-shadow hover:shadow-md">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3.5 pt-1">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-semibold"
          title={widget.narrative ? `${widget.title}\n\n${widget.narrative}` : widget.title}
        >
          {widget.title}
        </span>
        <div className="opacity-0 transition-opacity has-[[data-state=open]]:opacity-100 group-focus-within/widget:opacity-100 group-hover/widget:opacity-100">
          {actions}
        </div>
      </div>
      <div className="min-h-0 flex-1 px-2 pb-2">
        {isText ? (
          <div className="h-full overflow-y-auto px-2 text-sm">
            <MarkdownMessage content={widget.text ?? ""} />
          </div>
        ) : isOntology ? (
          <BiChartRender chart={chart} rows={rows} fill />
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            No data snapshot — run or refresh this widget to load data.
          </div>
        ) : chart.type === "table" ? (
          <WidgetDataTable columns={columns} rows={rows} />
        ) : (
          <BiChartRender chart={chart} rows={rows} fill onElementClick={onElementClick} />
        )}
      </div>
    </div>
  );
}
