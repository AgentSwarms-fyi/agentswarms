// Data Prep saw less than BI did, and billed nobody for what it ran.
//
// TWO GAPS, FOUND BY COMPARING TWO PATHS THAT SHOULD AGREE.
//
// 1. VISIBILITY. `loadLocalTables` (BI refresh) resolves own datasets, public
//    samples AND datasets shared by an IAM grant, then applies that grant's row
//    filters and column masks. `loadFlowTables` (Data Prep) resolved only own +
//    samples. So a dataset someone shared with you worked in a dashboard and was
//    invisible in a prep flow: the grant appeared to do nothing here. It failed
//    closed, so it was a missing feature rather than a leak — but the fix is the
//    dangerous direction, because widening the query WITHOUT the masking would
//    turn it into one. Visibility and masking are one decision.
//
// 2. BILLING. `executeWarehouseQuery`'s `userId` is the tenant the concurrency
//    governor charges, and the governor reads `userId ? gateFor(userId) : null`.
//    Omitting it does not relax the per-user limit, it removes the gate — so a
//    prep flow buffering a large warehouse table could consume the whole global
//    budget while interactive users queued behind it.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const prep = readFileSync("src/utils/bi/prep.server.ts", "utf8");
const refresh = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
const semantic = readFileSync("src/utils/semantic/query.server.ts", "utf8");
const governor = readFileSync("src/utils/warehouse/governor.server.ts", "utf8");

describe("the governor only gates what it is told to bill", () => {
  it("has no per-user gate without a userId", () => {
    // The whole reason the omissions below matter. If this stopped being true
    // the fixes become tidiness rather than correctness.
    expect(governor).toContain("const userGate = userId ? gateFor(userId) : null;");
  });
});

describe("Data Prep sees what BI sees", () => {
  it("resolves IAM-granted datasets, like refresh does", () => {
    expect(refresh, "refresh is the precedent").toContain(
      "grantedDatasetIds(supabaseAdmin, userId)",
    );
    expect(prep).toContain("grantedDatasetIds(supabaseAdmin, userId)");
    expect(prep).toContain('id.in.(${grantedIds.join(",")})');
  });

  it("applies the grant's masks to anything not its own", () => {
    // The half that makes widening safe. A shared dataset must arrive with the
    // owner's row filters and column masks already applied, before any prep
    // step can transform, join or export it.
    expect(prep).toContain("restrictSharedDataset(supabaseAdmin, t.id, userId, columns, rows)");
    expect(prep).toContain("!t.is_sample && t.user_id !== userId");
  });

  it("masks at load time, so every later step inherits it", () => {
    // Masking after a join would be too late — the join has already read the
    // values.
    const load = prep.slice(prep.indexOf("async function loadFlowTables"));
    const maskAt = load.indexOf("restrictSharedDataset(");
    const pushAt = load.indexOf("loaded.push({ name: t.name, columns, rows: visibleRows })");
    expect(maskAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(maskAt);
  });

  it("stops offering in-flight upload staging rows as sources", () => {
    expect(prep).toContain('.not("name", "like", `${STAGING_PREFIX}%`)');
  });

  it("guards the id list it interpolates", () => {
    // `id.in.(…)` is built by string concatenation; a non-UUID there is a
    // syntax error at best.
    expect(prep).toContain("grantedIds = [...granted].filter((id) => UUID_RE.test(id))");
  });
});

describe("warehouse work is billed to a tenant", () => {
  it("bills the three Data Prep queries", () => {
    // Buffering a source, proving a pushdown, and running the folded query.
    const withUser = prep.match(/executeWarehouseQuery\([\s\S]{0,220}?userId[,\s}]/g) ?? [];
    expect(withUser.length).toBeGreaterThanOrEqual(3);
  });

  it("bills a semantic query to the model's OWNER, not the requester", () => {
    // The documented convention: a model queried by many viewers must not let
    // one popular model consume every other tenant's budget.
    expect(semantic).toContain("userId: ownerId");
  });
});
