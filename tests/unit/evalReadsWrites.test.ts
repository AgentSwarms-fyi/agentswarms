// Evaluations: failed reads shown as failed, refused deletes said (R186).
//
// FOUND IN R186, the last of the client read survey's named modules
// (evaluations: five error-less reads) with the write survey's two deletes.
// Driven with each PostgREST call refused in the browser:
//   - the run's results read: "Progress 2/2 · Pass rate 100% … No results.";
//   - the dataset's case read: "r186 evals · 0 cases", New eval run disabled,
//     beside a runs list saying "r186 evals · 2/2";
//   - a case delete and the dataset delete, each confirmed: nothing said,
//     and both still there;
//   - the driver's case read as a run started: "running · 0/2 · Executing
//     cases…" with nothing executing;
//   - the baseline's results read: "0 improved · 0 regressed · 0 unchanged",
//     every case "only_b" ("— → pass").
// The page is pinned by source, section by section.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PAGE = readFileSync("src/routes/_authenticated/evaluations.tsx", "utf8");
const between = (start: string, end: string) => {
  const a = PAGE.indexOf(start);
  if (a < 0) throw new Error(`${start} not found`);
  const b = PAGE.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`${end} not found after ${start}`);
  return PAGE.slice(a, b);
};

describe("the dataset's cases", () => {
  const load = between('.from("eval_cases")\n      .select("*")', "}, [dataset.id]);");
  it("keep the read's error, and show no list for it", () => {
    expect(load).toMatch(
      /if \(error\) \{\s*setCasesError\(error\.message\);\s*setCases\(\[\]\);\s*return;\s*\}\s*setCasesError\(null\);/,
    );
  });
  it("say so where the count was, with a way to try again", () => {
    expect(PAGE).toMatch(/\{casesError\s*\?\s*"cases not read"/);
    expect(PAGE).toMatch(
      /\{casesError && \(\s*<p className="text-sm text-destructive">\s*The cases could not be read, so this list says nothing about them: \{casesError\}/,
    );
    expect(PAGE).toMatch(/onClick=\{\(\) => void load\(\)\}>\s*Try again/);
  });
});

describe("the deletes", () => {
  const delCase = between("const deleteCase = async", "const deleteDataset = async");
  const delSet = between("const deleteDataset = async", "return (");
  it("say when a case was not deleted", () => {
    expect(delCase).toMatch(
      /const \{ error \} = await supabase\.from\("eval_cases"\)\.delete\(\)\.eq\("id", id\);\s*if \(error\) toast\.error\("The case was not deleted", \{ description: error\.message \}\);/,
    );
  });
  it("say when the dataset was not deleted, and do not carry on as if it were", () => {
    expect(delSet).toMatch(
      /const \{ error \} = await supabase\.from\("eval_datasets"\)\.delete\(\)\.eq\("id", dataset\.id\);\s*if \(error\) \{\s*toast\.error\(`"\$\{dataset\.name\}" was not deleted`, \{ description: error\.message \}\);\s*return;\s*\}\s*onChanged\(\);/,
    );
  });
});

describe("a run's results", () => {
  const load = between("const loadResults = useCallback(async () => {", "}, [run.id]);");
  it("keep the read's error", () => {
    expect(load).toMatch(
      /if \(error\) \{\s*setResultsError\(error\.message\);\s*return;\s*\}\s*setResultsError\(null\);/,
    );
  });
  it("show it instead of 'No results.', and say 'Executing' only while cases execute", () => {
    expect(PAGE).toMatch(
      /\{resultsError \? \(\s*<p className="p-4 text-sm text-destructive">\s*The results could not be read, so this list says nothing about them: \{resultsError\}/,
    );
    expect(PAGE).toMatch(/\{driving\s*\?\s*"Executing cases…"\s*:\s*run\.status === "running"/);
    expect(PAGE).not.toMatch(/run\.status === "running" \? "Executing cases…"/);
  });
});

describe("the driver", () => {
  const drive = between("const drive = useCallback(async () => {", "const worker = async");
  it("stops and says why when it cannot read the cases or the scored ones", () => {
    expect(drive).toMatch(/const \{ data: allCases, error: casesErr \} = await supabase/);
    expect(drive).toMatch(/const \{ data: doneRows, error: doneErr \} = await supabase/);
    expect(drive).toMatch(
      /const readErr = casesErr \?\? doneErr;\s*if \(readErr\) \{\s*toast\.error\("The run could not carry on", \{/,
    );
    // Before the queue is built from what it read.
    expect(drive.indexOf("if (readErr)")).toBeLessThan(drive.indexOf("const queue ="));
  });
});

describe("the comparison", () => {
  const load = between("const loadCompare = useCallback(", "}, []);");
  it("does not compare against a baseline it could not read", () => {
    expect(load).toMatch(
      /if \(error\) \{\s*setCompareResults\(null\);\s*setBaselineError\(error\.message\);\s*return;\s*\}\s*setBaselineError\(null\);/,
    );
    expect(PAGE).toMatch(
      /\{baselineError && \(\s*<span className="text-xs text-destructive">\s*The baseline&apos;s results could not be read: \{baselineError\}/,
    );
  });
});
