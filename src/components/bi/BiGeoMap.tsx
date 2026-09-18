// Country-level geo visuals for BI widgets: filled (choropleth) and bubble
// maps. Entirely offline — d3-geo projects a bundled Natural Earth 110m
// topology (world-atlas), so no tile servers or external requests.
//
// Location values are matched to countries by NAME (case/diacritic
// insensitive, with common aliases like "USA" or "UK") and by ISO 3166-1
// CODE: alpha-2 ("DE") and the three-digit numeric form ("276"). That rule
// lives in src/lib/countryMatch.ts, atlas-free and directly testable; this
// file supplies the shapes it chooses between. Unmatched rows are counted
// and surfaced, never silently dropped.
import { useMemo, useRef, useState } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import worldData from "world-atlas/countries-110m.json";
import { fmtBiNumber } from "@/components/bi/BiChartRender";
import { normalizeName, resolveCountry } from "@/lib/countryMatch";

const VIEW_W = 960;
const VIEW_H = 500;

type CountryShape = {
  name: string;
  key: string;
  /** ISO 3166-1 numeric, from the atlas's own feature id; null for the few without one. */
  num: string | null;
  d: string;
  centroid: [number, number];
};

// Parsed once at module load; ~170 country paths.
const COUNTRY_SHAPES: CountryShape[] = (() => {
  const topo = worldData as unknown as Parameters<typeof feature>[0];
  const objects = (worldData as unknown as { objects: { countries: unknown } }).objects.countries;
  const collection = feature(
    topo,
    objects as Parameters<typeof feature>[1],
  ) as unknown as FeatureCollection<Geometry, { name?: string }>;
  const projection = geoNaturalEarth1().fitExtent(
    [
      [8, 8],
      [VIEW_W - 8, VIEW_H - 8],
    ],
    collection,
  );
  const path = geoPath(projection);
  return collection.features
    .map((f: Feature<Geometry, { name?: string }>) => {
      const name = f.properties?.name ?? "";
      const d = path(f);
      if (!name || !d) return null;
      return {
        name,
        key: normalizeName(name),
        // Natural Earth's feature id is the ISO 3166-1 NUMERIC code, so a
        // column of numeric codes needs no lookup table at all.
        num: f.id == null ? null : String(f.id).padStart(3, "0"),
        d,
        centroid: path.centroid(f) as [number, number],
      };
    })
    .filter((s): s is CountryShape => s !== null);
})();

const SHAPE_BY_KEY = new Map(COUNTRY_SHAPES.map((s) => [s.key, s]));
const SHAPE_BY_NUM = new Map(COUNTRY_SHAPES.filter((s) => s.num).map((s) => [s.num as string, s]));

/**
 * The atlas indexed the two ways a location value can arrive.
 *
 * Exported so the matcher's test can run the shipped rule against the shipped
 * shapes — the indexing and the rule are both defects waiting to happen, and
 * a test that rebuilt either would miss half of them.
 */
export const COUNTRY_INDEX = { byKey: SHAPE_BY_KEY, byNum: SHAPE_BY_NUM };

function lookupCountry(raw: unknown): CountryShape | null {
  return resolveCountry(raw, COUNTRY_INDEX);
}

export function BiGeoMap({
  rows,
  locationField,
  valueField,
  mode,
  onElementClick,
  selectedValue,
}: {
  rows: Record<string, unknown>[];
  locationField: string;
  valueField: string;
  mode: "fill" | "bubble";
  /** Cross-filtering: called with the ROW's raw location value (not the atlas name). */
  onElementClick?: (value: string) => void;
  /** The currently cross-filtered location (raw value) — highlighted so it's
   *  obvious which country the click selected. */
  selectedValue?: string | null;
}) {
  // Styled hover tooltip (native SVG <title> is delayed and easy to miss —
  // this matches the recharts tooltips used by every other visual).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ name: string; value: number; x: number; y: number } | null>(
    null,
  );

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
    const values = new Map<string, { shape: CountryShape; value: number; raw: string }>();
    let unmatched = 0;
    for (const row of rows) {
      const shape = lookupCountry(row[locationField]);
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
  }, [rows, locationField, valueField]);

  // Atlas key of the cross-filtered country (if any), so we can outline it.
  const selectedKey = useMemo(
    () => (selectedValue != null ? (lookupCountry(selectedValue)?.key ?? null) : null),
    [selectedValue],
  );
  const selectedShape = selectedKey ? SHAPE_BY_KEY.get(selectedKey) : undefined;
  const selectedEntry = selectedKey ? values.get(selectedKey) : undefined;

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="h-full w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
      >
        {COUNTRY_SHAPES.map((s) => {
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
              strokeWidth={0.6}
              onPointerMove={
                entry && mode === "fill" ? (e) => showTip(e, s.name, entry.value) : undefined
              }
              onPointerLeave={entry && mode === "fill" ? () => setHover(null) : undefined}
              onClick={entry && onElementClick ? () => onElementClick(entry.raw) : undefined}
              cursor={entry && onElementClick ? "pointer" : undefined}
            />
          );
        })}
        {/* Selected-country outline, drawn last so it sits above neighbouring
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
              const r = 4 + 22 * Math.sqrt(max > 0 ? value / max : 0);
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
            r={4 + 22 * Math.sqrt(max > 0 ? selectedEntry.value / max : 0) + 3}
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
            {unmatched} row{unmatched === 1 ? "" : "s"} not matched to a country
          </span>
        )}
      </div>
    </div>
  );
}
