// ETL on a failed read: started from the beginning, failed while running,
// and logged its secrets in clear.
//
// FOUND IN R253, closing two sweep-7 rows ("ETL cursors re-read from the
// start"; "a live ETL run is marked failed") and one the round turned up:
//
//   resolveRunEnv          a cursor read that failed was no cursor, so every
//                          incremental source re-read from the beginning into
//                          targets that already held it.
//   reconcileOrphanedEtlRuns  a session read that failed was "no longer exists",
//                          and a LIVE run was finalized as failed (and retried,
//                          so a second run started beside the first).
//   appendPartialLogs / finalizeEtlRun  "scrub what we can" scrubbed NOTHING when
//                          the secrets could not be resolved - one of them
//                          deleted mid-run makes resolveRunEnv throw - and the
//                          logs and the error were stored with every other
//                          secret in clear.
//
// resolveRunEnv reaches egress, catalog and warehouse code, so these pin the
// ORDER of the checks against the code that acts on them.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/utils/etl/service.server.ts", "utf8");

function body(start: string): string {
  const from = SRC.indexOf(start);
  expect(from, `${start} not found`).toBeGreaterThan(-1);
  const fn = SRC.slice(from);
  return fn.slice(0, fn.indexOf("\n}\n"));
}

describe("resolveRunEnv", () => {
  it("refuses to start rather than read every source from the beginning", () => {
    const fn = body("export async function resolveRunEnv");
    const check = fn.indexOf("if (stateErr) {");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(fn.indexOf("const cursors = new Map("));
    expect(fn.slice(check)).toMatch(/^if \(stateErr\) \{\s*throw new Error\(/);
  });
});

describe("reconcileOrphanedEtlRuns", () => {
  it("leaves a run alone when its session cannot be read", () => {
    const fn = body("export async function reconcileOrphanedEtlRuns");
    const check = fn.indexOf("if (sessionErr) {");
    const gone = fn.indexOf('"The run\'s sandbox session no longer exists."');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(gone);
    expect(fn.slice(check, gone)).toMatch(/continue;/);
  });
});

describe("the logs", () => {
  it("skips a live-log tick whose secrets cannot be resolved, instead of writing it raw", () => {
    const fn = body("export async function appendPartialLogs");
    const write = fn.indexOf(".update({ logs: scrubSecrets(");
    expect(fn).toMatch(/if \(pipelineErr \|\| !pipeline\) return;/);
    expect(fn).toMatch(
      /secretValues = \(await resolveRunEnv\(pipeline\)\)\.secretValues;\s*\} catch \{\s*return;\s*\}/,
    );
    expect(fn.indexOf("if (pipelineErr || !pipeline) return;")).toBeLessThan(write);
    // The old comment, and the behaviour it named, are gone.
    expect(fn).not.toContain("scrub what we can");
  });

  it("withholds final output it could not scrub, the error text included", () => {
    const fn = body("export async function finalizeEtlRun");
    expect(fn).toMatch(/\} catch \{\s*secretValues = null;\s*\}/);
    // Neither the logs nor the error reach scrubSecrets with a list that
    // stands for "could not be resolved".
    expect(fn).toMatch(/secretValues === null\s*\?\s*body\.logs\s*\?\s*WITHHELD/);
    expect(fn).toMatch(
      /secretValues === null\s*\?\s*`The run ended with an error\. \$\{WITHHELD\}`/,
    );
    expect(fn).not.toContain("scrub what we can");
  });

  it("does not finalize a run whose pipeline could not be read", () => {
    const fn = body("export async function finalizeEtlRun");
    const check = fn.indexOf("if (pipelineErr) {");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(fn.indexOf('const ok = body.status !== "error";'));
    expect(fn.slice(check)).toMatch(/^if \(pipelineErr\) \{[\s\S]*?return;/);
  });
});
