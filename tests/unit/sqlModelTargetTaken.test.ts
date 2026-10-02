// A SQL model given the name of a table it never built.
//
// FOUND IN R103, from R101's sweep. A model's name IS its target table, and a
// build runs `DROP <the other shape> IF EXISTS <target>` and then `CREATE OR
// REPLACE`. Saving a model checked the name against materialized views and
// not against ordinary tables. Driven: `CREATE TABLE analytics.r103_keep AS
// SELECT 103 AS id, 'a table no model built' AS note` → SQL Models → New
// model `r103_keep`, schema analytics, Stored as View, `SELECT 1 AS x` →
// Create ("Created r103_keep") → Build this and what it reads ("Built 1
// model") → `SELECT * FROM analytics.r103_keep` read back `x | 1`. The table
// had been dropped.
//
// The save is a server function that drags in the lakehouse and Supabase, so
// it is pinned by source. The check it calls, lakehouseTableExists, is
// executed in lakehouseImportNoReplace.test.ts.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const FNS = readFileSync("src/utils/sqlModels.functions.ts", "utf8");

const SAVE = (() => {
  const start = FNS.indexOf("export const sqlModelSave");
  if (start < 0) throw new Error("sqlModelSave not found: did the module change shape?");
  const rest = FNS.slice(start + 10);
  const end = rest.indexOf("\nexport ");
  return FNS.slice(start, start + 10 + (end < 0 ? rest.length : end));
})();

describe("a model may not take a name it did not build", () => {
  it("asks the lakehouse whether the target is taken", () => {
    expect(SAVE).toMatch(/taken = await lakehouseTableExists\(data\.schema_name, data\.name\)/);
  });

  it("refuses exactly when the answer is taken", () => {
    // The message existing somewhere proves nothing; it has to be what a
    // taken name returns.
    expect(SAVE).toMatch(
      /if \(taken\) \{\s*return \{\s*ok: false,\s*error:\s*`\$\{data\.schema_name\}\.\$\{data\.name\} already exists/,
    );
  });

  it("refuses with the target, the reason and the way out", () => {
    expect(SAVE).toMatch(/already exists, and this model did not build it\. /);
    expect(SAVE).toMatch(/a view-stored model drops the table first/);
    expect(SAVE).toMatch(/Give the model another name, or drop the table first/);
  });

  it("asks only when the target is new to this model", () => {
    // Rebuilding its own output is a model's job; refusing that would break
    // every existing model on its next save.
    expect(SAVE).toMatch(
      /const previous = data\.id \? existing\.find\(\(m\) => m\.id === data\.id\) : undefined;/,
    );
    expect(SAVE).toMatch(
      /!previous \|\| previous\.schema_name !== data\.schema_name \|\| previous\.name !== data\.name/,
    );
    expect(SAVE).toMatch(/if \(retargeted\) \{/);
  });

  it("refuses when it cannot tell, rather than guessing free", () => {
    expect(SAVE).toMatch(
      /Could not check whether \$\{data\.schema_name\}\.\$\{data\.name\} is free/,
    );
  });

  it("decides before anything is written", () => {
    const asked = SAVE.indexOf("await lakehouseTableExists(");
    const written = SAVE.indexOf('.from("sql_models")');
    expect(asked).toBeGreaterThan(-1);
    expect(written).toBeGreaterThan(asked);
  });
});

describe("the clash with a materialized view fails closed too", () => {
  it("an unreadable answer is not no clash", () => {
    expect(SAVE).toMatch(/const \{ data: clash, error: clashErr \} = await supabaseAdmin/);
    expect(SAVE).toMatch(/if \(clashErr\) \{/);
  });
});
