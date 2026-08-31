// Compute limits an operator can actually change.
//
// WHY THIS EXISTS. Six knobs decided how much of the host the platform would
// use, and they lived in three places: two in the settings table behind
// validation ceilings, two only in .env (so changing them meant a redeploy),
// and two as CONSTANTS in TypeScript — unreachable without a release. On a
// 16-core / 128 GB machine the defaults spent roughly 6 cores and 12 GB, and
// there was no supported way to spend the rest.
//
// These tests pin the two properties that matter: nothing caps a value below
// what the machine can do, and every consumer reads the resolved setting
// rather than the old hardcoded constant.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("no compute limit is hardcoded", () => {
  const config = read("src/utils/notebookRuntime/config.server.ts");
  const admin = read("src/utils/notebookRuntimeAdmin.functions.ts");

  it("resolves every knob as setting → env → default", () => {
    // The order matters: an admin changing a value in the UI must beat an env
    // var left over from a previous deploy, or the UI would silently do
    // nothing and look broken.
    expect(config).toContain("export async function getPlatformResources()");
    expect(config).toContain("data?.lakehouse_memory_limit?.trim() ||");
    expect(config).toContain("process.env.LAKEHOUSE_MEMORY_LIMIT?.trim() ||");
    expect(config).toContain(
      'positive(data?.lakehouse_threads) ?? envInt("LAKEHOUSE_THREADS") ?? 4',
    );
    expect(config).toContain("positive(data?.etl_max_concurrent_runs_per_user)");
    expect(config).toContain("positive(data?.etl_pipelines_per_sweep)");
    expect(config).toContain("positive(data?.sandbox_tmpfs_mb) ?? 512");
  });

  it("puts no ceiling on any sizing field", () => {
    // A ceiling written into the code is a ceiling nobody can raise without a
    // release. Each of these had one; none may come back.
    for (const forbidden of [
      "mem_limit_mb: z.number().int().min(256).max(65536)",
      "batch_mem_limit_mb: z.number().int().min(256).max(131072)",
      "max_sessions_per_user: z.number().int().min(1).max(50)",
      "max_sessions_total: z.number().int().min(1).max(1000)",
    ]) {
      expect(admin).not.toContain(forbidden);
    }
    expect(admin).toContain("mem_limit_mb: z.number().int().min(256).optional()");
    expect(admin).toContain("lakehouse_threads: z.number().int().min(1).optional()");
    expect(admin).toContain("etl_max_concurrent_runs_per_user: z.number().int().min(1).optional()");
    expect(admin).toContain("etl_pipelines_per_sweep: z.number().int().min(1).optional()");
  });

  it("validates CPU as a number, not as a string LENGTH", () => {
    // The old rule was z.string().min(1).max(16) — a length check that
    // accepted "banana" and bounded nothing an operator would type.
    expect(admin).not.toContain("cpu_limit: z.string().min(1).max(16)");
    expect(admin).not.toContain("batch_cpu_limit: z.string().min(1).max(16)");
    expect(admin).toContain("const positiveNumericString");
    expect(admin).toContain("cpu_limit: positiveNumericString");
    expect(admin).toContain("batch_cpu_limit: positiveNumericString");
  });

  it("still refuses a size string that means nothing", () => {
    // Removing ceilings is not the same as accepting anything: "48 potatoes"
    // would reach DuckDB and fail at engine boot, far from the person who
    // typed it.
    expect(admin).toContain("Use a size like 48GB");
  });
});

describe("every consumer reads the setting", () => {
  it("the lakehouse engine no longer reads process.env directly", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("resources.lakehouseThreads");
    expect(core).toContain("resources.lakehouseMemoryLimit");
    // The old clamp capped a 16-core host at 8 threads whatever it was told.
    expect(core).not.toContain("Math.min(8, Number(process.env.LAKEHOUSE_THREADS");
  });

  it("ETL concurrency and sweep size come from settings", () => {
    const svc = read("src/utils/etl/service.server.ts");
    const sched = read("src/utils/etl/schedule.server.ts");
    // Renamed to DEFAULT_ to make it obvious they are a fallback, not the law.
    expect(svc).toContain("DEFAULT_MAX_CONCURRENT_RUNS_PER_USER");
    expect(svc).toContain("getPlatformResources()).etlMaxConcurrentRunsPerUser");
    expect(sched).toContain("DEFAULT_PIPELINES_PER_SWEEP");
    expect(sched).toContain("getPlatformResources()).etlPipelinesPerSweep");
    // And the refusal tells you where to change it.
    expect(svc).toContain("Admin -> Developer runtime");
  });

  it("the sandbox tmpfs is sized from settings, not a literal", () => {
    const docker = read("src/utils/notebookRuntime/docker.server.ts");
    expect(docker).not.toContain("size=512m");
    expect(docker).toContain("size=${tmpfsMb}m");
    expect(read("src/utils/notebookRuntime/service.server.ts")).toContain(
      "tmpfsMb: settings.sandboxTmpfsMb",
    );
  });
});

describe("the admin UI sizes against the real host", () => {
  const ui = read("src/components/admin/RuntimeTab.tsx");

  it("reports what this machine actually has", () => {
    // Removing the caps only helps if the operator can see what they are
    // sizing against.
    expect(read("src/utils/notebookRuntime/config.server.ts")).toContain(
      "export function hostResources()",
    );
    expect(ui).toContain("This host reports");
    expect(ui).toContain("state.host.cpus");
    expect(ui).toContain("state.host.totalMemMb");
  });

  it("warns past host capacity without blocking it", () => {
    // A container's view of its host is not always the whole story, so this
    // is advice. The field stays editable.
    expect(ui).toContain("still allowed");
    expect(ui).toContain("More than the ${state.host.cpus} CPU this host reports");
  });

  it("shows what the ETL settings actually add up to", () => {
    // "3 runs x 2 CPU / 4 GB = 6 CPU / 12 GB" is the sentence that makes an
    // under-used 128 GB box obvious.
    expect(ui).toContain("Batch capacity");
    expect(ui).toContain("per user at full tilt");
  });
});
