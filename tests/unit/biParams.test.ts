// Dashboard parameters, the point map, the road of pins and the figures
// sentence (R501) — each found missing while rebuilding a bike-share
// dashboard over the lakehouse.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  categoryColors,
  fitView,
  pinPath,
  project,
  roadPoints,
  stopsAlong,
  tileUrl,
  toScreen,
  visibleTiles,
} from "@/components/bi/biDrawHelpers";
import { DASH_FONTS, parseFilters } from "@/lib/biDashboards";
import { computeInsight } from "@/lib/biInsights";
import {
  atDefaults,
  defaultParamValues,
  joinFiltersColumn,
  paramNamesIn,
  parseOptionLines,
  parseParams,
  resolveParamValues,
  substituteParams,
  usesParams,
} from "@/lib/biParams";
import { rejectPublicValue } from "@/lib/publicConfig";

const saved = [
  { id: "f1", label: "Area", column: "area", kind: "select" },
  {
    id: "p1",
    kind: "param",
    name: "rider",
    label: "Group",
    control: "radio",
    options: [
      { value: "all", label: "Select all" },
      { value: "member", label: "Member" },
      { value: "it's", label: "Quoted" },
    ],
    default: "all",
    placement: "canvas",
  },
  {
    id: "p2",
    kind: "param",
    name: "date_from",
    label: "From",
    control: "date",
    default: "2025-11-01",
  },
  {
    id: "p3",
    kind: "param",
    name: "location",
    label: "by",
    control: "dropdown",
    options: [{ value: "start" }, { value: "end" }],
    default: "nope",
  },
  // Malformed: a bad name, a duplicate, a list with no options.
  {
    id: "x1",
    kind: "param",
    name: "Bad Name",
    control: "dropdown",
    options: [{ value: "a" }],
    default: "a",
  },
  { id: "x2", kind: "param", name: "rider", control: "date", default: "2025-01-01" },
  { id: "x3", kind: "param", name: "empty", control: "radio", options: [], default: "" },
];

describe("parameters are read from the saved filter list", () => {
  const params = parseParams(saved);

  it("keeps only well-formed parameters, and filters stay filters", () => {
    expect(params.map((p) => p.name)).toEqual(["rider", "date_from", "location"]);
    expect(parseFilters(saved as never).map((f) => f.id)).toEqual(["f1"]);
    expect(params[2].options?.[0]).toEqual({ value: "start", label: "start" });
    // A default that is not one of the choices becomes the first choice.
    expect(params[2].default).toBe("start");
    expect(params[0].placement).toBe("canvas");
    expect(params[1].placement).toBe("bar");
  });

  it("saves filters and parameters in one list that reads back the same", () => {
    const column = joinFiltersColumn(parseFilters(saved as never), params);
    expect(parseParams(column)).toEqual(params);
    expect(parseFilters(column as never).length).toBe(1);
  });

  it("turns typed choices into options", () => {
    expect(parseOptionLines("all | Select all\nmember\n  \n | nothing")).toEqual([
      { value: "all", label: "Select all" },
      { value: "member", label: "member" },
    ]);
  });
});

describe("a picked value reaches SQL only as one of the owner's values", () => {
  const params = parseParams(saved);

  it("falls back to the default for anything not allowed", () => {
    const v = resolveParamValues(params, {
      rider: "x' OR 1=1 --",
      date_from: "2026-02-30",
      location: "end",
      unknown: "x",
    });
    expect(v).toEqual({ rider: "all", date_from: "2025-11-01", location: "end" });
    expect(resolveParamValues(params, "not an object")).toEqual(defaultParamValues(params));
  });

  it("writes quoted literals, and a date as a DATE", () => {
    const sql =
      "SELECT * FROM t WHERE ({{rider}} = 'all' OR rider_type = {{ rider }}) " +
      "AND d >= {{date_from}} AND k = '{{location}}' AND z = {{nobody}}";
    expect(
      substituteParams(sql, params, { rider: "member", date_from: "2026-06-01", location: "end" }),
    ).toBe(
      "SELECT * FROM t WHERE ('member' = 'all' OR rider_type = 'member') " +
        "AND d >= DATE '2026-06-01' AND k = 'end' AND z = {{nobody}}",
    );
    // An option holding a quote is escaped, not closed early.
    expect(substituteParams("x = {{rider}}", params, { rider: "it's" })).toBe("x = 'it''s'");
    // A value that slipped past resolve is still replaced by the default.
    expect(substituteParams("x = {{rider}}", params, { rider: "1; DROP TABLE t" })).toBe(
      "x = 'all'",
    );
  });

  it("knows which queries read a parameter, and when they are at the defaults", () => {
    expect(paramNamesIn("a {{rider}} b {{ date_from }} c {{rider}}")).toEqual([
      "rider",
      "date_from",
    ]);
    expect(usesParams("SELECT 1", params)).toBe(false);
    expect(usesParams("WHERE x = {{location}}", params)).toBe(true);
    const sql = "WHERE r = {{rider}}";
    expect(atDefaults(sql, params, { rider: "all", location: "end" })).toBe(true);
    expect(atDefaults(sql, params, { rider: "member" })).toBe(false);
  });
});

describe("a sentence of figures", () => {
  const rows = [{ rides: 25207936, electric: 16105496, classic: 9102440, rides_2026: 7 }];
  const f = { value: (n: number) => n.toLocaleString("en-US") };

  it("fills each column's total, by name", () => {
    const r = computeInsight(
      {
        kind: "figures",
        valueField: "rides",
        template:
          "About {{rides}} rides, {{electric}} electric; {{rides_2026}} in 2026 over {{rows}} row.",
      },
      rows,
      f,
    );
    expect(r.ok && r.lead.map((p) => p.text).join("")).toBe(
      "About 25,207,936 rides, 16,105,496 electric; 7 in 2026 over 1 row.",
    );
  });

  it("names every figure when there is no sentence, and needs no date", () => {
    const r = computeInsight({ kind: "figures", valueField: "rides", label: "Rides" }, rows, f);
    expect(r.ok && r.lead.map((p) => p.text).join("")).toBe(
      "Rides 25,207,936, Electric 16,105,496, Classic 9,102,440, Rides 2026 7",
    );
    const none = computeInsight({ kind: "figures", valueField: "name" }, [{ name: "x" }], f);
    expect(none.ok).toBe(false);
  });
});

describe("the point map's geometry", () => {
  it("projects the world onto a 256-pixel square", () => {
    expect(project(0, 0).map((n) => Math.round(n))).toEqual([128, 128]);
    expect(project(-180, 0)[0]).toBe(0);
  });

  it("fits the points, and a lone point gets a street-level zoom", () => {
    const pts = [project(-74.0, 40.7), project(-73.9, 40.85)];
    const v = fitView(pts, 600, 400, 20);
    for (const p of pts) {
      const [x, y] = toScreen(p, v, 600, 400);
      expect(x).toBeGreaterThanOrEqual(19.9);
      expect(x).toBeLessThanOrEqual(580.1);
      expect(y).toBeGreaterThanOrEqual(19.9);
      expect(y).toBeLessThanOrEqual(380.1);
    }
    expect(fitView([project(-74, 40.7)], 600, 400).zoom).toBe(14);
  });

  it("covers the view with tiles, wrapping across the date line", () => {
    const tiles = visibleTiles({ zoom: 1, cx: 128, cy: 128 }, 1024, 512);
    expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([1]));
    expect(tiles.every((t) => t.x >= 0 && t.x < 2 && t.y >= 0 && t.y < 2)).toBe(true);
    expect(tileUrl("https://t/{z}/{x}/{y}.png", { z: 3, x: 2, y: 1 })).toBe("https://t/3/2/1.png");
  });

  it("colours by category, or by the column's own colours", () => {
    const pal = ["#111111", "#222222"];
    expect([...categoryColors(["b", "a", "b"], pal)]).toEqual([
      ["b", "#111111"],
      ["a", "#222222"],
    ]);
    expect(categoryColors(["#27F4D2", "#E8002D"], pal).get("#E8002D")).toBe("#E8002D");
  });
});

describe("the road of pins", () => {
  it("winds from bottom left to top right, with pins evenly along it", () => {
    const road = roadPoints(1000, 600);
    expect(road[0][1]).toBeGreaterThan(road[road.length - 1][1]);
    const stops = stopsAlong(road, 7);
    expect(stops).toHaveLength(7);
    // The top stretch leaves room for the largest pin above it.
    expect(Math.min(...road.map((p) => p[1]))).toBeGreaterThanOrEqual(56 * 2.75 + 6);
    expect(pinPath(100, 200, 10)).toMatch(/^M100\.0 200\.0 L.* A10\.0 10\.0 0 1 1 .* Z$/);
  });
});

describe("settings and wiring", () => {
  it("offers a handwritten font from the viewer's own system", () => {
    expect(DASH_FONTS.hand.stack).toContain("cursive");
    expect(DASH_FONTS.hand.stack).not.toMatch(/url\(|https?:/);
  });

  it("takes a tile server only as a {z}/{x}/{y} http(s) template", () => {
    expect(
      rejectPublicValue("mapTilesUrl", "https://tiles.example.com/{z}/{x}/{y}.png"),
    ).toBeNull();
    expect(rejectPublicValue("mapTilesUrl", "https://tiles.example.com/tile.png")).not.toBeNull();
    expect(rejectPublicValue("mapTilesUrl", "javascript:{z}{x}{y}")).not.toBeNull();
    expect(rejectPublicValue("mapTilesAttribution", "© OpenStreetMap contributors")).toBeNull();
    expect(rejectPublicValue("mapTilesAttribution", "<script>")).not.toBeNull();
  });

  const read = (p: string) => readFileSync(path.join(__dirname, "../..", p), "utf8");

  it("runs a live widget with the dashboard's own definitions, on any page", () => {
    const route = read("src/routes/api/bi.direct-query.ts");
    expect(route).toContain('.select("id, user_id, widgets, pages, filters")');
    expect(route).toMatch(/resolveParamValues\(params, body\.params\)/);
    expect(route).toMatch(/baseSql: widgetSql/);
    // A masked viewer gets the defaults.
    expect(route).toMatch(/maskedColumns\.length > 0 && paramsUsed\s*\?\s*defaultParamValues/);
  });

  it("refreshes and alerts at the defaults", () => {
    const refresh = read("src/utils/bi/refresh.server.ts");
    expect(refresh.match(/widgetQuerySql\(\s*withParams\(w\)/g)?.length).toBe(2);
    expect(refresh).toMatch(/const widget = await withParamDefaults\(found\);/);
  });
});
