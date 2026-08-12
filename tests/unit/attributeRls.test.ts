// Attribute-driven row security: {{user.<key>}} tokens in share grants,
// resolved per caller BEFORE the permissive-union merge.
//
// Everything here calls the REAL functions — the resolver, the merge, the
// enforcement, the compiler — and the last suite EXECUTES a resolved policy
// on DuckDB against hand-computed rows, because "the filter was added to the
// query" and "the grantee saw only their region" are different claims.
import { describe, expect, it } from "vitest";

import {
  applyAccessPolicy,
  attributeKeysInGrants,
  describePolicy,
  policyFromGrants,
  resolveAttributeGrants,
  USER_ATTR_TOKEN_RE,
  type GrantRow,
} from "@/lib/semanticPolicy";
import { compileSemanticQuery, type SemanticModel } from "@/lib/semanticLayer";
import { rowFilterValueOk } from "@/utils/iam.functions";
import { runLocalSqlDuckDB, type DuckTable } from "@/utils/data/duckdb.server";

const grant = (values: string[], column = "region"): GrantRow => ({
  principal_type: "user",
  principal_id: "u1",
  row_filter: { column, values } as GrantRow["row_filter"],
  column_mask: [],
});

const attrs = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

describe("the token grammar", () => {
  it("matches exactly {{user.<key>}}, with inner whitespace tolerated", () => {
    expect(USER_ATTR_TOKEN_RE.test("{{user.region}}")).toBe(true);
    expect(USER_ATTR_TOKEN_RE.test("{{ user.region }}")).toBe(true);
    expect(USER_ATTR_TOKEN_RE.test("{{user.region_2}}")).toBe(true);
  });

  it("rejects everything that merely looks like a token", () => {
    for (const bad of [
      "{user.region}",
      "{{user.}}",
      "{{user.region}} extra",
      "{{region}}",
      "{{user.re-gion}}",
      "{{USER.region}}",
    ]) {
      expect(USER_ATTR_TOKEN_RE.test(bad), bad).toBe(false);
    }
  });

  it("the grant writer refuses malformed token-looking values, accepts literals and tokens", () => {
    // Same grammar at write time as at enforcement time — a malformed token
    // stored as a literal would silently match nothing while reading like a
    // rule.
    expect(rowFilterValueOk("EMEA")).toBe(true);
    expect(rowFilterValueOk("{{user.region}}")).toBe(true);
    expect(rowFilterValueOk("{{user.}}")).toBe(false);
    expect(rowFilterValueOk("{{region}}")).toBe(false);
    expect(rowFilterValueOk("x{{user.region}}")).toBe(false);
  });
});

describe("resolveAttributeGrants — substitution and refusal", () => {
  it("substitutes a token with ALL of the user's values for the key", () => {
    const [g] = resolveAttributeGrants(
      [grant(["{{user.region}}"])],
      attrs({ region: ["EMEA", "APAC"] }),
    );
    expect(g.row_filter).toEqual({ column: "region", values: ["EMEA", "APAC"] });
  });

  it("mixes literals and tokens in one filter", () => {
    const [g] = resolveAttributeGrants(
      [grant(["GLOBAL", "{{user.region}}"])],
      attrs({ region: ["EMEA"] }),
    );
    expect(g.row_filter).toEqual({ column: "region", values: ["GLOBAL", "EMEA"] });
  });

  it("REFUSES when the referenced attribute is missing, naming it", () => {
    expect(() => resolveAttributeGrants([grant(["{{user.region}}"])], attrs({}))).toThrow(
      /attribute "region".*no value.*IAM → Attributes/is,
    );
  });

  it("REFUSES when the attribute exists but is empty — never an empty filter", () => {
    expect(() =>
      resolveAttributeGrants([grant(["{{user.region}}"])], attrs({ region: [] })),
    ).toThrow(/attribute "region"/);
  });

  it("leaves grants without tokens untouched — same object, no copy", () => {
    const g = grant(["EMEA"]);
    const [out] = resolveAttributeGrants([g], attrs({}));
    expect(out).toBe(g);
  });

  it("attributeKeysInGrants finds every referenced key once", () => {
    const keys = attributeKeysInGrants([
      grant(["{{user.region}}", "{{user.tier}}"]),
      grant(["{{user.region}}"]),
      grant(["EMEA"]),
    ]);
    expect(keys.sort()).toEqual(["region", "tier"]);
  });
});

describe("resolution composes with the established merge semantics", () => {
  it("the union lives INSIDE one grant: a multi-value attribute widens its own IN list", () => {
    // "One grant, per-viewer scope" means the token expands within its own
    // filter; separate grants keep the merge's existing behavior below.
    const [g] = resolveAttributeGrants(
      [grant(["{{user.region}}", "GLOBAL"])],
      attrs({ region: ["EMEA", "APAC"] }),
    );
    const policy = policyFromGrants([g]);
    expect(policy.rowFilters).toEqual([{ column: "region", values: ["EMEA", "APAC", "GLOBAL"] }]);
  });

  it("two filtered grants stay two enforced filters — resolution does not reinvent the merge", () => {
    const resolved = resolveAttributeGrants(
      [grant(["{{user.region}}"]), grant(["AMER"])],
      attrs({ region: ["EMEA"] }),
    );
    const policy = policyFromGrants(resolved);
    expect(policy.rowFilters).toEqual([
      { column: "region", values: ["EMEA"] },
      { column: "region", values: ["AMER"] },
    ]);
  });

  it("an unrestricted grant still wins, token or not", () => {
    const resolved = resolveAttributeGrants(
      [grant(["{{user.region}}"]), { ...grant([]), row_filter: null }],
      attrs({ region: ["EMEA"] }),
    );
    expect(policyFromGrants(resolved).rowFilters).toBeNull();
  });

  it("the disclosure line shows RESOLVED values, not the token", () => {
    const policy = policyFromGrants(
      resolveAttributeGrants([grant(["{{user.region}}"])], attrs({ region: ["EMEA"] })),
    );
    expect(describePolicy(policy)).toContain("region ∈ [EMEA]");
    expect(describePolicy(policy)).not.toContain("{{");
  });
});

describe("the resolved policy, enforced and EXECUTED", () => {
  const model: SemanticModel = {
    name: "sales",
    source: { kind: "data_table", table: "orders" },
    dimensions: [{ name: "region", sql: "region", type: "categorical" }],
    metrics: [{ name: "total", agg: "sum", sql: "amount" }],
  } as SemanticModel;

  const orders: DuckTable = {
    name: "orders",
    columns: [
      { name: "region", type: "string" },
      { name: "amount", type: "number" },
    ],
    rows: [
      { region: "EMEA", amount: 100 },
      { region: "EMEA", amount: 50 },
      { region: "APAC", amount: 70 },
      { region: "AMER", amount: 999 },
    ],
  };

  it("the grantee's number is their region's — the other rows never reach them", async () => {
    const policy = policyFromGrants(
      resolveAttributeGrants([grant(["{{user.region}}"])], attrs({ region: ["EMEA"] })),
    );
    const q = applyAccessPolicy(model, { model: "sales", metrics: ["total"] }, policy);
    const compiled = compileSemanticQuery(model, q, { dialect: "duckdb" });
    const res = await runLocalSqlDuckDB(compiled.sql, [orders]);
    expect(res.rows).toEqual([{ total: 150 }]); // not 1219 — AMER stayed invisible
  });

  it("a two-value attribute widens to exactly those two regions", async () => {
    const policy = policyFromGrants(
      resolveAttributeGrants([grant(["{{user.region}}"])], attrs({ region: ["EMEA", "APAC"] })),
    );
    const q = applyAccessPolicy(model, { model: "sales", metrics: ["total"] }, policy);
    const compiled = compileSemanticQuery(model, q, { dialect: "duckdb" });
    const res = await runLocalSqlDuckDB(compiled.sql, [orders]);
    expect(res.rows).toEqual([{ total: 220 }]);
  });
});
