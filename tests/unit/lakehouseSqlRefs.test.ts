// Reading SQL text well enough to refuse on it.
//
// These back a SECURITY decision, so the bias is explicit: every case that
// cannot be understood must produce MORE references (a refusal the user can
// argue with), never fewer (a table they did not know they had exposed).
import { describe, expect, it } from "vitest";

import { qualifiedRefs, stripComments, writeSubSelect } from "@/utils/lakehouse/sqlRefs";

describe("comment stripping keeps string literals intact", () => {
  it("leaves a double dash inside a literal alone", () => {
    // FOUND IN AUDIT: the old stripper ran two regexes over the whole text and
    // the STRIPPED text is what executes, so this statement reached the engine
    // as `INSERT INTO s.t VALUES ('A ` and died with a syntax error no user
    // could explain. It is reachable from the Insert row dialog.
    const sql = "INSERT INTO s.t VALUES ('A--B', 'c')";
    expect(stripComments(sql)).toBe(sql);
  });

  it("leaves block-comment markers inside literals alone", () => {
    // This one was worse: it produced a WRONG ANSWER with no error at all.
    const sql = "SELECT '/*' AS a, '*/' AS b";
    expect(stripComments(sql)).toBe(sql);
  });

  it("still removes real comments", () => {
    expect(stripComments("SELECT 1 -- trailing\nFROM a.t").trim()).toBe(
      "SELECT 1            \nFROM a.t".trim(),
    );
    expect(stripComments("SELECT /* mid */ 1").replace(/\s+/g, " ")).toBe("SELECT 1");
  });

  it("keeps every index lined up with the input", () => {
    // Blanking rather than deleting means an engine error's column number
    // still points at the same character the user typed.
    for (const sql of [
      "SELECT 1 -- x\nFROM a.t",
      "SELECT /* xx */ 1",
      "SELECT 'a--b' /* c */, 2",
    ]) {
      expect(stripComments(sql)).toHaveLength(sql.length);
    }
  });

  it("handles a doubled quote inside a literal", () => {
    const sql = "SELECT 'it''s--fine' FROM a.t";
    expect(stripComments(sql)).toBe(sql);
  });

  it("does not run off the end of an unterminated literal", () => {
    expect(() => stripComments("SELECT 'oops")).not.toThrow();
    expect(() => stripComments("SELECT /* oops")).not.toThrow();
  });
});

describe("finding every qualified name a statement mentions", () => {
  it("finds the source of a CTAS, which is the table the old check missed", () => {
    // The whole reason this module exists: DuckDB's serializer refuses to
    // parse a CTAS, so the AST walk that authorizes SELECTs cannot see this.
    const refs = qualifiedRefs("CREATE TABLE mine.copy AS SELECT * FROM theirs.customers");
    expect(refs).toEqual([
      { schema: "mine", table: "copy" },
      { schema: "theirs", table: "customers" },
    ]);
  });

  it("finds sources buried mid-statement", () => {
    for (const [sql, wanted] of [
      ["INSERT INTO mine.t SELECT * FROM theirs.secret", "theirs.secret"],
      ["MERGE INTO mine.t USING theirs.src s ON s.id = mine.t.id", "theirs.src"],
      ["UPDATE mine.t SET x = s.x FROM theirs.src s", "theirs.src"],
      ["DELETE FROM mine.t USING theirs.src s WHERE s.id = mine.t.id", "theirs.src"],
      ["CREATE VIEW mine.v AS SELECT * FROM theirs.policed", "theirs.policed"],
    ] as const) {
      const found = qualifiedRefs(sql).map((r) => `${r.schema}.${r.table}`);
      expect(found, sql).toContain(wanted);
    }
  });

  it("ignores a dotted name inside a string literal", () => {
    // The one false positive worth removing: this is data, not a reference.
    const refs = qualifiedRefs("INSERT INTO mine.t VALUES ('theirs.secret')");
    expect(refs).toEqual([{ schema: "mine", table: "t" }]);
  });

  it("reads quoted identifiers, including ones with a dot in the name", () => {
    const refs = qualifiedRefs('SELECT * FROM "od d".&quot;my.table&quot;'.replace(/&quot;/g, '"'));
    expect(refs).toEqual([{ schema: "od d", table: "my.table" }]);
  });

  it("takes the last two parts of a three-part name", () => {
    expect(qualifiedRefs("SELECT * FROM lake.raw.events")).toEqual([
      { schema: "raw", table: "events" },
    ]);
  });

  it("is not fooled by a star or a number after the dot", () => {
    expect(qualifiedRefs("SELECT t.* FROM a.t")).toEqual([{ schema: "a", table: "t" }]);
  });

  it("de-duplicates case-insensitively", () => {
    expect(qualifiedRefs("SELECT * FROM A.T JOIN a.t ON 1=1")).toHaveLength(1);
  });

  it("finds nothing to authorize in a statement with no qualified names", () => {
    // Which is itself a refusal upstream — an unqualified write target is
    // already rejected by the classifier.
    expect(qualifiedRefs("SHOW ALL TABLES")).toEqual([]);
  });
});

describe("isolating the sub-select of a write", () => {
  it("returns the tail of a CTAS and of a CREATE VIEW", () => {
    expect(writeSubSelect("CREATE TABLE a.b AS SELECT * FROM c.d")).toBe("SELECT * FROM c.d");
    expect(writeSubSelect("CREATE OR REPLACE VIEW a.v AS SELECT 1")).toBe("SELECT 1");
  });

  it("returns the tail of an INSERT, with or without a column list", () => {
    expect(writeSubSelect("INSERT INTO a.b SELECT * FROM c.d")).toBe("SELECT * FROM c.d");
    expect(writeSubSelect("INSERT INTO a.b (x, y) SELECT x, y FROM c.d")).toBe(
      "SELECT x, y FROM c.d",
    );
  });

  it("returns null for the forms whose sources sit mid-statement", () => {
    // Guessing where a MERGE's USING clause ends is how a parser-by-regex
    // starts lying. The caller falls back to the coarser check instead.
    for (const sql of [
      "MERGE INTO a.b USING c.d ON 1=1 WHEN MATCHED THEN DELETE",
      "UPDATE a.b SET x = 1 FROM c.d",
      "DELETE FROM a.b USING c.d",
      "INSERT INTO a.b VALUES (1)",
      "DROP TABLE a.b",
    ]) {
      expect(writeSubSelect(sql), sql).toBeNull();
    }
  });
});
