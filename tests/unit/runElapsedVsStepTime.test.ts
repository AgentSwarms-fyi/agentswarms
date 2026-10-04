// Elapsed time and step time are two numbers, named for what they are.
//
// FOUND IN R257 (open since R179): a run parked twelve hours and then
// cancelled read "12h 19m" on Recent runs and "Duration 0ms" on its own
// Observability page. Both were true; only one was a duration. The page
// labelled the sum of its steps' latencies "Duration".
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { formatRunDuration, runElapsedMs } from "@/lib/swarmRunStatus";

describe("runElapsedMs", () => {
  it("is start to finish for a finished run", () => {
    const ms = runElapsedMs("2026-09-30T04:09:35Z", "2026-09-30T16:28:35Z");
    expect(ms).toBe((12 * 60 + 19) * 60_000);
    expect(formatRunDuration(ms as number)).toBe("12h 19m");
  });

  it("is unknown for a run that has not finished", () => {
    expect(runElapsedMs("2026-09-30T04:09:35Z", null)).toBeNull();
  });

  it("never goes negative on a clock that stepped backwards", () => {
    expect(runElapsedMs("2026-09-30T04:09:35Z", "2026-09-30T04:09:30Z")).toBe(0);
  });
});

describe("the Observability pages", () => {
  const detail = readFileSync(
    "src/routes/_authenticated/analytics_.observability.$runId.tsx",
    "utf8",
  );
  const list = readFileSync("src/routes/_authenticated/analytics_.observability.tsx", "utf8");

  it("does not call step time a duration", () => {
    expect(detail).not.toMatch(/label="Duration" value=\{`\$\{run\.total_latency_ms\}ms`\}/);
    expect(detail).toContain('<Metric label="Step time" value={`${run.total_latency_ms}ms`} />');
  });

  it("shows the run's elapsed time beside it", () => {
    expect(detail).toContain('<Metric label="Elapsed" value={elapsedLabel} />');
    expect(detail).toMatch(/const elapsedMs = runElapsedMs\(run\.started_at, run\.finished_at\);/);
  });

  it("names the list's column for what it adds up", () => {
    expect(list).not.toMatch(/<TableHead className="text-right">Latency<\/TableHead>/);
    expect(list).toMatch(/>\s*Step time\s*<\/TableHead>/);
  });
});
