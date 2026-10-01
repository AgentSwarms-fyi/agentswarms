// The catalog asset sheet keeps what is being edited while the asset object
// behind it is replaced.
//
// FOUND IN R221: the sheet filled owner, status, tags and column tags in an
// effect keyed on the `asset` prop. AI docs saves the description and columns
// and hands back a patch, which gives the page's `selected` a new object, so
// the effect ran again. On analytics.r211_double, an owner and a tag typed but
// not saved were empty again the moment "Documentation generated" showed. A
// save and a restore replace the object the same way.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const src = readFileSync("src/components/catalog/CatalogView.tsx", "utf8");

/** The dependency list of the hook that contains `marker`. */
function depsAfter(marker: string): string[] {
  const at = src.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  expect(src.indexOf(marker, at + 1), `marker not unique: ${marker}`).toBe(-1);
  const m = /\}\s*,\s*(?:\/\/[^\n]*\n\s*)*\[([^\]]*)\]\s*,?\s*\)/g;
  m.lastIndex = at;
  const hit = m.exec(src);
  expect(hit).not.toBeNull();
  return hit![1]
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

describe("the asset sheet's form", () => {
  it("is filled when a different asset opens, not when the object is replaced", () => {
    expect(src).toContain("const assetId = asset?.id;");
    expect(depsAfter('setOwner(asset?.owner ?? "");')).toEqual(["assetId"]);
  });

  it("is replaced by AI docs, the save and the restore — the reason the key matters", () => {
    // If these stop replacing the object, the key is moot; if they keep doing
    // it, the form must not follow the object.
    expect(src).toContain("onSaved({ description: res.description, columns: res.columns });");
    expect(src).toContain("setSelected((prev) => (prev ? { ...prev, ...patch } : prev));");
  });
});
