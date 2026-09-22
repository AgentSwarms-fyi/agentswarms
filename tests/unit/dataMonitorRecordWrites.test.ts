// The data monitor's records: a verdict that could not be stamped is said
// and returned, an incident that could not be opened or resolved is said
// to the owner instead of the opposite.
//
// FOUND FROM THE SURVEY (R84). run.server.ts had 3 writes that dropped
// their errors, and one insert whose answer was read only for its id.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/dataMonitors/run.server.ts", "utf8");
const between = (start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const run = between("export async function runDataMonitor(", "async function reconcileIncident(");
const reconcile = between(
  "async function reconcileIncident(",
  "export async function processDueDataMonitors(",
);

describe("a monitor's verdict", () => {
  it("is stamped with the answer read, and returned with what could not be", () => {
    expect(run).toContain("const { error: stampErr } = await supabaseAdmin");
    expect(run).toContain("the monitor shows the previous run until it is");
    expect(run).toContain("recordError: `The verdict could not be stamped on the monitor");
  });
});

describe("a monitor's incident", () => {
  it("says when it could not be extended", () => {
    expect(reconcile).toContain("const { error: extendErr } = await supabaseAdmin");
    expect(reconcile).toContain("could not be extended");
  });

  it("tells the owner an alert whose incident could not be recorded", () => {
    expect(reconcile).toContain("const { data: created, error: openErr } = await supabaseAdmin");
    expect(reconcile).toContain("the incident could not be recorded");
    expect(reconcile).toContain("...(openErr ? { incident_error: openErr.message } : {}),");
  });

  it("does not say Recovered over an incident that could not be resolved", () => {
    expect(reconcile).toContain("const { error: resolveErr } = await supabaseAdmin");
    expect(reconcile).toContain("Recovered, incident still open:");
    expect(reconcile).toContain("the incident could not be marked resolved");
    expect(reconcile).toContain("...(resolveErr ? { incident_error: resolveErr.message } : {}),");
  });
});
