// A SQL model's build replaces only what it built (R178).
//
// R103 made a new model find its name free when saved, and R128 refused a
// table a sheet holds; a table made at the target AFTER the save was still
// replaced by the next build. Driven: SQL Models → New model `r178_target`,
// analytics, Table, `SELECT 178 AS id` → Create (not built); Lakehouse →
// `CREATE TABLE analytics.r178_target AS SELECT 'made after the model was
// saved' AS note`; the model → Build this and what it reads → "Built 1
// model"; `SELECT * FROM analytics.r178_target` → `id 178`. The table was gone.
//
// Each build now marks what it made with a comment DuckLake keeps, and a
// build replaces only its own mark. The rules are pure and always run; the
// catalog half runs on a real DuckLake when its extension can be loaded here.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import {
  builtMark,
  markStatement,
  targetObject,
  targetRefusal,
  type ModelAtTarget,
} from "@/utils/sqlModels/target.server";

const model = (over: Partial<ModelAtTarget> = {}): ModelAtTarget => ({
  id: "m-178",
  schema_name: "analytics",
  name: "r178_target",
  last_status: "built",
  last_run_at: "2026-09-30T10:00:00.000Z",
  ...over,
});
const at = (iso: string) => Date.parse(iso);

describe("what a build may replace", () => {
  it("nothing there, or its own mark", () => {
    expect(targetRefusal(null, model())).toBeNull();
    const own = {
      kind: "table" as const,
      comment: builtMark("m-178"),
      createdMs: at("2026-09-30T11:00:00Z"),
      beforeHistory: false,
    };
    expect(targetRefusal(own, model())).toBeNull();
  });
  it("not another model's mark, nor any other comment", () => {
    const other = {
      kind: "table" as const,
      comment: builtMark("m-other"),
      createdMs: 1,
      beforeHistory: false,
    };
    expect(targetRefusal(other, model())).toMatch(/this model did not build it/);
    const note = {
      kind: "view" as const,
      comment: "kept by finance",
      createdMs: 1,
      beforeHistory: false,
    };
    expect(targetRefusal(note, model())).toMatch(/^A view named analytics\.r178_target/);
  });
  it("an unmarked object only if no newer than the model's last successful build", () => {
    const older = {
      kind: "table" as const,
      comment: null,
      createdMs: at("2026-09-30T09:59:00Z"),
      beforeHistory: false,
    };
    expect(targetRefusal(older, model())).toBeNull();
    const newer = { ...older, createdMs: at("2026-09-30T10:01:00Z") };
    expect(targetRefusal(newer, model())).toMatch(/would replace it/);
    // A failed last build, or a model never built, vouches for nothing.
    expect(targetRefusal(older, model({ last_status: "failed" }))).not.toBeNull();
    expect(targetRefusal(older, model({ last_status: null, last_run_at: null }))).not.toBeNull();
    // Nor does an object whose age cannot be told.
    expect(targetRefusal({ ...older, createdMs: null }, model())).not.toBeNull();
  });
  it("an unmarked object older than the catalog's kept history, after a successful build", () => {
    // Maintenance expires snapshots after a week; a table built before marks
    // then has no creation time at all (stg_revenue in R178's own round).
    const aged = { kind: "table" as const, comment: null, createdMs: null, beforeHistory: true };
    expect(targetRefusal(aged, model())).toBeNull();
    expect(targetRefusal(aged, model({ last_status: "failed" }))).not.toBeNull();
    expect(targetRefusal(aged, model({ last_status: null, last_run_at: null }))).not.toBeNull();
    // A comment that is not this model's mark is refused, however old.
    expect(targetRefusal({ ...aged, comment: builtMark("m-other") }, model())).not.toBeNull();
  });
  it("names the target and the way out", () => {
    const newer = {
      kind: "table" as const,
      comment: null,
      createdMs: at("2026-09-30T10:01:00Z"),
      beforeHistory: false,
    };
    expect(targetRefusal(newer, model())).toBe(
      "A table named analytics.r178_target is at this model's target, and this model did not " +
        "build it: the build would replace it. Rename the model, or rename or drop that table.",
    );
  });
  it("the mark is a comment statement on the model's own target", () => {
    expect(markStatement("VIEW", '"analytics"."r178_target"', "m'178")).toBe(
      `COMMENT ON VIEW "analytics"."r178_target" IS 'agentswarms: built by SQL model m''178'`,
    );
  });
});

describe("the build asks before it touches the target, and marks what it made", () => {
  const RUN = readFileSync("src/utils/sqlModels/run.server.ts", "utf8");
  const BUILD = RUN.slice(
    RUN.indexOf("async function buildOne("),
    RUN.indexOf("async function runTests("),
  );
  it("refuses before the DROP of the other shape and the CREATE", () => {
    const ask = BUILD.indexOf(
      "const refused = targetRefusal(await targetObject(c, model.schema_name, model.name), model);",
    );
    const refuse = BUILD.indexOf("if (refused) return fail(refused);");
    expect(ask).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(ask);
    expect(BUILD.indexOf("DROP ${kind")).toBeGreaterThan(refuse);
  });
  it("marks right after the CREATE, before counting and testing", () => {
    const create = BUILD.indexOf("await c.run(`CREATE OR REPLACE ${kind} ${target} AS ${body}`);");
    const mark = BUILD.indexOf("await c.run(markStatement(kind, target, model.id));");
    expect(create).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(create);
    expect(BUILD.indexOf("SELECT count(*) FROM ${target}")).toBeGreaterThan(mark);
  });
});

// A real DuckLake catalog, when the extension can be loaded (it is cached with DuckDB's own).
const lake = await (async () => {
  try {
    const dir = mkdtempSync(join(tmpdir(), "r178-"));
    const db = await DuckDBInstance.create(":memory:");
    const c = await db.connect();
    const path = (p: string) => join(dir, p).replace(/\\/g, "/");
    await c.run("INSTALL ducklake; LOAD ducklake;");
    await c.run(`ATTACH 'ducklake:${path("cat.ducklake")}' AS lake (DATA_PATH '${path("data")}/')`);
    await c.run("USE lake");
    await c.run("CREATE SCHEMA analytics");
    return c;
  } catch {
    return null;
  }
})();

describe.skipIf(!lake)("on a DuckLake catalog", () => {
  it("finds a table or a view at the target, without case, with its comment and age", async () => {
    const c = lake!;
    expect(await targetObject(c, "analytics", "r178_target")).toBeNull();
    const before = Date.now() - 1000;
    await c.run("CREATE TABLE analytics.R178_Target AS SELECT 'made after the save' AS note");
    const found = await targetObject(c, "Analytics", "r178_TARGET");
    expect(found).toMatchObject({ kind: "table", comment: null });
    expect(found!.createdMs).toBeGreaterThanOrEqual(before);
    expect(found!.createdMs).toBeLessThanOrEqual(Date.now() + 1000);
    await c.run("CREATE VIEW analytics.r178_view AS SELECT 1 AS x");
    expect(await targetObject(c, "analytics", "r178_view")).toMatchObject({ kind: "view" });
  });
  it("reads back the mark a build leaves, which a replace does not keep", async () => {
    const c = lake!;
    await c.run("CREATE TABLE analytics.r178_marked AS SELECT 1 AS id");
    await c.run(markStatement("TABLE", '"analytics"."r178_marked"', "m-178"));
    const marked = await targetObject(c, "analytics", "r178_marked");
    expect(marked!.comment).toBe(builtMark("m-178"));
    expect(targetRefusal(marked, model({ name: "r178_marked", last_status: null }))).toBeNull();
    await c.run("CREATE OR REPLACE TABLE analytics.r178_marked AS SELECT 2 AS id");
    expect((await targetObject(c, "analytics", "r178_marked"))!.comment).toBeNull();
    await c.run("CREATE VIEW analytics.r178_vmark AS SELECT 1 AS x");
    await c.run(markStatement("VIEW", '"analytics"."r178_vmark"', "m-178"));
    expect((await targetObject(c, "analytics", "r178_vmark"))!.comment).toBe(builtMark("m-178"));
  });
  it("an object whose creation snapshot was expired is older than the history, and keeps its mark", async () => {
    const c = lake!;
    await c.run("CREATE TABLE analytics.r178_aged AS SELECT 1 AS id");
    await c.run(markStatement("TABLE", '"analytics"."r178_aged"', "m-aged"));
    await c.run("CREATE TABLE analytics.r178_later AS SELECT 2 AS id");
    await c.run("CALL ducklake_expire_snapshots('lake', older_than => now())");
    const aged = await targetObject(c, "analytics", "r178_aged");
    expect(aged).toMatchObject({ createdMs: null, beforeHistory: true });
    expect(aged!.comment).toBe(builtMark("m-aged"));
  });
  it("refuses the table made after the save, as the driven case", async () => {
    const c = lake!;
    const found = await targetObject(c, "analytics", "r178_target");
    const neverBuilt = model({ last_status: null, last_run_at: null });
    expect(targetRefusal(found, neverBuilt)).toMatch(/^A table named analytics\.r178_target/);
  });
});
