// The world atlas the geo visuals draw: Natural Earth 110m country shapes,
// projected once into the map's canvas, and indexed by name key and by ISO
// numeric code (R346: moved out of BiGeoMap.tsx, which now exports only its
// component).
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import worldData from "world-atlas/countries-110m.json";
import { normalizeName } from "@/lib/countryMatch";

export const VIEW_W = 960;
export const VIEW_H = 500;

export type CountryShape = {
  name: string;
  key: string;
  /** ISO 3166-1 numeric, from the atlas's own feature id; null for the few without one. */
  num: string | null;
  d: string;
  centroid: [number, number];
};

// Parsed once at module load; ~170 country paths.
export const COUNTRY_SHAPES: CountryShape[] = (() => {
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

export const SHAPE_BY_KEY = new Map(COUNTRY_SHAPES.map((s) => [s.key, s]));

const SHAPE_BY_NUM = new Map(COUNTRY_SHAPES.filter((s) => s.num).map((s) => [s.num as string, s]));

/**
 * The atlas indexed the two ways a location value can arrive.
 *
 * Exported so the matcher's test can run the shipped rule against the shipped
 * shapes — the indexing and the rule are both defects waiting to happen, and
 * a test that rebuilt either would miss half of them.
 */
export const COUNTRY_INDEX = { byKey: SHAPE_BY_KEY, byNum: SHAPE_BY_NUM };
