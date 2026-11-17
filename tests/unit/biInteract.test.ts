// R503: titles that say what is picked, clicks that open a page or a link,
// text links to pages, and parameters that are numbers (Top N).
import { describe, expect, it } from "vitest";

import {
  clickActionUrl,
  fillAtDefaults,
  fillTextTokens,
  pageIndexFor,
  parseClickAction,
  resolveClick,
  withTokensFilled,
} from "@/lib/biInteract";
import {
  isValidParamValue,
  numberRange,
  paramLiteral,
  parseParams,
  resolveParamValues,
  substituteParams,
} from "@/lib/biParams";

const params = parseParams([
  {
    id: "p1",
    kind: "param",
    name: "rider",
    label: "Rider group",
    control: "radio",
    options: [
      { value: "all", label: "Every rider" },
      { value: "member", label: "Members" },
    ],
    default: "all",
  },
  {
    id: "p2",
    kind: "param",
    name: "top_n",
    label: "How many",
    control: "slider",
    min: 5,
    max: 50,
    step: 5,
    default: "10",
  },
]);

describe("titles and text that say what is picked", () => {
  const state = { params, values: { rider: "member" }, selected: null };

  it("fills a parameter with its picked label, and the rest at their defaults", () => {
    expect(fillTextTokens("Rides by {{rider}}, top {{ top_n }}", state)).toBe(
      "Rides by Members, top 10",
    );
    expect(fillAtDefaults("Rides by {{rider}}", params)).toBe("Rides by Every rider");
  });

  it("fills {{selected}} with the clicked value, or its fallback", () => {
    expect(fillTextTokens("Rides at {{selected|every station}}", state)).toBe(
      "Rides at every station",
    );
    expect(
      fillTextTokens("Rides at {{selected|every station}}", { ...state, selected: "W 21 St" }),
    ).toBe("Rides at W 21 St");
    expect(fillTextTokens("At {{selected}}.", state)).toBe("At .");
  });

  it("leaves names it does not know as written", () => {
    expect(fillTextTokens("{{rides}} and {{Rider}}", state)).toBe("{{rides}} and Members");
    expect(fillTextTokens("no braces", state)).toBe("no braces");
  });

  it("escapes markdown in what it fills into text, so a value cannot add a link", () => {
    const s = { ...state, selected: "[x](https://evil.example) *b*" };
    expect(fillTextTokens("## {{selected}}", s, { markdown: true })).toBe(
      "## \\[x\\]\\(https://evil\\.example\\) \\*b\\*",
    );
    // A title is plain text: nothing to escape.
    expect(fillTextTokens("{{selected}}", { ...state, selected: "*b*" })).toBe("*b*");
  });

  it("fills copies for a deck, and keeps a widget it did not change", () => {
    const ws = [
      { id: "a", title: "Top {{top_n}}" },
      { id: "b", title: "Plain" },
    ];
    const out = withTokensFilled(ws, { params, values: {}, selected: null });
    expect(out[0].title).toBe("Top 10");
    expect(out[1]).toBe(ws[1]);
    expect(ws[0].title).toBe("Top {{top_n}}");
  });
});

describe("a link built from a clicked value", () => {
  it("puts the value in URL-encoded", () => {
    expect(clickActionUrl("https://example.com/s?name={{value}}", "W 21 St & 6 Ave")).toBe(
      "https://example.com/s?name=W%2021%20St%20%26%206%20Ave",
    );
  });

  it("opens only http(s) addresses", () => {
    expect(clickActionUrl("javascript:alert('{{value}}')", "x")).toBeNull();
    expect(clickActionUrl("data:text/html,{{value}}", "x")).toBeNull();
    expect(clickActionUrl("/relative/{{value}}", "x")).toBeNull();
    expect(clickActionUrl("http://intranet.example/{{value}}", "a/b")).toBe(
      "http://intranet.example/a%2Fb",
    );
  });

  it("reads saved actions through a parser", () => {
    expect(parseClickAction({ kind: "page", pageId: "p2" })).toEqual({
      kind: "page",
      pageId: "p2",
    });
    expect(parseClickAction({ kind: "url", url: "https://x.example/{{value}}" })).toEqual({
      kind: "url",
      url: "https://x.example/{{value}}",
    });
    expect(parseClickAction({ kind: "url", url: "javascript:void 0" })).toBeUndefined();
    expect(parseClickAction({ kind: "url", url: 5 })).toBeUndefined();
    expect(parseClickAction({ kind: "page" })).toBeUndefined();
    expect(parseClickAction("page")).toBeUndefined();
  });
});

describe("what a click does", () => {
  const pages = [{ id: "overview" }, { id: "station" }];

  it("opens the page it names, filtered, unless that page is gone or is this one", () => {
    expect(resolveClick({ kind: "page", pageId: "station" }, "W 21 St", pages, "overview")).toEqual(
      { kind: "page", pageId: "station", index: 1 },
    );
    expect(resolveClick({ kind: "page", pageId: "gone" }, "v", pages, "overview")).toEqual({
      kind: "filter",
    });
    expect(resolveClick({ kind: "page", pageId: "station" }, "v", pages, "station")).toEqual({
      kind: "filter",
    });
  });

  it("opens a link, does nothing for a link that cannot be made, and filters by default", () => {
    expect(
      resolveClick({ kind: "url", url: "https://x.example/{{value}}" }, "a b", pages, "overview"),
    ).toEqual({ kind: "url", href: "https://x.example/a%20b" });
    expect(resolveClick({ kind: "url", url: "ftp://x/{{value}}" }, "v", pages, "overview")).toEqual(
      { kind: "filter" },
    );
    expect(resolveClick(undefined, "v", pages, "overview")).toEqual({ kind: "filter" });
    expect(resolveClick({ kind: "teleport" }, "v", pages, "overview")).toEqual({ kind: "filter" });
  });
});

describe("a text link to a page", () => {
  const pages = [{ name: "Overview" }, { name: "Station detail" }, { name: "2026" }];

  it("finds a page by name, ignoring case and spaces around it", () => {
    expect(pageIndexFor(pages, "#page=Station%20detail")).toBe(1);
    expect(pageIndexFor(pages, "#page= station DETAIL ")).toBe(1);
  });

  it("falls back to the page's number, and a name wins over a number", () => {
    expect(pageIndexFor(pages, "#page=1")).toBe(0);
    expect(pageIndexFor(pages, "#page=2026")).toBe(2);
    expect(pageIndexFor(pages, "#page=4")).toBe(-1);
  });

  it("is not fooled by other links", () => {
    expect(pageIndexFor(pages, "https://example.com/#page=Overview")).toBe(-1);
    expect(pageIndexFor(pages, "#page=")).toBe(-1);
    expect(pageIndexFor(pages, "#page=%E0%A4%A")).toBe(-1);
    expect(pageIndexFor(pages, null)).toBe(-1);
  });
});

describe("a number parameter", () => {
  const top = params.find((p) => p.name === "top_n")!;

  it("keeps its range and step, and takes only values on them", () => {
    expect([top.min, top.max, top.step, top.default]).toEqual([5, 50, 5, "10"]);
    for (const ok of ["5", "10", "50", "25.0"]) expect(isValidParamValue(top, ok)).toBe(true);
    for (const bad of ["7", "0", "55", "1e1", " 10", "10;", "0x0A", "", "Infinity"]) {
      expect(isValidParamValue(top, bad)).toBe(false);
    }
  });

  it("goes into SQL bare, so LIMIT reads it, and a bad value becomes the default", () => {
    const sql = "SELECT * FROM t ORDER BY rides DESC LIMIT {{top_n}}";
    expect(substituteParams(sql, params, { top_n: "25" })).toBe(
      "SELECT * FROM t ORDER BY rides DESC LIMIT 25",
    );
    const picked = resolveParamValues(params, { top_n: "25; DROP TABLE t" });
    expect(substituteParams(sql, params, picked)).toBe(
      "SELECT * FROM t ORDER BY rides DESC LIMIT 10",
    );
    // A quoted placeholder is replaced whole: no '25' string.
    expect(substituteParams("LIMIT '{{top_n}}'", params, { top_n: "25" })).toBe("LIMIT 25");
  });

  it("writes a negative number in brackets, so x -{{n}} cannot become a comment", () => {
    const [n] = parseParams([
      { id: "n", kind: "param", name: "n", control: "number", min: -10, max: 10, default: "-5" },
    ]);
    expect(paramLiteral(n, "-5")).toBe("(-5)");
    expect(substituteParams("WHERE x -{{n}} > 0 AND owner = 'me'", [n], { n: "-5" })).toBe(
      "WHERE x -(-5) > 0 AND owner = 'me'",
    );
  });

  it("refuses a range that is not one, and starts at the lowest value", () => {
    expect(numberRange(10, 5, 1)).toBeNull();
    expect(numberRange(0, 10, 0)).toBeNull();
    expect(numberRange(0, 10, 20)).toBeNull();
    expect(numberRange(0, Infinity, 1)).toBeNull();
    expect(numberRange(undefined, undefined, undefined)).toEqual({ min: 0, max: 100, step: 1 });
    expect(
      parseParams([
        { id: "x", kind: "param", name: "x", control: "number", min: 10, max: 1, default: "5" },
      ]),
    ).toEqual([]);
    const [d] = parseParams([
      { id: "y", kind: "param", name: "y", control: "slider", min: 3, max: 9, default: "100" },
    ]);
    expect(d.default).toBe("3");
    expect(d.options).toBeUndefined();
  });
});
