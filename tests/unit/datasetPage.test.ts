// One page per dataset (R519): what the page says about a dataset, and what
// it lets each reader see.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assistantPage } from "@/lib/assistantPage";
import type { QualityRollup } from "@/lib/dataQualityCore";
import {
  agentsReading,
  analystsReading,
  datasetTrust,
  everyLabel,
  filterSentence,
  originSentence,
  originsOf,
  profileColumns,
  schemaChanges,
  type TrustInput,
} from "@/lib/datasetPage";
import { linkToObject } from "@/lib/objectKinds";

const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const NOW = Date.parse("2026-11-21T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const rollup = (over: Partial<QualityRollup>): QualityRollup => ({
  status: "pass",
  passed: 0,
  failed: 0,
  warned: 0,
  errored: 0,
  total: 0,
  ranAt: null,
  ...over,
});

describe("where the rows come from", () => {
  it("names the flow that writes it first, with how often it refreshes", () => {
    const o = originsOf(
      { source_filename: "sales.csv" },
      {
        flowsProducing: [
          { id: "f", name: "Sales prep", refreshEnabled: true, refreshEveryMinutes: 1440 },
        ],
      },
    );
    expect(o).toHaveLength(1);
    expect(originSentence(o[0])).toBe(
      "Made by the data-prep flow “Sales prep”, which refreshes it daily.",
    );
  });

  it("says when the flow's last refresh failed", () => {
    const [o] = originsOf(
      {},
      { flowsProducing: [{ id: "f", name: "X", lastRefreshError: "boom" }] },
    );
    expect(originSentence(o)).toBe("Made by the data-prep flow “X”, whose last refresh failed.");
  });

  it("reads uploads, warehouse copies, samples, synced connections and the unknown", () => {
    const say = (row: Parameters<typeof originsOf>[0], name?: string) =>
      originsOf(row, { connectionName: name }).map(originSentence);
    expect(say({ source_filename: "q3.xlsx" })).toEqual([
      "Uploaded from q3.xlsx; it changes only when someone uploads again.",
    ]);
    expect(say({ source_filename: "warehouse:pg.public.orders" })).toEqual([
      "Copied from the warehouse table pg.public.orders; it changes only when copied again.",
    ]);
    expect(say({ is_sample: true })).toEqual([
      "A sample that comes with the app, read-only for everyone.",
    ]);
    expect(say({ saas_connection_id: "c1", saas_stream: "contacts" }, "Our CRM")).toEqual([
      "Synced from the connection “Our CRM” (contacts).",
    ]);
    expect(say({ source_filename: "prep:Old flow" })).toEqual([
      "Made by the data-prep flow “Old flow”; it changes when that flow is run.",
    ]);
    expect(say({})).toEqual(["Where its rows came from was not recorded."]);
  });

  it("says an interval in words", () => {
    expect(everyLabel(60)).toBe("every hour");
    expect(everyLabel(360)).toBe("every 6 hours");
    expect(everyLabel(1440)).toBe("daily");
    expect(everyLabel(4320)).toBe("every 3 days");
    expect(everyLabel(15)).toBe("every 15 minutes");
    expect(everyLabel(0)).toBeNull();
  });
});

describe("whether it can be trusted today", () => {
  const base: TrustInput = {
    role: "owner",
    loadedAt: hoursAgo(2),
    quality: rollup({ status: "pass", passed: 3, total: 3 }),
    origins: originsOf({ source_filename: "a.csv" }),
    usedBy: 2,
    now: NOW,
  };

  it("is good when fresh and every check passed, and says why", () => {
    const t = datasetTrust(base);
    expect(t.tone).toBe("good");
    expect(t.headline).toBe("Fresh, and every check passed");
    expect(t.lines).toEqual([
      "Rows last loaded 2h ago.",
      "All 3 checks passed.",
      "2 things of yours are built on it.",
    ]);
  });

  it("calls failing checks before staleness, and staleness before 'unchecked'", () => {
    expect(
      datasetTrust({
        ...base,
        quality: rollup({ status: "fail", failed: 1, passed: 2, total: 3 }),
      }),
    ).toMatchObject({ tone: "attention", headline: "Checks are failing" });
    expect(datasetTrust({ ...base, loadedAt: hoursAgo(30) })).toMatchObject({
      tone: "attention",
      headline: "Stale: last loaded 1d ago",
    });
    expect(datasetTrust({ ...base, quality: rollup({ status: "unknown" }) })).toMatchObject({
      tone: "unknown",
      headline: "Fresh, with nothing checking it",
    });
  });

  it("holds the rows to the dataset's own freshness check when it has one", () => {
    const t = datasetTrust({ ...base, loadedAt: hoursAgo(3), freshnessSlaHours: 2 });
    expect(t.headline).toBe("Stale: last loaded 3h ago");
    expect(t.lines[0]).toBe("Rows last loaded 3h ago (its check expects at least every 2 h).");
    expect(datasetTrust({ ...base, loadedAt: hoursAgo(30), freshnessSlaHours: 48 }).tone).toBe(
      "good",
    );
  });

  it("says a failed refresh is the problem", () => {
    const t = datasetTrust({
      ...base,
      origins: originsOf({}, { flowsProducing: [{ id: "f", name: "F", lastRefreshError: "x" }] }),
    });
    expect(t).toMatchObject({ tone: "attention", headline: "Its last refresh failed" });
  });

  it("tells a grantee nothing about the owner's checks, and what their grant leaves out", () => {
    const t = datasetTrust({
      ...base,
      role: "shared",
      quality: null,
      masked: true,
      filtered: true,
    });
    expect(t.headline).toBe("Fresh");
    expect(t.lines.join(" ")).not.toMatch(/check/);
    expect(t.lines).toContain("Shared with you without some rows and some columns.");
    expect(datasetTrust({ ...base, role: "shared", quality: null }).lines).toContain(
      "Shared with you, all rows and columns.",
    );
  });

  it("calls a never-loaded dataset unknown, and a sample a sample", () => {
    expect(datasetTrust({ ...base, loadedAt: null })).toMatchObject({
      tone: "unknown",
      headline: "Not loaded yet",
    });
    expect(
      datasetTrust({ ...base, role: "sample", loadedAt: hoursAgo(9000), quality: null }),
    ).toMatchObject({ tone: "good", headline: "A sample to try things on" });
  });
});

describe("how the columns changed", () => {
  it("compares each kept version with the next, and the newest with today, newest first", () => {
    const changes = schemaChanges(
      [
        { at: "2026-11-02T00:00:00Z", columns: ["a", "b", "c"] },
        { at: "2026-11-01T00:00:00Z", columns: ["a", "b"] },
      ],
      { at: "2026-11-03T00:00:00Z", columns: ["a", "c", "d"] },
    );
    expect(changes).toEqual([
      { at: "2026-11-03T00:00:00Z", added: ["d"], removed: ["b"] },
      { at: "2026-11-02T00:00:00Z", added: ["c"], removed: [] },
    ]);
  });

  it("lists nothing when the columns never changed", () => {
    expect(
      schemaChanges([{ at: "2026-11-01T00:00:00Z", columns: ["a"] }], {
        at: "2026-11-02T00:00:00Z",
        columns: ["a"],
      }),
    ).toEqual([]);
  });
});

describe("what each column holds, from the sample", () => {
  const rows = [
    { n: 3, d: "2026-01-05", t: "x", b: true, e: null },
    { n: "10", d: "2026-03-01T10:00:00Z", t: "x", b: false, e: "" },
    { n: null, d: "2025-12-31", t: "y", b: true, e: null },
  ];
  const [n, d, t, b, e] = profileColumns(rows, ["n", "d", "t", "b", "e"]);

  it("reads numbers, dates, text, true/false and empty", () => {
    expect([n.looks, d.looks, t.looks, b.looks, e.looks]).toEqual([
      "number",
      "date",
      "text",
      "true/false",
      "empty",
    ]);
  });

  it("counts empties and different values, and gives a range", () => {
    expect(n).toMatchObject({ rows: 3, empty: 1, distinct: 2, min: "3", max: "10" });
    expect(d).toMatchObject({ min: "2025-12-31", max: "2026-03-01" });
    expect(e).toMatchObject({ empty: 3, distinct: 0 });
  });

  it("reads US-style dates as dates when the dataset says the column holds dates", () => {
    const us = [{ d: "6/13/2024" }, { d: "10/29/2024" }, { d: "1/2/2022" }];
    const [declared] = profileColumns(us, ["d"], new Map([["d", "date"]]));
    expect(declared).toMatchObject({ looks: "date", min: "2022-01-02", max: "2024-10-29" });
    // Without the declaration the same text stays text: no guessing at 6/13 vs 13/6.
    expect(profileColumns(us, ["d"])[0].looks).toBe("text");
  });

  it("lists a common value only when it repeats", () => {
    expect(t.common).toEqual([{ value: "x", count: 2 }]);
    expect(n.common).toEqual([]);
  });
});

describe("what of the reader's reads it", () => {
  it("names analysts that list it, and counts those that read every dataset", () => {
    const r = analystsReading(
      [
        { id: "1", name: "Sales", source: { kind: "local", tables: ["sales"] } },
        { id: "2", name: "All", source: { kind: "local", tables: [] } },
        { id: "3", name: "WH", source: { kind: "warehouse", connection_id: "c" } },
        { id: "4", name: "Other", source: { kind: "local", tables: ["orders"] } },
      ],
      "sales",
    );
    expect(r).toEqual({ named: [{ id: "1", name: "Sales" }], everything: 1 });
  });

  it("counts only agents whose SQL tool is on", () => {
    const r = agentsReading(
      [
        {
          id: "1",
          name: "Lists it",
          tools: { sql_query: true, toolConfigs: { sql_query: { table_names: ["sales"] } } },
        },
        { id: "2", name: "Reads all", tools: { sql_query: true } },
        {
          id: "3",
          name: "Tool off",
          tools: { sql_query: false, toolConfigs: { sql_query: { table_names: ["sales"] } } },
        },
        { id: "4", name: "No tools", tools: null },
      ],
      "sales",
    );
    expect(r).toEqual({ named: [{ id: "1", name: "Lists it" }], everything: 1 });
  });
});

describe("the page and its links", () => {
  it("opens a dataset on its own page, wherever it is found", () => {
    const id = "5959cfea-fdf6-4832-b055-5007e8e2e806";
    expect(linkToObject({ kind: "dataset", id, name: "x" })).toEqual({ to: `/data-sql/${id}` });
    // The assistant knows which dataset is open there.
    expect(assistantPage(`/data-sql/${id}`).object).toEqual({ kind: "dataset", id });
    expect(assistantPage(`/data-sql/${id}`).title).toBe("Data Catalog");
  });

  it("says a grant's row filter in words", () => {
    expect(filterSentence({ column: "region", values: ["EU"] })).toBe(
      "Only rows where region is EU.",
    );
    expect(filterSentence({ column: "region", values: ["EU", "UK"] })).toBe(
      "Only rows where region is one of EU, UK.",
    );
    expect(filterSentence(null)).toBeNull();
  });

  it("shows a grantee no checks, versions, schema changes or other grants", () => {
    const page = src("src/routes/_authenticated/data-sql_.$datasetId.tsx");
    for (const tab of ["checks", "schema"]) {
      expect(page).toMatch(new RegExp(`\\{owner && <TabsTrigger value="${tab}">`));
    }
    // The owner-only reads sit behind the owner test.
    const ownerOnly = page.indexOf('if (ok.role !== "owner") {');
    expect(ownerOnly).toBeGreaterThan(-1);
    for (const read of ["listQualityTests(id)", "listDatasetVersionsFn(", 'rpc("dataset_access"'])
      expect(page.indexOf(read), read).toBeGreaterThan(ownerOnly);
    // A grantee's rows come through the grant, never the owner's window read.
    expect(page).toMatch(/ok\.role === "shared"[\s\S]{0,200}rpc\("shared_dataset_rows"/);
  });
});

describe("the migration that tells an owner who can read it", () => {
  const sql = src("supabase/migrations/20261123000000_dataset_access.sql");

  it("answers the dataset's owner and nobody else", () => {
    expect(sql).toMatch(/AND t\.user_id = auth\.uid\(\)/);
    expect(sql).toMatch(/AND auth\.uid\(\) IS NOT NULL/);
    expect(sql).toMatch(/g\.resource_type = 'data_table'/);
  });

  it("is a definer with an empty search path, closed to anon", () => {
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path = ''/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.dataset_access\(uuid\) FROM PUBLIC, anon;/);
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b/);
  });
});
