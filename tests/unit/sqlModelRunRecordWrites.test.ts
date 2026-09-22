// The SQL model build's records: a run that finished does not stay
// "running", a model's badge that could not be stamped is said in the
// build's own result, and lineage is never written beside what could not be
// cleared.
//
// FOUND FROM THE SURVEY (R83). run.server.ts had 4 writes that dropped their
// errors — among them the "edited — not built since" clear R60 added.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/sqlModels/run.server.ts", "utf8");
const between = (start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const finish = between("const finish = async (", "if (!lakehouseEnabled()) {");
const buildOne = between("async function buildOne(", "async function runTests(");
const stamp = between("async function stampModel(", "/**\n * Record model-to-model edges");
const lineage = between("async function writeLineage(", "/**\n * Build for every owner");

describe("closing a build", () => {
  it("retries the close once and says a run it could not close", () => {
    expect((finish.match(/await close\(\)/g) ?? []).length).toBe(2);
    expect(finish).toContain("could not be closed after two attempts");
    expect(finish).toContain("It will show as running until it is closed.");
  });
});

describe("stamping a model", () => {
  it("returns what could not be written, and the build's result says it", () => {
    expect(stamp).toContain("): Promise<string | null> {");
    expect(stamp).toContain("const { error: stampErr } = await supabaseAdmin");
    expect(stamp).toContain("the page shows the previous build until it is");
    expect(stamp).toContain("const { error: clearErr } = await supabaseAdmin");
    expect(stamp).toContain("the model shows as edited, not built since, until the next build");
    expect((buildOne.match(/const stampErr = await stampModel\(/g) ?? []).length).toBe(2);
    expect(buildOne).toContain("[error, stampErr].filter(Boolean).join");
    expect(buildOne).toContain("[message, stampErr].filter(Boolean).join");
  });
});

describe("the models' lineage", () => {
  it("is never written beside edges that could not be cleared", () => {
    expect(lineage).toContain("const { error: clearErr } = await supabaseAdmin");
    expect(lineage.indexOf("if (clearErr) {")).toBeLessThan(
      lineage.indexOf("if (rows.length > 0) {"),
    );
    expect(lineage).toContain("the old ones stand");
    expect(lineage).toContain("const { error: insErr } = await supabaseAdmin");
    expect(lineage).toContain("the graph is partial until the next build");
  });
});
