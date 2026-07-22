// Hand-rendered BI visuals that recharts has no primitive for: gauge,
// heatmap, box-and-whisker plot, and the matrix (pivot) table. All pure
// SVG/HTML on design tokens, so they follow light/dark themes.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Pause, Play } from "lucide-react";
import {
  fmtBiNumber,
  fmtBiValue,
  toBiNumber,
  type BiFormatOptions,
} from "@/components/bi/BiChartRender";
import { condFill } from "@/lib/biChartMath";
import type { BiCondFormat, BiNumberFormat } from "@/lib/biAgent";

// Categorical palette shared by the hand-rendered visuals below (kept local to
// avoid deepening the BiChartRender ↔ BiChartParts import cycle).
const PART_COLORS = [
  "#4E79A7",
  "#F28E2B",
  "#59A14F",
  "#E15759",
  "#76B7B2",
  "#EDC948",
  "#B07AA1",
  "#FF9DA7",
  "#9C755F",
  "#BAB0AC",
  "#86BCB6",
  "#D37295",
];

/** Stable colour for a category name (so a bar keeps its colour across frames). */
function colorForKey(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PART_COLORS[h % PART_COLORS.length];
}

function NoNumericData() {
  return (
    <p className="flex h-full items-center justify-center text-xs text-muted-foreground">
      No values to plot.
    </p>
  );
}

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
    return {
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
    };
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

// ── Bar-chart race ────────────────────────────────────────────────────────
// Animated horizontal bars that re-rank as an animation steps through the
// frames of a time column. Pure DOM with CSS transitions on position/width, so
// bars slide smoothly and the whole thing exports/prints as a static snapshot.

type RaceFrame = { frame: string; entries: [string, number][] };

function compareFrames(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b); // ISO dates sort correctly as strings
}

export function BarRace({
  rows,
  xField,
  yField,
  timeField,
  format,
  onElementClick,
  topN = 12,
  frameMs = 1100,
}: {
  rows: Record<string, unknown>[];
  xField: string;
  yField: string;
  timeField: string;
  format?: BiNumberFormat | BiFormatOptions;
  onElementClick?: (column: string, value: string) => void;
  topN?: number;
  frameMs?: number;
}) {
  const frames = useMemo<RaceFrame[]>(() => {
    const byFrame = new Map<string, Map<string, number>>();
    const order: string[] = [];
    for (const r of rows) {
      const f = String(r[timeField] ?? "");
      const c = String(r[xField] ?? "—");
      const v = toBiNumber(r[yField]);
      if (v === null) continue;
      if (!byFrame.has(f)) {
        byFrame.set(f, new Map());
        order.push(f);
      }
      const m = byFrame.get(f)!;
      m.set(c, (m.get(c) ?? 0) + v);
    }
    order.sort(compareFrames);
    return order.slice(0, 400).map((f) => ({
      frame: f,
      entries: [...byFrame.get(f)!.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN),
    }));
  }, [rows, xField, yField, timeField, topN]);

  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    setIdx(0);
    setPlaying(true);
  }, [frames]);

  useEffect(() => {
    if (!playing || frames.length <= 1) return;
    const t = setTimeout(() => setIdx((i) => (i + 1) % frames.length), frameMs);
    return () => clearTimeout(t);
  }, [playing, idx, frames, frameMs]);

  if (frames.length === 0) return <NoNumericData />;

  const cur = frames[Math.min(idx, frames.length - 1)];
  const max = Math.max(...cur.entries.map((e) => e[1]), 1e-9);
  const rowPct = 100 / topN;
  const fmt = (v: unknown) => fmtBiValue(v, format);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 px-1 pb-1 text-[10px] text-muted-foreground">
        <button
          type="button"
          className="rounded p-0.5 hover:bg-muted hover:text-foreground"
          onClick={() => setPlaying((p) => !p)}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(frames.length - 1, 0)}
          value={Math.min(idx, frames.length - 1)}
          onChange={(e) => {
            setPlaying(false);
            setIdx(Number(e.target.value));
          }}
          className="h-1 flex-1 cursor-pointer accent-[var(--primary)]"
        />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {cur.entries.map(([cat, val], rank) => {
          const pct = (val / max) * 100;
          const inside = pct > 82;
          return (
            <div
              key={cat}
              className="absolute inset-x-0 flex items-center gap-1.5 px-1"
              style={{
                top: `${rank * rowPct}%`,
                height: `${rowPct}%`,
                transition: "top 0.7s cubic-bezier(.4,0,.2,1)",
              }}
            >
              <span
                className="w-24 shrink-0 truncate text-right text-[10px] text-muted-foreground"
                title={cat}
              >
                {cat}
              </span>
              <div className="relative h-[68%] flex-1">
                <div
                  className="absolute inset-y-0 left-0 flex items-center justify-end rounded-r-sm pr-1"
                  style={{
                    width: `${Math.max(pct, 0.5)}%`,
                    background: colorForKey(cat),
                    transition: "width 0.7s cubic-bezier(.4,0,.2,1)",
                    cursor: onElementClick ? "pointer" : undefined,
                  }}
                  onClick={onElementClick ? () => onElementClick(xField, cat) : undefined}
                >
                  {inside && (
                    <span className="text-[10px] font-medium tabular-nums text-white">
                      {fmt(val)}
                    </span>
                  )}
                </div>
                {!inside && (
                  <span
                    className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap pl-1 text-[10px] tabular-nums text-foreground"
                    style={{ left: `${pct}%` }}
                  >
                    {fmt(val)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <div className="pointer-events-none absolute bottom-1 right-2 text-2xl font-bold tabular-nums text-muted-foreground/30">
          {cur.frame}
        </div>
      </div>
    </div>
  );
}

// ── Nightingale / polar-area rose ─────────────────────────────────────────
// Equal-angle wedges, one per category; radius encodes value (area-proportional,
// radius ∝ √value) so magnitude reads honestly. Pure SVG on design tokens.

function annularSector(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
): string {
  const p = (r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  const [x0, y0] = p(r0, a0);
  const [x1, y1] = p(r1, a0);
  const [x2, y2] = p(r1, a1);
  const [x3, y3] = p(r0, a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${x0} ${y0} L ${x1} ${y1} A ${r1} ${r1} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${r0} ${r0} 0 ${large} 0 ${x0} ${y0} Z`;
}

export function NightingaleChart({
  rows,
  nameField,
  valueField,
  format,
  onElementClick,
}: {
  rows: Record<string, unknown>[];
  nameField: string;
  valueField: string;
  format?: BiNumberFormat | BiFormatOptions;
  onElementClick?: (column: string, value: string) => void;
}) {
  const data = useMemo(() => {
    const agg = new Map<string, number>();
    const order: string[] = [];
    for (const r of rows) {
      const k = String(r[nameField] ?? "—");
      const v = toBiNumber(r[valueField]);
      if (v === null) continue;
      if (!agg.has(k)) {
        agg.set(k, 0);
        order.push(k);
      }
      agg.set(k, agg.get(k)! + v);
    }
    return order
      .map((k) => ({ name: k, value: agg.get(k)! }))
      .filter((d) => d.value > 0)
      .slice(0, 12);
  }, [rows, nameField, valueField]);

  if (data.length === 0) return <NoNumericData />;

  const maxV = Math.max(...data.map((d) => d.value));
  const CX = 110;
  const CY = 110;
  const R = 96;
  const R0 = 14;
  const slice = (2 * Math.PI) / data.length;
  const fmt = (v: unknown) => fmtBiValue(v, format);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1">
      <svg
        viewBox="0 0 220 220"
        className="min-h-0 w-full flex-1"
        preserveAspectRatio="xMidYMid meet"
        role="img"
      >
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <circle
            key={t}
            cx={CX}
            cy={CY}
            r={R0 + (R - R0) * t}
            fill="none"
            stroke="var(--border)"
            strokeDasharray="2 3"
            strokeWidth={0.75}
          />
        ))}
        {data.map((d, i) => {
          const r = R0 + (R - R0) * Math.sqrt(d.value / maxV);
          const a0 = -Math.PI / 2 + i * slice + slice * 0.03;
          const a1 = -Math.PI / 2 + (i + 1) * slice - slice * 0.03;
          return (
            <g
              key={d.name}
              onClick={onElementClick ? () => onElementClick(nameField, d.name) : undefined}
              cursor={onElementClick ? "pointer" : undefined}
            >
              <title>{`${d.name}: ${fmt(d.value)}`}</title>
              <path
                d={annularSector(CX, CY, R0, r, a0, a1)}
                fill={PART_COLORS[i % PART_COLORS.length]}
                fillOpacity={0.85}
                stroke="var(--card)"
                strokeWidth={1}
              />
            </g>
          );
        })}
      </svg>
      <div className="flex max-h-16 shrink-0 flex-wrap justify-center gap-x-2 gap-y-0.5 overflow-hidden px-1">
        {data.map((d, i) => (
          <span
            key={d.name}
            className="flex items-center gap-1 text-[9px] text-muted-foreground"
            title={`${d.name}: ${fmt(d.value)}`}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: PART_COLORS[i % PART_COLORS.length] }}
            />
            <span className="max-w-24 truncate">{d.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
