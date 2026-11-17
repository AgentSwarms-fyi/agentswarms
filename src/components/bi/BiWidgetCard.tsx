// Visual frame for one dashboard widget: a quiet header (title + actions
// that appear on hover) and a body that renders the chart snapshot, a data
// table, or markdown text. Used by the BI project editor, the read-only
// shared view, and the public published page.
import { useContext, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  CheckCircle2,
  Circle,
  Flag,
  Image as ImageIcon,
  Lightbulb,
  Loader2,
  Network,
  SlidersHorizontal,
  Table2,
  Type,
  type LucideIcon,
} from "lucide-react";
import { BiChartRender } from "@/components/bi/BiChartRender";
import { fmtBiValue, toBiNumber } from "@/components/bi/biChartData";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import type { BiColumnFormat, BiCondIcon } from "@/lib/biAgent";
import {
  condColorHex,
  condFill,
  firstMatchingRule,
  ruleFill,
  type DrillEntry,
} from "@/lib/biChartMath";
import { hexColor, widgetAccentColor, type BiImage, type BiWidget } from "@/lib/biDashboards";
import { BiTextBlock } from "@/components/bi/BiTextBlock";
import { BiViewContext } from "@/components/bi/biParamContext";
import { PAGE_LINK_PREFIX, fillTextTokens, type TextTokenState } from "@/lib/biInteract";
import { describeFreshness } from "@/lib/biFreshness";
import { safeImageSrc, safeLinkHref } from "@/lib/safeUrl";
import { isPreAggregated } from "@/lib/biColumnKinds";
import { cn } from "@/lib/utils";

const TABLE_PAGE = 50;

/** Outside a dashboard view (an export, a thumbnail): no picks, nothing clicked. */
const NO_VIEW: TextTokenState = { params: [], values: {}, selected: null };

/** Icons a conditional-format rule can put before a table cell's value (R498). */
const COND_ICONS: Record<BiCondIcon, { label: string; Icon: LucideIcon }> = {
  up: { label: "Arrow up", Icon: ArrowUp },
  down: { label: "Arrow down", Icon: ArrowDown },
  dot: { label: "Dot", Icon: Circle },
  flag: { label: "Flag", Icon: Flag },
  check: { label: "Check", Icon: CheckCircle2 },
  alert: { label: "Warning", Icon: AlertTriangle },
};

type ColumnStats = { min: number; max: number; maxAbs: number };

/**
 * One table cell under its column's format: a picture, a link, a data bar,
 * or the value — tinted and given an icon by the first conditional rule it
 * matches. Pictures and links are only ever drawn from absolute http(s)
 * addresses (and image data URIs); anything else stays text.
 */
function TableCell({
  value,
  format,
  stats,
  numeric,
  onActivate,
}: {
  value: unknown;
  format?: BiColumnFormat;
  stats?: ColumnStats;
  numeric: boolean;
  /** What choosing this cell does (R503): filter by it, or its click action.
   *  The cell's text becomes a button, so a keyboard reaches it too. */
  onActivate?: () => void;
}) {
  if (value === null || value === undefined) {
    return (
      <td className={cn("px-2.5 py-1.5 text-xs", numeric && "text-right")}>
        <span className="text-muted-foreground/60">—</span>
      </td>
    );
  }
  const n = toBiNumber(value);
  const text = `${format?.prefix ?? ""}${
    typeof value === "number" ? fmtBiValue(value, format) : String(value)
  }${format?.suffix ?? ""}`;
  // First matching rule — numeric or text ("is" / "contains") — or a scale.
  const rule = firstMatchingRule(value, format?.cond);
  const fillc = rule
    ? ruleFill(rule)
    : format?.cond?.mode === "scale" && n !== null && stats
      ? condFill(n, format.cond, stats.min, stats.max)
      : null;
  const icon = rule?.icon ? COND_ICONS[rule.icon] : undefined;
  const iconColor = rule ? condColorHex(rule.color) : undefined;

  let body: React.ReactNode = text;
  if (format?.display === "image") {
    const src = safeImageSrc(value);
    if (src) {
      body = (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="inline-block h-8 w-8 rounded object-cover align-middle"
        />
      );
    }
  } else if (format?.display === "link") {
    const href = safeLinkHref(value);
    if (href) {
      body = (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline-offset-2 hover:underline"
        >
          {href.replace(/^(https?:\/\/|mailto:)/i, "").replace(/\/$/, "")}
        </a>
      );
    }
  } else if (format?.display === "bar" && n !== null && stats && stats.maxAbs > 0) {
    const width = Math.min(100, (Math.abs(n) / stats.maxAbs) * 100);
    body = (
      <span className="relative flex items-center justify-end">
        <span
          aria-hidden
          className="absolute inset-y-0.5 left-0 rounded-sm"
          style={{
            width: `${width}%`,
            background:
              n < 0
                ? "color-mix(in oklch, #E15759 30%, transparent)"
                : "color-mix(in oklch, var(--primary) 28%, transparent)",
          }}
        />
        <span className="relative">{text}</span>
      </span>
    );
  }

  return (
    <td
      className={cn(
        "px-2.5 py-1.5 text-xs",
        numeric && "text-right tabular-nums",
        // "390 pts" stays on one line; a narrow column split it after the
        // number (FOUND IN R500's UI test).
        (format?.prefix || format?.suffix) && "whitespace-nowrap",
      )}
      // A whole-row rule tints the <tr>; tinting this cell again would double it.
      style={
        fillc
          ? { background: format?.rowHighlight ? undefined : fillc.bg, color: fillc.fg }
          : undefined
      }
    >
      {(() => {
        const shown = icon ? (
          <span className={cn("inline-flex items-center gap-1", numeric && "justify-end")}>
            <icon.Icon
              className={cn("h-3 w-3 shrink-0", rule?.icon === "dot" && "fill-current")}
              style={iconColor ? { color: iconColor } : undefined}
              aria-label={icon.label}
            />
            {body}
          </span>
        ) : (
          body
        );
        // A link cell already is a control; a button around it would nest two.
        return onActivate && format?.display !== "link" ? (
          <button
            type="button"
            onClick={onActivate}
            className="block w-full cursor-pointer rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {shown}
          </button>
        ) : (
          shown
        );
      })()}
    </td>
  );
}

export function WidgetDataTable({
  columns,
  rows,
  columnFormats,
  totals: showTotals = true,
  striped = false,
  onCellClick,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Per-column display formats configured in the builder. */
  columnFormats?: Record<string, BiColumnFormat>;
  /** false hides the totals row (R499). */
  totals?: boolean;
  /** Shade alternate rows (R500). */
  striped?: boolean;
  /**
   * A click on a text cell, as (column, value) (R503): a table of stations can
   * filter the page, or open a station's own page, like a bar can.
   */
  onCellClick?: (column: string, value: string) => void;
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
      // A rate, an average or a percentage does not add up: 14.1% + 15.2% +
      // 2.8% is not a margin of 32.1%. FOUND IN R498's UI test, under a
      // margin column drawn as data bars. Those columns get no total.
      if (isPreAggregated(c) || columnFormats?.[c]?.format === "percent") continue;
      t.set(
        c,
        rows.reduce((a, r) => a + (toBiNumber(r[c]) ?? 0), 0),
      );
    }
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns.join("|"), columnFormats]);
  // Columns whose matching rule tints the whole row (R498): the first one
  // that matches wins, in column order, so the result does not depend on
  // which cell happened to be drawn last.
  const rowRuleCols = columns.filter(
    (c) => columnFormats?.[c]?.rowHighlight && columnFormats[c]?.cond?.mode === "rules",
  );
  const rowStyle = (row: Record<string, unknown>): React.CSSProperties | undefined => {
    for (const c of rowRuleCols) {
      const r = firstMatchingRule(row[c], columnFormats?.[c]?.cond);
      const f = r ? ruleFill(r) : null;
      if (f) return { background: f.bg };
    }
    return undefined;
  };
  // Over EVERY row, not the page: a colour scale or a data bar that rescaled
  // per page would give the same value two colours.
  const stats = useMemo(() => {
    const s = new Map<string, ColumnStats>();
    for (const c of columns) {
      const f = columnFormats?.[c];
      if (!f?.cond && f?.display !== "bar") continue;
      let min = Infinity;
      let max = -Infinity;
      for (const r of rows) {
        const n = toBiNumber(r[c]);
        if (n === null) continue;
        if (n < min) min = n;
        if (n > max) max = n;
      }
      if (min <= max) s.set(c, { min, max, maxAbs: Math.max(Math.abs(min), Math.abs(max)) });
    }
    return s;
  }, [rows, columns, columnFormats]);

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
                  {columnFormats?.[c]?.label || c}
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
              <tr
                key={i}
                className={cn(
                  "border-b border-border/30 transition-colors hover:bg-muted/40",
                  striped && "even:bg-foreground/[0.06]",
                )}
                style={rowStyle(row)}
              >
                {columns.map((c) => (
                  <TableCell
                    key={c}
                    value={row[c]}
                    format={columnFormats?.[c]}
                    stats={stats.get(c)}
                    numeric={numeric.has(c)}
                    // Text cells name something; a number is a measure.
                    onActivate={
                      onCellClick && !numeric.has(c) && row[c] !== null && row[c] !== undefined
                        ? () => onCellClick(c, String(row[c]))
                        : undefined
                    }
                  />
                ))}
              </tr>
            ))}
          </tbody>
          {showTotals && numeric.size > 0 && rows.length > 1 && (
            <tfoot>
              <tr className="border-t border-border/60 bg-muted/40 font-medium">
                {columns.map((c, i) => (
                  <td
                    key={c}
                    className={`px-2.5 py-1.5 text-xs ${numeric.has(c) ? "text-right tabular-nums" : ""}`}
                  >
                    {numeric.has(c) && totals.has(c)
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
    <a
      href={image.href}
      {...(image.href.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })}
      className="block h-full w-full"
    >
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
  onDrillChange,
  selectedValue,
  busy,
}: {
  widget: BiWidget;
  /** Extra header controls (edit/remove menu) injected by the editor. */
  actions?: React.ReactNode;
  /** Cross-filtering: bar/slice clicks bubble up as (column, value). */
  onElementClick?: (column: string, value: string) => void;
  /** Drill position inside this widget — drill-through queries against it. */
  onDrillChange?: (path: DrillEntry[]) => void;
  /** This widget's active cross-filter value (when it is the filter source) —
   *  forwarded so the map can outline the selected country. */
  selectedValue?: string | null;
  /** A query for what this widget should now show is running (R503): what is
   *  drawn is from before it, so it is dimmed and says so. */
  busy?: boolean;
}) {
  const isText = widget.kind === "text";
  const isImage = widget.kind === "image";
  // R503: {{rider}} and {{selected}} in the title and text say what is picked.
  const view = useContext(BiViewContext);
  const title = fillTextTokens(widget.title, view ?? NO_VIEW);
  const text = isText ? fillTextTokens(widget.text ?? "", view ?? NO_VIEW, { markdown: true }) : "";
  // A #page= link in text or on an image goes to that page of the dashboard.
  // Caught before the anchor acts, so it neither opens a tab nor scrolls.
  const followPageLink = (e: React.MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.("a");
    const href = a?.getAttribute("href");
    if (!href || !href.startsWith(PAGE_LINK_PREFIX)) return;
    e.preventDefault();
    e.stopPropagation();
    view?.openPage(href);
  };
  const chart = widget.chart ?? { type: "table" as const };
  const rows = widget.rows ?? [];
  const columns = widget.columns ?? [];
  // Ontology widgets render from the spec inside `chart` — no row snapshot —
  // and so do Controls (R501), which hold the dashboard's parameters.
  const isOntology = chart.type === "ontology" || chart.type === "controls";
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
        ? chart.type === "controls"
          ? SlidersHorizontal
          : Network
        : chart.type === "table"
          ? Table2
          : chart.type === "insight"
            ? Lightbulb
            : BarChart3;
  // Per-widget appearance: the accent recolours the chart primary via a
  // scoped CSS variable; card styles suit plain, tinted or image-backed
  // dashboards.
  const accent = widgetAccentColor(widget.theme?.accent);
  const cardStyle = widget.theme?.card ?? "default";
  // No title bar (R500): the content takes the whole card and the widget's
  // menu floats over its corner on hover, so it can still be edited.
  const hideTitle = widget.theme?.hideTitle === true;
  const titleColor = hexColor(widget.theme?.titleColor);
  const titleSize = widget.theme?.titleSize ?? "sm";
  const surface = cn(
    "group/widget relative flex h-full w-full flex-col overflow-hidden rounded-xl transition-shadow",
    cardStyle === "none"
      ? "border border-transparent hover:border-border/40"
      : cardStyle === "glass"
        ? "border border-border/40 bg-card/75 shadow-sm backdrop-blur-md hover:shadow-md"
        : cardStyle === "tint"
          ? "border border-border/60 shadow-sm hover:shadow-md"
          : "border border-border/60 bg-card shadow-sm hover:shadow-md",
  );
  const style: React.CSSProperties = {};
  if (accent) style["--primary" as never] = accent as never;
  if (cardStyle === "tint") {
    style.background = `color-mix(in oklch, ${accent || "var(--primary)"} 7%, var(--card))`;
  }

  return (
    <div className={surface} style={style}>
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 px-3.5 pt-1",
          hideTitle
            ? "absolute right-0 top-0 z-10 h-9"
            : titleSize === "xl"
              ? "h-14"
              : titleSize === "lg"
                ? "h-12"
                : "h-10",
        )}
      >
        {!hideTitle && (
          <>
            <Icon
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
              style={accent ? { color: accent } : undefined}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-semibold",
                titleSize === "xl"
                  ? "text-[26px] font-bold tracking-tight"
                  : titleSize === "lg"
                    ? "text-[19px] font-bold tracking-tight"
                    : titleSize === "md"
                      ? "text-[15px]"
                      : "text-[13px]",
              )}
              style={titleColor ? { color: titleColor } : undefined}
              title={widget.narrative ? `${title}\n\n${widget.narrative}` : title}
            >
              {title}
            </span>
          </>
        )}
        {/* A snapshot that filled to the row cap means the chart is drawing a
            SUBSET and presenting it as the whole. Silent wrongness is worse
            than a visible caveat, so say it where the number is read.

            NOT gated on `agg_pushdown` any more. Pushing the aggregation into
            SQL makes each row's value complete; it does not make the row LIST
            complete. A daily series that returns 364 rows under a 50-row cap
            loses 314 points either way — measured: the cumulative line ended
            the year 12x short while claiming to cover it.

            Shown with the title hidden too (R500): a frameless card with no
            title is still a chart whose total can be partial. */}
        {widget.truncated && (
          <span
            className="shrink-0 cursor-help rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400"
            title={
              widget.agg_pushdown
                ? "This widget's result hit the snapshot row cap, so rows beyond the cap are missing " +
                  "from the chart. Narrow the query, or raise PUBLIC_BI_SNAPSHOT_ROWS_CAP."
                : "This widget's data hit the snapshot row cap, so totals are computed from part of the " +
                  "table, not all of it. Edit the widget and turn on “Aggregate in SQL” to make them complete."
            }
          >
            Partial
          </span>
        )}
        {/* When the data was last computed. Every widget already recorded
            this; not showing it meant a viewer — especially on a published
            or embedded dashboard, which always renders a stored snapshot —
            had no way to tell last night's numbers from last quarter's.
            With the title hidden (R500) it shows only once the data is stale. */}
        {busy && (
          <span className="flex shrink-0 items-center gap-1 text-[9px] text-muted-foreground">
            <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" />
            Updating…
          </span>
        )}
        {freshness && (!hideTitle || freshness.stale) && (
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
      <div
        className={cn(
          "min-h-0 flex-1 px-2 pb-2 transition-opacity",
          hideTitle && "pt-2",
          busy && "opacity-40",
        )}
        aria-busy={busy || undefined}
        onClickCapture={isText || isImage ? followPageLink : undefined}
      >
        {isImage ? (
          <ImageWidgetBody image={widget.image} />
        ) : isText ? (
          <div className="h-full overflow-y-auto px-2 text-sm">
            {widget.textStyle ? (
              <BiTextBlock text={text} style={widget.textStyle} />
            ) : (
              <MarkdownMessage content={text} />
            )}
          </div>
        ) : isOntology ? (
          <BiChartRender chart={chart} rows={rows} fill />
        ) : widget.withheld ? (
          // A per-viewer embed could not limit this widget's results to the
          // viewer. It must NOT fall through to "no data snapshot" below:
          // that sends the owner to refresh a widget that refreshed fine, and
          // tells the viewer there is nothing here when there is plenty.
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {widget.withheld}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            No data snapshot — run or refresh this widget to load data.
          </div>
        ) : chart.type === "table" ? (
          <WidgetDataTable
            columns={columns}
            rows={rows}
            columnFormats={chart.columnFormats}
            totals={chart.type === "table" ? chart.totals !== false : true}
            striped={chart.type === "table" && chart.striped === true}
            onCellClick={onElementClick}
          />
        ) : (
          <BiChartRender
            chart={chart}
            rows={rows}
            fill
            onElementClick={onElementClick}
            onDrillChange={onDrillChange}
            selectedValue={selectedValue}
          />
        )}
      </div>
    </div>
  );
}
