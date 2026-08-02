// The ontology spec guard.
//
// A spec is stored inside a widget's `chart` JSON, and `chart` is one of the
// fields sanitizePublicWidgets passes through to ANONYMOUS viewers on the
// published share page and the embed. It is drawn by OntologyGraph, whose
// computeLayout dereferences spec.entities, spec.relations AND spec.domains.
//
// THE ONLY BOUNDARY ABOVE IT IS THE ROUTER'S, AND IT IS PER ROUTE. router.tsx
// sets defaultErrorComponent, so TanStack Router's CatchBoundary catches the
// throw and the browser does not blank — an earlier version of this comment
// claimed there was no boundary at all, which was wrong: that grep looked for
// componentDidCatch / getDerivedStateFromError / errorElement and missed the
// router's own idiom. What is true is the granularity. The boundary wraps the
// ROUTE, so one malformed spec replaces the ENTIRE dashboard with a
// full-screen error card, for everyone holding the share link, instead of
// degrading a single tile.
//
// isOntologySpec used to check `entities` and `relations` only, which is two of
// the three fields computeLayout reads: a spec without `domains` passed the
// guard and threw anyway. It also had ZERO callers — an exported validator
// nothing used, which is the same landmine shape as the dead CSV escaper next
// door. It now checks all three and gates the render.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isOntologySpec } from "@/lib/biOntology";

const valid = {
  builtAt: "",
  summary: "",
  aiEnriched: false,
  domains: [],
  entities: [],
  relations: [],
  notes: [],
};

describe("accepts a spec the renderer can draw", () => {
  it("accepts a well-formed spec", () => {
    expect(isOntologySpec(valid)).toBe(true);
  });

  it("accepts empty arrays — an empty graph draws fine", () => {
    expect(isOntologySpec({ domains: [], entities: [], relations: [] })).toBe(true);
  });

  it("does not require the fields the renderer never reads", () => {
    // Shallow on purpose: rejecting a spec that would have drawn is its own
    // kind of bug, and the optional metadata is not dereferenced in layout.
    expect(isOntologySpec({ domains: ["a"], entities: [], relations: [] })).toBe(true);
  });
});

describe("rejects every shape that would throw in computeLayout", () => {
  it("rejects a missing domains array — the field the old guard forgot", () => {
    // spec.domains.length is read directly; without it the render throws and
    // the page goes blank.
    expect(isOntologySpec({ entities: [], relations: [] })).toBe(false);
    expect(isOntologySpec({ ...valid, domains: undefined })).toBe(false);
    expect(isOntologySpec({ ...valid, domains: null })).toBe(false);
    expect(isOntologySpec({ ...valid, domains: "General" })).toBe(false);
  });

  it("rejects missing or non-array entities and relations", () => {
    expect(isOntologySpec({ ...valid, entities: undefined })).toBe(false);
    expect(isOntologySpec({ ...valid, relations: undefined })).toBe(false);
    expect(isOntologySpec({ ...valid, entities: {} })).toBe(false);
    expect(isOntologySpec({ ...valid, relations: "none" })).toBe(false);
  });

  it("rejects non-objects without throwing on them", () => {
    for (const v of [null, undefined, 0, "", "spec", true, []]) {
      expect(isOntologySpec(v), JSON.stringify(v)).toBe(false);
    }
  });
});

describe("the guard is actually wired into the renderer", () => {
  // It had no callers at all before. A validator nobody calls is decoration —
  // the same reason the dead CSV escaper was deleted rather than fixed.
  const render = readFileSync("src/components/bi/BiChartRender.tsx", "utf8");

  it("gates the ontology branch on it", () => {
    expect(render).toMatch(/isOntologySpec\(chart\.spec\)/);
  });

  it("imports it rather than re-declaring the check", () => {
    expect(render).toMatch(/import \{ isOntologySpec \} from "@\/lib\/biOntology"/);
  });

  it("still renders the graph for a valid spec", () => {
    expect(render).toMatch(/<OntologyGraph spec=\{chart\.spec\}/);
  });
});
