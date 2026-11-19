// Points at a latitude and longitude (R501): stations, stores, sensors —
// coloured by a category (or by a #rrggbb column), sized by a measure, with
// zoom and pan.
//
// Street tiles are drawn only when the deployment names a tile server
// (PUBLIC_MAP_TILES_URL). Without one the map draws its points on a plain
// ground and asks no third party for anything, as the country maps do: every
// tile request tells the tile server which part of the world a viewer looks at.
// The dashboard's owner is told how to add streets (R504). Tiles send the
// site's origin as Referer, never the page's path (a dashboard id, a share
// slug): tile servers' terms expect a Referer from a browser.
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";

import { fmtBiValue } from "@/components/bi/biChartData";
import {
  fitView,
  mapPoints,
  pointMapCorner,
  tileUrl,
  toScreen,
  visibleTiles,
  type MapPoint,
  type MapView,
} from "@/components/bi/biDrawHelpers";
import { BiViewContext } from "@/components/bi/biParamContext";
import type { ChartSpec } from "@/lib/biAgent";
import { publicConfig } from "@/lib/publicConfig";

type PointMapChart = Extract<ChartSpec, { type: "pointmap" }>;

type Pt = MapPoint;

const LEGEND_MAX = 8;

export function BiPointMap({
  chart,
  rows,
  onElementClick,
}: {
  chart: PointMapChart;
  rows: Record<string, unknown>[];
  /**
   * A point's name — its label field, else its colour field — as a click
   * (R503): filter the page, or open a station's own page.
   */
  onElementClick?: (column: string, value: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<MapView | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const drag = useRef<{ x: number; y: number; v: MapView } | null>(null);
  // Where a press started and on which point: the map captures the pointer to
  // pan, so a click on a point is a press that ends where it began.
  const press = useRef<{ x: number; y: number; key: string | null } | null>(null);
  const clickField = chart.labelField || chart.colorField || null;
  const cfg = publicConfig();
  const tiles = cfg.mapTilesUrl;
  const corner = pointMapCorner(cfg, useContext(BiViewContext)?.canEdit === true);

  const empty = rows.length === 0;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }),
    );
    ro.observe(el);
    // Native and not passive: React's wheel handler cannot stop the page from
    // zooming on Ctrl + scroll. Scrolling past the map without Ctrl scrolls.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomRef.current?.(e.deltaY < 0 ? 0.5 : -0.5, [e.clientX - r.left, e.clientY - r.top]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [empty]);

  const { points, colors } = useMemo(() => mapPoints(rows, chart), [rows, chart]);

  const fitted = useMemo(
    () =>
      size.w > 0
        ? fitView(
            points.map((p) => p.p),
            size.w,
            size.h,
          )
        : null,
    [points, size.w, size.h],
  );
  const v = view ?? fitted;
  // New data (a parameter, a filter) starts from its own fitted view.
  useEffect(() => setView(null), [points]);

  const zoomBy = (d: number, at?: [number, number]) => {
    if (!v) return;
    const zoom = Math.max(0, Math.min(19, v.zoom + d));
    if (!at) return setView({ ...v, zoom });
    // Keep the point under the cursor where it is.
    const k0 = 2 ** v.zoom;
    const k1 = 2 ** zoom;
    const wx = v.cx + (at[0] - size.w / 2) / k0;
    const wy = v.cy + (at[1] - size.h / 2) / k0;
    setView({ zoom, cx: wx - (at[0] - size.w / 2) / k1, cy: wy - (at[1] - size.h / 2) / k1 });
  };
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;

  if (points.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No rows with a latitude and longitude to place.
      </div>
    );
  }

  const legend = [...colors.entries()].slice(0, LEGEND_MAX);
  return (
    <div
      ref={box}
      className="relative h-full w-full touch-none select-none overflow-hidden rounded-md"
      style={
        tiles
          ? { background: "var(--muted)" }
          : {
              background:
                "linear-gradient(var(--border) 1px, transparent 1px) 0 0 / 40px 40px, " +
                "linear-gradient(90deg, var(--border) 1px, transparent 1px) 0 0 / 40px 40px, " +
                "color-mix(in oklch, var(--muted) 45%, transparent)",
            }
      }
      onPointerDown={(e) => {
        press.current = {
          x: e.clientX,
          y: e.clientY,
          key: (e.target as Element).getAttribute?.("data-point") ?? null,
        };
        if (!v) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, v };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const k = 2 ** d.v.zoom;
        setView({ ...d.v, cx: d.v.cx - (e.clientX - d.x) / k, cy: d.v.cy - (e.clientY - d.y) / k });
      }}
      onPointerUp={(e) => {
        drag.current = null;
        const p = press.current;
        press.current = null;
        if (!p?.key || !onElementClick || !clickField) return;
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) return;
        const pt = points.find((q) => String(q.key) === p.key);
        const value = pt ? (chart.labelField ? pt.label : pt.cat) : "";
        if (value) onElementClick(clickField, value);
      }}
      onDoubleClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        zoomBy(1, [e.clientX - r.left, e.clientY - r.top]);
      }}
    >
      {v && tiles && (
        <div className="pointer-events-none absolute inset-0">
          {visibleTiles(v, size.w, size.h).map((t) => (
            <img
              key={`${t.z}/${t.x}/${t.y}/${Math.round(t.left)}`}
              src={tileUrl(tiles, t)}
              alt=""
              draggable={false}
              referrerPolicy="strict-origin"
              loading="lazy"
              className="absolute max-w-none"
              style={{ left: t.left, top: t.top, width: t.size + 0.5, height: t.size + 0.5 }}
            />
          ))}
        </div>
      )}
      {v && (
        <svg className="absolute inset-0" width={size.w} height={size.h} role="img">
          <title>{`${points.length} points`}</title>
          {points.map((pt) => {
            const [x, y] = toScreen(pt.p, v, size.w, size.h);
            if (x < -20 || y < -20 || x > size.w + 20 || y > size.h + 20) return null;
            return (
              <circle
                key={pt.key}
                cx={x}
                cy={y}
                r={pt.r}
                fill={pt.color}
                fillOpacity={0.78}
                stroke="white"
                strokeOpacity={0.7}
                strokeWidth={0.6}
                data-point={pt.key}
                cursor={onElementClick && clickField ? "pointer" : undefined}
                onPointerEnter={() => setHover(pt)}
                onPointerLeave={() => setHover((h) => (h?.key === pt.key ? null : h))}
              />
            );
          })}
        </svg>
      )}
      {hover && v && (
        <div
          className="pointer-events-none absolute z-10 max-w-[220px] rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md"
          style={(() => {
            const [x, y] = toScreen(hover.p, v, size.w, size.h);
            return { left: Math.min(x + 10, size.w - 160), top: Math.max(4, y - 44) };
          })()}
        >
          {hover.label && <div className="font-semibold">{hover.label}</div>}
          {hover.cat && <div className="text-muted-foreground">{hover.cat}</div>}
          {hover.size !== null && (
            <div className="tabular-nums">
              {chart.sizeField}: {fmtBiValue(hover.size, chart)}
            </div>
          )}
        </div>
      )}
      {legend.length > 1 && (
        <div className="pointer-events-none absolute left-2 top-2 space-y-0.5 rounded-md bg-background/80 px-2 py-1 text-[10px] backdrop-blur">
          {legend.map(([cat, color]) => (
            <div key={cat} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: color }} />
              <span className="max-w-[120px] truncate">{cat || "(blank)"}</span>
            </div>
          ))}
        </div>
      )}
      <div className="absolute bottom-2 right-2 flex flex-col overflow-hidden rounded-md border border-border bg-background/90 shadow-sm">
        <button
          type="button"
          aria-label="Zoom in"
          className="p-1 hover:bg-muted"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => zoomBy(1)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          className="border-t border-border p-1 hover:bg-muted"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => zoomBy(-1)}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Fit every point"
          className="border-t border-border p-1 hover:bg-muted"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setView(null)}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {corner?.kind === "credit" && (
        <div className="pointer-events-none absolute bottom-0 left-0 rounded-tr bg-background/75 px-1.5 py-0.5 text-[9px] text-muted-foreground">
          {corner.text}
        </div>
      )}
      {corner?.kind === "setup" && (
        // Its own press: the map captures the pointer to pan, which would
        // send the click to the map instead of the link.
        <a
          href={corner.href}
          target="_blank"
          rel="noopener"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="absolute bottom-0 left-0 rounded-tr bg-background/75 px-1.5 py-0.5 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {corner.text}
        </a>
      )}
    </div>
  );
}
