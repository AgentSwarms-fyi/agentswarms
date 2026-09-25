// A workbook's thumbnail: the corner of its first grid sheet drawn small, as
// a sheet reads (column letters, row numbers, gridlines, the values, bold
// and fills), with a badge for the charts on it. Drawn from the stored
// preview, so the Sheets page never loads a sheet to show one.

import { AreaChart, BarChart3, LineChart, PieChart, Radar, ScatterChart } from "lucide-react";
import { colLetters } from "@/lib/sheets/a1";
import type { ChartType } from "@/lib/sheets/charts";
import { inkOn } from "@/lib/sheets/ink";
import type { WorkbookPreview } from "@/lib/sheets/preview";
import { cn } from "@/lib/utils";

const CHART_ICON: Record<ChartType, typeof BarChart3> = {
  column: BarChart3,
  bar: BarChart3,
  combo: BarChart3,
  line: LineChart,
  area: AreaChart,
  pie: PieChart,
  doughnut: PieChart,
  scatter: ScatterChart,
  radar: Radar,
};

const EMPTY_WIDTHS = [0.22, 0.2, 0.2, 0.2, 0.18];

export function WorkbookThumb({
  preview,
  chartCount,
  compact = false,
  className,
}: {
  preview: WorkbookPreview | null;
  /** Charts in the whole workbook, when known; else the preview's. */
  chartCount?: number;
  /** The small list-row version: no headers, fewer rows. */
  compact?: boolean;
  className?: string;
}) {
  const rows = preview?.rows ?? [];
  const widths = preview?.widths.length ? preview.widths : EMPTY_WIDTHS;
  const shownRows = compact ? 4 : 7;
  const template = `${compact ? "" : "14px "}${widths.map((w) => `${Math.max(w, 0.05)}fr`).join(" ")}`;
  const charts = preview?.charts ?? [];
  const nCharts = chartCount ?? preview?.chartCount ?? charts.length;
  const Icon = charts[0] ? CHART_ICON[charts[0]] : BarChart3;
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-[var(--thumb-paper)] text-[var(--thumb-ink)] [--thumb-grid:color-mix(in_oklab,var(--border)_85%,transparent)] [--thumb-head:color-mix(in_oklab,var(--muted)_80%,transparent)] [--thumb-ink:var(--foreground)] [--thumb-paper:var(--card)]",
        className,
      )}
      aria-hidden
    >
      <div
        className="grid font-sans tabular-nums"
        style={{
          gridTemplateColumns: template,
          fontSize: compact ? 6 : 8.5,
          lineHeight: compact ? "9px" : "15px",
        }}
      >
        {!compact && (
          <>
            <div className="border-b border-r border-[var(--thumb-grid)] bg-[var(--thumb-head)]" />
            {widths.map((_, c) => (
              <div
                key={`h${c}`}
                className="truncate border-b border-r border-[var(--thumb-grid)] bg-[var(--thumb-head)] text-center text-[7px] leading-[11px] text-muted-foreground"
              >
                {colLetters(c)}
              </div>
            ))}
          </>
        )}
        {Array.from({ length: shownRows }, (_, r) => (
          <Row key={r} r={r} cells={rows[r] ?? []} cols={widths.length} compact={compact} />
        ))}
      </div>
      {/* A soft fade where the sheet runs on past the thumbnail. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--thumb-paper)] to-transparent" />
      {nCharts > 0 && !compact && (
        <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full border border-border bg-background/90 px-2 py-0.5 text-[10px] font-medium text-foreground shadow-sm backdrop-blur">
          <Icon className="h-3 w-3 text-primary" />
          {nCharts} chart{nCharts === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

function Row({
  r,
  cells,
  cols,
  compact,
}: {
  r: number;
  cells: (WorkbookPreview["rows"][number][number] | undefined)[];
  cols: number;
  compact: boolean;
}) {
  return (
    <>
      {!compact && (
        <div className="border-b border-r border-[var(--thumb-grid)] bg-[var(--thumb-head)] text-center text-[7px] text-muted-foreground">
          {r + 1}
        </div>
      )}
      {Array.from({ length: cols }, (_, c) => {
        const cell = cells[c];
        return (
          <div
            key={c}
            className={cn(
              "truncate border-b border-r border-[var(--thumb-grid)] px-[3px]",
              cell?.a === "r" && "text-right",
              cell?.a === "c" && "text-center",
              cell?.b && "font-semibold",
            )}
            style={{
              backgroundColor: cell?.bg,
              color: cell?.fg ?? inkOn(cell?.bg),
            }}
          >
            {compact ? (
              // Too small to read: the text as a bar of its length, as the shape of the sheet.
              cell?.t ? (
                <span
                  className={cn(
                    "mt-[3px] inline-block h-[3px] rounded-full bg-current opacity-45",
                    cell.a === "r" && "float-right",
                  )}
                  style={{ width: `${Math.min(100, 18 + cell.t.length * 9)}%` }}
                />
              ) : null
            ) : (
              (cell?.t ?? "")
            )}
          </div>
        );
      })}
    </>
  );
}
