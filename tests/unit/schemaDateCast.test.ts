// A column the schema calls "date" is physically text, and the model has to be
// told before it writes SQL against it.
//
// REPORTED FROM A REAL RUN. Generating a dashboard over a Salesforce
// `opportunities` table produced:
//
//   Binder Error: No function matches the given name and argument types
//   'date_trunc(STRING_LITERAL, VARCHAR)' ...
//   GROUP BY DATE_TRUNC('month', CloseDate)
//
// The catalog was RIGHT — CloseDate is typed `date` and holds "2026-06-19".
// duckType maps date → VARCHAR in both engines on purpose: values arrive in
// mixed formats and a failed CAST would drop the row rather than the value.
// So the storage is deliberate and the schema description is accurate; what
// was missing is the sentence connecting them.
//
// MEASURED across 254 saved widget queries on that account: 6 use a date
// function, 4 cast and 2 do not. The model was coin-flipping because nothing
// stated the rule.
import { describe, expect, it } from "vitest";

import { describeSchema } from "@/lib/biAgent";
import type { DatasetMeta } from "@/lib/sqlEngine";

const ds = (cols: Array<{ name: string; type: "string" | "number" | "date" }>): DatasetMeta => ({
  id: "t1",
  name: "opportunities",
  source_filename: null,
  is_sample: false,
  user_id: null,
  columns: cols,
  row_count: 10,
  data_loaded_at: null,
  parquet_bytes: null,
});

const schemaFor = (cols: Parameters<typeof ds>[0]) => describeSchema([ds(cols)], new Map(), []);

describe("a date column comes with its casting rule", () => {
  const withDate = schemaFor([
    { name: "Amount", type: "number" },
    { name: "CloseDate", type: "date" },
  ]);

  it("states that date columns are stored as text", () => {
    expect(withDate).toMatch(/stored as text/i);
  });

  it("shows the cast the engine actually requires", () => {
    // The exact shape that failed in the report.
    expect(withDate).toMatch(/CAST\(col AS DATE\)/);
    expect(withDate).toMatch(/DATE_TRUNC/i);
  });

  it("offers strptime for non-ISO formats", () => {
    // Four of the six working queries on this account used strptime, because
    // the source was m/d/Y — CAST alone would not have parsed it.
    expect(withDate).toMatch(/strptime/i);
  });

  it("says plain grouping needs no cast, so it does not over-correct", () => {
    // Over-casting is its own bug: wrapping every reference makes simple
    // string groupings slower and can change ordering.
    expect(withDate).toMatch(/needs no cast/i);
  });

  it("still lists the column as (date), which is what the catalog knows", () => {
    expect(withDate).toContain("CloseDate (date)");
  });
});

describe("the rule appears only when it applies", () => {
  it("is absent when no column is a date", () => {
    const noDate = schemaFor([
      { name: "Amount", type: "number" },
      { name: "StageName", type: "string" },
    ]);
    expect(noDate).not.toMatch(/stored as text/i);
  });

  it("appears when any one table has a date column", () => {
    expect(schemaFor([{ name: "CreatedDate", type: "date" }])).toMatch(/stored as text/i);
  });
});
