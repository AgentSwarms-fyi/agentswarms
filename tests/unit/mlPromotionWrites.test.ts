// ML promotion: a write that failed is a promotion that did not happen, and
// the answer says which step failed and what is now true.
//
// FOUND FROM THE UI. With every PATCH to ml_models and ml_model_versions
// rejected, "v2 is now in production" toasted and the model still served
// v1 after a reload. All four writes in applyPromotion dropped their error
// and it returned ok.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/ml/promote.server.ts", "utf8");
const fn = src.slice(
  src.indexOf("export async function applyPromotion("),
  src.indexOf("auditEvent({", src.indexOf("export async function applyPromotion(")),
);

describe("applyPromotion", () => {
  it("keeps the error of every write and returns it instead of ok", () => {
    expect(fn).not.toMatch(
      /^\s*await supabaseAdmin\s*\n?\s*\.from\("ml_(models|model_versions)"\)/m,
    );
    expect((fn.match(/const \{ error: \w+Err \} = await supabaseAdmin/g) ?? []).length).toBe(5);
    expect((fn.match(/ok: false/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("promotes in the order that never leaves a model with no production version", () => {
    const prod = fn.slice(fn.indexOf('if (stage === "production") {'), fn.indexOf("} else {"));
    const stage = prod.indexOf(".update({ stage })");
    const pointer = prod.indexOf(".update({ production_version_id: version.id");
    const archive = prod.indexOf('.update({ stage: "archived" })');
    expect(stage).toBeGreaterThan(-1);
    expect(stage).toBeLessThan(pointer);
    expect(pointer).toBeLessThan(archive);
  });

  it("says what is true after a failure part-way", () => {
    expect(fn).toContain("Nothing changed.");
    expect(fn).toContain("is marked production but not served — promote it again.");
    expect(fn).toContain("Two versions are marked production until it is.");
    expect(fn).toContain("It is still served.");
  });

  it("audits only after every write landed", () => {
    const audit = src.indexOf("auditEvent({", src.indexOf("export async function applyPromotion("));
    const lastReturn = src.lastIndexOf("ok: false", audit);
    expect(lastReturn).toBeGreaterThan(-1);
    expect(lastReturn).toBeLessThan(audit);
  });
});
