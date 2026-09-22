// The prep flow's rebuild: a delete whose failure would append the new rows
// to the old ones stops the write instead, and a schema that could not be
// updated fails the refresh rather than describing the previous columns.
//
// FOUND FROM THE SURVEY (R87). prep.server.ts dropped the rebuild's delete,
// the incremental refresh's schema update, and both semantics writes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/bi/prep.server.ts", "utf8");
const between = (start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const rebuild = between("const { snapshotDatasetQuiet } = await import", "} else {");
const insertLoop = src.slice(
  src.indexOf("for (let i = 0; i < args.rows.length; i += INSERT_BATCH)"),
);
const semantics = src.slice(src.indexOf("export async function savePrepSemantics("));

describe("a prep flow's rebuild", () => {
  it("does not write the new rows when the old ones could not be cleared", () => {
    expect(rebuild).toContain("const { error: clearErr } = await supabaseAdmin");
    expect(rebuild).toContain("The dataset's previous rows could not be cleared");
    expect(rebuild).toContain("Nothing was written, so");
    // The throw stands between the delete and the insert loop.
    expect(src.indexOf("if (clearErr) {")).toBeLessThan(
      src.indexOf("for (let i = 0; i < args.rows.length; i += INSERT_BATCH)"),
    );
    expect(insertLoop).toContain(
      'const { error } = await supabaseAdmin.from("user_data_rows").insert(slice);',
    );
  });
});

describe("an incremental refresh", () => {
  it("fails when the dataset's column list could not be updated", () => {
    expect(src).toContain("const { error: schemaErr } = await supabaseAdmin");
    expect(src).toContain("the dataset's column list could not be updated");
    expect(src).toContain("It describes the previous columns until it is");
  });
});

describe("a prep output's semantics", () => {
  it("reads the write's answer rather than trusting a catch that never runs", () => {
    expect(semantics).toContain("const { error } = existing");
    expect(semantics).toContain("the data is there, the descriptions are not");
  });
});
