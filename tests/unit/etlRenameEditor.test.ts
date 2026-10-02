// "Add rename" has to add a rename.
//
// Found by building a pipeline node by node and reaching the Rename columns
// step: clicking "Add rename" did nothing. Not "did the wrong thing" — nothing
// at all, twice by mouse and once by calling .click() on the element. The node
// could not be configured through the editor, which makes one of the fifteen
// transform kinds unreachable from the canvas that offers it.
//
// The cause is a shape mismatch that reads as correct. A rename is stored as
// `{from: to}`. The editor derived its rows from `Object.entries(value)` and
// wrote back a map built by skipping any row whose `from` was blank — which is
// right, an empty key cannot be stored. So the new row `["", ""]` was dropped
// on the way out, the unchanged map came back in, and the row disappeared
// before it rendered. The comment above it said the list existed "so a
// half-typed row can exist". It could not.
//
// This file pins the round trip as a function of the two pieces, since the
// component itself is a React tree: what the editor writes upward, and what
// the editor shows for a given saved value.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const editor = readFileSync("src/components/etl/TransformFields.tsx", "utf8");
const page = readFileSync("src/routes/_authenticated/etl.tsx", "utf8");

/** The rule the editor applies on the way OUT, restated here. */
const toMap = (rows: [string, string][]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [from, to] of rows) if (from.trim()) out[from.trim()] = to.trim();
  return out;
};

describe("what a rename row becomes", () => {
  it("drops a row with no source column, which is why it cannot be the state", () => {
    // Not a bug in itself — a map has no key for it. The bug was making the
    // rendered list a function of this.
    expect(toMap([["", ""]])).toEqual({});
    expect(toMap([["amount", "gross"]])).toEqual({ amount: "gross" });
    expect(toMap([["  amount  ", "  gross  "]])).toEqual({ amount: "gross" });
  });

  it("keeps a row whose target is still empty, so it can be typed into", () => {
    expect(toMap([["amount", ""]])).toEqual({ amount: "" });
  });
});

describe("where the draft lives", () => {
  it("is component state seeded from the saved map, not the map itself", () => {
    const at = editor.indexOf("export function RenameEditor");
    expect(at).toBeGreaterThan(-1);
    // To the NEXT top-level function: the props block ends in a brace, so a
    // slice that stops at the first one stops before the code being checked
    // and would pass on an empty string.
    const after = editor.indexOf("export function", at + 10);
    const body = editor.slice(at, after > -1 ? after : editor.length);
    expect(body.length).toBeGreaterThan(400);
    expect(body).toContain(
      "const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value ?? {}));",
    );
    // And every write updates the draft as well as the parent, or the row
    // vanishes again on the next render.
    expect(body).toContain("setRows(next);");
    // The old derivation is gone.
    expect(body).not.toMatch(/const rows = Object\.entries\(value/);
  });

  it("does not follow the reader to another node", () => {
    // Draft state in a panel React reuses across selections would show one
    // node's half-typed row on the next. The panel is keyed by node id.
    const at = page.indexOf("<NodePanel");
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(at, at + 400)).toContain("key={selected.id}");
  });
});
