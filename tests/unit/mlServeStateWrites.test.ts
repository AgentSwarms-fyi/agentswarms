// The ML endpoint's state writes: a state the record could not take is
// said, and a copy the record cannot describe is stopped rather than left
// running.
//
// FOUND FROM THE SURVEY (R77). serve.server.ts had 23 writes that dropped
// their errors. The ready stamp among them left a serving endpoint "starting"
// and every later call replaced its copy; undeploy said "stopped" over a row
// still "ready"; a copy whose session write failed could never be stopped.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/ml/serve.server.ts", "utf8");
const fns = readFileSync("src/utils/mlOps.functions.ts", "utf8");
const between = (start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const markStopped = between("async function markStopped(", "async function stampReady(");
const stampReady = between("async function stampReady(", "async function markReplica(");
const ensureDeployment = between(
  "export async function ensureDeployment(",
  "async function replicaRoom(",
);
const startReplica = between("async function startReplica(", "async function retireReplica(");
const retireReplica = between("async function retireReplica(", "async function healthy(");
const touch = between("async function touch(", "async function stopQuietly(");
const undeploy = between(
  "export async function undeploy(",
  "export async function reapIdleDeployments(",
);
const setCandidate = src.slice(src.indexOf("export async function setCandidate("));

describe("the endpoint's own state", () => {
  it("marks stopped or failed and returns what could not be written", () => {
    expect(markStopped).toContain("const { error: writeErr } = await supabaseAdmin");
    expect(markStopped).toContain("but its record could not be marked so");
    expect(markStopped).toContain("return writeErr.message;");
  });

  it("stamps ready with one retry and says when it could not", () => {
    expect((stampReady.match(/await stamp\(\)/g) ?? []).length).toBe(2);
    expect(stampReady).toContain("could not be marked ready after two attempts");
  });

  it("does not answer ok over a stamp that failed", () => {
    expect(ensureDeployment).toContain("const readyErr = await stampReady(dep.id);");
    expect(ensureDeployment).toContain(
      "The endpoint is up but its record could not be marked ready",
    );
    expect(ensureDeployment).toContain("the next Deploy will replace the copy");
    expect(ensureDeployment).toContain("const stampErr = await markStopped(dep.id, first.error);");
    expect(ensureDeployment).toContain("could not be marked failed");
  });
});

describe("a copy", () => {
  it("is stopped again when its session could not be recorded", () => {
    const i = startReplica.indexOf("if (sessErr) {");
    expect(i).toBeGreaterThan(-1);
    const block = startReplica.slice(i, startReplica.indexOf("const ready = await waitReady("));
    expect(block).toContain("await stopQuietly(args.userId, session.id);");
    expect(block).toContain("its session could not be recorded");
  });

  it("is stopped again when it could not be marked ready", () => {
    const i = startReplica.indexOf("if (readyErr) {");
    expect(i).toBeGreaterThan(-1);
    const block = startReplica.slice(
      i,
      startReplica.indexOf("return { ok: true, endpoint: ready.endpoint"),
    );
    expect(block).toContain("await stopQuietly(args.userId, session.id);");
    expect(block).toContain("could not be marked ready");
  });

  it("reports the write that should have retired it", () => {
    expect(retireReplica).toContain("Promise<string | null>");
    expect(retireReplica).toContain("return markReplica(");
  });

  it("has its use recorded, or the failure said", () => {
    expect(touch).toContain("const err = used.error ?? touched.error;");
    expect(touch).toContain("the idle reaper reads what was recorded");
  });
});

describe("undeploy", () => {
  it("answers with what could not be written, and the server function passes it on", () => {
    expect(undeploy).toContain('const err = await retireReplica(replica, "undeployed");');
    expect(undeploy).toContain("const { error: candErr } = await supabaseAdmin");
    expect(undeploy).toContain("const stopErr = await markStopped(dep.id);");
    expect(undeploy).toContain("if (failed.length > 0) {");
    expect(undeploy).toContain(
      "Every copy is stopped, but the endpoint's record could not be updated",
    );
    expect(fns).toContain("return await undeploy(model.id, userId);");
  });
});

describe("a candidate", () => {
  it("is stopped again when the record could not name it", () => {
    const i = setCandidate.indexOf("if (nameErr) {");
    expect(i).toBeGreaterThan(-1);
    const block = setCandidate.slice(i, setCandidate.indexOf("const { error: clearErr }"));
    expect(block).toContain("await retireReplica(copy,");
    expect(block).toContain("the copy was stopped again");
  });

  it("says when its stop or its mode change could not be recorded", () => {
    expect(setCandidate).toContain("still names the candidate");
    expect(setCandidate).toContain("its mode could not be recorded");
  });
});
