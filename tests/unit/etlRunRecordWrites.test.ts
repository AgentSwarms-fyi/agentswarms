// The ETL run's records: a sandbox the run row never learned of is stopped
// again, a cancel that could not be written is not said, a watermark that
// could not be saved is said on the run that succeeded.
//
// FOUND FROM THE SURVEY (R78). service.server.ts had 13 writes that dropped
// their errors; the page said "Stopping" whatever the server answered.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/etl/service.server.ts", "utf8");
const fns = readFileSync("src/utils/etl.functions.ts", "utf8");
const page = readFileSync("src/routes/_authenticated/etl.tsx", "utf8");
const between = (start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const startRunSandbox = between("async function startRunSandbox(", "/** Backoff:");
const cancelEtlRun = src.slice(src.indexOf("export async function cancelEtlRun("));
const persist = between(
  "export async function persistEtlWatermarks(",
  "export async function recordEtlProgress(",
);
const finalize = between(
  "export async function finalizeEtlRun(",
  "async function runChainTargets(",
);

describe("a run's sandbox", () => {
  it("is stopped again when the run row could not learn its session", () => {
    expect(startRunSandbox).toContain("const { error: recErr } = await supabaseAdmin");
    const i = startRunSandbox.indexOf("if (recErr) {");
    expect(i).toBeGreaterThan(-1);
    const block = startRunSandbox.slice(i, startRunSandbox.indexOf("return { ok: true };"));
    expect(block).toContain("await stopSession(session)");
    expect(block).toContain("its session could not be recorded");
    expect(block.indexOf("await stopSession(session)")).toBeLessThan(
      block.indexOf("await failOrRetry("),
    );
  });
});

describe("cancelling a run", () => {
  it("writes the record first and stops nothing the record still calls running", () => {
    expect(cancelEtlRun).toContain("Promise<{ ok: true } | { ok: false; error: string }>");
    expect(cancelEtlRun).toContain("const { error: cancelErr } = await supabaseAdmin");
    expect(cancelEtlRun).toContain("The run could not be marked cancelled");
    expect(cancelEtlRun.indexOf("if (cancelErr) {")).toBeLessThan(
      cancelEtlRun.indexOf("await releaseRunCluster(runId);"),
    );
    expect(cancelEtlRun).toContain("That run is not running.");
  });

  it("is answered to the page as it went, and the page reads the answer", () => {
    expect(fns).toContain("return cancelEtlRun(data.run_id, userId);");
    expect(fns).not.toContain("{ ok: await cancelEtlRun(");
    expect(page).toContain('toast.error("Could not stop the run", {');
    expect(page).toContain('toast.error("Could not cancel the run", {');
    const stop = page.slice(
      page.indexOf("const stopLive = async () => {"),
      page.indexOf("const cancelFn = useServerFn(cancelEtlRunFn);", page.indexOf("const stopLive")),
    );
    expect(stop.indexOf("if (!res.ok) {")).toBeLessThan(stop.indexOf('toast.success("Stopping'));
  });

  it("says a cancel whose call never reached the server, from the runs list too", () => {
    const i = page.indexOf('<Square className="mr-1 h-3 w-3" /> Cancel');
    expect(i).toBeGreaterThan(-1);
    const handler = page.slice(page.lastIndexOf("onClick={async () => {", i), i);
    expect(handler).toContain("} catch (e) {");
    expect(handler).toContain("It is still running.");
    expect((handler.match(/toast\.error\("Could not cancel the run"/g) ?? []).length).toBe(2);
  });
});

describe("a run that succeeded", () => {
  it("returns the watermarks it could not save, and says so on the run", () => {
    expect(persist).toContain("Promise<string[]>");
    expect(persist).toContain("if (error) failed.push(`${nodeId}: ${error.message}`);");
    expect(persist).toContain("The next run reads from the previous cursor.");
    expect(finalize).toContain(
      "const lost = await persistEtlWatermarks(pipeline, watermarks, now);",
    );
    expect(finalize).toContain("if (lost.length > 0) {");
    expect(finalize).toContain("Succeeded, but the watermark could not be saved for");
  });

  it("keeps the error of the pipeline's stamp, on success, failure and cancel", () => {
    // R241 added the third. Every stamp keeps its error and says the same
    // thing, so the list's badge is never silently a run behind.
    expect((src.match(/const \{ error: stampErr \} = await supabaseAdmin/g) ?? []).length).toBe(3);
    expect((src.match(/last status could not be stamped/g) ?? []).length).toBe(3);
  });
});

describe("a cancelled run is still a run", () => {
  // FOUND IN R241. Only the succeeded and failed paths stamped the pipeline's
  // last run, and both return early for a cancelled run — correctly, since a
  // cancel is not a failure. So nothing stamped it at all, and a pipeline
  // whose only runs were cancelled read "last run: —" and "never ran" on the
  // ETL list. It ran, and the operator stopped it.

  it("stamps the pipeline, so the list stops saying it never ran", () => {
    expect(cancelEtlRun).toContain('last_run_status: "cancelled"');
    expect(cancelEtlRun).toContain("last_run_at:");
    // It can only stamp the pipeline if it read which one.
    expect(cancelEtlRun).toMatch(/select\("[^"]*pipeline_id[^"]*"\)/);
  });

  it("writes the run's own record FIRST, as R78 established", () => {
    // The run is cancelled by the etl_runs write; the pipeline summary is a
    // derived convenience. Stamping first would claim a cancel that the run
    // row might not have taken.
    const runWrite = cancelEtlRun.indexOf('status: "cancelled"');
    const stamp = cancelEtlRun.indexOf('last_run_status: "cancelled"');
    expect(runWrite).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(runWrite);
  });

  it("does not report a failed stamp as a failed cancel", () => {
    // The run IS cancelled by then. Answering ok: false would send the
    // operator back to cancel something that is already stopped.
    const stamp = cancelEtlRun.indexOf('last_run_status: "cancelled"');
    const after = cancelEtlRun.slice(stamp, stamp + 500);
    expect(after).toContain("console.warn");
    expect(after).not.toMatch(/return \{\s*ok: false/);
  });

  it("writes a status the list can actually draw", () => {
    // The chip has carried a `cancelled` style the whole time and was never
    // given one. If the style is removed, the status becomes an unstyled
    // badge rather than a visible state.
    // Pinned to the CHIP's map: etl.tsx has a second `cancelled:` entry for
    // the trend bar, and matching the file as a whole let a mutant delete this
    // one and still pass.
    const styles = page.slice(
      page.indexOf("const RUN_STATUS_STYLE"),
      page.indexOf("function StatusChip"),
    );
    expect(styles).toMatch(/cancelled:\s*"/);
  });

  it("leaves the drift chip comparing against a run that produced a RESULT", () => {
    // A cancelled run may have run nothing, so it cannot answer "is the
    // result I see from today's program?". The query stays on finished runs,
    // and the comment no longer claims it is the run that wrote the status.
    const drift = fns.slice(fns.indexOf("async function lastRunDrift("));
    expect(drift).toContain('.in("status", ["succeeded", "failed"])');
    const doc = fns.slice(Math.max(0, fns.indexOf("async function lastRunDrift(") - 900));
    expect(doc).toMatch(/latest run that FINISHED/);
  });
});
