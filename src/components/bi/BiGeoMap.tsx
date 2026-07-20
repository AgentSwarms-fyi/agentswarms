// Country-level geo visuals for BI widgets: filled (choropleth) and bubble
// maps. Entirely offline — d3-geo projects a bundled Natural Earth 110m
// topology (world-atlas), so no tile servers or external requests.
//
// Location values are matched to countries by name (case/diacritic
// insensitive, with common aliases like "USA" or "UK"). Unmatched rows are
// counted and surfaced instead of silently dropped.
import { useMemo } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import worldData from "world-atlas/countries-110m.json";
import { fmtBiNumber } from "@/components/bi/BiChartRender";

const VIEW_W = 960;
const VIEW_H = 500;

function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Common shorthand → Natural Earth country name. */
const ALIASES: Record<string, string> = {
  usa: "united states of america",
  us: "united states of america",
  "united states": "united states of america",
  america: "united states of america",
  uk: "united kingdom",
  "great britain": "united kingdom",
  britain: "united kingdom",
  england: "united kingdom",
  uae: "united arab emirates",
  "czech republic": "czechia",
  "ivory coast": "cote divoire",
  "democratic republic of the congo": "dem rep congo",
  drc: "dem rep congo",
  "republic of the congo": "congo",
  "south korea": "south korea",
  korea: "south korea",
  "north korea": "north korea",
  russia: "russia",
  "russian federation": "russia",
  vietnam: "vietnam",
  "viet nam": "vietnam",
  laos: "laos",
  syria: "syria",
  iran: "iran",
  bolivia: "bolivia",
  venezuela: "venezuela",
  tanzania: "tanzania",
  myanmar: "myanmar",
  burma: "myanmar",
  netherlands: "netherlands",
  holland: "netherlands",
  "bosnia and herzegovina": "bosnia and herz",
  macedonia: "north macedonia",
  swaziland: "eswatini",
  "cape verde": "cabo verde",
};

type CountryShape = {
  name: string;
  key: string;
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
        d,
        centroid: path.centroid(f) as [number, number],
      };
    })
    .filter((s): s is CountryShape => s !== null);
})();

const SHAPE_BY_KEY = new Map(COUNTRY_SHAPES.map((s) => [s.key, s]));

function lookupCountry(raw: unknown): CountryShape | null {
  if (raw === null || raw === undefined) return null;
  const norm = normalizeName(String(raw));
  if (!norm) return null;
  const aliased = ALIASES[norm];
  return SHAPE_BY_KEY.get(aliased ?? norm) ?? null;
}

export function BiGeoMap({
  rows,
  locationField,
  valueField,
  mode,
}: {
  rows: Record<string, unknown>[];
  locationField: string;
  valueField: string;
  mode: "fill" | "bubble";
}) {
  const { values, unmatched, max } = useMemo(() => {
    const values = new Map<string, { shape: CountryShape; value: number }>();
    let unmatched = 0;
    for (const row of rows) {
      const shape = lookupCountry(row[locationField]);
      const v = Number(row[valueField]);
      if (!shape || !Number.isFinite(v)) {
        unmatched++;
        continue;
      }
      const prev = values.get(shape.key);
      values.set(shape.key, { shape, value: (prev?.value ?? 0) + v });
    }
    const max = Math.max(...[...values.values()].map((e) => e.value), 0);
    return { values, unmatched, max };
  }, [rows, locationField, valueField]);

  return (
    <div className="relative h-full w-full">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="h-full w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
      >
        {COUNTRY_SHAPES.map((s) => {
          const entry = values.get(s.key);
          const t = entry && max > 0 ? entry.value / max : 0;
          return (
            <path
              key={s.key}
              d={s.d}
              fill={entry && mode === "fill" ? "var(--primary)" : "var(--muted)"}
              fillOpacity={entry && mode === "fill" ? 0.15 + 0.85 * t : 1}
              stroke="var(--card)"
              strokeWidth={0.6}
            >
              {entry && mode === "fill" && (
                <title>{`${s.name}: ${fmtBiNumber(entry.value)}`}</title>
              )}
            </path>
          );
        })}
        {mode === "bubble" &&
          [...values.values()]
            .sort((a, b) => b.value - a.value)
            .map(({ shape, value }) => {
              const r = 4 + 22 * Math.sqrt(max > 0 ? value / max : 0);
              return (
                <circle
                  key={shape.key}
                  cx={shape.centroid[0]}
                  cy={shape.centroid[1]}
                  r={r}
                  fill="var(--primary)"
                  fillOpacity={0.45}
                  stroke="var(--primary)"
                  strokeWidth={1.25}
                >
                  <title>{`${shape.name}: ${fmtBiNumber(value)}`}</title>
                </circle>
              );
            })}
      </svg>
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
