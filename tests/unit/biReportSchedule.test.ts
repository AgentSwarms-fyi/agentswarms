// Scheduled report delivery (R509): the rules, the vector chart drawing, and
// the policy the database holds the server to.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import type { BiParamConfig } from "@/lib/biParams";
import {
  attachmentName,
  cadenceLabel,
  cleanSubjectLine,
  deliverySubject,
  domainPolicy,
  nextReportRun,
  parseRecipients,
  recipientVerdict,
  resolveRelativeDate,
  runClock,
  scheduledDrawProblem,
  scheduledValues,
  suggestedScheduleName,
  validateSchedule,
  zonedToUtc,
  type ReportScheduleFields,
} from "@/lib/biReportSchedule";
import {
  apply,
  crowdedTicks,
  decodeEntities,
  drawSvg,
  findAll,
  mul,
  parseCssColor,
  parseMarkup,
  parseTransform,
  PRINT_TOKENS,
  readLegend,
  ROOT_PAINT,
  shapePath,
  textContent,
  type MeasureText,
  type MElement,
} from "@/lib/svgPdf";
import { captionLines, mainSvg, narrativeText } from "@/lib/biReportCharts";

const root = path.resolve(__dirname, "../..");

const when = (over: Partial<ReportScheduleFields> = {}) => ({
  cadence: "daily" as const,
  at_hour: 8,
  weekday: 1,
  month_day: 1,
  timezone: "UTC",
  ...over,
});

describe("when a schedule runs next", () => {
  it("runs daily at the hour, today if it is still to come", () => {
    expect(nextReportRun(when(), new Date("2026-03-10T07:00:00Z")).toISOString()).toBe(
      "2026-03-10T08:00:00.000Z",
    );
    expect(nextReportRun(when(), new Date("2026-03-10T08:00:00Z")).toISOString()).toBe(
      "2026-03-11T08:00:00.000Z",
    );
  });

  it("keeps the LOCAL hour across a clock change", () => {
    // London goes to summer time on 29 March 2026: 08:00 there is 08:00Z the
    // day before and 07:00Z that morning.
    const s = when({ timezone: "Europe/London" });
    expect(nextReportRun(s, new Date("2026-03-27T09:00:00Z")).toISOString()).toBe(
      "2026-03-28T08:00:00.000Z",
    );
    expect(nextReportRun(s, new Date("2026-03-28T09:00:00Z")).toISOString()).toBe(
      "2026-03-29T07:00:00.000Z",
    );
  });

  it("resolves the hour that does not exist to the first one that does", () => {
    // 01:00 on 29 March 2026 never happens in London (01:00 GMT → 02:00 BST).
    expect(zonedToUtc(2026, 3, 29, 1, "Europe/London").toISOString()).toBe(
      "2026-03-29T01:00:00.000Z",
    );
    // An ordinary hour is exact.
    expect(zonedToUtc(2026, 7, 1, 9, "America/New_York").toISOString()).toBe(
      "2026-07-01T13:00:00.000Z",
    );
  });

  it("skips weekends on weekdays, and finds the named weekday", () => {
    // Friday 2026-03-13 after the hour → Monday 16th.
    expect(
      nextReportRun(when({ cadence: "weekdays" }), new Date("2026-03-13T09:00:00Z")).toISOString(),
    ).toBe("2026-03-16T08:00:00.000Z");
    // Weekly on Wednesday (3), from Thursday 12th → Wednesday 18th.
    expect(
      nextReportRun(
        when({ cadence: "weekly", weekday: 3 }),
        new Date("2026-03-12T00:00:00Z"),
      ).toISOString(),
    ).toBe("2026-03-18T08:00:00.000Z");
  });

  it("runs monthly on a day, or on the month's last day", () => {
    expect(
      nextReportRun(
        when({ cadence: "monthly", month_day: 1 }),
        new Date("2026-01-01T09:00:00Z"),
      ).toISOString(),
    ).toBe("2026-02-01T08:00:00.000Z");
    expect(
      nextReportRun(
        when({ cadence: "monthly", month_day: 0 }),
        new Date("2026-02-10T00:00:00Z"),
      ).toISOString(),
    ).toBe("2026-02-28T08:00:00.000Z");
    expect(
      nextReportRun(
        when({ cadence: "monthly", month_day: 0 }),
        new Date("2028-02-10T00:00:00Z"),
      ).toISOString(),
    ).toBe("2028-02-29T08:00:00.000Z");
  });

  it("reads as a sentence", () => {
    expect(cadenceLabel(when({ cadence: "weekly", weekday: 1, timezone: "Europe/London" }))).toBe(
      "Every Monday at 08:00 (Europe/London)",
    );
    expect(cadenceLabel(when({ cadence: "monthly", month_day: 0 }))).toBe(
      "On the last day of every month at 08:00 (UTC)",
    );
    expect(cadenceLabel(when({ cadence: "monthly", month_day: 2 }))).toBe(
      "On the 2nd of every month at 08:00 (UTC)",
    );
  });

  it("names a new schedule after its timing", () => {
    const t = (cadence: ReportScheduleFields["cadence"], weekday = 1, month_day = 1) =>
      suggestedScheduleName("Sales", { cadence, weekday, month_day });
    expect(t("weekly")).toBe("Sales every Monday");
    expect(t("weekly", 5)).toBe("Sales every Friday");
    expect(t("daily")).toBe("Sales every day");
    expect(t("weekdays")).toBe("Sales on weekdays");
    expect(t("monthly", 1, 0)).toBe("Sales at month end");
    expect(t("monthly", 1, 15)).toBe("Sales every month");
    // A long report name gives way; the timing, which tells schedules apart, stays.
    const long = suggestedScheduleName("x".repeat(200), {
      cadence: "daily",
      weekday: 1,
      month_day: 1,
    });
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(" every day")).toBe(true);
    expect(suggestedScheduleName("  ", { cadence: "daily", weekday: 1, month_day: 1 })).toBe(
      "Report every day",
    );
  });

  it("prints the day and time the schedule's zone reads, not the server's", () => {
    // 06:30 on the 18th in Tokyo is still the 17th in UTC: a server-local
    // {{date}} would date the report a day early.
    const at = new Date("2026-11-17T21:30:00Z");
    expect(runClock(at, "Asia/Tokyo")).toEqual({ date: "2026-11-18", time: "06:30" });
    expect(runClock(at, "UTC")).toEqual({ date: "2026-11-17", time: "21:30" });
    expect(runClock(new Date("2026-03-01T00:05:00Z"), "America/New_York")).toEqual({
      date: "2026-02-28",
      time: "19:05",
    });
  });

  it("dates the PDF's header with that clock on a server run", () => {
    const pdf = readFileSync(path.resolve(__dirname, "../../src/lib/biReportPdf.ts"), "utf8");
    expect(pdf).toMatch(/args\.clock\?\.date \?\? now\.toLocaleDateString\(\)/);
    const server = readFileSync(
      path.resolve(__dirname, "../../src/utils/bi/reportSchedule.server.ts"),
      "utf8",
    );
    expect(server).toMatch(/clock: runClock\(now, tz\)/);
    expect(server).toMatch(/const runDay = runClock\(now, tz\)\.date/);
  });
});

describe("relative dates", () => {
  const thu = { year: 2026, month: 1, day: 15 }; // a Thursday
  it.each([
    ["@today", "2026-01-15"],
    ["@yesterday", "2026-01-14"],
    ["@week_start", "2026-01-12"],
    ["@prev_week_start", "2026-01-05"],
    ["@prev_week_end", "2026-01-11"],
    ["@month_start", "2026-01-01"],
    ["@prev_month_start", "2025-12-01"],
    ["@prev_month_end", "2025-12-31"],
    ["@quarter_start", "2026-01-01"],
    ["@prev_quarter_start", "2025-10-01"],
    ["@prev_quarter_end", "2025-12-31"],
    ["@year_start", "2026-01-01"],
    ["@prev_year_start", "2025-01-01"],
    ["@prev_year_end", "2025-12-31"],
  ])("%s on 2026-01-15 is %s", (token, want) => {
    expect(resolveRelativeDate(token, thu)).toBe(want);
  });

  it("counts a Sunday in the week that started the Monday before", () => {
    expect(resolveRelativeDate("@week_start", { year: 2026, month: 1, day: 18 })).toBe(
      "2026-01-12",
    );
    expect(resolveRelativeDate("@prev_month_end", { year: 2026, month: 3, day: 2 })).toBe(
      "2026-02-28",
    );
  });

  const params: BiParamConfig[] = [
    { name: "from", control: "date", default: "2025-01-01" } as BiParamConfig,
    {
      name: "region",
      control: "dropdown",
      default: "EU",
      options: [
        { value: "EU", label: "Europe" },
        { value: "US", label: "Americas" },
      ],
    } as BiParamConfig,
  ];

  it("works the date out in the schedule's zone, on the day it runs", () => {
    // 02:00Z on 1 March is still 28 February in Los Angeles.
    const { values } = scheduledValues(
      params,
      { from: "@today" },
      new Date("2026-03-01T02:00:00Z"),
      "America/Los_Angeles",
    );
    expect(values.from).toBe("2026-02-28");
  });

  it("runs a value the report no longer accepts at its default, and says so", () => {
    const { values, fellBack } = scheduledValues(
      params,
      { region: "APAC", ghost: "x" },
      new Date("2026-03-01T00:00:00Z"),
      "UTC",
    );
    expect(values).toEqual({ from: "2025-01-01", region: "EU" });
    expect(fellBack).toEqual(["region"]);
  });
});

describe("recipients", () => {
  it("splits, lower-cases and de-duplicates, and names what is not an address", () => {
    expect(parseRecipients("A@x.com, a@x.com; b@y.org\nnot-an-address")).toEqual({
      valid: ["a@x.com", "b@y.org"],
      invalid: ["not-an-address"],
    });
    // A display name or a second address hidden in one entry is refused.
    expect(parseRecipients(["Bob <b@y.org>"]).invalid.length).toBeGreaterThan(0);
  });

  it("allows accounts, listed domains, subdomains when asked, and anything with *", () => {
    const accounts = new Set(["me@corp.example"]);
    expect(recipientVerdict(["me@corp.example", "x@else.org"], accounts, "")).toEqual({
      allowed: ["me@corp.example"],
      refused: ["x@else.org"],
    });
    const exact = domainPolicy("client.com");
    expect(exact("a@client.com")).toBe(true);
    expect(exact("a@eu.client.com")).toBe(false);
    expect(exact("a@client.com.evil.org")).toBe(false);
    const sub = domainPolicy(".client.com");
    expect(sub("a@eu.client.com")).toBe(true);
    expect(sub("a@client.com")).toBe(true);
    expect(sub("a@notclient.com")).toBe(false);
    expect(domainPolicy("*")("anyone@anywhere.net")).toBe(true);
    expect(domainPolicy(undefined)("a@b.com")).toBe(false);
  });
});

describe("a schedule as saved", () => {
  const base: ReportScheduleFields = {
    name: "Monday pack",
    enabled: true,
    cadence: "weekly",
    at_hour: 8,
    weekday: 1,
    month_day: 1,
    timezone: "Europe/London",
    recipients: ["a@b.com"],
    subject: "",
    message: "",
    param_values: {},
    skip_empty: false,
  };

  it("names what is wrong", () => {
    expect(validateSchedule(base)).toBeNull();
    expect(validateSchedule({ ...base, name: " " })).toMatch(/name/);
    expect(validateSchedule({ ...base, timezone: "Mars/Olympus" })).toMatch(/time zone/);
    expect(validateSchedule({ ...base, recipients: [] })).toMatch(/recipient/);
    expect(validateSchedule({ ...base, month_day: 31 })).toMatch(/day of the month/);
    expect(validateSchedule({ ...base, recipients: ["x"] })).toMatch(/Not an email address/);
  });

  it("puts a subject on one line, so it can carry no header", () => {
    expect(cleanSubjectLine("Sales\r\nBcc: victim@x.com")).toBe("Sales Bcc: victim@x.com");
    expect(deliverySubject("", "Monthly pack", (s) => s)).toBe("Monthly pack");
    expect(
      deliverySubject("Pack for {{region}}", "x", (s) => s.replace("{{region}}", "Europe")),
    ).toBe("Pack for Europe");
  });

  it("names the attachment after the report and the day, safely", () => {
    expect(attachmentName('Q4 "final" / v2', "2026-01-05")).toBe("Q4 final v2 2026-01-05.pdf");
  });
});

describe("the database holds the server to the policy", () => {
  const sql = readFileSync(
    path.join(root, "supabase/migrations/20261118000000_bi_report_schedules.sql"),
    "utf8",
  );

  it("lets owners read schedules and deliveries, and nobody write them from a browser", () => {
    const policies = [...sql.matchAll(/CREATE POLICY[\s\S]*?;/g)].map((m) => m[0]);
    expect(policies.length).toBe(2);
    for (const p of policies) {
      expect(p).toMatch(/FOR SELECT/);
      expect(p).not.toMatch(/FOR (ALL|INSERT|UPDATE|DELETE)/);
    }
    expect(sql).toMatch(/bi_report_schedules ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/bi_report_deliveries ENABLE ROW LEVEL SECURITY/);
  });

  it("answers the account check to the service role only", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.report_recipient_accounts\(text\[\]\) FROM public, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.report_recipient_accounts\(text\[\]\) TO service_role;/,
    );
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path = public, auth/);
  });

  it("audits a change to who a report goes to", () => {
    expect(sql).toMatch(/UPDATE OF[^;]*recipients[^;]*ON public\.bi_report_schedules/);
  });
});

describe("svg markup", () => {
  it("parses what a server render writes", () => {
    const tree = parseMarkup(
      '<div class="a"><svg width="10" height="5" viewBox="0 0 10 5"><path d="M0,0L1,1"></path>' +
        '<text x="1" y="2">A &amp; B &#x27;x&#x27;</text></svg><br><p>after</p></div>',
    );
    const svg = findAll(tree, (e) => e.tag === "svg")[0];
    expect(svg.attrs.viewBox).toBe("0 0 10 5");
    expect(findAll(tree, (e) => e.tag === "text")[0].children[0]).toBe("A & B 'x'");
    expect(findAll(tree, (e) => e.tag === "p").length).toBe(1);
    expect(decodeEntities("&lt;&#60;&quot;")).toBe('<<"');
  });

  it("reads the theme's colours as the page is printed", () => {
    const red = parseCssColor("#ff0000")!;
    expect([red.r, red.g, red.b, red.a]).toEqual([1, 0, 0, 1]);
    expect(parseCssColor("rgba(0, 0, 255, 0.5)")).toMatchObject({ b: 1, a: 0.5 });
    expect(parseCssColor("hsl(120 100% 25%)")).toMatchObject({ g: 0.5 });
    expect(parseCssColor("none")).toBeNull();
    // White in oklch is white; the theme's primary is a mid teal.
    const white = parseCssColor("oklch(1 0 0)")!;
    for (const ch of [white.r, white.g, white.b]) expect(ch).toBeCloseTo(1, 6);
    const primary = parseCssColor("var(--primary)")!;
    expect(primary.b).toBeGreaterThan(primary.r);
    expect(primary.g).toBeGreaterThan(primary.r);
    // An unknown token takes the fallback; color-mix tints toward transparent.
    expect(parseCssColor("var(--nope, #000)")).toMatchObject({ r: 0, g: 0, b: 0 });
    expect(parseCssColor("color-mix(in oklch, #ff0000 40%, transparent)")!.a).toBeCloseTo(0.4);
    expect(parseCssColor("currentColor", { r: 0, g: 1, b: 0, a: 1 })).toMatchObject({ g: 1 });
  });

  it("keeps the print palette equal to the light theme in styles.css", () => {
    const css = readFileSync(path.join(root, "src/styles.css"), "utf8");
    const lightRoot = /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1];
    for (const [token, value] of Object.entries(PRINT_TOKENS)) {
      const m = new RegExp(`--${token}:\\s*([^;]+);`).exec(lightRoot);
      expect(m?.[1]?.trim(), `--${token}`).toBe(value);
    }
  });

  it("composes transforms and rotates about a point", () => {
    const m = parseTransform("translate(10, 20) rotate(90, 5, 5)");
    const [x, y] = apply(m, 5, 0);
    expect(x).toBeCloseTo(20);
    expect(y).toBeCloseTo(25);
    const flip = mul([1, 0, 0, -1, 0, 0], [1, 0, 0, 1, 0, 3]);
    expect(apply(flip, 0, 0)).toEqual([0, -3]);
  });

  it("outlines rectangles, rounded or not, and refuses an empty one", () => {
    const sq = { tag: "rect", attrs: { x: "1", y: "2", width: "3", height: "4" }, children: [] };
    expect(shapePath(sq)).toBe("M1,2H4V6H1Z");
    const round = { ...sq, attrs: { ...sq.attrs, rx: "1" } };
    expect(shapePath(round)).toMatch(/^M2,2H3A1,1,0,0,1,4,3/);
    expect(shapePath({ ...sq, attrs: { ...sq.attrs, width: "0" } })).toBeNull();
  });

  it("draws an arc written across lines as it draws the same arc on one line", async () => {
    // Recharts writes pie and donut sectors like this. pdf-lib's tokenizer
    // read each line break as an extra 0, and the wedges came out huge and
    // off the chart.
    const multi =
      "M 404.4,150\n    A 104.4,104.4,0,\n    0,0,\n    195.74,144.53\n  L 239.18,146.81\n" +
      "            A 60.9,60.9,0,\n            0,1,\n            360.9,150 Z";
    const oneLine = multi.replace(/\s+/g, " ");
    expect(shapePath({ tag: "path", attrs: { d: multi }, children: [] })).toBe(oneLine.trim());
    const draw = async (d: string) => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([400, 400]);
      const regular = await pdf.embedFont(StandardFonts.Helvetica);
      const svg = parseMarkup(
        `<svg width="600" height="300"><path fill="#4E79A7" d="${d}"></path></svg>`,
      ).children[0] as MElement;
      drawSvg({ page, regular, bold: regular, encode: (s) => s }, svg, {
        x: 0,
        top: 400,
        w: 400,
        h: 200,
      });
      const bytes = await pdf.save({ useObjectStreams: false });
      return Buffer.from(bytes)
        .toString("latin1")
        .replace(/\/CreationDate[^\n]*|\/ModDate[^\n]*|\/ID[^\n]*/g, "");
    };
    expect(await draw(multi)).toBe(await draw(oneLine));
  });

  it("leaves out axis labels that would print over their neighbours", () => {
    const tick = (x: number, label: string, side = "bottom", y = 274) =>
      `<g class="recharts-cartesian-axis-tick"><text orientation="${side}" font-size="11" x="${x}" y="${y}" text-anchor="middle"><tspan x="${x}" y="${y}">${label}</tspan></text></g>`;
    const group = (ticks: string[]) =>
      parseMarkup(`<g class="recharts-cartesian-axis-ticks">${ticks.join("")}</g>`)
        .children[0] as MElement;
    const measure: MeasureText = (t, size) => t.length * size * 0.55;
    // 48 months 11.5 units apart, each label about 42 wide.
    const months = Array.from({ length: 48 }, (_, i) =>
      tick(48 + i * 11.49, `${2022 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`),
    );
    const g = group(months);
    const dropped = crowdedTicks(g, ROOT_PAINT, measure);
    const kept = (g.children as MElement[]).filter((c) => !dropped.has(c));
    expect(kept.length).toBeGreaterThan(5);
    expect(kept.length).toBeLessThan(14);
    expect(textContent(kept[0])).toBe("2022-01");
    expect(textContent(kept[kept.length - 1])).toBe("2025-12");
    const xs = kept.map((k) => Number(findAll(k, (e) => e.tag === "text")[0].attrs.x));
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(42 + 4);
    // Room for every label: nothing goes.
    expect(
      crowdedTicks(
        group([0, 1, 2, 3, 4].map((i) => tick(50 + i * 100, "East"))),
        ROOT_PAINT,
        measure,
      ).size,
    ).toBe(0);
    // A vertical axis is crowded by line height, not width.
    const left = group([100, 105, 110, 200].map((y) => tick(40, "A long category", "left", y)));
    expect(crowdedTicks(left, ROOT_PAINT, measure).size).toBe(2);
  });

  it("reads a chart's legend, its colours and where it sits", () => {
    const tree = parseMarkup(
      '<div class="recharts-legend-wrapper" style="position:absolute;width:470px;left:5px;bottom:5px;font-size:11px">' +
        '<ul><li style="display:inline-block"><svg><path fill="#4E79A7" d="M0,0"></path></svg>' +
        '<span style="color:#4E79A7">East</span></li>' +
        '<li style="display:inline-block"><svg><path fill="#F28E2B" d="M0,0"></path></svg>' +
        "<span>West</span></li></ul></div>",
    );
    const legend = readLegend(tree)!;
    expect(legend.position).toBe("bottom");
    expect(legend.fontSize).toBe(11);
    expect(legend.items.map((i) => i.label)).toEqual(["East", "West"]);
    expect(legend.items[1].color.r).toBeCloseTo(0xf2 / 255);
  });

  it("finds the one chart svg, the captions and a narrative's words", () => {
    const tree = parseMarkup(
      '<div><p>3 of 4 make up 80% of the total.</p><svg width="5" height="5"><text>t</text></svg>' +
        '<div class="recharts-legend-wrapper"><li><svg></svg></li></div>' +
        '<div class="recharts-tooltip-wrapper"><p class="recharts-tooltip-label">tip</p></div></div>',
    );
    expect(mainSvg(tree)?.attrs.width).toBe("5");
    expect(captionLines(tree)).toEqual(["3 of 4 make up 80% of the total."]);
    expect(
      narrativeText(
        parseMarkup('<div><svg><path d="M0,0"></path></svg><p>The top <b>3</b> regions</p></div>'),
      ),
    ).toBe("The top 3 regions");
  });
});

describe("what a scheduled PDF draws", () => {
  it("names the visuals it cannot draw, and draws the rest", () => {
    for (const t of ["bar", "line", "pie", "kpi", "insight", "matrix", "heatmap", "map", "table"]) {
      expect(scheduledDrawProblem(t), t).toBeNull();
    }
    for (const t of ["smallmultiples", "pictogram", "pointmap", "wordcloud", "cards", "barrace"]) {
      expect(scheduledDrawProblem(t), t).not.toBeNull();
    }
  });
});
