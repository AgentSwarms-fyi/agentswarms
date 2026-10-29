// The ontology header's "draft has changes". It stayed on after a save even
// when the save put the published model back: the page set it to true on
// every save, and the server compared the draft with the published version
// byte for byte, which a jsonb round trip (keys in jsonb's own order) defeats.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@/lib/definitionFingerprint";
import { sampleSpec } from "@/lib/ontology/sample";

const rd = (p: string) => readFileSync(p, "utf8");

/** What a jsonb column hands back: the same value, keys in another order. */
function reorder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reorder);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .reverse()
        .map((k) => [k, reorder((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

describe("draft has changes", () => {
  it("a spec read back from jsonb compares equal to the one saved, and a real edit does not", () => {
    const spec = sampleSpec("ontology_sample");
    const stored = reorder(spec);
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(spec));
    expect(canonicalJson(stored)).toBe(canonicalJson(spec));
    const edited = { ...spec, description: `${spec.description ?? ""} Edited.` };
    expect(canonicalJson(edited)).not.toBe(canonicalJson(stored));
  });

  it("the server says it after a save and on load, compared as JSON values", () => {
    const fns = rd("src/utils/ontology.functions.ts");
    expect(fns).toContain("canonicalJson(v.spec) !== canonicalJson(spec)");
    expect(fns).not.toMatch(/JSON\.stringify\(v\.spec\)/);
    expect(fns).toMatch(/unpublished_changes: await draftDiffers\(/);
    expect(fns).toMatch(/role === "owner" && \(await draftDiffers\(row\.id/);
  });

  it("the page shows what the save answered instead of assuming a change", () => {
    const page = rd("src/routes/_authenticated/ontology_.$ontologyId.tsx");
    expect(page).toContain("unpublished_changes: res.unpublished_changes");
    expect(page).not.toMatch(/unpublished_changes: true/);
  });
});
