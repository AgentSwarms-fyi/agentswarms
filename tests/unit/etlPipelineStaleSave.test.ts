// Two tabs on one ETL pipeline (R287, sweep 9). saveEtlPipeline wrote the
// whole pipeline over whatever was stored, so a save from a second tab undid
// the first's rename. Runs write the row too, so `updated_at` cannot say who
// changed it; the save compares a fingerprint of the stored definition with
// the one the editor opened. The projection is tested as a function; the
// wiring is pinned by reading the server function and the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fingerprintOf } from "@/lib/definitionFingerprint";
import { etlPipelineDefinition } from "@/lib/etlDefinition";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const server = read("src/utils/etl.functions.ts");
const page = read("src/routes/_authenticated/etl.tsx");

const stored = {
  id: "p1",
  user_id: "u1",
  name: "r214_after",
  description: null,
  mode: "visual",
  engine: "pandas",
  source_code: "import pandas",
  graph: { nodes: [{ id: "a", type: "source" }], edges: [] },
  requirements: "",
  secret_refs: "",
  dest_catalog_source_id: null,
  schedule: "manual",
  cron_expr: null,
  timezone: null,
  retry_count: 0,
  alerts: { on_failure: true, on_success: false, on_recovery: true },
  allow_concurrent: false,
  poll_seconds: 5,
  default_params: null,
  run_after: null,
  chain_sql_models: null,
  chain_ml_schedules: [],
  is_active: true,
  timeout_minutes: 30,
};

describe("etlPipelineDefinition", () => {
  it("leaves out run state, the next run, the trigger token and timestamps", async () => {
    const base = await fingerprintOf(etlPipelineDefinition(stored));
    expect(
      await fingerprintOf(
        etlPipelineDefinition({
          ...stored,
          last_run_at: "2026-10-05T10:00:00+00:00",
          last_run_status: "succeeded",
          next_run_at: "2026-10-06T00:00:00+00:00",
          trigger_token_hash: "abc",
          updated_at: "2026-10-05T10:00:01+00:00",
          // jsonb hands the graph back with its keys in another order.
          graph: { edges: [], nodes: [{ type: "source", id: "a" }] },
        }),
      ),
    ).toBe(base);
  });

  it("changes with what the editor saves", async () => {
    const base = await fingerprintOf(etlPipelineDefinition(stored));
    for (const change of [
      { name: "r214_after A287" },
      { timeout_minutes: 31 },
      { is_active: false },
      { schedule: "daily" },
      { graph: { nodes: [], edges: [] } },
    ]) {
      expect(await fingerprintOf(etlPipelineDefinition({ ...stored, ...change }))).not.toBe(base);
    }
  });
});

describe("getEtlPipeline and saveEtlPipeline", () => {
  it("hands the editor the pipeline with its definition's fingerprint", () => {
    expect(server).toMatch(
      /return \{\s*pipeline: \{ \.\.\.safe, fingerprint: await fingerprintOf\(etlPipelineDefinition\(safe\)\) \},?\s*\};/,
    );
  });

  it("refuses a save whose stored definition moved on, before writing", () => {
    expect(server).toContain("expected_fingerprint: z.string().length(64).optional(),");
    expect(server).toMatch(
      /data\.expected_fingerprint &&\s*\(await fingerprintOf\(etlPipelineDefinition\(existing\)\)\) !== data\.expected_fingerprint\s*\) \{\s*return \{\s*stale: true,/,
    );
    expect(server.indexOf("stale: true,")).toBeLessThan(
      server.indexOf(".update({\n            ...payload,"),
    );
  });

  it("lands only on the row it read, and returns the fingerprint of the row as written", () => {
    expect(server).toMatch(
      /\.eq\("updated_at", existing\.updated_at\)\s*\.select\("\*"\)\s*\.maybeSingle\(\);/,
    );
    expect(server).toContain("fingerprint: await fingerprintOf(etlPipelineDefinition(updated)),");
    expect(server).toContain("fingerprint: await fingerprintOf(etlPipelineDefinition(created)),");
  });
});

describe("the pipeline editor", () => {
  it("keeps the fingerprint it opened and sends it back, unless overwriting", () => {
    expect(page).toMatch(/fingerprintRef\.current = row\.fingerprint;\s*setStale\(false\);/);
    expect(page).toContain(
      "expected_fingerprint: overwrite ? undefined : (fingerprintRef.current ?? undefined),",
    );
    expect(page).toMatch(
      /if \("stale" in res\) \{\s*setStale\(true\);\s*toast\.error\(res\.error\);\s*return false;\s*\}\s*fingerprintRef\.current = res\.fingerprint;/,
    );
  });

  it("does not hand the click event to save as an overwrite", () => {
    expect(page).not.toContain("onClick={save}");
  });

  it("says so, with Reload and Overwrite with mine", () => {
    expect(page).toMatch(/\{stale && \(\s*<div[^>]*data-testid="pipeline-stale"/);
    expect(page).toMatch(/setDirty\(false\);\s*reloadPipeline\(\);/);
    expect(page).toMatch(/onClick=\{\(\) => void save\(true\)\}\s*>\s*Overwrite with mine/);
  });
});
