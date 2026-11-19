// Visual frame for one dashboard widget: a quiet header (title + actions
// that appear on hover) and a body that renders the chart snapshot, a data
// table, or markdown text. Used by the BI project editor, the read-only
// shared view, and the public published page.
import { useContext, useMemo, useState } from "react";
import {
  BarChart3,
  Image as ImageIcon,
  Lightbulb,
  Loader2,
  Network,
  SlidersHorizontal,
  Table2,
  Type,
} from "lucide-react";
import { BiChartRender } from "@/components/bi/BiChartRender";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import type { DrillEntry } from "@/lib/biChartMath";
import { hexColor, widgetAccentColor, type BiImage, type BiWidget } from "@/lib/biDashboards";
import { BiTextBlock } from "@/components/bi/BiTextBlock";
import { BiViewContext } from "@/components/bi/biParamContext";
import { PAGE_LINK_PREFIX, fillTextTokens, type TextTokenState } from "@/lib/biInteract";
import { describeFreshness } from "@/lib/biFreshness";
import { WidgetDataTable } from "@/components/bi/BiDataTable";
import { cn } from "@/lib/utils";

/** Outside a dashboard view (an export, a thumbnail): no picks, nothing clicked. */
const NO_VIEW: TextTokenState = { params: [], values: {}, selected: null };

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
