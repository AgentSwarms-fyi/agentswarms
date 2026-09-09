// What the report will look like on paper, at true proportions.
//
// The preview paginates with the SAME function the PDF renderer uses, in the
// same units (points), scaled by one CSS factor — so a break that shows here
// is a break that happens. A preview that flowed differently would be a
// picture of a document nobody receives, which is worse than no preview.
import { BiChartRender } from "@/components/bi/BiChartRender";
import {
  BAND_H,
  TABLE_HEADER_H,
  TABLE_ROW_H,
  blockHeight,
  pageGeometry,
  paginateBlocks,
  substituteTokens,
  tableColumns,
  tableRows,
  type BiReport,
  type PlacedItem,
} from "@/lib/biReports";
import { cn } from "@/lib/utils";

/** Points to CSS pixels at the chosen zoom. */
const px = (pt: number, scale: number) => `${pt * scale}px`;

export function ReportPagePreview({
  report,
  scale = 0.9,
  now = new Date(),
  selectedBlockId,
  onSelectBlock,
}: {
  report: BiReport;
  /** 1 renders a point as a pixel — about 96 dpi on a normal screen. */
  scale?: number;
  now?: Date;
  selectedBlockId?: string | null;
  onSelectBlock?: (id: string) => void;
}) {
  const geo = pageGeometry(report.page);
  const pages = paginateBlocks(report.blocks, geo, (b) => blockHeight(b, geo.contentW));
  const margin = (geo.w - geo.contentW) / 2;
  const date = now.toLocaleDateString();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col items-center gap-6 py-2">
      {pages.map((page, i) => {
        const ctx = {
          page: i + 1,
          pages: pages.length,
          title: report.name,
          date,
          time,
        };
        const band = (b: BiReport["header"]) => (
          <div
            className="flex items-center justify-between text-muted-foreground"
            style={{ fontSize: px(7.5, scale), height: px(BAND_H, scale) }}
          >
            <span>{b.left ? substituteTokens(b.left, ctx) : ""}</span>
            <span>{b.center ? substituteTokens(b.center, ctx) : ""}</span>
            <span>{b.right ? substituteTokens(b.right, ctx) : ""}</span>
          </div>
        );
        return (
          <div
            key={i}
            data-testid="report-page"
            className="relative flex flex-col bg-white text-black shadow-md ring-1 ring-black/10"
            style={{
              width: px(geo.w, scale),
              height: px(geo.h, scale),
              paddingLeft: px(margin, scale),
              paddingRight: px(margin, scale),
              paddingTop: px(margin, scale),
              paddingBottom: px(margin, scale),
            }}
          >
            {band(report.header)}
            <div className="flex-1 overflow-hidden">
              {page.items.map((item, j) => (
                <PreviewItem
                  key={`${item.block.id}-${j}`}
                  item={item}
                  scale={scale}
                  selected={selectedBlockId === item.block.id}
                  onSelect={onSelectBlock}
                />
              ))}
            </div>
            {band(report.footer)}
            <span
              className="pointer-events-none absolute -bottom-5 right-0 text-[10px] text-muted-foreground"
              aria-hidden
            >
              {i + 1} / {pages.length}
            </span>
          </div>
        );
      })}
      {pages.length === 1 && pages[0].items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          An empty page. Add a block, or generate the report with AI.
        </p>
      ) : null}
    </div>
  );
}

function PreviewItem({
  item,
  scale,
  selected,
  onSelect,
}: {
  item: PlacedItem;
  scale: number;
  selected: boolean;
  onSelect?: (id: string) => void;
}) {
  const { block } = item;
  const wrap = (children: React.ReactNode) => (
    <div
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(block.id) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(block.id);
              }
            }
          : undefined
      }
      className={cn(
        "rounded-sm outline-none",
        onSelect && "cursor-pointer hover:ring-1 hover:ring-primary/40",
        selected && "ring-2 ring-primary",
      )}
      style={{ marginBottom: px(6, scale) }}
    >
      {children}
    </div>
  );

  switch (block.kind) {
    case "heading":
      return wrap(
        <div
          className={cn("font-semibold", block.level !== 3 && "border-b border-black/10 pb-1")}
          style={{ fontSize: px(block.level === 1 ? 16 : block.level === 3 ? 10.5 : 12.5, scale) }}
        >
          {block.text}
        </div>,
      );
    case "text":
      return wrap(
        <p className="whitespace-pre-wrap leading-snug" style={{ fontSize: px(9.5, scale) }}>
          {block.text}
        </p>,
      );
    case "spacer":
      return <div style={{ height: px(block.height, scale) }} />;
    case "pagebreak":
      return null;
    case "chart": {
      const h = block.height ?? 200;
      const spec = (block.widget.rows ?? []).length ? block.widget.chart : undefined;
      const drawable = Boolean(spec);
      return wrap(
        <div>
          {block.widget.title ? (
            <div className="font-semibold" style={{ fontSize: px(10.5, scale) }}>
              {block.widget.title}
            </div>
          ) : null}
          {/* The export rasterises THIS node, so the PDF gets the chart the
              designer was looking at rather than a second, redrawn one. */}
          <div data-chart-block={drawable ? block.id : undefined} style={{ height: px(h, scale) }}>
            {spec ? (
              <BiChartRender chart={spec} rows={block.widget.rows ?? []} fill />
            ) : (
              <div
                className="flex h-full items-center justify-center border border-dashed border-black/20 text-muted-foreground"
                style={{ fontSize: px(9, scale) }}
              >
                No data for this chart yet
              </div>
            )}
          </div>
        </div>,
      );
    }
    case "table": {
      const cols = tableColumns(block);
      const rows = tableRows(block);
      const slice = item.slice ?? { from: 0, to: rows.length, continued: false };
      return wrap(
        <div>
          {block.widget.title && !slice.continued ? (
            <div className="font-semibold" style={{ fontSize: px(10.5, scale) }}>
              {block.widget.title}
            </div>
          ) : null}
          <table className="w-full border-collapse" style={{ fontSize: px(8.5, scale) }}>
            <thead>
              {/* Drawn on every slice — the reason a paginated table is not a
                  screenshot of a scrolling one. */}
              <tr style={{ height: px(TABLE_HEADER_H, scale) }}>
                {cols.map((c) => (
                  <th
                    key={c}
                    className="bg-black/[0.04] px-1 text-left font-semibold"
                    style={{ width: `${100 / cols.length}%` }}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(slice.from, slice.to).map((r, i) => (
                <tr
                  key={slice.from + i}
                  style={{ height: px(TABLE_ROW_H, scale) }}
                  className={block.zebra !== false && i % 2 === 1 ? "bg-black/[0.025]" : undefined}
                >
                  {cols.map((c) => (
                    <td key={c} className="truncate px-1">
                      {r[c] === null || r[c] === undefined ? "—" : String(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    }
  }
}
