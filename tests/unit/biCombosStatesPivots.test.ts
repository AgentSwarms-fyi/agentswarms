// R506: combos with several measures, maps of US states, pivots with several
// measures — the rules behind each, run as shipped, and how the builder's
// options become specs and back.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { COUNTRY_INDEX } from "@/components/bi/countryAtlas";
import { buildUsAtlas, loadUsAtlas } from "@/components/bi/usAtlas";
import { COMBO_LINE, comboColor, comboSeries } from "@/components/bi/biDrawHelpers";
import type { ChartSpec } from "@/lib/biAgent";
import { assignChartFields, mainMeasures, takesExtraMeasures } from "@/lib/biFieldQuery";
import { buildPivot, pivotTotalKind } from "@/lib/biPivot";
import {
  VISUAL_OPTS_DEFAULT,
  comboShape,
  mapRegion,
  visualOptsFrom,
  type VisualOpts,
} from "@/lib/biVisualOpts";
import { US_STATES, US_STATE_ALIASES, chooseMapRegion, resolveUsState } from "@/lib/usStateMatch";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const opts = (patch: Partial<VisualOpts>): VisualOpts => ({ ...VISUAL_OPTS_DEFAULT, ...patch });

/** The `state` column of the bundled claims sample, one value per row. */
function claimStates(): string[] {
  const [head, ...lines] = read("src/assets/sample-data/auto_claims_history.csv")
    .trim()
    .split(/\r?\n/);
  const at = head.split(",").indexOf("state");
  return lines.map((l) => l.split(",")[at]);
}

describe("a US state from a location value", () => {
  const name = (raw: unknown) => resolveUsState(raw)?.name ?? null;

  it("takes names, postal codes, ISO 3166-2 and FIPS codes", () => {
    expect(name("New York")).toBe("New York");
    expect(name("  new york ")).toBe("New York");
    expect(name("NY")).toBe("New York");
    expect(name("ny")).toBe("New York");
    expect(name("US-NY")).toBe("New York");
    expect(name("36")).toBe("New York");
    // A spreadsheet drops California's leading zero.
    expect(name("6")).toBe("California");
    expect(name(6)).toBe("California");
  });

  it("knows the ways Washington DC and the state of Washington are written", () => {
    expect(name("D.C.")).toBe("District of Columbia");
    expect(name("Washington, D.C.")).toBe("District of Columbia");
    expect(name("Washington")).toBe("Washington");
    expect(name("Washington State")).toBe("Washington");
  });

  it("matches nothing it cannot draw rather than guessing", () => {
    // Territories have no shape on the map: unmatched, and counted.
    expect(name("Puerto Rico")).toBeNull();
    expect(name("PR")).toBeNull();
    expect(name("72")).toBeNull();
    expect(name("XX")).toBeNull();
    expect(name("US-XX")).toBeNull();
    expect(name("")).toBeNull();
    expect(name(null)).toBeNull();
    expect(name(undefined)).toBeNull();
  });

  it("every alias names a listed state", () => {
    const names = new Set(US_STATES.map((s) => s.name.toLowerCase()));
    for (const target of Object.values(US_STATE_ALIASES)) expect(names.has(target)).toBe(true);
  });
});

describe("the US atlas", () => {
  it("draws exactly the 50 states and DC the matcher lists, keyed by FIPS", async () => {
    const atlas = await loadUsAtlas();
    expect(atlas.shapes).toHaveLength(51);
    for (const s of US_STATES) {
      const shape = atlas.byFips.get(s.fips);
      expect(shape?.name, s.usps).toBe(s.name);
      expect(shape?.d.length).toBeGreaterThan(20);
    }
  });

  it("keeps every shape and centre inside the 975 × 610 canvas", async () => {
    const atlas = await loadUsAtlas();
    for (const s of atlas.shapes) {
      const [x, y] = s.centroid;
      expect(x, s.name).toBeGreaterThan(0);
      expect(x, s.name).toBeLessThan(975);
      expect(y, s.name).toBeGreaterThan(0);
      expect(y, s.name).toBeLessThan(610);
    }
  });

  it("skips a feature with no name or id instead of drawing it nameless", () => {
    const topo = JSON.parse(read("node_modules/us-atlas/states-albers-10m.json"));
    topo.objects.states.geometries[0].properties = {};
    expect(buildUsAtlas(topo).shapes).toHaveLength(50);
  });
});

describe("which map a location column is drawn on", () => {
  it("draws the claims sample's state codes on the US map", () => {
    // FOUND building R506: on the world map seven of these twelve codes are
    // also countries — AZ, CA, CO, GA, IL, MA, NC — so claims landed in
    // Azerbaijan, Gabon and Israel, and Florida, New York, Ohio, Texas and
    // Washington were "not matched". Any field name, even a vague one.
    const states = claimStates();
    expect(new Set(states).size).toBe(12);
    expect(chooseMapRegion(states, COUNTRY_INDEX, "location")).toBe("us");
    expect(states.every((s) => resolveUsState(s))).toBe(true);
  });

  it("keeps country names and country codes on the world map", () => {
    const names = ["Germany", "France", "Brazil", "Japan", "Georgia", "India"];
    expect(chooseMapRegion(names, COUNTRY_INDEX, "country")).toBe("world");
    const codes = ["US", "GB", "DE", "FR", "IN", "CN", "JP", "BR"];
    expect(chooseMapRegion(codes, COUNTRY_INDEX, "code")).toBe("world");
  });

  it("draws full state names on the US map", () => {
    const names = ["Texas", "Ohio", "Georgia", "New York", "Washington"];
    expect(chooseMapRegion(names, COUNTRY_INDEX, "region")).toBe("us");
  });

  it("leaves a tie on the world map unless the column is named for states", () => {
    // Three states, and three countries: Canada, Colombia, Gabon.
    const tie = ["CA", "CO", "GA"];
    expect(chooseMapRegion(tie, COUNTRY_INDEX, "code")).toBe("world");
    expect(chooseMapRegion(tie, COUNTRY_INDEX, "state")).toBe("us");
    expect(chooseMapRegion(tie, COUNTRY_INDEX, "billing_state")).toBe("us");
    expect(chooseMapRegion(tie, COUNTRY_INDEX, "state_or_country")).toBe("world");
  });

  it("needs nearly every value to be a state", () => {
    expect(chooseMapRegion(["TX", "OH", "Mars", "Venus"], COUNTRY_INDEX, "state")).toBe("world");
    expect(chooseMapRegion([], COUNTRY_INDEX, "state")).toBe("world");
    expect(chooseMapRegion([null, "", " "], COUNTRY_INDEX, "state")).toBe("world");
  });

  it("is chosen in the map, and the owner's choice wins", () => {
    const geo = read("src/components/bi/BiGeoMap.tsx");
    expect(geo).toMatch(/region \?\?\s*chooseMapRegion\(/);
    const render = read("src/components/bi/BiChartRender.tsx");
    expect(render).toMatch(/<BiGeoMap[\s\S]{0,400}region=\{/);
  });
});

describe("a combo's bars and lines", () => {
  const rows = [{ month: "Jan", sales: 1, cost: 2, margin: 3, orders: 4, target: 5 }];

  it("draws the bar and line fields first, then each extra as bars unless named a line", () => {
    expect(
      comboSeries(
        {
          barField: "sales",
          lineField: "margin",
          extraMeasures: ["cost", "target", "orders"],
          extraLines: ["target"],
        },
        rows,
      ),
    ).toEqual({ bars: ["sales", "cost", "orders"], lines: ["margin", "target"] });
  });

  it("skips a repeated measure and one no row carries", () => {
    expect(
      comboSeries(
        { barField: "sales", lineField: "margin", extraMeasures: ["sales", "margin", "gone", ""] },
        rows,
      ),
    ).toEqual({ bars: ["sales"], lines: ["margin"] });
  });

  it("keeps a one-measure combo's colours and gives every other series its own", () => {
    expect(comboColor("bar", 0, 3)).toBe("var(--primary)");
    expect(comboColor("line", 0, 3)).toBe(COMBO_LINE);
    const all = [
      comboColor("bar", 0, 3),
      comboColor("bar", 1, 3),
      comboColor("bar", 2, 3),
      comboColor("line", 0, 3),
      comboColor("line", 1, 3),
      comboColor("line", 2, 3),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(all.slice(1).filter((c) => c === COMBO_LINE)).toHaveLength(1);
  });

  it("round-trips the builder's options through the spec", () => {
    const shape = comboShape(
      opts({ comboLines: ["target", "dropped"], stackBars: true, linesLeft: true }),
      ["cost", "target"],
    );
    expect(shape).toEqual({ extraLines: ["target"], stackBars: true, lineAxis: "left" });
    expect(comboShape(VISUAL_OPTS_DEFAULT, ["cost"])).toEqual({
      extraLines: undefined,
      stackBars: undefined,
      lineAxis: undefined,
    });
    const spec = {
      type: "combo",
      xField: "month",
      barField: "sales",
      lineField: "margin",
      extraMeasures: ["cost", "target"],
      ...shape,
    } as ChartSpec;
    const back = visualOptsFrom(spec);
    expect(back.comboLines).toEqual(["target"]);
    expect(back.stackBars).toBe(true);
    expect(back.linesLeft).toBe(true);
  });

  it("draws one bar and one line from a combo saved before R506, as it did", () => {
    expect(comboSeries({ barField: "sales", lineField: "margin" }, rows)).toEqual({
      bars: ["sales"],
      lines: ["margin"],
    });
    const render = read("src/components/bi/BiChartRender.tsx");
    // Without a right-hand line the axis is not drawn at all.
    expect(render).toMatch(/\{!linesLeft && \(\s*<YAxis\s+yAxisId="right"/);
  });
});

describe("the map's area option", () => {
  it("saves nothing for automatic, and the owner's choice otherwise", () => {
    expect(mapRegion(VISUAL_OPTS_DEFAULT)).toEqual({});
    expect(mapRegion(opts({ region: "us" }))).toEqual({ region: "us" });
    expect(mapRegion(opts({ region: "world" }))).toEqual({ region: "world" });
    const spec = { type: "map", locationField: "state", valueField: "loss", region: "us" };
    expect(visualOptsFrom(spec as ChartSpec).region).toBe("us");
    const old = { type: "bubblemap", locationField: "country", valueField: "n" };
    expect(visualOptsFrom(old as ChartSpec).region).toBe("auto");
  });
});

describe("which charts take more measures, and from Fields mode", () => {
  it("lets combos and pivots take them, never split by a series", () => {
    expect(takesExtraMeasures("combo", "region")).toBe(true);
    expect(takesExtraMeasures("matrix", "region")).toBe(true);
    expect(takesExtraMeasures("bar", "")).toBe(true);
    expect(takesExtraMeasures("bar", "region")).toBe(false);
    expect(takesExtraMeasures("pie", "")).toBe(false);
    const f = { yField: "y", lineField: "l", valueField: "v" };
    expect(mainMeasures("combo", f)).toEqual(["y", "l"]);
    expect(mainMeasures("matrix", f)).toEqual(["v"]);
    expect(mainMeasures("line", f)).toEqual(["y"]);
  });

  it("gives a combo's third value on, and a pivot's second on, as extra measures", () => {
    const out = {
      dims: ["month", "area"],
      measures: ["rides", "avg_minutes", "electric", "members"],
      labels: {},
    };
    expect(assignChartFields("combo", out)).toMatchObject({
      xField: "month",
      yField: "rides",
      lineField: "avg_minutes",
      extraMeasures: ["electric", "members"],
    });
    expect(assignChartFields("matrix", out)).toMatchObject({
      rowField: "month",
      colField: "area",
      valueField: "rides",
      extraMeasures: ["avg_minutes", "electric", "members"],
    });
    const two = { dims: ["month"], measures: ["rides", "avg_minutes"], labels: {} };
    expect(assignChartFields("combo", two).extraMeasures).toBeUndefined();
  });
});

describe("a pivot's totals", () => {
  it("adds sums and counts, and never an average, rate, percentage or distinct count", () => {
    expect(pivotTotalKind("rides")).toBe("sum");
    expect(pivotTotalKind("count_rides")).toBe("sum");
    expect(pivotTotalKind("avg_minutes")).toBe("none");
    expect(pivotTotalKind("margin")).toBe("none");
    expect(pivotTotalKind("electric_share")).toBe("none");
    expect(pivotTotalKind("distinct_riders")).toBe("none");
    expect(pivotTotalKind("rides", "percent")).toBe("none");
    expect(pivotTotalKind("min_minutes")).toBe("min");
    expect(pivotTotalKind("max_minutes")).toBe("max");
  });

  const rows = [
    { area: "North", rider: "member", rides: 10, avg_minutes: 12, max_minutes: 40 },
    { area: "North", rider: "casual", rides: 5, avg_minutes: 20, max_minutes: 90 },
    { area: "South", rider: "member", rides: 7, avg_minutes: 9, max_minutes: 30 },
  ];

  it("gives each measure its cells and the totals it can have", () => {
    const pv = buildPivot(rows, {
      rowField: "area",
      colField: "rider",
      valueField: "rides",
      extraMeasures: ["avg_minutes", "max_minutes"],
    });
    expect(pv.measures).toEqual(["rides", "avg_minutes", "max_minutes"]);
    expect(pv.rowKeys).toEqual(["North", "South"]);
    expect(pv.colKeys).toEqual(["member", "casual"]);
    expect(pv.cell("North", "casual", "avg_minutes")).toBe(20);
    expect(pv.cell("South", "casual", "rides")).toBeUndefined();
    // Sums add up …
    expect(pv.rowTotal("North", "rides")).toBe(15);
    expect(pv.colTotal("member", "rides")).toBe(17);
    expect(pv.grand("rides")).toBe(22);
    // … an average of one cell is that cell; of several, no total …
    expect(pv.rowTotal("South", "avg_minutes")).toBe(9);
    expect(pv.rowTotal("North", "avg_minutes")).toBeNull();
    expect(pv.grand("avg_minutes")).toBeNull();
    // … and the highest of the highest is the highest.
    expect(pv.rowTotal("North", "max_minutes")).toBe(90);
    expect(pv.grand("max_minutes")).toBe(90);
  });

  it("colours each measure against its own range", () => {
    const pv = buildPivot(rows, {
      rowField: "area",
      colField: "rider",
      valueField: "rides",
      extraMeasures: ["avg_minutes"],
    });
    expect(pv.extent("rides")).toEqual({ min: 5, max: 10 });
    expect(pv.extent("avg_minutes")).toEqual({ min: 9, max: 20 });
  });

  it("gives a group no average when its rows have several, and a percentage no total", () => {
    const pv = buildPivot(rows, {
      rowField: "area",
      colField: "area",
      valueField: "avg_minutes",
      rowSubField: "rider",
    });
    expect(pv.leaf("North", "member", "North", "avg_minutes")).toBe(12);
    expect(pv.cell("North", "North", "avg_minutes")).toBeNull();
    const pct = buildPivot(rows, {
      rowField: "area",
      colField: "rider",
      valueField: "rides",
      formatOf: () => "percent",
    });
    expect(pct.grand("rides")).toBeNull();
  });

  it("draws one measure as it always did, and skips extras no row carries", () => {
    const pv = buildPivot(rows, {
      rowField: "area",
      colField: "rider",
      valueField: "rides",
      extraMeasures: ["rides", "gone"],
    });
    expect(pv.measures).toEqual(["rides"]);
  });

  it("is what the pivot draws, with each measure's formats and the table's icons", () => {
    const parts = read("src/components/bi/BiChartParts.tsx");
    expect(parts).toMatch(/buildPivot\(rows,/);
    expect(parts).toMatch(/COND_ICONS\[rule\.icon\]/);
    const render = read("src/components/bi/BiChartRender.tsx");
    expect(render).toMatch(/<MatrixTable[\s\S]{0,400}extraMeasures=\{chart\.extraMeasures\}/);
    expect(render).toMatch(/<MatrixTable[\s\S]{0,400}columnFormats=\{chart\.columnFormats\}/);
    const builder = read("src/components/bi/BiBuilderPane.tsx");
    expect(builder).toMatch(/spec\.type === "table" \|\| spec\.type === "matrix"/);
    // One icon map for tables and pivots.
    expect(read("src/components/bi/BiWidgetCard.tsx")).not.toMatch(/const COND_ICONS/);
  });
});

describe("the docs", () => {
  it("explain each of the three, and the index finds them", () => {
    const page = read("src/routes/docs.bi.tsx");
    const index = read("src/components/docs/docsIndex.ts");
    for (const id of ["combo-measures", "us-state-maps", "pivot-measures"]) {
      expect(page, id).toContain(`id="${id}"`);
      expect(index, id).toContain(`"${id}"`);
    }
  });
});
