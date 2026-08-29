// Sample ETL templates: every one must stay runnable.
//
// The templates were verified end-to-end against a live object store when they
// were written (SCD2 closing exactly the planted 18 versions, the watermark
// loading 308 then 0, the reconciliation recovering the exact defect counts
// built into the datasets). That harness cannot run in CI, so this file pins
// what can be pinned mechanically: visual graphs compile, code parses as real
// Python, the datasets they fetch exist with the row counts the scenarios
// assume, and each template declares the packages its code imports.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ETL_TEMPLATES } from "@/lib/etlTemplates";
import { compileGraph, requirementsFor } from "@/utils/etl/codegen";

function pythonBin(): string | null {
  for (const bin of ["python", "python3", "py"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "pipe" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}
const PY = pythonBin();

function assertParsesAsPython(code: string): void {
  if (!PY) return;
  const dir = mkdtempSync(join(tmpdir(), "etl-templates-"));
  try {
    const file = join(dir, "gen.py");
    writeFileSync(file, code, "utf8");
    execFileSync(
      PY,
      ["-c", `compile(open(${JSON.stringify(file)}, encoding='utf8').read(), 'gen.py', 'exec')`],
      { stdio: "pipe" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sample = (name: string) =>
  readFileSync(resolve(process.cwd(), "public/etl-samples", name), "utf8");

describe("sample templates", () => {
  it("ships all six scenarios", () => {
    expect(ETL_TEMPLATES.map((t) => t.id).sort()).toEqual([
      "fuzzy-dedupe",
      "medallion",
      "reconciliation",
      "scd2",
      "sessionization",
      "watermark",
    ]);
  });

  it("every visual template compiles, and its declared requirements match", () => {
    for (const t of ETL_TEMPLATES.filter((x) => x.mode === "visual")) {
      const code = compileGraph(t.graph!);
      expect(code).toContain("def entrypoint(inputs=None):");
      assertParsesAsPython(code);
      // The registry pins requirements explicitly; they must at least cover
      // what the compiler would derive for the graph.
      for (const req of requirementsFor(t.graph!).split("\n")) {
        expect(t.requirements, `${t.id} misses ${req}`).toContain(req.split(">=")[0]);
      }
    }
  });

  it("every code template parses as Python and follows the contract", () => {
    for (const t of ETL_TEMPLATES.filter((x) => x.mode === "code")) {
      const code = t.source_code!;
      expect(code).toContain("def entrypoint(inputs=None):");
      expect(code).toContain("ETL_DEST_BUCKET_URL");
      expect(code).toContain("[etl] ");
      // No helper placeholder may survive into the shipped script.
      expect(code).not.toContain("__FETCH_CSV__");
      expect(code).not.toContain("__DEST_FS__");
      assertParsesAsPython(code);
    }
  });

  it("no credential literal appears in any template", () => {
    for (const t of ETL_TEMPLATES) {
      const body = t.source_code ?? JSON.stringify(t.graph);
      expect(body).not.toMatch(/SECRET_ACCESS_KEY['"]?\s*[:=]\s*['"][A-Za-z0-9]/);
    }
  });

  it("every dataset a template fetches exists under public/etl-samples", () => {
    const referenced = new Set<string>();
    for (const t of ETL_TEMPLATES) {
      const body = t.source_code ?? JSON.stringify(t.graph);
      for (const m of body.matchAll(/etl-samples\/([a-z0-9_.]+)/g)) referenced.add(m[1]);
      for (const m of body.matchAll(/_fetch_csv\('([a-z0-9_.]+)'\)/g)) referenced.add(m[1]);
      for (const m of body.matchAll(/SNAPSHOT = '([a-z0-9_.]+)'/g)) referenced.add(m[1]);
    }
    // The SCD2 template names day1 inline and day2 in its comment; both ship.
    referenced.add("employees_day2.csv");
    expect(referenced.size).toBeGreaterThanOrEqual(6);
    for (const name of referenced) {
      expect(() => sample(name), `missing dataset ${name}`).not.toThrow();
    }
  });

  it("the datasets carry the row counts the scenario assertions assume", () => {
    const lines = (name: string) => sample(name).trim().split("\n").length;
    expect(lines("orders.csv")).toBe(309); // header + 300 unique + 8 duplicates
    expect(lines("payments.csv")).toBe(291); // header + 290
    expect(lines("crm_contacts_a.csv")).toBe(71);
    expect(lines("crm_contacts_b.csv")).toBe(66);
    expect(lines("employees_day1.csv")).toBe(81);
    expect(lines("employees_day2.csv")).toBe(83);
    expect(lines("clickstream.jsonl")).toBe(648);
  });

  it("dataset content is data, not accidental HTML", () => {
    // The dev server answers unknown paths with the SPA shell; a rename that
    // broke the sample URLs would make templates "load" a web page.
    expect(sample("orders.csv").startsWith("order_id,")).toBe(true);
    expect(sample("clickstream.jsonl").trimStart().startsWith("{")).toBe(true);
  });
});
