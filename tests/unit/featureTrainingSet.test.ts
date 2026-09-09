// Point-in-time training sets: every label row keeps the features that were
// true at its OWN moment. The mistake this exists to prevent is joining the
// latest feature row, which teaches a model what happened after the thing it
// is predicting.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  leakyJoinSql,
  trainingSetError,
  trainingSetSql,
  type FeatureView,
  type TrainingSpine,
} from "@/lib/featureViews";

const rd = (p: string) => readFileSync(p, "utf8");

const view: FeatureView = {
  id: "v1",
  name: "customer_features",
  schema_name: "analytics",
  table_name: "features",
  key_columns: ["customer"],
  feature_columns: ["score", "tier"],
  timestamp_column: "as_of",
};

const spine: TrainingSpine = {
  schema_name: "analytics",
  table_name: "labels",
  timestamp_column: "label_at",
  key_columns: ["customer"],
  where: null,
};

const FEATURES = ["score", "tier"];

describe("the join asks for the past, not the present", () => {
  const sql = trainingSetSql(view, spine, FEATURES);

  it("is an ASOF join whose inequality points backwards in time", () => {
    expect(sql).toContain("ASOF LEFT JOIN");
    // The equality on the key comes first; the inequality ASOF resolves is
    // last, and it reads "the label's time is at or after the feature's".
    expect(sql).toContain(`ON s."customer" = f."customer" AND s."label_at" >= f."as_of"`);
    // Never the other direction: that would join a feature from the future.
    expect(sql).not.toContain(`s."label_at" <= f."as_of"`);
  });

  it("keeps every label row, including the ones with no feature yet", () => {
    // A key whose features start later is part of the training set; dropping
    // it silently changes what the model was trained on.
    expect(sql).toContain("ASOF LEFT JOIN");
    // Asking for it explicitly drops them, and only then.
    const inner = trainingSetSql(view, spine, FEATURES, { keepUnmatched: false });
    expect(inner).toContain(`ASOF JOIN "analytics"."features" f`);
    expect(inner).not.toContain("ASOF LEFT JOIN");
  });

  it("carries the whole label row and each feature by name", () => {
    expect(sql).toContain(`SELECT s.*, f."score", f."tier"`);
  });

  it("bounds staleness without dropping unmatched rows", () => {
    const bounded = trainingSetSql(view, spine, FEATURES, { maxAgeDays: 90 });
    expect(bounded).toContain(
      `WHERE (f."as_of" IS NULL OR f."as_of" >= s."label_at" - INTERVAL 90 DAY)`,
    );
    // A fractional or absent bound is simply no bound.
    expect(trainingSetSql(view, spine, FEATURES, { maxAgeDays: null })).not.toContain("INTERVAL");
    expect(trainingSetSql(view, spine, FEATURES, { maxAgeDays: 30.7 })).toContain(
      "INTERVAL 30 DAY",
    );
  });

  it("composite keys join on every part", () => {
    const composite = { ...view, key_columns: ["tenant", "customer"] };
    const mapped = { ...spine, key_columns: ["org", "cust"] };
    const out = trainingSetSql(composite, mapped, FEATURES);
    expect(out).toContain(`s."org" = f."tenant" AND s."cust" = f."customer" AND s."label_at" >=`);
  });

  it("a filter on the labels rides in the same WHERE", () => {
    const filtered = trainingSetSql(
      view,
      { ...spine, where: "label_at >= DATE '2024-01-01'" },
      FEATURES,
      { maxAgeDays: 60 },
    );
    expect(filtered).toContain(`WHERE (label_at >= DATE '2024-01-01') AND (f."as_of" IS NULL`);
  });
});

describe("what it refuses", () => {
  it("a view with no timestamp, because there is no “as of” to join on", () => {
    const err = trainingSetError({ ...view, timestamp_column: null }, spine, FEATURES);
    expect(err).toMatch(/no timestamp column/);
    expect(err).toMatch(/when each feature row became true/);
  });

  it("a key mapping that does not cover the view's key", () => {
    expect(trainingSetError(view, { ...spine, key_columns: [] }, FEATURES)).toMatch(
      /keyed by 1 column/,
    );
  });

  it("a feature whose name the label table already uses", () => {
    // Two columns of the same name and the trainer reads whichever the engine
    // hands it — which is not a thing to leave to chance.
    expect(trainingSetError(view, spine, ["customer"])).toMatch(/already has a column named/);
    expect(trainingSetError(view, spine, ["label_at"])).toMatch(/already has a column named/);
  });

  it("anything that is not a plain identifier", () => {
    expect(trainingSetError(view, { ...spine, timestamp_column: "a b" }, FEATURES)).toMatch(
      /not a column name/,
    );
    expect(trainingSetError(view, { ...spine, table_name: "x; DROP TABLE y" }, FEATURES)).toMatch(
      /plain identifiers/,
    );
  });
});

describe("the join people write by hand, kept for contrast", () => {
  it("takes the latest feature row regardless of when the label was true", () => {
    const leaky = leakyJoinSql(view, spine, FEATURES);
    expect(leaky).toContain(`row_number() OVER (PARTITION BY "customer" ORDER BY "as_of" DESC)`);
    expect(leaky).toContain("f._fv_rn = 1");
    // It has no idea the label has a time at all. That is the whole bug.
    expect(leaky).not.toContain(`s."label_at" >=`);
    expect(leaky).not.toContain("ASOF");
  });
});

describe("the wiring", () => {
  const srv = rd("src/utils/featureViews/trainingSet.server.ts");

  it("runs through the lakehouse chokepoint, never its own connection", () => {
    // That chokepoint applies the owner's schema access and writes the audit
    // row; a training set that opened its own connection would be a side door.
    expect(srv).toContain("runLakehouseStatement");
    expect(srv).not.toContain("DuckDBInstance");
    expect(srv).toContain('auditVia: "feature-training-set"');
    expect(srv).toContain('action: "feature_view.training_set"');
  });

  it("writes the table in one statement", () => {
    // So a reader sees the old rows or the new ones, never a half-built set.
    expect(srv).toContain("CREATE OR REPLACE TABLE ${target} AS ${select}");
  });

  it("excludes the timestamp from the features it infers", () => {
    // A model that trains on the feature clock learns the shape of the ETL
    // schedule rather than anything about the entity.
    const fn = srv.slice(srv.indexOf("export async function resolveFeatureColumns"));
    expect(fn).toContain("view.timestamp_column");
    expect(fn).toContain("excluded.has(n)");
  });

  it("counts the rows a hand-written join would have got wrong", () => {
    expect(srv).toContain("IS DISTINCT FROM");
    expect(srv).toContain("leaked_rows_avoided");
  });

  it("the panel offers it only when the view can answer as of a time", () => {
    const page = rd("src/components/ml/FeatureViewsPanel.tsx");
    expect(page).toContain("disabled={!v.timestamp_column}");
    expect(page).toContain("Training set");
    expect(page).toContain("at its own timestamp");
    expect(page).toContain("featureViewBuildTrainingSet");
  });

  it("is documented in both doc sets", () => {
    expect(rd("docs/ML.md")).toContain("Point-in-time training sets");
    expect(rd("src/routes/docs.ml.tsx")).toContain("point-in-time");
  });
});
