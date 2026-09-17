// A write is authorized on what it READS, not only on what it writes.
//
// THE HOLE THIS CLOSES. The chokepoint resolved and access-checked referenced
// tables only on the `select` branch. For everything else it authorized the
// write target and stopped, so two statements copied any table in the
// deployment into a schema you own:
//
//   CREATE TABLE mine.copy AS SELECT * FROM someone_elses.customers;
//
// DuckDB has no per-user ACLs and the engine holds one attach over the whole
// catalog, so the read simply succeeded. INSERT…SELECT, MERGE…USING,
// UPDATE…FROM and DELETE…USING all have the same shape.
//
// It could not be fixed by reusing the SELECT path: DuckDB's
// `json_serialize_sql` refuses every non-SELECT statement — probed against the
// shipped engine, which is why the hole existed. The read set is recovered by
// a text scan that fails closed instead.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { qualifiedRefs } from "@/utils/lakehouse/sqlRefs";

const core = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");

/**
 * The write branch of the chokepoint, as CODE.
 *
 * Anchored forward from the branch start. Two earlier attempts got this wrong
 * and both failed OPEN: "for (let attempt" also appears in the extension
 * bootstrap hundreds of lines above, so the slice ran backwards and produced
 * "", and "Writes get a bounded retry" lives in a comment that this file
 * strips, so the slice ran to end-of-file and swallowed unrelated matches. A
 * slice that is too big is why the worst mutant survived.
 */
function branch(): string {
  const a = code.indexOf('if (classified.kind !== "select")');
  expect(a, "the write branch moved; re-anchor this file").toBeGreaterThan(-1);
  const b = code.indexOf("for (let attempt", a);
  expect(b, "the retry loop moved; re-anchor this file").toBeGreaterThan(a);
  return code.slice(a, b);
}
/** Comments removed, for asserting an absence — the comments describe the bug. */
const code = core.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("the attack the old code allowed", () => {
  it("names both schemas of a CTAS, so the source can be refused", () => {
    // The old path saw only "mine". If this ever returns one schema again,
    // the copy-any-table bypass is back.
    const refs = qualifiedRefs("CREATE TABLE mine.copy AS SELECT * FROM someone_elses.customers");
    const schemas = [...new Set(refs.map((r) => r.schema))];
    expect(schemas).toContain("mine");
    expect(schemas, "the SOURCE schema is invisible again").toContain("someone_elses");
  });

  it("names the source of every write shape that can read another table", () => {
    for (const [sql, source] of [
      ["INSERT INTO mine.t SELECT * FROM theirs.secret", "theirs"],
      [
        "MERGE INTO mine.t USING theirs.src s ON s.id = mine.t.id WHEN MATCHED THEN DELETE",
        "theirs",
      ],
      ["UPDATE mine.t SET x = s.x FROM theirs.src s WHERE s.id = mine.t.id", "theirs"],
      ["DELETE FROM mine.t USING theirs.src s WHERE s.id = mine.t.id", "theirs"],
      ["CREATE VIEW mine.v AS SELECT * FROM theirs.policed", "theirs"],
    ] as const) {
      const schemas = qualifiedRefs(sql).map((r) => r.schema);
      expect(schemas, sql).toContain(source);
    }
  });
});

describe("the chokepoint checks reads on every statement kind", () => {
  it("authorizes the read set outside the select-only branch", () => {
    // The structural property: the write branch must do its own read check.
    const writeBranch = branch();
    expect(writeBranch, "the write branch no longer exists; re-anchor").toContain(
      "assertSchemasAllowed",
    );
    expect(writeBranch).toContain("qualifiedRefs(sql)");
    // Two distinct assertions: the write target, and everything mentioned.
    expect(writeBranch.match(/assertSchemasAllowed/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("refuses a write that reads a policed table rather than filtering it", () => {
    // Filtering would produce a copy with silently fewer rows than the source.
    // A refusal is a thing the user can ask about.
    const writeBranch = branch();
    expect(writeBranch).toContain("loadPolicies");
    // It must THROW. An earlier version asserted only that the sentence
    // existed, and a mutant that downgraded the refusal to console.warn
    // survived — the message was still there, and the statement still ran.
    // Anchored on THIS guard's own wording. "has a security policy" also
    // appears in the pre-existing write-TARGET guard a few lines above, so a
    // looser regex matched that one and a mutant downgrading this refusal to
    // console.warn survived.
    expect(writeBranch).toMatch(
      /throw new Error\(\s*`This statement reads[\s\S]{0,80}has a security policy/,
    );
  });
});

describe("policed-ness has one implementation", () => {
  it("no longer reads the policy table directly at the write guard", () => {
    // The direct read was a SECOND implementation of "is this table policed"
    // and it had drifted: a table protected only by a TAG rule has no row in
    // lakehouse_table_policies, so its grantee could UPDATE and DELETE rows
    // the policy hides from them. loadPolicies folds tag rules in.
    expect(code).not.toMatch(/from\("lakehouse_table_policies"\)[\s\S]{0,200}\.eq\("schema_name"/);
  });
});

describe("catalog-wide listing is not a read of nothing", () => {
  it("refuses SHOW with no qualified target instead of returning an empty read set", () => {
    // `SHOW ALL TABLES` matched no qualified name, so the old code returned []
    // and assertSchemasAllowed([]) passed vacuously — it listed every schema,
    // table and column in the catalog, including other users' and every mount.
    const fn = core.slice(
      core.indexOf("export async function selectReferencedSchemas"),
      core.indexOf("// ── Access"),
    );
    expect(fn).toMatch(/catalog-wide listings are not available/);
    expect(fn).toContain("qualifiedRefs");
  });

  it("sends DESCRIBE/SUMMARIZE over a select to the real parser", () => {
    // `SUMMARIZE SELECT * FROM mine.t JOIN theirs.secret USING (id)` used to
    // authorize only the first name the regex found, and SUMMARIZE reports
    // min/max/approx-distinct per column — a rich leak.
    const fn = core.slice(
      core.indexOf("export async function selectReferencedSchemas"),
      core.indexOf("// ── Access"),
    );
    expect(fn).toMatch(/return selectReferencedSchemas\(c, sub\)/);
  });
});
