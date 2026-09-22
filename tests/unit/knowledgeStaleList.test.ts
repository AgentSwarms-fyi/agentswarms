// Knowledge Bases: picking a base clears the previous base's lists, says
// "loading" until this base's read lands, and drops a read that comes back
// for a base no longer selected. A count on a tab is a claim about rows the
// page has read.
//
// FOUND FROM THE UI (R76). The previous base's twelve documents stayed
// listed under the next base's name for the seven seconds its read spent
// failing, and the tab kept "Documents (12)" after it had.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { listCountLabel } from "../../src/lib/listState";

const src = readFileSync("src/routes/_authenticated/knowledge.tsx", "utf8");
const effect = src.slice(
  src.indexOf("  useEffect(() => {\n    if (selectedBase) {"),
  src.indexOf("}, [selectedBase]);"),
);
const loadDocs = src.slice(
  src.indexOf("async function loadDocs("),
  src.indexOf("async function loadChunkCounts("),
);
const loadSources = src.slice(
  src.indexOf("async function loadSources("),
  src.indexOf("async function resyncSource("),
);
const docsPanel = src.slice(
  src.indexOf('<TabsContent value="documents"'),
  src.indexOf('<TabsContent value="sources"'),
);
const sourcesPanel = src.slice(
  src.indexOf('<TabsContent value="sources"'),
  src.indexOf('<TabsContent value="graph"'),
);

describe("listCountLabel", () => {
  it("says what the page has read, not what it held", () => {
    expect(listCountLabel("error", 12)).toBe("?");
    expect(listCountLabel("loading", 0)).toBe("\u2026");
    expect(listCountLabel("list", 12)).toBe("12");
    expect(listCountLabel("empty", 0)).toBe("0");
  });
});

describe("the Knowledge Bases page on a base change", () => {
  it("clears the previous base's lists before reading this one's", () => {
    for (const call of [
      "setDocs([])",
      "setSources([])",
      "setChunkCounts(new Map())",
      "setDocsLoaded(false)",
      "setSourcesLoaded(false)",
    ]) {
      expect(effect).toContain(call);
      expect(effect.indexOf(call)).toBeLessThan(effect.indexOf("loadDocs(selectedBase.id)"));
    }
    expect(effect).toContain("listReq.current += 1;");
  });

  it("drops a read that comes back for a base no longer selected", () => {
    for (const fn of [loadDocs, loadSources]) {
      expect(fn).toContain("const req = listReq.current;");
      expect(fn).toContain("if (req !== listReq.current) return;");
    }
    expect(loadDocs).toContain("setDocsLoaded(true);");
    expect(loadSources).toContain("setSourcesLoaded(true);");
  });

  it("puts the read's state on the tab counts", () => {
    expect(src).toContain("Documents ({listCountLabel(docsState, docs.length)})");
    expect(src).toContain("Sources ({listCountLabel(sourcesState, sources.length)})");
  });

  it("says loading ahead of empty on both panels", () => {
    expect(docsPanel).toContain('docsState === "loading"');
    expect(docsPanel).toContain("Loading documents");
    expect(docsPanel.indexOf('docsState === "loading"')).toBeLessThan(
      docsPanel.indexOf("docs.length === 0 ? ("),
    );
    expect(sourcesPanel).toContain('sourcesState === "loading"');
    expect(sourcesPanel).toContain("Loading sources");
    expect(sourcesPanel.indexOf('sourcesState === "loading"')).toBeLessThan(
      sourcesPanel.indexOf("sources.length === 0 ? ("),
    );
  });
});
