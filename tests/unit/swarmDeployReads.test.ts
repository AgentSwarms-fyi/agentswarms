// The deploy dialog under a failed read (R188).
//
// FOUND IN R188, the client read survey's swarms batch. The dialog reads the
// swarm's API keys, its schedules and its own row, and dropped every error.
// Driven on "Approval durability check", pinned 9/23 and with several
// schedules: the schedules read refused → "Not deployed · No API keys or
// schedules yet." and, on the Schedules tab, "No schedules yet." with Add
// enabled. Adding the schedule again from there runs the swarm twice on
// every tick. The dialog is pinned by source; the state copy is pure.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { deployStateCopy } from "@/lib/swarmPublish";

const SRC = readFileSync("src/components/swarms/SwarmDeployDialog.tsx", "utf8");
const load = SRC.slice(
  SRC.indexOf("const load = useCallback(async () => {"),
  SRC.indexOf("}, [swarmId]);"),
);

describe("the deployment state", () => {
  it("has a word for 'could not be read', and it is not 'Not deployed'", () => {
    const c = deployStateCopy("unknown");
    expect(c.label).toBe("Deployment not read");
    expect(c.detail).toMatch(/could not be read, so this panel says nothing about it/);
    expect(deployStateCopy("not-deployed").label).toBe("Not deployed");
  });

  it("is unknown when any of the three reads failed", () => {
    expect(SRC).toMatch(
      /const state =\s*readErrors\.keys \|\| readErrors\.schedules \|\| readErrors\.row\s*\?\s*"unknown"/,
    );
  });
});

describe("the reads", () => {
  it("keep each error, and show no list for a read that failed", () => {
    expect(load).toMatch(
      /\{ data: k, error: kErr \}, \{ data: s, error: sErr \}, \{ data: sw, error: swErr \}/,
    );
    expect(load).toMatch(
      /setReadErrors\(\{ keys: kErr\?\.message, schedules: sErr\?\.message, row: swErr\?\.message \}\);/,
    );
    expect(load).toMatch(/setKeys\(kErr \? \[\] :/);
    expect(load).toMatch(/setSchedules\(sErr \? \[\] :/);
    expect(load).toMatch(/setRow\(swErr \? null :/);
  });
});

describe("the lists", () => {
  it("say the keys were not read, ahead of 'No keys yet.'", () => {
    const at = SRC.indexOf(") : readErrors.keys ? (");
    expect(at).toBeGreaterThan(0);
    expect(SRC.indexOf("No keys yet.", at)).toBeGreaterThan(at);
    expect(SRC.slice(at, at + 300)).toContain(
      "The keys could not be read, so this list says nothing about them:",
    );
  });

  it("say the schedules were not read, and turn Add off until they are", () => {
    const at = SRC.indexOf(") : readErrors.schedules ? (");
    expect(at).toBeGreaterThan(0);
    expect(SRC.indexOf("No schedules yet.", at)).toBeGreaterThan(at);
    expect(SRC.slice(at, at + 400)).toContain(
      "The schedules could not be read, so this list says nothing about them:",
    );
    expect(SRC).toMatch(
      /onClick=\{addSchedule\}\s*disabled=\{addingSched \|\| !!readErrors\.schedules\}/,
    );
  });
});
