// The ML model page and its predictions list: a failed read must not be
// "nothing here", and the newest N must not be presented as all.
//
// mlGetModel dropped the error of every read it made — a failed versions
// read was "Versions (0)" with no production version, a failed jobs read "No
// jobs yet." — and listed the newest twenty jobs as "Jobs (20)" for a model
// with more. mlListPredictions did the same for prediction runs at fifty:
// "No predictions yet." over a read that failed, and the newest fifty as
// every run there was, which also made the Accuracy and Fairness panels say
// "no successful batch run" when the only one was older than fifty runs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { capList } from "@/lib/listCap";

const rd = (p: string) => readFileSync(p, "utf8");
const fns = rd("src/utils/ml.functions.ts");
const panel = rd("src/components/ml/PredictionsPanel.tsx");
const page = rd("src/routes/_authenticated/ml_.$modelId.tsx");
const acc = rd("src/components/ml/AccuracyPanel.tsx");
const fair = rd("src/components/ml/FairnessPanel.tsx");

const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i, start).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i);
  expect(j, end).toBeGreaterThan(i);
  return src.slice(i, j);
};

describe("capList", () => {
  it("returns the rows untouched when they fit the cap", () => {
    const rows = [1, 2, 3];
    expect(capList(rows, 3)).toEqual({ rows, truncated: false });
    expect(capList([], 3)).toEqual({ rows: [], truncated: false });
  });

  it("cuts at the cap and says so when the extra row came back", () => {
    expect(capList([1, 2, 3, 4], 3)).toEqual({ rows: [1, 2, 3], truncated: true });
  });
});

describe("mlGetModel", () => {
  const body = between(fns, "export const mlGetModel", "export const mlGetJob");

  it("throws on every read that fails, instead of answering with nothing", () => {
    expect(body).toContain("could not read the model's live training jobs");
    expect(body).toContain("could not read the model's versions");
    expect(body).toContain("could not read the model's training jobs");
    expect(body).toContain("could not read the model:");
    // No read in the handler drops its error any more.
    expect(body).not.toMatch(/const \{ data: (live|versions|jobs|fresh) \} = await/);
    expect(body).not.toMatch(/\[\{ data: versions \}, \{ data: jobs \}, \{ data: fresh \}\]/);
  });

  it("fetches one job past what it shows and says whether the list goes on", () => {
    expect(body).toContain(".limit(JOBS_SHOWN + 1)");
    expect(body).toContain("const jobs = capList(jobsRead.data ?? [], JOBS_SHOWN);");
    expect(body).toMatch(
      /jobs: jobs\.rows,\s*jobs_truncated: jobs\.truncated,\s*jobs_shown: JOBS_SHOWN,/,
    );
    expect(fns).toContain("export const JOBS_SHOWN = 20;");
  });
});

describe("mlListPredictions", () => {
  const body = between(fns, "export const mlListPredictions", "export const mlCancelPrediction");

  it("throws on a read that fails, instead of 'No predictions yet.'", () => {
    expect(body).toContain("could not read the model's live prediction runs");
    expect(body).toContain("could not read the model's prediction runs");
    expect(body).not.toMatch(/const \{ data: (live|rows) \} = await/);
  });

  it("fetches one run past what it shows and says whether the list goes on", () => {
    expect(body).toContain(".limit(PREDICTIONS_SHOWN + 1)");
    expect(body).toContain("const cut = capList(rows ?? [], PREDICTIONS_SHOWN);");
    expect(body).toContain(
      "return { predictions: cut.rows, truncated: cut.truncated, shown: PREDICTIONS_SHOWN };",
    );
    expect(fns).toContain("export const PREDICTIONS_SHOWN = 50;");
  });
});

describe("the surfaces say when the list is the newest N", () => {
  it("the Predictions tab", () => {
    expect(panel).toContain("setTruncated(r.truncated);");
    expect(panel).toContain("Older runs exist and are not listed here.");
  });

  it("the model page's Jobs tab, in its count and under its table", () => {
    expect(page).toContain("Jobs ({jobs_truncated ? `${jobs.length}+` : jobs.length})");
    expect(page).not.toContain("Jobs ({jobs.length})");
    expect(page).toContain("Older jobs exist and are not listed here.");
  });

  it("the Accuracy and Fairness panels, when no batch run is among the newest", () => {
    for (const [src, name] of [
      [acc, "AccuracyPanel"],
      [fair, "FairnessPanel"],
    ] as const) {
      expect(src, name).toContain(
        "const { predictions, truncated, shown } = await predictionsFn({",
      );
      expect(src, name).toContain(
        "`No successful batch run among the newest ${shown} runs — older runs are not searched`",
      );
    }
  });
});
