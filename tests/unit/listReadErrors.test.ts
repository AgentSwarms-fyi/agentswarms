// The Agent Builder and Knowledge Base lists: a read that failed is shown
// as a failure, never as "nothing yet".
//
// FOUND FROM THE UI. Both pages dropped their read's `error`, so a read that
// failed left the list empty and the page offered a "New Agent" or "No
// knowledge bases yet." — over the rows it could not read. The one page
// that had already learned "not fetched yet" is not "none" (agents.tsx's
// `loaded`) still had no third state for "could not fetch".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { listState } from "@/lib/listState";

const agents = readFileSync("src/routes/_authenticated/agents.tsx", "utf8");
const kb = readFileSync("src/routes/_authenticated/knowledge.tsx", "utf8");

describe("listState", () => {
  it("is an error whenever the read failed, ahead of empty and of loading", () => {
    expect(listState({ loaded: true, error: "Failed to fetch", count: 0 })).toBe("error");
    expect(listState({ loaded: false, error: "Failed to fetch", count: 0 })).toBe("error");
    expect(listState({ loaded: true, error: "Failed to fetch", count: 7 })).toBe("error");
  });

  it("is loading until the first read answered", () => {
    expect(listState({ loaded: false, error: null, count: 0 })).toBe("loading");
  });

  it("is empty only after a read that answered with nothing", () => {
    expect(listState({ loaded: true, error: null, count: 0 })).toBe("empty");
    expect(listState({ loaded: true, error: null, count: 3 })).toBe("list");
  });
});

describe("the Agent Builder", () => {
  it("keeps the read's error and shows it ahead of the empty state", () => {
    const load = agents.slice(
      agents.indexOf("async function loadAgents()"),
      agents.indexOf("async function deleteAgent"),
    );
    expect(load).toContain("const { data, error } = await supabase");
    expect(load).toContain("setLoadError(error ? error.message : null);");
    const err = agents.indexOf('title="Could not load your agents"');
    const empty = agents.indexOf('title="No agents yet"');
    expect(err).toBeGreaterThan(0);
    expect(err).toBeLessThan(empty);
    expect(agents).toContain(
      'listState({ loaded, error: loadError, count: agents.length }) === "error"',
    );
    expect(agents).toContain("Try again");
  });
});

describe("the Knowledge Base page", () => {
  const fn = (name: string, until: string) =>
    kb.slice(kb.indexOf(name), kb.indexOf(until, kb.indexOf(name)));

  it("keeps the error of each of its three list reads", () => {
    expect(fn("async function loadBases()", "async function reindexWithCurrentSettings")).toContain(
      "setBasesError(error ? error.message : null);",
    );
    expect(fn("async function loadDocs(", "async function loadChunkCounts")).toContain(
      "setDocsError(error ? error.message : null);",
    );
    expect(fn("async function loadSources(", "if (data) setSources(")).toContain(
      "setSourcesError(error ? error.message : null);",
    );
  });

  it("renders each error ahead of the empty state it used to hide behind", () => {
    for (const [err, empty] of [
      ["Could not load your knowledge bases:", "No knowledge bases yet."],
      ["Could not load the documents:", "No documents in this knowledge base."],
      ["Could not load the sources:", "No sources yet"],
    ]) {
      const i = kb.indexOf(err);
      const j = kb.indexOf(empty);
      expect(i, err).toBeGreaterThan(0);
      expect(i, `${err} before ${empty}`).toBeLessThan(j);
    }
    expect((kb.match(/role="alert"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
