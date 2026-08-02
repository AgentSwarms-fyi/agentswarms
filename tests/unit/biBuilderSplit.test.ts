// The BI builder split.
//
// BiBuilderPane was 2,664 lines and is now 1,754, across seven components.
//
// WHICH REGIONS CAME OUT WAS DECIDED BY MEASURING how many of the parent's
// values each one uses, not by line count — a component with eighty props is
// harder to follow than the block it replaced.
//
// That measurement was wrong the first time, in a way worth recording. Scanning
// the whole 751-line chart branch gave 84 values and the conclusion "too
// coupled to split". But that branch is a chain of `chartType === …` tests that
// are MUTUALLY EXCLUSIVE, so 84 was a union over code paths that never render
// together, not the coupling of anything. Measured per region, the conditional
// formatting editor inside it needs six. A union over exclusive branches is not
// a coupling measure.
//
// THE SAFETY PROPERTY IS THAT NO HOOK MOVED. Every extracted component owns no
// state: it receives values and setters. That is what makes this a refactor
// rather than a rewrite, because hook order and effect timing are untouched —
// and it is the one thing a type checker cannot tell you.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const parent = readFileSync("src/components/bi/BiBuilderPane.tsx", "utf8");
const CHILDREN = {
  "BiAiTab.tsx": readFileSync("src/components/bi/BiAiTab.tsx", "utf8"),
  "BiOntologyTab.tsx": readFileSync("src/components/bi/BiOntologyTab.tsx", "utf8"),
  "BiVizPicker.tsx": readFileSync("src/components/bi/BiVizPicker.tsx", "utf8"),
  "BiTablePicker.tsx": readFileSync("src/components/bi/BiTablePicker.tsx", "utf8"),
  "BiSqlEditor.tsx": readFileSync("src/components/bi/BiSqlEditor.tsx", "utf8"),
  "BiCondFormatEditor.tsx": readFileSync("src/components/bi/BiCondFormatEditor.tsx", "utf8"),
  "BiChartOptions.tsx": readFileSync("src/components/bi/BiChartOptions.tsx", "utf8"),
};

describe("no hook moved out of the parent", () => {
  for (const [name, src] of Object.entries(CHILDREN)) {
    it(`${name} owns no state`, () => {
      // A useState here would be a second source of truth for something the
      // parent still thinks it owns — the child would keep its own copy and the
      // two would drift the moment either updated.
      for (const hook of ["useState", "useReducer", "useEffect", "useLayoutEffect", "useRef"]) {
        expect(src, `${name} calls ${hook}`).not.toMatch(new RegExp(`\\b${hook}\\s*[<(]`));
      }
    });
  }

  it("the parent still owns them all", () => {
    expect((parent.match(/useState[<(]/g) ?? []).length).toBeGreaterThan(40);
  });
});

describe("the extracted regions are gone from the parent", () => {
  it("renders each child rather than its JSX", () => {
    for (const tag of [
      "<BiAiTab",
      "<BiOntologyTab",
      "<BiVizPicker",
      "<BiTablePicker",
      "<BiSqlEditor",
      "<BiCondFormatEditor",
      "<BiDrillHierarchy",
      "<BiTimeSeriesOptions",
      "<BiRefLineOptions",
    ]) {
      expect(parent, `${tag} is not rendered`).toContain(tag);
    }
  });

  it("shrank the parent substantially", () => {
    // 2,664 before, 1,754 now. A ceiling rather than an exact number so
    // ordinary edits do not fail this, but a wholesale re-inlining would.
    expect(parent.split("\n").length).toBeLessThan(1900);
  });
});

describe("extraction happened where the coupling was actually low", () => {
  // The rule the split followed, stated so it can be checked: a region is worth
  // extracting when it carries enough lines to pay for its prop list. A flat
  // prop ceiling is the wrong rule — a first version of this test used one and
  // failed the two largest children, which are fine: 24 props for 348 lines is
  // a different thing from 24 props for 40.
  //
  // Measured, the split is unambiguous. Every extracted component:
  //
  //     BiSqlEditor           9.1 lines/prop      BiTablePicker  13.4
  //     BiTimeSeriesOptions   9.5                 BiOntologyTab  14.5
  //     BiRefLineOptions     11.8                 BiDrillHierarchy 16.7
  //     BiAiTab              12.8                 BiCondFormatEditor 25.8
  //                                               BiVizPicker    27.5
  //
  // and the region left in the parent: 3.8. The floor sits in that gap, well
  // under the weakest extraction, so ordinary edits do not trip it but adding
  // props to a small component does.
  const FLOOR = 7;

  for (const [name, src] of Object.entries(CHILDREN)) {
    it(`${name} earns its prop list`, () => {
      const marks = [...src.matchAll(/export function (\w+)\(\{([^}]*)\}/g)];
      expect(marks.length, `${name} exports no component`).toBeGreaterThan(0);

      for (let i = 0; i < marks.length; i++) {
        const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
        const lines = src.slice(marks[i].index, end).split("\n").length;
        const props = marks[i][2]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean).length;

        expect(
          lines / props,
          `${marks[i][1]}: ${lines} lines for ${props} props — ${(lines / props).toFixed(1)} per prop`,
        ).toBeGreaterThanOrEqual(FLOOR);
      }
    });
  }
});

describe("nothing was duplicated on the way out", () => {
  // Moving a constant but leaving the original behind gives two definitions
  // that agree by coincidence. MAX_AI_DOCS is the sharp case: the tab quotes
  // the number back to the user in its own error message.
  // Anchored at LINE START so a re-export or an `import { type X }` does not
  // count as a declaration. A first version matched the bare substring and
  // failed on the parent's own `import { BiAiTab, type KbDocOption }`.
  const ONCE: [string, RegExp][] = [
    ["MAX_AI_DOCS", /^(?:export )?const MAX_AI_DOCS\b/m],
    ["KbDocOption", /^(?:export )?type KbDocOption\b/m],
    ["VIZ_TYPES", /^(?:export )?const VIZ_TYPES\b/m],
    ["ONTO_STAGE_LABEL", /^(?:export )?const ONTO_STAGE_LABEL\b/m],
  ];

  for (const [label, decl] of ONCE) {
    it(`${label} is declared exactly once`, () => {
      const all = [parent, ...Object.values(CHILDREN)];
      const count = all.filter((s) => decl.test(s)).length;
      expect(count, `${label} is declared in ${count} of these files`).toBe(1);
    });
  }

  it("COND_COLORS is imported by the formatting editor, not re-declared", () => {
    // It is the shared palette; a second copy would drift from the renderer's
    // and colour the legend differently from the cells.
    expect(CHILDREN["BiCondFormatEditor.tsx"]).toMatch(
      /import \{ COND_COLORS \} from "@\/lib\/biChartMath"/,
    );
    expect(CHILDREN["BiCondFormatEditor.tsx"]).not.toMatch(/const COND_COLORS/);
  });
});

describe("the field-slot mapping was deliberately NOT extracted", () => {
  // What is left of the chart editor's configuration grid: ~132 lines mapping
  // each chart type to the field pickers it needs. It touches ~35 of the
  // parent's values, and unlike the 84 that number is NOT a union over
  // exclusive branches — it is fifteen-odd field/setter pairs that any one
  // extraction would have to take together. Making it separable means a
  // reducer or a config object for the field state, which is a design change
  // and not a split. Left in place on purpose, and recorded so nobody
  // "finishes the job" without reading why.
  it("still lives in the parent", () => {
    expect(parent).toMatch(/\{fieldSelect\(/);
    expect(parent).toMatch(/chartType === "sankey"/);
  });

  it("the field state it needs is still the parent's", () => {
    for (const f of ["xField", "yField", "seriesField", "valueField", "nameField"]) {
      expect(parent, `${f} left the parent`).toMatch(new RegExp(`const \\[${f}, set`));
    }
  });
});

describe("the reasoning is written where someone would look", () => {
  it("a child explains the mutually-exclusive-branch measurement error", () => {
    // The trap is re-runnable: anyone scanning that branch again gets 84 again
    // and reaches the same wrong conclusion. The correction belongs next to the
    // code, not only in a commit message nobody will find.
    const said = Object.values(CHILDREN).some((s) => /mutually exclusive/i.test(s));
    expect(said, "no child records why the first measurement was wrong").toBe(true);
  });
});

describe("shared helpers come from the tested module, not from props", () => {
  it("the ontology tab imports biBuilder directly", () => {
    // groupCheckState/selHas/toggleName are pure and covered by
    // tests/unit/biBuilder.test.ts. Threading them through as props would add
    // three that can only ever hold one value.
    expect(CHILDREN["BiOntologyTab.tsx"]).toMatch(
      /import \{[^}]*groupCheckState[^}]*\} from "@\/lib\/biBuilder"/s,
    );
  });
});
