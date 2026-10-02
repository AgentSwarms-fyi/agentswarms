// The sandbox's own record: a container the session row could not take is
// stopped again, a stopped container whose row could not be marked is said,
// a touch that was not recorded is said for the reaper's sake.
//
// FOUND FROM THE SURVEY (R80). service.server.ts had 7 writes that dropped
// their errors, and every ML and ETL sandbox runs through it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/notebookRuntime/service.server.ts", "utf8");
const between = (start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const startSession = between(
  "export async function startSession(",
  "export async function refreshSession(",
);
const refresh = between(
  "export async function refreshSession(",
  "export async function stopSession(",
);
const stop = between("export async function stopSession(", "/**\n * Refresh every live session");
const touch = between("export async function touchSession(", "/** Reap idle interactive kernels");
const reap = src.slice(src.indexOf("export async function reapSessions("));

describe("starting a session", () => {
  it("stops the container again when the row could not record it", () => {
    expect(startSession).toContain("const { error: refErr } = await supabaseAdmin");
    const i = startSession.indexOf("if (refErr) {");
    expect(i).toBeGreaterThan(-1);
    const block = startSession.slice(
      i,
      startSession.indexOf("return { session: { ...row, container_ref: ref }"),
    );
    // Chain-tolerant: prettier breaks `await orch.stop(ref).catch(...)` across lines.
    const stopCall = /await orch\s*\.stop\(ref\)/;
    expect(block).toMatch(stopCall);
    expect(block).toContain("its session could not record it");
    expect(block.search(stopCall)).toBeLessThan(block.indexOf("throw new Error("));
  });

  it("says when the error mark could not be written, on both paths", () => {
    expect(
      (startSession.match(/const \{ error: markErr \} = await supabaseAdmin/g) ?? []).length,
    ).toBe(2);
    expect((startSession.match(/could not be marked error/g) ?? []).length).toBe(2);
  });
});

describe("a session's record afterwards", () => {
  it("says when the reconciled state could not be written", () => {
    expect(refresh).toContain("const { error: patchErr } = await supabaseAdmin");
    expect(refresh).toContain("the table still says");
  });

  it("says when a stopped container's row could not be marked stopped", () => {
    expect(stop).toContain("const { error: stopErr } = await supabaseAdmin");
    expect(stop).toContain("is stopped but its record could not be marked so");
  });

  it("says when a touch was not recorded, for the reaper's sake", () => {
    expect(touch).toContain("const { error } = await supabaseAdmin");
    expect(touch).toContain("the idle reaper reads what was recorded");
  });

  it("says when a reaped app could not be marked stopped", () => {
    expect(reap).toContain("const { error: appErr } = await supabaseAdmin");
    expect(reap).toContain("MCP Builder will show it running");
  });
});
