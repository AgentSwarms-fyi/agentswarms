// What an ML run may do in the lakehouse.
//
// Training, prediction and warm scoring hold no lakehouse credential since
// R231: the app reads the source, loads the scored rows and signs one URL per
// model artifact. What a run may ask for is this manifest, pinned on its
// session, and the app serves nothing else.
import { describe, expect, it, vi } from "vitest";

import {
  artifactKeyOf,
  mlPredictManifest,
  mlSourceSelect,
  mlTrainManifest,
} from "@/utils/ml/lakeManifest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

const SRC = { schema: "analytics", table: "facts" };
const ART = "s3://lake/ml-artifacts/m1/v3/model.joblib";

describe("the SELECT an ML run reads", () => {
  it("is the table, quoted, when there is no preparation", () => {
    expect(mlSourceSelect(SRC)).toBe('SELECT * FROM "analytics"."facts"');
  });

  it("narrows by a prep step's WHERE, or is replaced by its own SQL", () => {
    expect(mlSourceSelect({ ...SRC, prep: { where: "region = 'EMEA'" } })).toBe(
      'SELECT * FROM "analytics"."facts" WHERE (region = \'EMEA\')',
    );
    expect(mlSourceSelect({ ...SRC, prep: { sql: "SELECT a FROM analytics.facts;" } })).toBe(
      "SELECT * FROM (SELECT a FROM analytics.facts) AS _prep",
    );
    // A prep step with both: its own SQL wins, as it did in the sandbox.
    expect(mlSourceSelect({ ...SRC, prep: { sql: "SELECT 1", where: "x" } })).toContain("AS _prep");
  });

  it("quotes a table whose name could close the identifier", () => {
    expect(mlSourceSelect({ schema: 'a"b', table: 'c"d' })).toBe('SELECT * FROM "a""b"."c""d"');
  });
});

describe("a training run's manifest", () => {
  it("declares one read and the artifact it may write, and loads nothing", () => {
    const m = mlTrainManifest({ source: SRC, task: "classification", artifactUri: ART });
    expect(Object.keys(m.reads)).toEqual(["source"]);
    expect(m.reads.source!.sql).toBe('SELECT * FROM "analytics"."facts"');
    expect(m.writes).toEqual({});
    expect(m.artifacts).toEqual({ put: "ml-artifacts/m1/v3/model.joblib", get: [] });
  });

  it("samples a large table, but refuses a forecast's series instead", () => {
    const sampled = mlTrainManifest({
      source: SRC,
      task: "classification",
      maxRows: 5000,
      artifactUri: ART,
    });
    expect(sampled.reads.source!.sampleTo).toBe(5000);
    expect(sampled.reads.source!.refuseOver).toBeUndefined();
    // A series is not a bag of rows: a sample of it is not a shorter series.
    const forecast = mlTrainManifest({
      source: SRC,
      task: "forecast",
      maxRows: 5000,
      artifactUri: ART,
    });
    expect(forecast.reads.source!.sampleTo).toBeUndefined();
    expect(forecast.reads.source!.refuseOver!.rows).toBe(5000);
    expect(forecast.reads.source!.refuseOver!.message).toMatch(/Aggregate it to one row/);
    // No limit set means no limit, as the trainer's config has always meant.
    expect(
      mlTrainManifest({ source: SRC, task: "forecast", maxRows: 0, artifactUri: ART }).reads.source!
        .refuseOver,
    ).toBeUndefined();
  });

  it("gives a data-parallel worker its own slice, inside the declared SELECT", () => {
    const m = mlTrainManifest({
      source: SRC,
      task: "classification",
      artifactUri: ART,
      partitionSql: 'hash("a") % 4 = 2',
    });
    expect(m.reads.source!.sql).toBe(
      'SELECT * FROM (SELECT * FROM "analytics"."facts" WHERE hash("a") % 4 = 2) AS _part',
    );
  });

  it("lets an assemble step read its workers' artifacts and nothing else", () => {
    const parts = [
      "s3://lake/ml-artifacts/m1/v3/model.part0.joblib",
      "s3://lake/ml-artifacts/m1/v3/model.part1.joblib",
    ];
    const m = mlTrainManifest({
      source: SRC,
      task: "classification",
      artifactUri: ART,
      partUris: parts,
    });
    // An assemble does not train, so it reads no table at all.
    expect(m.reads).toEqual({});
    expect(m.artifacts!.get).toEqual([
      "ml-artifacts/m1/v3/model.part0.joblib",
      "ml-artifacts/m1/v3/model.part1.joblib",
    ]);
    expect(m.artifacts!.put).toBe("ml-artifacts/m1/v3/model.joblib");
  });
});

describe("a prediction's manifest", () => {
  it("reads the batch, writes the output table, and reads its own model", () => {
    const m = mlPredictManifest({
      input: {
        kind: "lakehouse",
        schema: "analytics",
        table: "to_score",
        where: "d > '2026-01-01'",
      },
      output: { schema: "analytics", table: "scored" },
      maxRows: 100000,
      artifactUri: ART,
    });
    expect(m.reads.input!.sql).toBe(
      'SELECT * FROM "analytics"."to_score" WHERE (d > \'2026-01-01\')',
    );
    expect(m.reads.input!.refuseOver!.rows).toBe(100000);
    expect(m.reads.input!.refuseOver!.message).toMatch(/above the 100000-row prediction limit/);
    expect(m.writes.output).toEqual({
      label: "analytics.scored",
      schema: "analytics",
      table: "scored",
      mode: "replace",
      primaryKey: [],
    });
    expect(m.artifacts).toEqual({ get: ["ml-artifacts/m1/v3/model.joblib"] });
    // It may not WRITE its model, only read it.
    expect(m.artifacts!.put).toBeUndefined();
  });

  it("reads nothing when the caller sent the rows, and writes nothing without an output", () => {
    const m = mlPredictManifest({ input: { kind: "rows" }, output: null, artifactUri: ART });
    expect(m.reads).toEqual({});
    expect(m.writes).toEqual({});
    expect(m.artifacts!.get).toHaveLength(1);
  });
});

describe("an artifact's key", () => {
  it("is what sits inside the bucket, however the URI is spelled", () => {
    expect(artifactKeyOf("s3://lake/ml-artifacts/m/v1/model.joblib")).toBe(
      "ml-artifacts/m/v1/model.joblib",
    );
    expect(artifactKeyOf("s3a://lake/ml-artifacts/m/v1/model.joblib")).toBe(
      "ml-artifacts/m/v1/model.joblib",
    );
    expect(artifactKeyOf("/ml-artifacts/m/v1/model.joblib")).toBe("ml-artifacts/m/v1/model.joblib");
  });
});
