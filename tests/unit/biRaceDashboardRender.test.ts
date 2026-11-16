// How the race-weekend dashboard draws (R500), each case found while building
// the Grand Prix sample in the UI: rank lines from change points, typed line
// breaks, names at line ends that do not sit on top of each other, narratives
// about amounts rather than ranks, and edits that keep a card's appearance.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  fillRanks,
  hardBreaks,
  lastPoints,
  spreadLabels,
  visualFields,
} from "@/components/bi/biDrawHelpers";
import type { ChartSpec } from "@/lib/biAgent";
import { editorCarried, type BiWidget } from "@/lib/biDashboards";
import { suggestNarratives } from "@/lib/biInsights";

describe("rank lines from change points", () => {
  it("holds each rank until it changes, sorted by lap, and draws nothing outside a series", () => {
    const data = [
      { lap: 3, NOR: 1, VER: 2 },
      { lap: 1, NOR: 2, VER: 1 },
      { lap: 2, NOR: null, VER: null },
      { lap: 5, NOR: null, VER: 3 },
      { lap: 4, NOR: 1, VER: null },
    ];
    expect(fillRanks(data, "lap", ["NOR", "VER"])).toEqual([
      { lap: 1, NOR: 2, VER: 1 },
      { lap: 2, NOR: 2, VER: 1 },
      { lap: 3, NOR: 1, VER: 2 },
      { lap: 4, NOR: 1, VER: 2 },
      // NOR's last change point was lap 4: the line stops there.
      { lap: 5, NOR: null, VER: 3 },
    ]);
  });
});

describe("text blocks keep their line breaks", () => {
  it("turns a single newline into a hard break and leaves paragraphs alone", () => {
    expect(hardBreaks("São Paulo\n71 laps")).toBe("São Paulo  \n71 laps");
    expect(hardBreaks("# Title\n\nBody")).toBe("# Title\n\nBody");
    expect(hardBreaks("one line")).toBe("one line");
  });
});

describe("names at the ends of lines", () => {
  it("leaves labels that do not collide where they are", () => {
    expect(spreadLabels([10, 50, 90], 11, 0, 200)).toEqual([10, 50, 90]);
  });

  it("spreads a cluster evenly around where it wanted to be, in the input's order", () => {
    // 262, 261, 249 points: three names wanting nearly the same pixel row.
    expect(spreadLabels([52, 50, 51], 11, 0, 200)).toEqual([62, 40, 51]);
  });

  it("keeps labels inside the plot", () => {
    expect(spreadLabels([0, 1], 11, 4, 200)).toEqual([4, 15]);
    expect(spreadLabels([100, 100], 11, 0, 100)).toEqual([89, 100]);
  });

  it("puts each name at its line's last drawn point", () => {
    const data = [
      { round: 1, Hadjar: 8, Gasly: 2 },
      { round: 2, Hadjar: 12, Gasly: null },
      { round: 3, Hadjar: 15, Gasly: "" },
    ];
    expect(
      lastPoints(data, "round", ["Hadjar", "Gasly"], (s) => s, new Map([["Hadjar", "#6692FF"]])),
    ).toEqual([
      { name: "Hadjar", x: 3, value: 15, color: "#6692FF" },
      { name: "Gasly", x: 1, value: 2, color: undefined },
    ]);
  });
});

describe("suggested narratives are about amounts", () => {
  const badge = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
  const standings = [
    { position: 1, badge, driver: "Antonelli", round: 20, points: 390 },
    { position: 2, badge, driver: "Verstappen", round: 20, points: 279 },
    { position: 3, badge, driver: "Russell", round: 20, points: 262 },
  ];
  const cols = ["position", "badge", "driver", "round", "points"];

  it("never sums a rank or a round, and never names a row by its picture", () => {
    const s = suggestNarratives(cols, standings, String);
    expect(s[0].spec.valueField).toBe("points");
    expect(s[0].spec.categoryField).toBe("driver");
    expect(s[0].text).toContain("Antonelli 390");
  });

  it("uses the visual's own measure and category first", () => {
    const rows = standings.map((r) => ({ ...r, team: r.driver === "Verstappen" ? "RB" : "MER" }));
    const s = suggestNarratives([...cols, "team"], rows, String, {}, 3, {
      measure: "points",
      category: "team",
    });
    expect(s[0].spec.categoryField).toBe("team");
    expect(s[0].text).toContain("MER 652");
  });

  it("reads the measure and category off the visual", () => {
    const line = {
      type: "line",
      xField: "round",
      yField: "total_points",
      seriesField: "family_name",
    } as ChartSpec;
    expect(visualFields(line)).toEqual({ measure: "total_points", category: "family_name" });
    const radial = { type: "radialbar", nameField: "team", valueField: "points" } as ChartSpec;
    expect(visualFields(radial)).toEqual({ measure: "points", category: "team" });
    expect(visualFields(undefined)).toEqual({});
  });
});

describe("editing a widget keeps what its menu set", () => {
  it("carries the appearance and the data mode, and invents neither", () => {
    const styled = {
      id: "w",
      kind: "chart",
      title: "Driver leaders",
      theme: { titleColor: "#e10600", titleSize: "lg" },
      query_mode: "direct",
    } as BiWidget;
    expect(editorCarried(styled)).toEqual({
      theme: { titleColor: "#e10600", titleSize: "lg" },
      query_mode: "direct",
    });
    expect(editorCarried({ id: "w", kind: "chart", title: "t" })).toEqual({});
    expect(editorCarried(null)).toEqual({});
  });

  it("is used by every editor that builds a widget field by field", () => {
    const read = (p: string) => readFileSync(path.join(__dirname, "../..", p), "utf8");
    const builder = read("src/components/bi/BiBuilderPane.tsx");
    // The SQL/fields path and the ontology path both build a fresh object.
    expect(builder.match(/\.\.\.editorCarried\(initial\)/g)?.length).toBe(2);
    const route = read("src/routes/_authenticated/bi_.$dashboardId.tsx");
    expect(route).toMatch(/kind: "image",[\s\S]{0,400}\.\.\.editorCarried\(initial\)/);
  });
});
