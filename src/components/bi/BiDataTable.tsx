// A widget's data table (moved out of BiWidgetCard in R510): the card draws
// it on screen, and a dashboard sent on a schedule renders it on the server
// and draws it into the PDF, so both show the same formats, rules and totals.
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import { fmtBiValue, toBiNumber } from "@/components/bi/biChartData";
import { COND_ICONS } from "@/components/bi/biCondIcons";
import type { BiColumnFormat } from "@/lib/biAgent";
import { condColorHex, condFill, firstMatchingRule, ruleFill } from "@/lib/biChartMath";
import { isPreAggregated, readsAsRatios } from "@/lib/biColumnKinds";
import { safeImageSrc, safeLinkHref } from "@/lib/safeUrl";
import { cn } from "@/lib/utils";

const TABLE_PAGE = 50;

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
  columnFormats: statedFormats,
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
  // A Percent column reads its scale from its values unless it states one
  // (R512): a margin returned as 0.14 printed "0.14%".
  const columnFormats = useMemo(() => {
    if (!statedFormats) return statedFormats;
    let out: Record<string, BiColumnFormat> | undefined;
    for (const [c, f] of Object.entries(statedFormats)) {
      if (f?.format === "percent" && !f.percentOf && readsAsRatios(rows, [c])) {
        out = { ...(out ?? statedFormats), [c]: { ...f, percentOf: "ratio" } };
      }
    }
    return out ?? statedFormats;
  }, [statedFormats, rows]);
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
