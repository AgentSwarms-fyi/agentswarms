// What a race-weekend dashboard needs from the BI layer (R500): cards filled
// from templates, the options behind the new visuals surviving a save, team
// colours taken from the rows, medal colours on table rules, a dashboard that
// stays dark for every viewer, and patterns that are only ever a faint image.
import { describe, expect, it } from "vitest";

import { seriesColors } from "@/components/bi/biChartData";
import type { ChartSpec } from "@/lib/biAgent";
import { cardLine, cardLines, ordinal, templateColumns } from "@/lib/biCardTemplate";
import { condColorHex, ruleFill } from "@/lib/biChartMath";
import {
  dashSurfaceClass,
  dashSurfaceStyle,
  hexColor,
  parseDashTheme,
  patternUrl,
  sanitizePublicWidgets,
  widgetAccentColor,
} from "@/lib/biDashboards";
import {
  VISUAL_OPTS_DEFAULT,
  visualAnalytics,
  visualOptsFrom,
  visualSpec,
} from "@/lib/biVisualOpts";

const fmt = (v: unknown) => String(v);
const winner = {
  finish_position: 1,
  given_name: "Lando",
  family_name: "Norris",
  race_time: "1:35:23.504",
  points: 25,
};

describe("card templates", () => {
  it("fills names, bolds, and writes ordinals", () => {
    expect(cardLine("**{{finish_position|ordinal}}** Place", winner, fmt)).toEqual([
      { text: "1st", bold: true },
      { text: " Place", bold: false },
    ]);
    expect(cardLine("{{given_name}} **{{family_name}}**", winner, fmt)).toEqual([
      { text: "Lando ", bold: false },
      { text: "Norris", bold: true },
    ]);
    expect(cardLines("{{race_time}}\n**{{points}}** points\n\n", winner, fmt)).toEqual([
      [{ text: "1:35:23.504", bold: false }],
      [
        { text: "25", bold: true },
        { text: " points", bold: false },
      ],
    ]);
  });

  it("says 1st, 2nd, 3rd, 11th, 12th, 13th, 21st and 22nd", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "101st",
      "111th",
    ]);
  });

  it("leaves a name the row does not have, and an unmatched ** plain", () => {
    expect(cardLine("{{nope}} won", winner, fmt)).toEqual([{ text: "{{nope}} won", bold: false }]);
    expect(cardLine("**{{family_name}}", winner, fmt)).toEqual([{ text: "Norris", bold: false }]);
    expect(templateColumns("{{a}} and {{ b | ordinal }}")).toEqual(["a", "b"]);
  });

  it("never produces markup — a value with tags stays text", () => {
    const segs = cardLine("{{given_name}}", { given_name: "<img src=x onerror=alert(1)>" }, fmt);
    expect(segs).toEqual([{ text: "<img src=x onerror=alert(1)>", bold: false }]);
  });
});

describe("the new visuals' options survive a save", () => {
  const fields = {
    xField: "lap",
    yField: "position",
    seriesField: "code",
    nameField: "team",
    valueField: "points",
  };

  it("round-trips cards", () => {
    const o = {
      ...VISUAL_OPTS_DEFAULT,
      cardsLayout: "rows" as const,
      imageField: "badge",
      iconFields: ["flag"],
      title: "**{{family_name}}**",
      lead: "{{position}}",
      value: "{{points}} pts",
      max: "3",
    };
    const spec = visualSpec("cards", o, fields)!;
    expect(spec).toEqual({
      type: "cards",
      layout: "rows",
      imageField: "badge",
      iconFields: ["flag"],
      heading: undefined,
      title: "**{{family_name}}**",
      body: undefined,
      lead: "{{position}}",
      value: "{{points}} pts",
      max: 3,
    });
    expect(visualOptsFrom(spec)).toMatchObject({
      cardsLayout: "rows",
      imageField: "badge",
      iconFields: ["flag"],
      title: "**{{family_name}}**",
      max: "3",
    });
    // No title, no cards.
    expect(visualSpec("cards", VISUAL_OPTS_DEFAULT, fields)).toBeNull();
  });

  it("builds a range, a rank chart and radial bars from the right fields", () => {
    expect(
      visualSpec(
        "range",
        {
          ...VISUAL_OPTS_DEFAULT,
          categoryField: "family_name",
          startField: "grid",
          endField: "finish",
        },
        fields,
      ),
    ).toEqual({
      type: "range",
      categoryField: "family_name",
      startField: "grid",
      endField: "finish",
      labelField: undefined,
      higherIsBetter: undefined,
    });
    expect(visualSpec("bump", VISUAL_OPTS_DEFAULT, fields)).toEqual({
      type: "bump",
      xField: "lap",
      yField: "position",
      seriesField: "code",
    });
    expect(visualSpec("radialbar", VISUAL_OPTS_DEFAULT, fields)).toEqual({
      type: "radialbar",
      nameField: "team",
      valueField: "points",
    });
  });

  it("adds colour, end labels and bands only where they draw", () => {
    const o = {
      ...VISUAL_OPTS_DEFAULT,
      colorField: "team_color",
      endLabels: true,
      bands: [
        { from: "18", to: "28", label: "Pit stops" },
        { from: "", to: "5", label: "half-filled" },
      ],
    };
    expect(visualAnalytics("line", o)).toEqual({
      colorField: "team_color",
      endLabels: true,
      xBands: [{ from: 18, to: 28, label: "Pit stops" }],
    });
    expect(visualAnalytics("bump", o)).toEqual({
      colorField: "team_color",
      xBands: [{ from: 18, to: 28, label: "Pit stops" }],
    });
    expect(visualAnalytics("bar", o)).toEqual({});
    const saved = {
      type: "line",
      xField: "round",
      yField: "pts",
      ...visualAnalytics("line", o),
    } as ChartSpec;
    expect(visualOptsFrom(saved).bands).toEqual([{ from: "18", to: "28", label: "Pit stops" }]);
  });
});

describe("colours from the rows", () => {
  it("takes each series' first valid colour and ignores anything else", () => {
    const c = seriesColors(
      [
        { code: "NOR", team_color: "#FF8000" },
        { code: "NOR", team_color: "#000000" },
        { code: "VER", team_color: "red" },
        { code: "ANT", team_color: "#27F4D2" },
      ],
      "code",
      "team_color",
    );
    expect([...c.entries()]).toEqual([
      ["NOR", "#FF8000"],
      ["ANT", "#27F4D2"],
    ]);
    expect(seriesColors([{ code: "X" }], "code", undefined).size).toBe(0);
  });

  it("gives table rules medal colours and any #rrggbb", () => {
    expect(condColorHex("gold")).toBe("#D4AF37");
    expect(condColorHex("#123abc")).toBe("#123abc");
    expect(condColorHex("url(javascript:x)")).toBeUndefined();
    expect(ruleFill({ op: "eq", value: 1, color: "bronze" })?.fg).toBe("#CD7F32");
  });
});

describe("a dashboard that stays dark", () => {
  it("keeps only a dark mode and a #rrggbb canvas colour", () => {
    expect(parseDashTheme({ mode: "dark", page: "#000000" })).toEqual({
      mode: "dark",
      page: "#000000",
    });
    expect(parseDashTheme({ mode: "light", page: "black;background:url(x)" })).toEqual({});
    expect(dashSurfaceClass({ mode: "dark" })).toBe("dark bg-background text-foreground");
    expect(dashSurfaceClass({})).toBe("");
    expect(dashSurfaceStyle({ page: "#0a0a0a" }).backgroundColor).toBe("#0a0a0a");
  });

  it("draws patterns as a faint SVG and refuses a colour that is not one", () => {
    const url = patternUrl("grid", "#e10600");
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = atob(url.split(",")[1]);
    expect(svg).toContain('stroke="#e10600"');
    expect(svg).toContain('stroke-opacity="0.18"');
    expect(atob(patternUrl("fine", '"/><script>').split(",")[1])).toContain('stroke="#e10600"');
  });

  it("resolves accents and title colours, refusing anything but #rrggbb", () => {
    expect(widgetAccentColor("rose")).toBe("#E15759");
    expect(widgetAccentColor("#E10600")).toBe("#E10600");
    expect(widgetAccentColor("expression(alert(1))")).toBe("");
    expect(hexColor(" #abcdef ")).toBe("#abcdef");
    expect(hexColor("#abc")).toBeUndefined();
  });

  it("keeps a text block's style on public pages, and nothing it should not", () => {
    const [w] = sanitizePublicWidgets([
      { id: "t", kind: "text", title: "T", text: "# Race", textStyle: { size: "3xl" }, sql: "x" },
    ]);
    expect(w.textStyle).toEqual({ size: "3xl" });
    expect(w.sql).toBeUndefined();
  });
});
