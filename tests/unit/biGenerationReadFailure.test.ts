// The generate dialogs, when the local datasets could not be read.
//
// Both dialogs take their table list and their "not ready" reason from
// generationSource(). With the table list rejected, the report route's
// hydration catch was bare and the dashboard route's toasted and moved on;
// either way the dialogs received datasets = [] and the reason on screen was
//
//   "No local datasets — upload data on the Data & SQL page first."
//
// — advice to upload, over a read that failed. The context now carries
// datasetsError; an empty list WITH a reason says the reason, an empty list
// without one still says where to get data, and a kept list is not blocked.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { LOCAL_SOURCE_KEY, generationSource } from "@/lib/biGenerationSource";

const base = {
  sourceKey: LOCAL_SOURCE_KEY,
  datasets: [] as never[],
  semantics: new Map(),
  metrics: [],
  warehouses: [],
  whTables: {},
  userId: "u1",
};

describe("generationSource, when the local list is empty", () => {
  it("says the read failed when that is why", () => {
    const g = generationSource({
      ...base,
      datasetsError: "injected: user_data_tables unreachable",
    });
    expect(g.notReady).toMatch(
      /Local datasets could not be read — injected: user_data_tables unreachable/,
    );
    expect(g.notReady).not.toMatch(/Data & SQL/);
  });

  it("still says where to get data when there simply is none", () => {
    expect(generationSource({ ...base, datasetsError: null }).notReady).toMatch(/Data & SQL/);
    expect(generationSource(base).notReady).toMatch(/Data & SQL/);
  });

  it("does not block generation over a kept list because a re-read failed", () => {
    const kept = { id: "t1", name: "saas_sales", columns: [] } as never;
    const g = generationSource({ ...base, datasets: [kept], datasetsError: "later failure" });
    expect(g.notReady).toBeNull();
    expect(g.datasets).toEqual([kept]);
  });
});

describe("the reason reaches the dialogs", () => {
  const CTX = readFileSync("src/components/bi/biDataContext.ts", "utf8");
  const REPORT_DLG = readFileSync("src/components/bi/GenerateReportDialog.tsx", "utf8");
  const DASH_DLG = readFileSync("src/components/bi/GenerateDashboardDialog.tsx", "utf8");
  const REPORT_ROUTE = readFileSync("src/routes/_authenticated/bi_.report.$reportId.tsx", "utf8");
  const DASH_ROUTE = readFileSync("src/routes/_authenticated/bi_.$dashboardId.tsx", "utf8");

  it("is part of the BI data context", () => {
    expect(CTX).toMatch(/datasetsError\?: string \| null;/);
  });

  it("is passed by both dialogs", () => {
    for (const src of [REPORT_DLG, DASH_DLG]) {
      expect(src).toMatch(
        /datasets: ctx\.datasets,\s*datasetsError: ctx\.datasetsError \?\? null,/,
      );
    }
  });

  it("is set by the report route, which also says so — its catch used to be bare", () => {
    expect(REPORT_ROUTE).toMatch(
      /catch \(e\) \{[\s\S]{0,400}?toast\.error\(`Could not load local datasets: \$\{\(e as Error\)\.message\}`\);\s*setDatasetsError\(\(e as Error\)\.message\);/,
    );
    expect(REPORT_ROUTE).toMatch(/setDatasets\(tables\);\s*setDatasetsError\(null\);/);
    expect(REPORT_ROUTE).toMatch(/datasets,\s*datasetsError,\s*semantics,/);
  });

  it("is set by the dashboard route beside the toast it already had", () => {
    expect(DASH_ROUTE).toMatch(
      /toast\.error\(`Could not load local datasets: \$\{\(e as Error\)\.message\}`\);\s*setDatasetsError\(\(e as Error\)\.message\);/,
    );
    expect(DASH_ROUTE).toMatch(/setDatasets\(tables\);\s*setDatasetsError\(null\);/);
    expect(DASH_ROUTE).toMatch(/datasets,\s*datasetsError,\s*preparedTables,/);
  });
});
