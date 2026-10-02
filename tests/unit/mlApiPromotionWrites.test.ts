// The promotion the API and the schedule make goes through the one guarded
// promotion, and a promotion that failed is answered as such.
//
// FOUND FROM THE SURVEY (R81). api.server.ts made the three promotion
// writes in the order R73 fixed on the page path and dropped every error;
// the register route and the schedule said "promoted" whatever happened.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const api = readFileSync("src/utils/ml/api.server.ts", "utf8");
const route = readFileSync("src/routes/api/ml.models.register.ts", "utf8");
const sch = readFileSync("src/utils/ml/schedule.server.ts", "utf8");

const promote = api.slice(
  api.indexOf("export async function promoteVersion("),
  api.indexOf("// ── Predictions"),
);
const register = api.slice(
  api.indexOf("export async function registerExternalVersion("),
  api.indexOf("export async function promoteVersion("),
);

describe("the API-path promotion", () => {
  it("is the guarded one, and answers as it went", () => {
    expect(promote).toContain(
      'await applyPromotion(model, version as MlVersionRow, "production", userId)',
    );
    expect(promote).toContain("Promise<{ ok: true } | { ok: false; error: string }>");
    expect(promote).toContain("return res;");
    expect(promote).not.toContain('.update({ stage: "archived" })');
    expect(promote).not.toContain('.update({ stage: "production" })');
  });

  it("is reported by the registration, and the route passes it on", () => {
    expect(register).toContain("promoted = res.ok;");
    expect(register).toContain("if (!res.ok) promotionError = res.error;");
    expect(register).toContain("...(promotionError ? { promotionError } : {}),");
    expect(route).toContain("promoted: done.promoted,");
    expect(route).toContain(
      "...(done.promotionError ? { promotion_error: done.promotionError } : {}),",
    );
  });
});

describe("the schedule's promotion", () => {
  it("reads the promotion's answer and says a failure to the owner and on the schedule", () => {
    expect(sch).toContain("promoted = res.ok;");
    expect(sch).not.toContain("promoted = true;");
    expect(sch).toContain("...(promotionError ? { last_error: promotionError } : {}),");
    expect(sch).toContain("trained, but could not be promoted");
    expect(sch).toContain("promotionError ??");
    expect(sch).toContain("const { error: stampErr } = await supabaseAdmin");
  });
});
