// The BI builder split.
//
// BiBuilderPane was 2,664 lines. Three regions came out of it, chosen by
// measuring how many of the parent's values each one actually used — a
// component with eighty props is harder to follow than the block it replaced,
// so the measurement decided the split rather than the line count.
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
};

describe("no hook moved out of the parent", () => {
  for (const [name, src] of Object.entries(CHILDREN)) {
    it(`${name} owns no state`, () => {
      // A useState here would be a second source of truth for something the
      // parent still thinks it owns — the tab would keep its own copy and the
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
    for (const tag of ["<BiAiTab", "<BiOntologyTab", "<BiVizPicker"]) {
      expect(parent, `${tag} is not rendered`).toContain(tag);
    }
  });

  it("shrank the parent substantially", () => {
    // 2,664 before. A ceiling rather than an exact number so ordinary edits do
    // not fail this, but a wholesale re-inlining would.
    expect(parent.split("\n").length).toBeLessThan(2300);
  });
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
});

describe("the chart editor was deliberately NOT extracted", () => {
  it("still lives in the parent", () => {
    // 751 lines using 84 of the parent's values. Extracting it means an
    // 84-prop component, which is a worse artifact than the block — the fix
    // there is a reducer or a config object, which is a design change and not
    // a split. Left in place ON PURPOSE, and recorded so nobody "finishes the
    // job" without reading why.
    expect(parent).toMatch(/chartType === "ontology"/);
    expect(parent.split("\n").length).toBeGreaterThan(1500);
  });

  it("says why, where someone would look", () => {
    const said = Object.values(CHILDREN).some((s) => /eighty|84/.test(s));
    expect(said, "no child explains why the chart editor stayed").toBe(true);
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
