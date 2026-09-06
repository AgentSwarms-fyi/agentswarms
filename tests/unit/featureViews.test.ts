// Feature views: score by key, so serving cannot compute a feature
// differently from how training computed it.
//
// The failure this exists to prevent is quiet. A caller POSTs the right column
// NAMES with values it worked out itself, months later, in its own code; the
// model gets numbers of the right shape and the wrong meaning and answers
// confidently. So what is pinned here is mostly about exactness: which columns
// come back, matched to which key, and what happens when a key matches nothing
// or matches twice.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  MAX_KEYS_PER_LOOKUP,
  keyFingerprint,
  lookupSql,
  ql,
  qi,
  resolutionError,
  resolveRows,
  validateKeys,
  validateView,
  validateViewName,
  viewTableLabel,
  type FeatureView,
} from "@/lib/featureViews";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const view = (over: Partial<FeatureView> = {}): FeatureView => ({
  id: "v1",
  name: "customer_features",
  schema_name: "analytics",
  table_name: "fct_customer_features",
  key_columns: ["customer_id"],
  feature_columns: ["orders_30d", "revenue_30d"],
  timestamp_column: null,
  ...over,
});

describe("what a view may say", () => {
  it("takes a name that can also be looked up, and refuses one that cannot", () => {
    expect(validateViewName("customer_features")).toBeNull();
    expect(validateViewName("Customer Features")).toMatch(/lower case/);
    expect(validateViewName("")).toMatch(/name/);
  });

  it("refuses a column that is both a key and a feature", () => {
    // A key is what you look a row up BY. Fed back in as a feature it teaches
    // the model to memorise identifiers, which scores beautifully in training
    // and predicts nothing.
    const bad = validateView({
      ...view({ feature_columns: ["customer_id", "orders_30d"] }),
      name: "v",
    });
    expect(bad).toMatch(/cannot be both a key and a feature/);
    // Mutation check: without the overlap the same view is fine.
    expect(validateView({ ...view(), name: "v" })).toBeNull();
  });

  it("refuses a name that is not a column name", () => {
    expect(validateView({ ...view({ key_columns: ['a"; drop table x --'] }), name: "v" })).toMatch(
      /is not a column name/,
    );
  });

  it("needs a key, and refuses a key listed twice", () => {
    expect(validateView({ ...view({ key_columns: [] }), name: "v" })).toMatch(/identif/);
    expect(
      validateView({ ...view({ key_columns: ["customer_id", "customer_id"] }), name: "v" }),
    ).toMatch(/twice/);
  });
});

describe("what a key must be", () => {
  it("takes a key naming every key column", () => {
    expect(validateKeys(view(), [{ customer_id: "c-1" }])).toBeNull();
  });

  it("refuses a key missing a column, or with a null in it", () => {
    expect(validateKeys(view({ key_columns: ["a", "b"] }), [{ a: 1 }])).toMatch(/every key needs/);
    expect(validateKeys(view(), [{ customer_id: null }])).toMatch(/cannot be null/);
    expect(validateKeys(view(), [])).toMatch(/non-empty/);
    expect(validateKeys(view(), [{ customer_id: { nested: 1 } as never }])).toMatch(
      /string, number or boolean/,
    );
  });

  it("caps a batch", () => {
    const many = Array.from({ length: MAX_KEYS_PER_LOOKUP + 1 }, (_, i) => ({ customer_id: i }));
    expect(validateKeys(view(), many)).toMatch(/Too many keys/);
  });
});

describe("the lookup", () => {
  it("selects a column LIST, never everything", () => {
    // A column added to the table later must not silently become a feature
    // the model never trained on.
    const sql = lookupSql(view(), [{ customer_id: "c-1" }]);
    expect(sql).toContain('SELECT "customer_id", "orders_30d", "revenue_30d"');
    expect(sql).not.toContain("SELECT *");
    expect(sql).toContain('FROM "analytics"."fct_customer_features"');
  });

  it("matches a composite key as AND, and several keys as OR", () => {
    const sql = lookupSql(view({ key_columns: ["tenant", "customer_id"] }), [
      { tenant: "t1", customer_id: "c-1" },
      { tenant: "t1", customer_id: "c-2" },
    ]);
    expect(sql).toContain(`("tenant" = 't1' AND "customer_id" = 'c-1')`);
    expect(sql).toContain(" OR ");
  });

  it("escapes a value with a quote in it", () => {
    const sql = lookupSql(view(), [{ customer_id: "O'Brien" }]);
    expect(sql).toContain("'O''Brien'");
    expect(ql("a'b")).toBe("'a''b'");
    expect(qi('we"ird')).toBe('"we""ird"');
  });

  it("writes numbers and booleans unquoted", () => {
    const sql = lookupSql(view({ key_columns: ["id", "active"] }), [{ id: 7, active: true }]);
    expect(sql).toContain(`"id" = 7`);
    expect(sql).toContain(`"active" = true`);
  });

  it("takes the newest row per key when the view has a timestamp", () => {
    const sql = lookupSql(view({ timestamp_column: "as_of" }), [{ customer_id: "c-1" }]);
    expect(sql).toContain('row_number() OVER (PARTITION BY "customer_id" ORDER BY "as_of" DESC)');
    expect(sql).toContain("_fv_rn = 1");
  });

  it("fetches one extra row without a timestamp, so a duplicate key is visible", () => {
    // Resolving a duplicate by taking whichever row arrived first is how a
    // feature store starts lying.
    const sql = lookupSql(view(), [{ customer_id: "c-1" }], { limit: 1 });
    expect(sql).toContain("LIMIT 2");
  });
});

describe("matching rows back to keys", () => {
  const v = view();

  it("returns rows in the order the keys were asked for, not the order they arrived", () => {
    // A feature attributed to the wrong key is the worst failure here, and a
    // SELECT promises nothing about row order.
    const rows = [
      { customer_id: "c-2", orders_30d: 2 },
      { customer_id: "c-1", orders_30d: 1 },
    ];
    const r = resolveRows(v, [{ customer_id: "c-1" }, { customer_id: "c-2" }], rows);
    expect(r.rows.map((x) => x.customer_id)).toEqual(["c-1", "c-2"]);
    expect(r.missing).toEqual([]);
  });

  it("names a key that matched nothing rather than filling it with nulls", () => {
    // A row of nulls scores perfectly happily and means nothing.
    const r = resolveRows(
      v,
      [{ customer_id: "c-1" }, { customer_id: "ghost" }],
      [{ customer_id: "c-1", orders_30d: 1 }],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.missing).toEqual(["customer_id=ghost"]);
  });

  it("reports a duplicate key rather than picking one", () => {
    const r = resolveRows(
      v,
      [{ customer_id: "c-1" }],
      [
        { customer_id: "c-1", orders_30d: 1 },
        { customer_id: "c-1", orders_30d: 9 },
      ],
    );
    expect(r.duplicated).toEqual(["customer_id=c-1"]);
    expect(resolutionError(v, r)).toMatch(/more than one row/);
    // With a timestamp the duplicate is expected and resolved by the SQL.
    const t = resolveRows(
      view({ timestamp_column: "as_of" }),
      [{ customer_id: "c-1" }],
      [{ customer_id: "c-1", orders_30d: 1 }],
    );
    expect(t.duplicated).toEqual([]);
    expect(resolutionError(view({ timestamp_column: "as_of" }), t)).toBeNull();
  });

  it("fails when nothing matched at all, and not when something did", () => {
    const none = resolveRows(v, [{ customer_id: "ghost" }], []);
    expect(resolutionError(v, none)).toMatch(/No features found/);
    const some = resolveRows(
      v,
      [{ customer_id: "c-1" }, { customer_id: "ghost" }],
      [{ customer_id: "c-1" }],
    );
    expect(resolutionError(v, some)).toBeNull();
  });

  it("fingerprints a key the one way", () => {
    expect(keyFingerprint(view({ key_columns: ["a", "b"] }), { a: 1, b: "x" })).toBe("a=1|b=x");
    expect(viewTableLabel(v)).toBe("analytics.fct_customer_features");
  });
});

describe("the wiring", () => {
  const migration = rd("supabase/migrations/20260875000000_feature_views.sql");
  const lookup = rd("src/utils/featureViews/lookup.server.ts");
  const route = rd("src/routes/api/ml.predict.ts");

  it("owns its table, owner-only, audited", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.feature_views");
    expect(migration).toContain("ALTER TABLE public.feature_views ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("auth.uid() = user_id");
    const trigger = migration.slice(migration.indexOf("CREATE TRIGGER audit_feature_views"));
    expect(trigger).toContain("audit_row_change('feature_view')");
    for (const col of ["schema_name", "table_name", "key_columns", "feature_columns"]) {
      expect(trigger, col).toContain(col);
    }
  });

  it("materialises nothing of its own", () => {
    // The table is whatever built it — a SQL model is the natural author, and
    // a second scheduler here would duplicate its schedule, its tests and its
    // lineage badly.
    expect(migration).not.toContain("CREATE OR REPLACE TABLE");
    expect(migration).not.toContain("next_run_at");
  });

  it("reads through the governed chokepoint, as the owner, uncached", () => {
    // A lookup that opened its own connection would be a way to read a table
    // the caller cannot read.
    expect(lookup).toContain("runLakehouseStatement");
    expect(lookup).toContain("useCache: false");
    expect(lookup).toContain("auditVia");
    expect(route).toContain("userId: auth.model.user_id");
  });

  it("accepts keys only when the model has a view, and never both inputs", () => {
    expect(route).toContain('return mlJson({ error: "Send rows or keys, not both" }, 400);');
    expect(route).toContain("auth.model.feature_view_id");
    expect(route).toContain("cannot be scored by key");
  });

  it("resolves keys before the shared predict path, not inside it", () => {
    // Everything downstream — the warm scorer, the sandbox stash, the
    // recorded prediction — assumes materialised rows. A second shape threaded
    // through all of it would be a second way for serving to disagree.
    // The CALL sites, not the imports at the top of the file.
    expect(route.indexOf("await lookupFeatures(")).toBeGreaterThan(0);
    expect(route.indexOf("await lookupFeatures(")).toBeLessThan(
      route.indexOf("await predictRowsSync("),
    );
    expect(rd("src/utils/ml/predict.server.ts")).not.toContain("feature_view");
  });

  it("says where the features came from, and which keys found nothing", () => {
    expect(route).toContain("feature_view: resolvedFrom.view");
    expect(route).toContain("keys_not_found: resolvedFrom.missing");
  });

  it("checks a view against its table before saving it", () => {
    // A view whose key column does not exist otherwise fails behind a live
    // prediction, which is the worst place to find out.
    const fns = rd("src/utils/featureViews.functions.ts");
    expect(fns).toContain("describeViewTable");
    expect(fns).toContain("has no column");
    expect(lookup).toContain("LIMIT 0");
  });

  it("says what stops working when a view is deleted", () => {
    const fns = rd("src/utils/featureViews.functions.ts");
    expect(fns).toContain("detachedFrom");
    expect(rd("src/components/ml/FeatureViewsPanel.tsx")).toContain("needs whole rows again");
  });

  it("is reachable where the models are, without a twelfth sidebar item", () => {
    const page = rd("src/routes/_authenticated/ml.tsx");
    expect(page).toContain("FeatureViewsPanel");
    expect(page).toContain("Feature views");
    expect(rd("src/routes/_authenticated/ml_.$modelId.tsx")).toContain("ModelFeatureView");
  });

  it("is documented in both doc sets", () => {
    expect(rd("docs/ML.md")).toContain("Feature views");
    expect(rd("src/routes/docs.ml.tsx")).toContain("Feature views");
  });
});
