// Cross-engine agreement.
//
// The app has more than one local SQL engine — AlaSQL in the workbench and on
// the refresh path, a hand-written AST interpreter behind the sql_query agent
// tool. The same question asked through two surfaces must not produce two
// answers. This file is the ratchet that keeps them honest, and the place a
// candidate engine (DuckDB) proves itself before replacing anything.
//
// EXPECTED_DIVERGENCE records the differences that exist today. Entries there
// are asserted to STILL differ: if someone fixes one, this test fails and they
// must update the record. That is deliberate — an undocumented behaviour
// change in a query engine is exactly what this suite exists to prevent.
import { describe, expect, it } from "vitest";

import { CORPUS, REJECT_CORPUS } from "./corpus";
import { canonRows, ENGINES, runAll } from "./engines";
import { freshTables } from "./fixtures";

const EXPECTED_DIVERGENCE: Record<string, string> = {
  "group-by":
    "SUM over a group whose values are all NULL: AlaSQL yields NULL (standard SQL), " +
    "the interpreter yields 0. Standard is NULL; the interpreter is the odd one out.",
  "numeric-strings":
    "SUM over a column holding numeric STRINGS: the interpreter coerces and returns 15, " +
    "AlaSQL counts only the real number and returns 3. Reachable only for uncoerced data — " +
    "saveDataset/ingest normally coerce on write.",
};

describe("differential: local SQL engines agree", () => {
  for (const entry of CORPUS) {
    const expectedDivergence = EXPECTED_DIVERGENCE[entry.id];

    it(`${entry.id}${expectedDivergence ? " (known divergence)" : ""} — ${entry.note}`, () => {
      const results = runAll(entry.sql);
      const canon: Record<string, string> = {};

      for (const engine of ENGINES) {
        const r = results[engine.id];
        // Every engine must at minimum RUN every corpus query. A parse failure
        // on a shape the product emits is a bug regardless of agreement.
        expect(r.ok, `${engine.id} failed: ${r.ok ? "" : r.error}`).toBe(true);
        if (r.ok) canon[engine.id] = canonRows(r.rows, Boolean(entry.ordered));
      }

      const values = Object.values(canon);
      const allAgree = values.every((v) => v === values[0]);

      if (expectedDivergence) {
        expect(
          allAgree,
          `${entry.id} now AGREES across engines. That is good — remove it from ` +
            `EXPECTED_DIVERGENCE. Recorded reason: ${expectedDivergence}`,
        ).toBe(false);
      } else {
        expect(
          canon,
          `Engines disagree on "${entry.sql}". Either fix the engine or record it in ` +
            `EXPECTED_DIVERGENCE with the reason.`,
        ).toEqual(Object.fromEntries(ENGINES.map((e) => [e.id, values[0]])));
      }
    });
  }
});

describe("differential: writes and DDL are refused everywhere", () => {
  for (const entry of REJECT_CORPUS) {
    it(`rejects ${entry.id} (${entry.note})`, () => {
      for (const engine of ENGINES) {
        const r = engine.run(entry.sql, freshTables());
        // A read-only engine must refuse. Returning rows — or silently
        // succeeding — would mean an agent could mutate a user's data.
        expect(r.ok, `${engine.id} accepted "${entry.sql}"`).toBe(false);
      }
    });
  }
});
