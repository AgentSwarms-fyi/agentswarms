// Agent Chat's agent list and trace panel under a failed read (R191).
//
// FOUND IN R191, the client read survey's playground batch, driven on the
// real image c9e16c0b2b3b with the reads refused from the browser:
// - the agent list: an empty picker under a pulsing "Pick an agent to
//   begin" and "Choose an agent from the top bar", over nine agents;
// - the Developer inspector's Trace tab: "Trace not recorded · The request
//   may have failed before the trace row was written." for a request that
//   had answered "OK" and whose trace the Traces page listed.
// Pinned by source: both live in the route file with no pure seam.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");

const between = (from: string, to: string) => {
  const a = SRC.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = SRC.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return SRC.slice(a, b);
};

describe("the agent list", () => {
  it("keeps the read's error, and fills the list only from a read that worked", () => {
    const load = between(
      '.select("id, name, llm_provider, llm_model, system_prompt, tools")',
      "}, [",
    );
    expect(load).toContain("setAgentsError(error ? error.message : null);");
    const guard = load.indexOf("if (error || !data) return;");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(load.indexOf("setAgents(data as Agent[]);"));
    expect(SRC).toContain("}, [agentId, agentsAttempt]);");
  });

  it("says the agents were not read, in place of 'Pick an agent to begin'", () => {
    const at = SRC.indexOf("{agentsError ? (");
    expect(at).toBeGreaterThan(0);
    expect(SRC.indexOf("Pick an agent to begin", at)).toBeGreaterThan(at);
    const mark = SRC.slice(at, SRC.indexOf("Pick an agent to begin", at));
    expect(mark).toContain("Agents not read");
    expect(mark).toContain("title={`Your agents could not be read: ${agentsError}`}");
  });

  it("does not ask for a pick from a list that did not load, and offers Try again", () => {
    expect(SRC).toMatch(
      /: agentsError\s*\?\s*"Your agents could not be read"\s*:\s*"Select an agent to start"/,
    );
    expect(SRC).toMatch(
      /: agentsError\s*\?\s*`So there is nothing to pick yet: \$\{agentsError\.replace\(/,
    );
    const at = SRC.indexOf("{!currentAgent && agentsError && (");
    expect(at).toBeGreaterThan(0);
    expect(SRC.slice(at, at + 300)).toMatch(
      /onClick=\{\(\) => setAgentsAttempt\(\(n\) => n \+ 1\)\}\s*>\s*Try again/,
    );
  });
});

describe("the trace panel", () => {
  const poll = between("const tick = async () => {", "tick();");

  it("keeps the last read's error while it polls", () => {
    expect(poll).toMatch(/const \{ data, error \} = await supabase\s*\.from\("execution_traces"\)/);
    expect(poll).toContain("setReadError(error ? error.message : null);");
    expect(SRC).toContain("}, [traceId, attempt]);");
  });

  it("says the trace was not read, ahead of 'Trace not recorded', with Try again", () => {
    const at = SRC.indexOf("if (!trace && readError) {");
    expect(at).toBeGreaterThan(0);
    const notRecorded = SRC.indexOf("Trace not recorded", at);
    expect(notRecorded).toBeGreaterThan(at);
    const branch = SRC.slice(at, notRecorded);
    expect(branch).toContain("Trace not read");
    expect(branch).toContain(
      "The trace could not be read, so this says nothing about whether it was recorded:",
    );
    expect(branch).toMatch(/onClick=\{\(\) => setAttempt\(\(n\) => n \+ 1\)\}\s*>\s*Try again/);
  });
});
