// Continuous pipelines: the loop a compiled program runs when told to, what
// a pipeline needs to be allowed to loop, and the wiring that keeps exactly
// one run live and its positions persisted after every tick.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileGraph, type EtlGraph } from "@/utils/etl/codegen";
import {
  CONTINUOUS_SCHEDULE,
  canRunContinuously,
  continuousRestartBackoffMs,
  continuousRolloverMinutes,
  continuousWrapper,
} from "@/utils/etl/continuous";
import { nextEtlRunAt } from "@/utils/etl/schedule.server";
import { compileSparkGraph } from "@/utils/etl/sparkCodegen";
import { defaultStreamConfig } from "@/utils/etl/streaming";

const rd = (p: string) => readFileSync(p, "utf8");

const kafkaGraph = (): EtlGraph => ({
  nodes: [
    {
      id: "n1",
      kind: "source",
      label: "Orders topic",
      config: { ...defaultStreamConfig("kafka"), brokers: "redpanda.local:9092", topic: "orders" },
    },
    {
      id: "n2",
      kind: "target",
      label: "Lakehouse",
      config: {
        type: "lakehouse",
        schema: "analytics",
        table: "orders_stream",
        write_mode: "append",
      },
    },
  ] as EtlGraph["nodes"],
  edges: [{ id: "e1", from: "n1", to: "n2" }],
});

const batchGraph = (): EtlGraph => ({
  nodes: [
    {
      id: "s1",
      kind: "source",
      label: "Files",
      config: { type: "object_storage", path: "raw/*.csv", format: "csv" },
    },
    {
      id: "t1",
      kind: "target",
      label: "Lakehouse",
      config: { type: "lakehouse", schema: "analytics", table: "files", write_mode: "replace" },
    },
  ] as EtlGraph["nodes"],
  edges: [{ id: "e1", from: "s1", to: "t1" }],
});

afterEach(() => vi.unstubAllEnvs());

describe("what may run continuously", () => {
  it("a visual pipeline with a stream, ingest, CDC or incremental source", () => {
    expect(canRunContinuously("visual", kafkaGraph())).toBeNull();
    expect(
      canRunContinuously("visual", { nodes: [{ kind: "source", config: { type: "ingest" } }] }),
    ).toBeNull();
    expect(
      canRunContinuously("visual", {
        nodes: [{ kind: "source", config: { type: "database", mode: "cdc" } }],
      }),
    ).toBeNull();
    expect(
      canRunContinuously("visual", {
        nodes: [
          {
            kind: "source",
            config: {
              type: "database",
              mode: "query",
              incremental: { cursor_column: "updated_at" },
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it("not a code pipeline, and not a batch source that would re-read everything", () => {
    expect(canRunContinuously("code", kafkaGraph())).toMatch(/visual/);
    expect(canRunContinuously("visual", batchGraph())).toMatch(/drain again and again/);
    expect(canRunContinuously("visual", null)).toMatch(/drain again and again/);
  });
});

describe("the loop", () => {
  const w = continuousWrapper({ n1: "ETL_N1", n7: "ETL_N7" });

  it("is off unless the run says so, and then wraps the per-tick body", () => {
    expect(w).toContain("def entrypoint(inputs=None):");
    expect(w).toContain("if os.environ.get('ETL_CONTINUOUS') != '1':");
    expect(w).toContain("return _tick(inputs)");
    expect(w).toContain("return _run_continuous(inputs)");
  });

  it("advances its own cursors from what each tick reported", () => {
    expect(w).toContain('_CURSOR_ENV = {"n1": "ETL_N1", "n7": "ETL_N7"}');
    expect(w).toContain("os.environ[_stem + '_CURSOR'] = str(v)");
    expect(w).toContain("total['watermarks'][k] = v");
  });

  it("reports after every tick, sleeps only when a tick found nothing, and rolls over on a budget", () => {
    expect(w).toContain("json={'partial': True, 'progress': progress}");
    expect(w).toContain("_post_progress(total)");
    expect(w).toContain("if rows == 0:\n            _time.sleep(poll)");
    expect(w).toContain("os.environ.get('ETL_POLL_SECONDS')");
    expect(w).toContain("os.environ.get('ETL_CONTINUOUS_MAX_SECONDS')");
    expect(w).toContain("while _time.monotonic() - started < budget:");
    // The final metrics keep the shape a run's end expects: a list of targets.
    expect(w).toContain(
      "metrics['targets'] = [{'target': k, 'fqn': k, 'rows': v, 'load_id': None} for k, v in total['targets'].items()]",
    );
    // Gate outcomes are per tick, never an ever-growing list.
    expect(w).toContain("del _quality[:]");
  });

  it("a progress report that cannot be delivered never ends the run", () => {
    expect(w).toContain("except Exception as e:\n        print('[etl] progress not recorded: '");
  });
});

describe("both code generators emit the loop", () => {
  it("the sandbox program: _tick is the body, entrypoint dispatches, cursors are mapped", () => {
    const code = compileGraph(kafkaGraph());
    expect(code).toContain("def _tick(inputs=None):");
    expect(code.indexOf("def _tick(inputs=None):")).toBeLessThan(
      code.indexOf("def entrypoint(inputs=None):"),
    );
    expect(code).toContain('_CURSOR_ENV = {"n1": "ETL_N1"}');
  });

  it("a batch-only graph still compiles, with nothing to map", () => {
    const code = compileGraph(batchGraph());
    expect(code).toContain("def entrypoint(inputs=None):");
    expect(code).toContain("_CURSOR_ENV = {}");
  });

  it("the Spark program too", () => {
    const code = compileSparkGraph(kafkaGraph());
    expect(code).toContain("def _tick(inputs=None):");
    expect(code).toContain("def entrypoint(inputs=None):");
    expect(code).toContain('_CURSOR_ENV = {"n1": "ETL_N1"}');
  });
});

describe("limits", () => {
  it("has no clock of its own", () => {
    expect(nextEtlRunAt(CONTINUOUS_SCHEDULE)).toBeNull();
  });

  it("rollover and restart backoff come from env, then defaults", () => {
    expect(continuousRolloverMinutes()).toBe(720);
    expect(continuousRestartBackoffMs()).toBe(300_000);
    vi.stubEnv("ETL_CONTINUOUS_ROLLOVER_MINUTES", "60");
    vi.stubEnv("ETL_CONTINUOUS_RESTART_BACKOFF_SECONDS", "30");
    expect(continuousRolloverMinutes()).toBe(60);
    expect(continuousRestartBackoffMs()).toBe(30_000);
  });
});

describe("the wiring", () => {
  it("the run tells the program to loop, and its sandbox outlives the rollover", () => {
    const src = rd("src/utils/etl/service.server.ts");
    expect(src).toContain('env.ETL_CONTINUOUS = "1";');
    expect(src).toContain(
      "env.ETL_POLL_SECONDS = String(Math.max(1, pipeline.poll_seconds ?? 5));",
    );
    expect(src).toContain(
      "env.ETL_CONTINUOUS_MAX_SECONDS = String(continuousRolloverMinutes() * 60);",
    );
    expect(src).toContain(
      "pipeline.schedule === CONTINUOUS_SCHEDULE ? continuousRolloverMinutes() + 10 : undefined",
    );
  });

  it("a tick's report persists positions before it updates the counters, and never ends the run", () => {
    const src = rd("src/utils/etl/service.server.ts");
    const fn = src.slice(src.indexOf("export async function recordEtlProgress"));
    const persist = fn.indexOf("await persistEtlWatermarks(");
    const metrics = fn.indexOf(".update({ metrics: progress as Json })");
    expect(persist).toBeGreaterThan(-1);
    expect(persist).toBeLessThan(metrics);
    expect(fn.slice(0, metrics)).toContain('if (!run || run.status !== "running") return;');
    // A run's end uses the same persistence.
    expect(src).toContain("await persistEtlWatermarks(pipeline, watermarks, now);");
  });

  it("chains do not fire at a rollover", () => {
    expect(rd("src/utils/etl/service.server.ts")).toContain(
      "if (hasChainTargets(targets) && pipeline.schedule !== CONTINUOUS_SCHEDULE) {",
    );
  });

  it("the sweep keeps one run live per continuous pipeline, with a backoff after a failure", () => {
    const src = rd("src/utils/etl/schedule.server.ts");
    expect(src).toContain('.not("schedule", "in", "(manual,continuous)")');
    expect(src).toContain("started += await keepContinuousPipelinesAlive(perSweep);");
    const fn = src.slice(src.indexOf("export async function keepContinuousPipelinesAlive"));
    expect(fn).toContain('.in("status", ["queued", "running", "retrying"])');
    expect(fn).toContain("if ((count ?? 0) > 0) continue;");
    expect(fn).toContain(
      "Date.now() - Date.parse(pipeline.last_run_at) < continuousRestartBackoffMs()",
    );
    expect(fn).toContain('await startEtlRun(pipeline, "schedule")');
  });

  it("the sandbox's per-tick report reaches the run", () => {
    const route = rd("src/routes/api/notebook.runtime.result.ts");
    expect(route).toContain("m.recordEtlProgress(");
    expect(route.indexOf("m.recordEtlProgress(")).toBeLessThan(
      route.indexOf('const status = body.status === "error"'),
    );
  });

  it("the save path guards the schedule and forces concurrency off", () => {
    const src = rd("src/utils/etl.functions.ts");
    expect(src).toContain('"cron", "continuous"]');
    expect(src).toContain("const why = canRunContinuously(data.mode, data.graph ?? null);");
    expect(src).toContain(
      "data.schedule === CONTINUOUS_SCHEDULE ? false : (data.allow_concurrent ?? false)",
    );
    expect(src).toContain("poll_seconds: data.poll_seconds ?? 5,");
  });

  it("the page offers it, shows the live run, and can stop it", () => {
    const page = rd("src/routes/_authenticated/etl.tsx");
    expect(page).toContain('<SelectItem value="continuous">Continuous (stream)</SelectItem>');
    expect(page).toContain("Poll every (seconds)");
    expect(page).toContain("streaming · {p.live_run.rows_loaded.toLocaleString()} rows");
    expect(page).toContain('p.schedule === "continuous" && p.live_run ? (');
    expect(page).toContain("run_id: p.live_run.id");
  });
});
