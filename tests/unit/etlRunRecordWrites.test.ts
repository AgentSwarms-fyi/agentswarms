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

  it("keeps the error of the pipeline's stamp, on success and on failure", () => {
    expect((src.match(/const \{ error: stampErr \} = await supabaseAdmin/g) ?? []).length).toBe(2);
    expect((src.match(/last status could not be stamped/g) ?? []).length).toBe(2);
  });
});
