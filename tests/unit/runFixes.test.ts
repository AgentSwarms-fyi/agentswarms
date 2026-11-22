// A fix for what keeps failing, recognised rather than imagined (R525). The
// errors are the ones the Runs page showed on the test project on 2026-11-22.
import { describe, expect, it } from "vitest";

import {
  errorSignature,
  fixFromPayload,
  fixSignature,
  isTransient,
  pickTimestampColumn,
  proposeRunFix,
  sameFailureStreak,
  type FixInput,
  type PastRun,
} from "@/lib/runFixes";

const MON = { type: "data_monitor" as const, id: "11111111-1111-1111-1111-111111111111" };
const PIPE = { type: "etl_pipeline" as const, id: "22222222-2222-2222-2222-222222222222" };
const NOT_A_TIME =
  "The newest value in this column is not a date or time: EMEA. Freshness needs a timestamp column.";
const COLUMNS = [
  { name: "order_id", type: "BIGINT" },
  { name: "region", type: "VARCHAR" },
  { name: "order_date", type: "DATE" },
  { name: "updated_at", type: "TIMESTAMP WITH TIME ZONE" },
  { name: "net_usd", type: "DECIMAL(18,2)" },
];
const times = (n: number, run: PastRun) => Array.from({ length: n }, () => run);

const freshness = (over: Partial<FixInput> = {}): FixInput => ({
  target: MON,
  name: "R238 freshness on a text column",
  active: true,
  monitorKind: "freshness",
  column: "region",
  columns: COLUMNS,
  runs: times(12, { status: "alert", error: NOT_A_TIME }),
  ...over,
});

describe("a freshness check on a column that holds no dates", () => {
  it("is pointed at the table's best date or time column", () => {
    const v = proposeRunFix(freshness());
    expect(v.proposal?.fix).toEqual({
      fix: "timestamp_column",
      column: "updated_at",
      from: "region",
    });
    expect(v.proposal?.title).toBe('Check "updated_at" instead of "region"');
    expect(v.proposal?.evidence).toBe("The last 12 runs failed the same way.");
  });

  it("counts every run that failed this way, whatever value the message quotes", () => {
    // Found from the UI: the quoted value changes from run to run, and counted
    // by text 752 failed runs read as "the last 8".
    const runs = ["EMEA", "APAC", "EMEA", "AMER"].map((v) => ({
      status: "alert",
      error: NOT_A_TIME.replace("EMEA", v),
    }));
    expect(proposeRunFix(freshness({ runs })).proposal?.evidence).toBe(
      "The last 4 runs failed the same way.",
    );
  });

  it("an outage between the failures neither counts nor ends them, and is said", () => {
    // Found from the UI: one "could not attach the catalog" during a restart
    // made 752 failed runs of the R238 check read as "the last 8".
    const outage = {
      status: "error",
      error: 'IO Error: Failed to attach DuckLake MetaData "__ducklake_metadata_lake"',
    };
    const runs = [
      ...times(8, { status: "alert", error: NOT_A_TIME }),
      outage,
      ...times(4, { status: "alert", error: NOT_A_TIME }),
    ];
    expect(proposeRunFix(freshness({ runs })).proposal?.evidence).toBe(
      "The last 12 runs failed the same way (not counting one when a service it needs was down).",
    );
  });

  it("says the cause once: the change's reason does not repeat it", () => {
    const p = proposeRunFix(freshness()).proposal!;
    expect(p.cause).toMatch(/does not hold dates or times/);
    expect(p.why).not.toContain(p.cause);
  });

  it("says 'or more' when the history read stopped at its cap", () => {
    const v = proposeRunFix(freshness({ capped: true }));
    expect(v.proposal?.evidence).toBe("The last 12 runs or more failed the same way.");
  });

  it("is paused when the table has no date or time column", () => {
    const v = proposeRunFix(
      freshness({ columns: COLUMNS.filter((c) => !/DATE|TIME/.test(c.type)) }),
    );
    expect(v.proposal?.fix).toEqual({ fix: "pause" });
    expect(v.diagnosis).toMatch(/no date or time column at all/);
  });

  it("proposes nothing when the table's columns could not be read", () => {
    const v = proposeRunFix(freshness({ columns: null }));
    expect(v.proposal).toBeNull();
    expect(v.diagnosis).toMatch(/could not be read/);
  });

  it("proposes nothing for a check that is already paused", () => {
    expect(proposeRunFix(freshness({ active: false })).proposal).toBeNull();
  });
});

describe("what is never fixed by a change", () => {
  it.each([
    'IO Error: Failed to attach DuckLake MetaData "__ducklake_metadata_lake" at path + "postgres:dbname=lakehouse_catalog host=x"',
    "IO Error: Could not connect to server error for HTTP GET to 'http://192.168.1.85:8181/v1/namespaces'",
    "INTERRUPT Error: Interrupted!",
    "Cannot reach the Docker socket-proxy, so no kernel can be started.",
    "The run never acquired a sandbox session.",
  ])("an outage: %s", (error) => {
    expect(isTransient(error)).toBe(true);
    const v = proposeRunFix({
      target: PIPE,
      name: "p",
      active: true,
      runs: times(9, { status: "error", error }),
    });
    expect(v.proposal).toBeNull();
    expect(v.diagnosis).toMatch(/unreachable or busy/);
  });

  it("an alert on the data: the check is working", () => {
    const v = proposeRunFix({
      target: MON,
      name: "revenue_facts · negative net rows",
      active: true,
      monitorKind: "custom_sql",
      runs: times(44, { status: "alert", error: "Value 2 is above the maximum of 0." }),
    });
    expect(v.proposal).toBeNull();
    expect(v.diagnosis).toMatch(/That is the check working/);
  });
});

describe("the same failure, run after run", () => {
  const gone =
    'Catalog Error: Table with name "analytics.revenue_facts" does not exist because schema "analytics" does not exist.';

  it("suggests pausing once it has happened three times", () => {
    const v = proposeRunFix({
      target: MON,
      name: "gone",
      active: true,
      monitorKind: "volume",
      runs: times(3, { status: "error", error: gone }),
    });
    expect(v.proposal?.fix).toEqual({ fix: "pause" });
    expect(v.proposal?.title).toBe("Pause this check");
    expect(v.proposal?.evidence).toBe("The last 3 runs failed the same way.");
  });

  it("not before", () => {
    const v = proposeRunFix({
      target: PIPE,
      name: "p",
      active: true,
      runs: times(2, { status: "failed", error: gone }),
    });
    expect(v.proposal).toBeNull();
    expect(v.diagnosis).toMatch(/2 of 3/);
  });

  it("a different error in between breaks the streak", () => {
    const runs = [
      { status: "failed", error: gone },
      { status: "failed", error: gone },
      { status: "failed", error: "Something else" },
      { status: "failed", error: gone },
    ];
    expect(sameFailureStreak(runs)).toBe(2);
  });

  it("counts errors that differ only in numbers and ids as the same", () => {
    expect(errorSignature("Run 12 failed at 3.5s for 11111111-1111-1111-1111-111111111111")).toBe(
      errorSignature("Run 13 failed at 4.25s for 22222222-2222-2222-2222-222222222222"),
    );
    expect(
      sameFailureStreak([
        { status: "failed", error: "Row 4 is bad" },
        { status: "failed", error: "Row 9 is bad" },
      ]),
    ).toBe(2);
  });

  it("a latest run that succeeded needs nothing", () => {
    expect(
      proposeRunFix({
        target: PIPE,
        name: "p",
        active: true,
        runs: [{ status: "succeeded", error: null }],
      }).proposal,
    ).toBeNull();
  });
});

describe("the timestamp column it picks", () => {
  it("prefers when a row last changed, then when it was loaded, then created", () => {
    expect(pickTimestampColumn(COLUMNS)).toBe("updated_at");
    expect(
      pickTimestampColumn([
        { name: "created_at", type: "timestamp" },
        { name: "loaded_at", type: "timestamp" },
      ]),
    ).toBe("loaded_at");
    expect(pickTimestampColumn([{ name: "order_date", type: "DATE" }])).toBe("order_date");
  });

  it("never the column it is moving away from, never an interval, never text", () => {
    expect(
      pickTimestampColumn([{ name: "updated_at", type: "TIMESTAMP" }], "UPDATED_AT"),
    ).toBeNull();
    expect(pickTimestampColumn([{ name: "wait", type: "INTERVAL" }])).toBeNull();
    expect(pickTimestampColumn([{ name: "date_text", type: "VARCHAR" }])).toBeNull();
  });
});

describe("a fix read back from an approval its owner can write", () => {
  it("is checked field by field", () => {
    expect(fixFromPayload({ target: MON, fix: { fix: "pause" } })).toEqual({
      target: MON,
      fix: { fix: "pause" },
    });
    expect(
      fixFromPayload({
        target: MON,
        fix: { fix: "timestamp_column", column: "updated_at", from: "region" },
      })?.fix,
    ).toEqual({ fix: "timestamp_column", column: "updated_at", from: "region" });
    // A pipeline has no timestamp column to change; an unknown fix, a bad id
    // or an unknown kind of thing is nothing.
    expect(
      fixFromPayload({ target: PIPE, fix: { fix: "timestamp_column", column: "x" } }),
    ).toBeNull();
    expect(fixFromPayload({ target: MON, fix: { fix: "delete" } })).toBeNull();
    expect(
      fixFromPayload({ target: { type: "data_monitor", id: "../x" }, fix: { fix: "pause" } }),
    ).toBeNull();
    expect(
      fixFromPayload({ target: { type: "agent", id: MON.id }, fix: { fix: "pause" } }),
    ).toBeNull();
    expect(fixFromPayload(null)).toBeNull();
  });

  it("the same change to the same thing has one signature", () => {
    expect(fixSignature(MON, { fix: "timestamp_column", column: "Updated_At", from: null })).toBe(
      fixSignature(MON, { fix: "timestamp_column", column: "updated_at", from: "region" }),
    );
    expect(fixSignature(MON, { fix: "pause" })).not.toBe(fixSignature(PIPE, { fix: "pause" }));
  });
});
