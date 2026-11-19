// The builder's preview of the visual being built: the chart itself, the
// real table with its cell styles, or the raw rows while no chart is chosen.
// Moved out of BiBuilderPane in R499 (it owns no state: values in).
import { BiChartRender } from "@/components/bi/BiChartRender";
import { WidgetDataTable } from "@/components/bi/BiDataTable";
import { fmtBiValue } from "@/components/bi/biChartData";
import type { BiColumnFormat, ChartSpec } from "@/lib/biAgent";

export function BiBuildPreview({
  chartSpec,
  chartType,
  preview,
  colFormats,
}: {
  chartSpec: ChartSpec | null;
  chartType: string;
  preview: { columns: string[]; rows: Record<string, unknown>[] };
  colFormats: Record<string, BiColumnFormat>;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-2">
      {chartSpec && chartSpec.type !== "table" ? (
        <BiChartRender chart={chartSpec} rows={preview.rows} />
      ) : chartType === "table" ? (
        // The real table, so cell styles show as they will on the dashboard.
        <div className="h-56">
          <WidgetDataTable
            columns={preview.columns}
            rows={preview.rows}
            columnFormats={colFormats}
            totals={chartSpec?.type === "table" ? chartSpec.totals !== false : true}
          />
        </div>
      ) : (
        <div className="max-h-48 overflow-auto rounded border border-border/50">
          <table className="w-full text-left">
            <thead>
              <tr>
                {preview.columns.map((c) => (
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
              {preview.rows.slice(0, 20).map((row, i) => (
                <tr key={i} className="border-t border-border/40">
                  {preview.columns.map((c) => (
                    <td key={c} className="px-2 py-1 font-mono text-[10px]">
                      {row[c] === null || row[c] === undefined
                        ? "null"
                        : typeof row[c] === "number"
                          ? fmtBiValue(row[c], colFormats[c])
                          : String(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
