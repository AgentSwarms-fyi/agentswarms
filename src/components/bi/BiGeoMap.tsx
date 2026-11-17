// Geo visuals for BI widgets: filled (choropleth) and bubble maps of
// countries or, since R506, of US states. Entirely offline — d3-geo draws a
// bundled Natural Earth 110m topology (world-atlas) or the Census Bureau's
// state shapes (us-atlas), so no tile servers or external requests.
//
// Location values are matched to countries by NAME (case/diacritic
// insensitive, with common aliases like "USA" or "UK") and by ISO 3166-1
// CODE: alpha-2 ("DE") and the three-digit numeric form ("276"); to states
// by name, postal code ("NY"), ISO 3166-2 ("US-NY") or FIPS ("36"). Those
// rules live in src/lib/countryMatch.ts and src/lib/usStateMatch.ts,
// atlas-free and directly testable; this file supplies the shapes they choose
// between. Unmatched rows are counted and surfaced, never silently dropped.
import { useMemo, useRef, useState } from "react";
import { fmtBiNumber } from "@/components/bi/biChartData";
import { resolveCountry } from "@/lib/countryMatch";
import { chooseMapRegion, resolveUsState, type MapRegion } from "@/lib/usStateMatch";
import { COUNTRY_INDEX, COUNTRY_SHAPES, VIEW_H, VIEW_W, type GeoShape } from "./countryAtlas";
import { US_VIEW_H, US_VIEW_W, useUsAtlas } from "./usAtlas";

/** One atlas as the map draws it: its shapes, its canvas, and its matcher. */
type AtlasView = {
  shapes: GeoShape[];
  byKey: ReadonlyMap<string, GeoShape>;
  width: number;
  height: number;
  lookup: (raw: unknown) => GeoShape | null;
  /** What an unmatched row failed to match: "country" or "US state". */
  noun: string;
};

const WORLD: AtlasView = {
  shapes: COUNTRY_SHAPES,
  byKey: COUNTRY_INDEX.byKey,
  width: VIEW_W,
  height: VIEW_H,
  lookup: (raw) => resolveCountry(raw, COUNTRY_INDEX),
  noun: "country",
};

export function BiGeoMap({
  rows,
  locationField,
  valueField,
  mode,
  region,
  onElementClick,
  selectedValue,
}: {
  rows: Record<string, unknown>[];
  locationField: string;
  valueField: string;
  mode: "fill" | "bubble";
  /** Countries or US states; unset chooses from the values (R506). */
  region?: MapRegion;
  /** Cross-filtering: called with the ROW's raw location value (not the atlas name). */
  onElementClick?: (value: string) => void;
  /** The currently cross-filtered location (raw value) — highlighted so it's
   *  obvious which place the click selected. */
  selectedValue?: string | null;
}) {
  // Styled hover tooltip (native SVG <title> is delayed and easy to miss —
  // this matches the recharts tooltips used by every other visual).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ name: string; value: number; x: number; y: number } | null>(
    null,
  );

  const chosen = useMemo<MapRegion>(
    () =>
      region ??
      chooseMapRegion(
        rows.map((r) => r[locationField]),
        COUNTRY_INDEX,
        locationField,
      ),
    [region, rows, locationField],
  );
  const us = useUsAtlas(chosen === "us");
  const atlas = useMemo<AtlasView | "loading" | "error">(() => {
    if (chosen === "world") return WORLD;
    if (us === "error") return "error";
    if (!us) return "loading";
    return {
      shapes: us.shapes,
      byKey: us.byFips,
      width: US_VIEW_W,
      height: US_VIEW_H,
      lookup: (raw) => {
        const s = resolveUsState(raw);
        return s ? (us.byFips.get(s.fips) ?? null) : null;
      },
      noun: "US state",
    };
  }, [chosen, us]);

  function showTip(e: React.PointerEvent, name: string, value: number) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({
      name,
      value,
      x: Math.min(e.clientX - rect.left + 12, rect.width - 130),
      y: Math.max(4, e.clientY - rect.top - 34),
    });
  }

  const { values, unmatched, max } = useMemo(() => {
    const values = new Map<string, { shape: GeoShape; value: number; raw: string }>();
    let unmatched = 0;
    if (typeof atlas === "string") return { values, unmatched, max: 0 };
    for (const row of rows) {
      const shape = atlas.lookup(row[locationField]);
      const v = Number(row[valueField]);
      if (!shape || !Number.isFinite(v)) {
        unmatched++;
        continue;
      }
      const prev = values.get(shape.key);
      values.set(shape.key, {
        shape,
        value: (prev?.value ?? 0) + v,
        raw: prev?.raw ?? String(row[locationField]),
      });
    }
    const max = Math.max(...[...values.values()].map((e) => e.value), 0);
    return { values, unmatched, max };
  }, [atlas, rows, locationField, valueField]);

  // Atlas key of the cross-filtered place (if any), so we can outline it.
  const selectedKey = useMemo(
    () =>
      selectedValue != null && typeof atlas !== "string"
        ? (atlas.lookup(selectedValue)?.key ?? null)
        : null,
    [selectedValue, atlas],
  );

  if (typeof atlas === "string") {
    return (
      <p className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {atlas === "loading"
          ? "Loading the US map…"
          : "The US map could not load. Reload the page."}
      </p>
    );
  }
  const selectedShape = selectedKey ? atlas.byKey.get(selectedKey) : undefined;
  const selectedEntry = selectedKey ? values.get(selectedKey) : undefined;
  // Bubbles are sized against the canvas, so the US map's larger states do
  // not get the same pixel radius as a world map's countries.
  const rMax = atlas === WORLD ? 22 : 30;

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      <svg
        viewBox={`0 0 ${atlas.width} ${atlas.height}`}
        className="h-full w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={chosen === "us" ? "Map of US states" : "World map"}
      >
        {atlas.shapes.map((s) => {
          const entry = values.get(s.key);
          const t = entry && max > 0 ? entry.value / max : 0;
          const active = hover?.name === s.name;
          const selected = selectedKey === s.key;
          return (
            <path
              key={s.key}
              d={s.d}
              fill={entry && mode === "fill" ? "var(--primary)" : "var(--muted)"}
              fillOpacity={
                entry && mode === "fill" ? (active || selected ? 1 : 0.15 + 0.85 * t) : 1
              }
              stroke="var(--card)"
              strokeWidth={chosen === "us" ? 1 : 0.6}
              onPointerMove={
                entry && mode === "fill" ? (e) => showTip(e, s.name, entry.value) : undefined
              }
              onPointerLeave={entry && mode === "fill" ? () => setHover(null) : undefined}
              onClick={entry && onElementClick ? () => onElementClick(entry.raw) : undefined}
              cursor={entry && onElementClick ? "pointer" : undefined}
            />
          );
        })}
        {/* Selected-place outline, drawn last so it sits above neighbouring
            borders and clearly marks the active cross-filter. */}
        {mode === "fill" && selectedShape && (
          <path
            d={selectedShape.d}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={2.25}
            strokeLinejoin="round"
            pointerEvents="none"
          />
        )}
        {mode === "bubble" &&
          [...values.values()]
            .sort((a, b) => b.value - a.value)
            .map(({ shape, value, raw }) => {
              const r = 4 + rMax * Math.sqrt(max > 0 ? value / max : 0);
              const active = hover?.name === shape.name;
              const selected = selectedKey === shape.key;
              return (
                <circle
                  key={shape.key}
                  cx={shape.centroid[0]}
                  cy={shape.centroid[1]}
                  r={r}
                  fill="var(--primary)"
                  fillOpacity={active || selected ? 0.75 : 0.45}
                  stroke={selected ? "var(--foreground)" : "var(--primary)"}
                  strokeWidth={active || selected ? 2 : 1.25}
                  onPointerMove={(e) => showTip(e, shape.name, value)}
                  onPointerLeave={() => setHover(null)}
                  onClick={onElementClick ? () => onElementClick(raw) : undefined}
                  cursor={onElementClick ? "pointer" : undefined}
                />
              );
            })}
        {/* Selection ring for the cross-filtered bubble, drawn on top. */}
        {mode === "bubble" && selectedShape && selectedEntry && (
          <circle
            cx={selectedShape.centroid[0]}
            cy={selectedShape.centroid[1]}
            r={4 + rMax * Math.sqrt(max > 0 ? selectedEntry.value / max : 0) + 3}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={1.75}
            pointerEvents="none"
          />
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: hover.x, top: hover.y }}
        >
          <span className="font-medium text-popover-foreground">{hover.name}</span>
          <span className="ml-1.5 tabular-nums text-muted-foreground">
            {fmtBiNumber(hover.value)}
          </span>
        </div>
      )}
      <div className="pointer-events-none absolute bottom-1 left-2 flex items-center gap-2 text-[9px] text-muted-foreground">
        {mode === "fill" && max > 0 && (
          <span className="flex items-center gap-1">
            <span className="h-2 w-10 rounded-sm bg-gradient-to-r from-primary/15 to-primary" />0 –{" "}
            {fmtBiNumber(max)}
          </span>
        )}
        {unmatched > 0 && (
          <span>
            {unmatched} row{unmatched === 1 ? "" : "s"} not matched to a {atlas.noun}
          </span>
        )}
      </div>
    </div>
  );
}
