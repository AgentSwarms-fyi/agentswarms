// A failed read of the swarm list, taken for an owner with no swarms.
//
// FOUND IN R110. The swarm canvas dropped the error on its read of the
// owner's swarms, so a refused read looked like an empty account: it
// created "My First Swarm" and opened it in place of the swarm asked for.
// Driven: Open on "R109 chat echo" with that read refused gave four refused
// GETs, a POST 201 and an empty canvas named "My First Swarm", and the
// gallery went from 18 swarms to 19. Nothing on screen said why.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { chooseInitialSwarm } from "@/lib/swarmInitialLoad";

const echo = { id: "d10c86c5", name: "R109 chat echo" };
const other = { id: "a1", name: "Support Copilot" };

describe("what the canvas opens first", () => {
  it("opens and creates nothing when the list could not be read", () => {
    expect(
      chooseInitialSwarm({
        rows: null,
        error: { message: "R110 injected" },
        requestedId: echo.id,
      }),
    ).toEqual({ kind: "failed", error: "R110 injected" });
    expect(chooseInitialSwarm({ rows: [], error: { message: "down" } }).kind).toBe("failed");
  });

  it("opens the swarm that was asked for", () => {
    expect(chooseInitialSwarm({ rows: [other, echo], error: null, requestedId: echo.id })).toEqual({
      kind: "open",
      row: echo,
      requestedMissing: false,
    });
  });

  it("says so when the swarm asked for is not in the list", () => {
    expect(chooseInitialSwarm({ rows: [other], error: null, requestedId: echo.id })).toEqual({
      kind: "open",
      row: other,
      requestedMissing: true,
    });
  });

  it("makes a first swarm only for an owner who really has none", () => {
    expect(chooseInitialSwarm({ rows: [], error: null })).toEqual({
      kind: "create-first",
      requestedMissing: false,
    });
    expect(chooseInitialSwarm({ rows: [], error: null, requestedId: echo.id })).toEqual({
      kind: "create-first",
      requestedMissing: true,
    });
  });

  it("opens the first swarm when none was asked for", () => {
    expect(chooseInitialSwarm({ rows: [other, echo], error: null })).toEqual({
      kind: "open",
      row: other,
      requestedMissing: false,
    });
  });
});

describe("the swarm canvas", () => {
  const page = readFileSync("src/routes/_authenticated/swarms.tsx", "utf8");
  const load = page.slice(page.indexOf("const loadKey ="), page.indexOf("const handleSwitchSwarm"));

  it("lets the list read's error decide before anything is opened or created", () => {
    expect(load).toMatch(/\{ data: swarmRows, error: swarmsErr \}/);
    expect(load).toMatch(/chooseInitialSwarm\(\{\s*rows: swarmRows,\s*error: swarmsErr,/);
    const failed = load.indexOf('if (first.kind === "failed") {');
    expect(failed).toBeGreaterThan(-1);
    expect(load.slice(failed, failed + 200)).toMatch(/setLoadError\(first\.error\);[\s\S]*return;/);
    expect(load.indexOf(".insert(")).toBeGreaterThan(failed);
    expect(load.indexOf("applySwarmRow(")).toBeGreaterThan(failed);
  });

  it("says why the swarms are not shown, and can try again", () => {
    expect(page).toContain("Could not load your swarms");
    expect(page).toMatch(/setLoadAttempt\(\(n\) => n \+ 1\)/);
    expect(page).toMatch(/\|\$\{loadAttempt\}`;/);
  });

  it("says why it did not switch when another swarm could not be read", () => {
    const sw = page.slice(
      page.indexOf("const handleSwitchSwarm"),
      page.indexOf("const handleNewSwarm"),
    );
    expect(sw).toMatch(
      /if \(error \|\| !data\) \{[\s\S]*toast\.error\("Could not open that swarm"[\s\S]*return;/,
    );
  });
});
