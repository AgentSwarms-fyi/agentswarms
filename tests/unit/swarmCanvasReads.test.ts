// The swarm canvas under a failed read (R189).
//
// FOUND IN R189, the client read survey's swarms batch. Three reads on the
// canvas dropped their errors and showed the empty state in their place:
// - the published snapshot re-read after a Publish: refused, the snapshot went
//   to null and "Draft ahead" never showed again, though the canvas had a node
//   the published one did not ("R109 chat echo", 3 nodes against 2);
// - "My components", in the palette and in the library: refused after a save
//   that went through, both read "None yet" / "No components yet" with the
//   component right there at v2;
// - the version history: refused, "No versions yet — Save the swarm or
//   capture one above." on a swarm with an Initial version.
// Pinned by source: the reads live in components with no pure seam.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CANVAS = readFileSync("src/routes/_authenticated/swarms.tsx", "utf8");
const LIBRARY = readFileSync("src/components/swarms/ComponentLibraryDialog.tsx", "utf8");
const VERSIONS = readFileSync("src/components/swarms/SwarmVersionsDialog.tsx", "utf8");

const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  return src.slice(a, src.indexOf(to, a));
};

describe("the published snapshot", () => {
  const refresh = between(CANVAS, "const refreshPublished = useCallback(", "}, [swarmId]);");

  it("keeps the error, and does not keep a snapshot it could not re-read", () => {
    expect(refresh).toMatch(/const \{ data, error \} = await supabase/);
    expect(refresh).toContain("setPublishedError(error ? error.message : null);");
    expect(refresh).toContain("setPublished(error ? null : (data ?? null));");
  });

  it("says on the toolbar that what is live was not checked", () => {
    const at = CANVAS.indexOf("{publishedError && (");
    expect(at).toBeGreaterThan(0);
    expect(CANVAS.indexOf("{draftAhead && (", at)).toBeGreaterThan(at);
    const badge = CANVAS.slice(at, at + 500);
    expect(badge).toContain("Live not checked");
    expect(badge).toContain("could not be read, so whether the canvas is ahead of it is unknown");
  });

  it("forgets the error when another swarm is opened", () => {
    const apply = between(CANVAS, "const applySwarmRow = useCallback(", "[setNodes, setEdges]");
    expect(apply).toContain("setPublishedError(null);");
  });
});

describe("the palette's components", () => {
  it("keep the error and show no list behind it", () => {
    const load = between(CANVAS, "const loadComponents = useCallback(", "}, []);");
    expect(load).toContain("setComponentsError(error ? error.message : null);");
    expect(load).toMatch(/setMyComponents\(error \? \[\] :/);
    const at = CANVAS.indexOf("{componentsError ? (");
    expect(at).toBeGreaterThan(0);
    expect(CANVAS.indexOf("None yet —", at)).toBeGreaterThan(at);
    expect(CANVAS.slice(at, at + 300)).toContain(
      "Your components could not be read, so this list says nothing about them:",
    );
  });

  it("can be read again from the palette, which otherwise reads them once", () => {
    const at = CANVAS.indexOf("{componentsError ? (");
    const message = CANVAS.slice(at, CANVAS.indexOf(") : myComponents.length === 0 ? (", at));
    expect(message).toMatch(/onClick=\{\(\) => void loadComponents\(\)\}\s*>\s*Try again/);
  });
});

describe("the component library", () => {
  it("keeps the error and shows no list behind it", () => {
    const load = between(LIBRARY, "const load = useCallback(", "}, []);");
    expect(load).toContain("setLoadError(error ? error.message : null);");
    expect(load).toMatch(/setList\(error \? \[\] :/);
    const at = LIBRARY.indexOf("{loadError ? (");
    expect(at).toBeGreaterThan(0);
    expect(LIBRARY.indexOf("No components yet.", at)).toBeGreaterThan(at);
    expect(LIBRARY.slice(at, at + 300)).toContain(
      "Your components could not be read, so this list says nothing about them:",
    );
  });
});

describe("the version history", () => {
  it("keeps the error and shows no list behind it", () => {
    const load = between(VERSIONS, "const load = useCallback(", "}, [swarmId]);");
    expect(load).toContain("setLoadError(error ? error.message : null);");
    expect(load).toMatch(/setVersions\(error \? \[\] :/);
    const at = VERSIONS.indexOf(") : loadError ? (");
    expect(at).toBeGreaterThan(0);
    expect(VERSIONS.indexOf("No versions yet", at)).toBeGreaterThan(at);
    expect(VERSIONS.slice(at, at + 300)).toContain(
      "The versions could not be read, so this list says nothing about them:",
    );
  });
});
