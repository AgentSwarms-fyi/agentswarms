// The US states atlas the geo visuals draw (R506): the US Census Bureau's
// 1:10m state shapes from us-atlas, already projected to Albers USA with
// Alaska and Hawaii inset, so no projection runs here — the path generator
// reads the planar coordinates as they are.
//
// Loaded on first use, not with the dashboard: most maps are of countries,
// and the file is 82 KB. Every caller shares one load.
import { useEffect, useState } from "react";
import { geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { GeoShape } from "./countryAtlas";

/** The atlas's own canvas: us-atlas projects into 975 × 610. */
export const US_VIEW_W = 975;
export const US_VIEW_H = 610;

export type UsAtlas = {
  shapes: GeoShape[];
  /** Two-digit FIPS code → shape. */
  byFips: ReadonlyMap<string, GeoShape>;
};

/** Build the shapes from the topology. Exported for the atlas test. */
export function buildUsAtlas(topo: unknown): UsAtlas {
  const objects = (topo as { objects: { states: unknown } }).objects.states;
  const collection = feature(
    topo as Parameters<typeof feature>[0],
    objects as Parameters<typeof feature>[1],
  ) as unknown as FeatureCollection<Geometry, { name?: string }>;
  const path = geoPath(null);
  const shapes = collection.features
    .map((f: Feature<Geometry, { name?: string }>) => {
      const name = f.properties?.name ?? "";
      const d = path(f);
      if (!name || !d || f.id == null) return null;
      return {
        name,
        // The FIPS code is the key: names are for people, codes for joins.
        key: String(f.id).padStart(2, "0"),
        d,
        centroid: path.centroid(f) as [number, number],
      };
    })
    .filter((s): s is GeoShape => s !== null);
  return { shapes, byFips: new Map(shapes.map((s) => [s.key, s])) };
}

let loaded: UsAtlas | null = null;
let loading: Promise<UsAtlas> | null = null;

export function loadUsAtlas(): Promise<UsAtlas> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import("us-atlas/states-albers-10m.json")
    .then((m) => {
      loaded = buildUsAtlas((m as { default?: unknown }).default ?? m);
      return loaded;
    })
    .catch((e: unknown) => {
      // A failed chunk load must not stick: the next map tries again.
      loading = null;
      throw e;
    });
  return loading;
}

/** The US atlas once it has loaded; "error" if it could not. */
export function useUsAtlas(enabled: boolean): UsAtlas | "error" | null {
  const [atlas, setAtlas] = useState<UsAtlas | "error" | null>(loaded);
  useEffect(() => {
    if (!enabled || atlas) return;
    let live = true;
    loadUsAtlas().then(
      (a) => live && setAtlas(a),
      () => live && setAtlas("error"),
    );
    return () => {
      live = false;
    };
  }, [enabled, atlas]);
  return enabled ? atlas : null;
}
