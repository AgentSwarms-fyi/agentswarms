// Visual frame for one dashboard widget: a quiet header (title + actions
// that appear on hover) and a body that renders the chart snapshot, a data
// table, or markdown text. Used by the BI project editor, the read-only
// shared view, and the public published page.
import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Image as ImageIcon,
  Network,
  Table2,
  Type,
} from "lucide-react";
import { BiChartRender, fmtBiValue, toBiNumber } from "@/components/bi/BiChartRender";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import type { BiColumnFormat } from "@/lib/biAgent";
import { WIDGET_ACCENTS, type BiImage, type BiWidget } from "@/lib/biDashboards";
import { describeFreshness } from "@/lib/biFreshness";
import { cn } from "@/lib/utils";

const TABLE_PAGE = 50;

export function WidgetDataTable({
  columns,
  rows,
  columnFormats,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Per-column display formats configured in the builder. */
  columnFormats?: Record<string, BiColumnFormat>;
}) {
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(0);
  const numeric = new Set(
    columns.filter((c) => toBiNumber(rows.find((r) => r[c] != null)?.[c]) !== null),
  );

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { col, dir } = sort;
    return [...rows].sort((a, b) => {
      const na = toBiNumber(a[col]);
      const nb = toBiNumber(b[col]);
      if (na !== null && nb !== null) return (na - nb) * dir;
      return String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * dir;
    });
  }, [rows, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / TABLE_PAGE));
  const safePage = Math.min(page, pages - 1);
  const view = sorted.slice(safePage * TABLE_PAGE, (safePage + 1) * TABLE_PAGE);
  const totals = useMemo(() => {
    const t = new Map<string, number>();
    for (const c of numeric) {
      t.set(
        c,
        rows.reduce((a, r) => a + (toBiNumber(r[c]) ?? 0), 0),
      );
    }
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns.join("|")]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c}
                  className={`sticky top-0 z-10 cursor-pointer select-none border-b border-border/60 bg-card px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground ${
                    numeric.has(c) ? "text-right" : ""
                  }`}
                  title="Click to sort"
                  onClick={() =>
                    setSort((s) =>
                      s?.col === c
                        ? s.dir === 1
                          ? { col: c, dir: -1 }
                          : null
                        : { col: c, dir: 1 },
                    )
                  }
                >
                  {c}
                  {sort?.col === c &&
                    (sort.dir === 1 ? (
                      <ArrowUp className="ml-0.5 inline h-2.5 w-2.5" />
                    ) : (
                      <ArrowDown className="ml-0.5 inline h-2.5 w-2.5" />
                    ))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((row, i) => (
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
                      fmtBiValue(row[c], columnFormats?.[c])
                    ) : (
                      String(row[c])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {numeric.size > 0 && rows.length > 1 && (
            <tfoot>
              <tr className="border-t border-border/60 bg-muted/40 font-medium">
                {columns.map((c, i) => (
                  <td
                    key={c}
                    className={`px-2.5 py-1.5 text-xs ${numeric.has(c) ? "text-right tabular-nums" : ""}`}
                  >
                    {numeric.has(c)
                      ? fmtBiValue(totals.get(c), columnFormats?.[c])
                      : i === 0
                        ? "Total"
                        : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {pages > 1 && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/40 px-2 py-1 text-[10px] text-muted-foreground">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
          >
            ‹ Prev
          </button>
          <span className="tabular-nums">
            {safePage + 1} / {pages} · {sorted.length} rows
          </span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
            disabled={safePage >= pages - 1}
            onClick={() => setPage(safePage + 1)}
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}

/** Image widget body — data-URI (uploaded) or external URL, with a fallback. */
function ImageWidgetBody({ image }: { image?: BiImage }) {
  const [broken, setBroken] = useState(false);
  const src = image?.src ?? "";
  if (!src || broken) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/60 text-center text-xs text-muted-foreground">
        <ImageIcon className="h-5 w-5 opacity-60" />
        {src ? "Image failed to load — check the URL." : "No image set."}
      </div>
    );
  }
  const img = (
    <img
      src={src}
      alt={image?.alt ?? ""}
      onError={() => setBroken(true)}
      className="h-full w-full rounded-lg"
      style={{ objectFit: image?.fit ?? "contain" }}
    />
  );
  return image?.href ? (
    <a href={image.href} target="_blank" rel="noopener noreferrer" className="block h-full w-full">
      {img}
    </a>
  ) : (
    img
  );
}

export function BiWidgetCard({
  widget,
  actions,
  onElementClick,
  selectedValue,
}: {
  widget: BiWidget;
  /** Extra header controls (edit/remove menu) injected by the editor. */
  actions?: React.ReactNode;
  /** Cross-filtering: bar/slice clicks bubble up as (column, value). */
  onElementClick?: (column: string, value: string) => void;
  /** This widget's active cross-filter value (when it is the filter source) —
   *  forwarded so the map can outline the selected country. */
  selectedValue?: string | null;
}) {
  const isText = widget.kind === "text";
  const isImage = widget.kind === "image";
  const chart = widget.chart ?? { type: "table" as const };
  const rows = widget.rows ?? [];
  const columns = widget.columns ?? [];
  // Ontology widgets render from the spec inside `chart` — no row snapshot.
  const isOntology = chart.type === "ontology";
  // Text and image tiles have no queried data, so an age would be meaningless.
  const freshness = useMemo(
    () => (isText || isImage ? null : describeFreshness(widget.refreshed_at)),
    [isText, isImage, widget.refreshed_at],
  );
  const Icon = isImage
    ? ImageIcon
    : isText
      ? Type
      : isOntology
        ? Network
        : chart.type === "table"
          ? Table2
          : BarChart3;
  // Per-widget appearance: the accent recolours the chart primary via a
  // scoped CSS variable; card styles suit plain, tinted or image-backed
  // dashboards.
  const accent = widget.theme?.accent ? WIDGET_ACCENTS[widget.theme.accent]?.color : "";
  const cardStyle = widget.theme?.card ?? "default";
  const surface = cn(
    "group/widget flex h-full w-full flex-col overflow-hidden rounded-xl border shadow-sm transition-shadow hover:shadow-md",
    cardStyle === "glass"
      ? "border-border/40 bg-card/75 backdrop-blur-md"
      : cardStyle === "tint"
        ? "border-border/60"
        : "border-border/60 bg-card",
  );
  const style: React.CSSProperties = {};
  if (accent) style["--primary" as never] = accent as never;
  if (cardStyle === "tint") {
    style.background = `color-mix(in oklch, ${accent || "var(--primary)"} 7%, var(--card))`;
  }

  return (
    <div className={surface} style={style}>
      <div className="flex h-10 shrink-0 items-center gap-2 px-3.5 pt-1">
        <Icon
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
          style={accent ? { color: accent } : undefined}
        />
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-semibold"
          title={widget.narrative ? `${widget.title}\n\n${widget.narrative}` : widget.title}
        >
          {widget.title}
        </span>
        {/* A snapshot that filled to the row cap means the chart is summing a
            SUBSET and showing it as the total. Silent wrongness is worse than a
            visible caveat, so say it where the number is read. */}
        {widget.truncated && !widget.agg_pushdown && (
          <span
            className="shrink-0 cursor-help rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400"
            title={
              "This widget's data hit the snapshot row cap, so totals are computed from part of the " +
              "table, not all of it. Edit the widget and turn on “Aggregate in SQL” to make them complete."
            }
          >
            Partial
          </span>
        )}
        {/* When the data was last computed. Every widget already recorded
            this; not showing it meant a viewer — especially on a published
            or embedded dashboard, which always renders a stored snapshot —
            had no way to tell last night's numbers from last quarter's. */}
        {freshness && (
          <span
            className={cn(
              "shrink-0 cursor-help text-[9px] tabular-nums",
              freshness.stale
                ? "font-semibold text-amber-600 dark:text-amber-400"
                : "text-muted-foreground/70",
            )}
            title={`Data last refreshed ${freshness.absolute}`}
          >
            {freshness.relative}
          </span>
        )}
        <div className="opacity-0 transition-opacity has-[[data-state=open]]:opacity-100 group-focus-within/widget:opacity-100 group-hover/widget:opacity-100">
          {actions}
        </div>
      </div>
      <div className="min-h-0 flex-1 px-2 pb-2">
        {isImage ? (
          <ImageWidgetBody image={widget.image} />
        ) : isText ? (
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
          <WidgetDataTable columns={columns} rows={rows} columnFormats={chart.columnFormats} />
        ) : (
          <BiChartRender
            chart={chart}
            rows={rows}
            fill
            onElementClick={onElementClick}
            selectedValue={selectedValue}
          />
        )}
      </div>
    </div>
  );
}
