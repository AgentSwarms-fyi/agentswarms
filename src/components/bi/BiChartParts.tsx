// Hand-rendered BI visuals that recharts has no primitive for: gauge,
// heatmap, box-and-whisker plot, and the matrix (pivot) table. All pure
// SVG/HTML on design tokens, so they follow light/dark themes.
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fmtBiNumber, fmtBiValue, type BiFormatOptions } from "@/components/bi/BiChartRender";
import { condFill } from "@/lib/biChartMath";
import type { BiCondFormat, BiNumberFormat } from "@/lib/biAgent";

// ── Gauge ───────────────────────────────────────────────────────────────

export function GaugeChart({
  value,
  target,
  max,
  label,
  format,
}: {
  value: number;
  target?: number;
  max?: number;
  label?: string;
  format?: BiNumberFormat | BiFormatOptions;
}) {
  const resolvedMax = Math.max(
    max ?? (target !== undefined ? target * 1.25 : value * 1.33),
    value,
    target ?? 0,
    1e-9,
  );
  const frac = Math.min(Math.max(value / resolvedMax, 0), 1);
  const R = 80;
  const CX = 100;
  const CY = 105;
  const arcLen = Math.PI * R;
  const arcPath = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;

  const tickAt = (t: number) => {
    const a = Math.PI * (1 - Math.min(Math.max(t, 0), 1));
    return {
      x1: CX + Math.cos(a) * (R - 12),
      y1: CY - Math.sin(a) * (R - 12),
      x2: CX + Math.cos(a) * (R + 12),
      y2: CY - Math.sin(a) * (R + 12),
    };
  };
  const targetTick = target !== undefined ? tickAt(target / resolvedMax) : null;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      <svg viewBox="0 0 200 120" className="max-h-full w-full max-w-72" role="img">
        <path
          d={arcPath}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={15}
          strokeLinecap="round"
        />
        <path
          d={arcPath}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={15}
          strokeLinecap="round"
          strokeDasharray={`${frac * arcLen} ${arcLen}`}
        />
        {targetTick && (
          <line {...targetTick} stroke="#F28E2B" strokeWidth={2.5} strokeLinecap="round" />
        )}
        <text
          x={CX}
          y={CY - 14}
          textAnchor="middle"
          className="fill-foreground"
          fontSize={26}
          fontWeight={600}
        >
          {fmtBiValue(value, format)}
        </text>
        <text x={CX} y={CY + 2} textAnchor="middle" className="fill-muted-foreground" fontSize={9}>
          {target !== undefined
            ? `target ${fmtBiValue(target, format)} · ${Math.round((value / target) * 100)}%`
            : `of ${fmtBiValue(resolvedMax, format)}`}
        </text>
      </svg>
      {label && (
        <p className="mt-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
          {label}
        </p>
      )}
    </div>
  );
}

// ── Heatmap ─────────────────────────────────────────────────────────────

export function HeatmapGrid({
  rows,
  xField,
  yField,
  valueField,
  onElementClick,
}: {
  rows: Record<string, unknown>[];
  xField: string;
  yField: string;
  valueField: string;
  /** Cross-filtering: column headers filter by xField, rows/cells by yField. */
  onElementClick?: (column: string, value: string) => void;
}) {
  const { xs, ys, cell, min, max } = useMemo(() => {
    const xs: string[] = [];
    const ys: string[] = [];
    const cell = new Map<string, number>();
    for (const row of rows) {
      const x = String(row[xField] ?? "—");
      const y = String(row[yField] ?? "—");
      const v = Number(row[valueField]);
      if (!Number.isFinite(v)) continue;
      if (!xs.includes(x)) xs.push(x);
      if (!ys.includes(y)) ys.push(y);
      const k = `${y}\u0000${x}`;
      cell.set(k, (cell.get(k) ?? 0) + v);
    }
    const all = [...cell.values()];
    return {
      xs: xs.slice(0, 40),
      ys: ys.slice(0, 60),
      cell,
      min: Math.min(...all, 0),
      max: Math.max(...all, 1e-9),
    };
  }, [rows, xField, yField, valueField]);

  if (xs.length === 0 || ys.length === 0) {
    return (
      <p className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No numeric values to plot.
      </p>
    );
  }

  return (
    <div className="h-full w-full overflow-auto">
      {/* w-full/h-full let the table fill the widget; the fixed cell sizes
          below act as minimums (HTML cell width/height are floors), so
          columns/rows stretch to fill and only scroll when they overflow. */}
      <table className="h-full w-full border-separate" style={{ borderSpacing: 2 }}>
        <thead>
          <tr>
            <th className="w-0" />
            {xs.map((x) => (
              <th
                key={x}
                className={`max-w-20 truncate px-1 pb-0.5 text-[9px] font-medium text-muted-foreground ${
                  onElementClick ? "cursor-pointer hover:text-foreground" : ""
                }`}
                title={x}
                onClick={onElementClick ? () => onElementClick(xField, x) : undefined}
              >
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ys.map((y) => (
            <tr key={y}>
              <th
                className={`w-0 max-w-28 truncate whitespace-nowrap pr-1.5 text-right text-[9px] font-medium text-muted-foreground ${
                  onElementClick ? "cursor-pointer hover:text-foreground" : ""
                }`}
                title={y}
                onClick={onElementClick ? () => onElementClick(yField, y) : undefined}
              >
                {y}
              </th>
              {xs.map((x) => {
                const v = cell.get(`${y}\u0000${x}`);
                const t = v === undefined ? 0 : (v - min) / (max - min || 1);
                return (
                  <td
                    key={x}
                    title={v === undefined ? `${y} · ${x}: —` : `${y} · ${x}: ${fmtBiNumber(v)}`}
                    onClick={onElementClick ? () => onElementClick(yField, y) : undefined}
                    className={`h-7 min-w-11 rounded-sm text-center text-[10px] tabular-nums ${
                      t > 0.55 ? "text-primary-foreground" : "text-foreground/80"
                    } ${onElementClick ? "cursor-pointer" : ""}`}
                    style={{
                      backgroundColor:
                        v === undefined
                          ? "var(--muted)"
                          : `color-mix(in oklab, var(--primary) ${Math.round(8 + t * 92)}%, var(--muted))`,
                    }}
                  >
                    {v === undefined ? "" : fmtBiNumber(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Box & whisker ───────────────────────────────────────────────────────

type BoxStats = {
  name: string;
  min: number;
  q1: number;
  med: number;
  q3: number;
  max: number;
};

export function computeBoxStats(
  rows: Record<string, unknown>[],
  xField: string,
  yField: string,
  maxGroups = 12,
): BoxStats[] {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const v = Number(row[yField]);
    if (!Number.isFinite(v)) continue;
    const k = String(row[xField] ?? "—");
    if (!groups.has(k)) {
      if (groups.size >= maxGroups) continue;
      groups.set(k, []);
    }
    groups.get(k)!.push(v);
  }
  const quantile = (sorted: number[], p: number) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  return [...groups.entries()]
    .filter(([, vs]) => vs.length > 0)
    .map(([name, vs]) => {
      const s = [...vs].sort((a, b) => a - b);
      return {
        name,
        min: s[0],
        q1: quantile(s, 0.25),
        med: quantile(s, 0.5),
        q3: quantile(s, 0.75),
        max: s[s.length - 1],
      };
    });
}

export function BoxPlot({
  rows,
  xField,
  yField,
}: {
  rows: Record<string, unknown>[];
  xField: string;
  yField: string;
}) {
  const stats = useMemo(() => computeBoxStats(rows, xField, yField), [rows, xField, yField]);
  if (stats.length === 0) {
    return (
      <p className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No numeric values to plot.
      </p>
    );
  }

  const lo = Math.min(...stats.map((s) => s.min));
  const hi = Math.max(...stats.map((s) => s.max));
  const pad = (hi - lo || 1) * 0.08;
  const yMin = lo - pad;
  const yMax = hi + pad;
  const W = Math.max(stats.length * 64 + 48, 240);
  const H = 230;
  const plotTop = 10;
  const plotBottom = H - 26;
  const y = (v: number) => plotBottom - ((v - yMin) / (yMax - yMin || 1)) * (plotBottom - plotTop);

  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((t) => yMin + t * (yMax - yMin));

  return (
    <div className="h-full w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
        {gridVals.map((v) => (
          <g key={v}>
            <line
              x1={44}
              x2={W - 6}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeDasharray="3 3"
            />
            <text
              x={40}
              y={y(v) + 3}
              textAnchor="end"
              fontSize={9}
              className="fill-muted-foreground"
            >
              {fmtBiNumber(v)}
            </text>
          </g>
        ))}
        {stats.map((s, i) => {
          const cx = 48 + i * 64 + 32;
          const boxW = 30;
          return (
            <g key={s.name}>
              <title>{`${s.name}\nmax ${fmtBiNumber(s.max)}\nQ3 ${fmtBiNumber(s.q3)}\nmedian ${fmtBiNumber(s.med)}\nQ1 ${fmtBiNumber(s.q1)}\nmin ${fmtBiNumber(s.min)}`}</title>
              <line x1={cx} x2={cx} y1={y(s.max)} y2={y(s.q3)} stroke="var(--primary)" />
              <line x1={cx} x2={cx} y1={y(s.q1)} y2={y(s.min)} stroke="var(--primary)" />
              <line x1={cx - 8} x2={cx + 8} y1={y(s.max)} y2={y(s.max)} stroke="var(--primary)" />
              <line x1={cx - 8} x2={cx + 8} y1={y(s.min)} y2={y(s.min)} stroke="var(--primary)" />
              <rect
                x={cx - boxW / 2}
                y={y(s.q3)}
                width={boxW}
                height={Math.max(y(s.q1) - y(s.q3), 1)}
                rx={3}
                fill="var(--primary)"
                fillOpacity={0.22}
                stroke="var(--primary)"
                strokeWidth={1.25}
              />
              <line
                x1={cx - boxW / 2}
                x2={cx + boxW / 2}
                y1={y(s.med)}
                y2={y(s.med)}
                stroke="var(--primary)"
                strokeWidth={2}
              />
              <text
                x={cx}
                y={H - 10}
                textAnchor="middle"
                fontSize={9}
                className="fill-muted-foreground"
              >
                {s.name.length > 9 ? `${s.name.slice(0, 8)}…` : s.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Matrix (pivot) table ────────────────────────────────────────────────

export function MatrixTable({
  rows,
  rowField,
  colField,
  valueField,
  rowSubField,
  condFormat,
  format,
}: {
  rows: Record<string, unknown>[];
  rowField: string;
  colField: string;
  valueField: string;
  /** Optional second row level — rows become expandable groups with subtotals. */
  rowSubField?: string;
  /** Conditional cell colouring (scale or first-match rules). */
  condFormat?: BiCondFormat;
  format?: BiNumberFormat | BiFormatOptions;
}) {
  const subField = rowSubField && rowSubField !== rowField ? rowSubField : undefined;
  // Expanded groups (hierarchy mode). Stale keys after data changes are harmless.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const {
    rowKeys,
    colKeys,
    sums,
    leafSums,
    children,
    leafTotals,
    rowTotals,
    colTotals,
    grand,
    min,
    max,
  } = useMemo(() => {
    const rowKeys: string[] = [];
    const colKeys: string[] = [];
    const sums = new Map<string, number>(); // group×col (subtotals in hierarchy mode)
    const leafSums = new Map<string, number>(); // group×sub×col
    const children = new Map<string, string[]>();
    const leafTotals = new Map<string, number>(); // group×sub row totals
    for (const row of rows) {
      const r = String(row[rowField] ?? "—");
      const c = String(row[colField] ?? "—");
      const v = Number(row[valueField]);
      if (!Number.isFinite(v)) continue;
      if (!rowKeys.includes(r) && rowKeys.length < 200) rowKeys.push(r);
      if (!colKeys.includes(c) && colKeys.length < 30) colKeys.push(c);
      const k = `${r}\u0000${c}`;
      sums.set(k, (sums.get(k) ?? 0) + v);
      if (subField) {
        const sv = String(row[subField] ?? "—");
        const kids = children.get(r) ?? [];
        if (!kids.includes(sv) && kids.length < 100) {
          kids.push(sv);
          children.set(r, kids);
        }
        const lk = `${r}\u0000${sv}\u0000${c}`;
        leafSums.set(lk, (leafSums.get(lk) ?? 0) + v);
        const tk = `${r}\u0000${sv}`;
        leafTotals.set(tk, (leafTotals.get(tk) ?? 0) + v);
      }
    }
    const rowTotals = new Map<string, number>();
    const colTotals = new Map<string, number>();
    let grand = 0;
    for (const r of rowKeys) {
      for (const c of colKeys) {
        const v = sums.get(`${r}\u0000${c}`);
        if (v === undefined) continue;
        rowTotals.set(r, (rowTotals.get(r) ?? 0) + v);
        colTotals.set(c, (colTotals.get(c) ?? 0) + v);
        grand += v;
      }
    }
    // Colour-scale extent from the finest data cells (totals excluded).
    let min = Infinity;
    let max = -Infinity;
    for (const v of (subField ? leafSums : sums).values()) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min)) {
      min = 0;
      max = 0;
    }
    return { rowKeys, colKeys, sums, leafSums, children, leafTotals, rowTotals, colTotals, grand, min, max };
  }, [rows, rowField, colField, valueField, subField]);

  const fmt = (v: number) => fmtBiValue(v, format);
  const cellStyle = (v: number | undefined): React.CSSProperties | undefined => {
    if (v === undefined) return undefined;
    const fill = condFill(v, condFormat, min, max);
    if (!fill) return undefined;
    return { background: fill.bg, ...(fill.fg ? { color: fill.fg, fontWeight: 500 } : {}) };
  };

  const toggle = (g: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  const allExpanded = subField ? rowKeys.every((r) => expanded.has(r)) : false;

  const th =
    "sticky top-0 z-10 border-b border-border/60 bg-card px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";
  const numCell = "px-2.5 py-1.5 text-right text-xs tabular-nums";

  const valueCells = (key: (c: string) => string, source: Map<string, number>, colour: boolean) =>
    colKeys.map((c) => {
      const v = source.get(key(c));
      return (
        <td key={c} className={numCell} style={colour ? cellStyle(v) : undefined}>
          {v === undefined ? <span className="text-muted-foreground/50">—</span> : fmt(v)}
        </td>
      );
    });

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-left">
        <thead>
          <tr>
            <th className={th}>
              <span className="flex items-center gap-1.5">
                {rowField}
                {subField && (
                  <>
                    <span className="font-normal normal-case text-muted-foreground/60">
                      › {subField}
                    </span>
                    <button
                      type="button"
                      className="rounded px-1 font-normal normal-case tracking-normal text-primary hover:bg-muted"
                      onClick={() => setExpanded(allExpanded ? new Set() : new Set(rowKeys))}
                    >
                      {allExpanded ? "Collapse all" : "Expand all"}
                    </button>
                  </>
                )}
              </span>
            </th>
            {colKeys.map((c) => (
              <th key={c} className={`${th} text-right`}>
                {c}
              </th>
            ))}
            <th className={`${th} text-right`}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rowKeys.map((r) => {
            const kids = subField ? (children.get(r) ?? []) : [];
            const open = expanded.has(r);
            return (
              <FragmentRows key={r}>
                <tr
                  className={`border-b border-border/30 transition-colors hover:bg-muted/40 ${
                    subField ? "cursor-pointer bg-muted/20" : ""
                  }`}
                  onClick={subField ? () => toggle(r) : undefined}
                >
                  <td className="px-2.5 py-1.5 text-xs font-medium">
                    <span className="flex items-center gap-1">
                      {subField &&
                        (open ? (
                          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                        ))}
                      {r}
                      {subField && (
                        <span className="text-[10px] font-normal text-muted-foreground/60">
                          ({kids.length})
                        </span>
                      )}
                    </span>
                  </td>
                  {valueCells((c) => `${r}\u0000${c}`, sums, !subField)}
                  <td className={`${numCell} font-semibold`}>{fmt(rowTotals.get(r) ?? 0)}</td>
                </tr>
                {subField &&
                  open &&
                  kids.map((sv) => (
                    <tr
                      key={`${r}\u0000${sv}`}
                      className="border-b border-border/20 transition-colors hover:bg-muted/40"
                    >
                      <td className="py-1.5 pl-8 pr-2.5 text-xs text-muted-foreground">{sv}</td>
                      {valueCells((c) => `${r}\u0000${sv}\u0000${c}`, leafSums, true)}
                      <td className={numCell}>{fmt(leafTotals.get(`${r}\u0000${sv}`) ?? 0)}</td>
                    </tr>
                  ))}
              </FragmentRows>
            );
          })}
          <tr className="border-t-2 border-border/60">
            <td className="px-2.5 py-1.5 text-xs font-semibold">Total</td>
            {colKeys.map((c) => (
              <td key={c} className={`${numCell} font-semibold`}>
                {fmt(colTotals.get(c) ?? 0)}
              </td>
            ))}
            <td className={`${numCell} font-bold`}>{fmt(grand)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Keyed wrapper for the group-row + child-rows pair (plain <>…</> can't take a key). */
function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
