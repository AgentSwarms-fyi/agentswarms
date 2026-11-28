// A connection's name (the label on the line between two nodes) holds at most
// 20 characters. It had no limit: any length was drawn on the line across the
// canvas, over the nodes, and offered whole to a Router's model as a route.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { EDGE_LABEL_MAX_LENGTH, edgeLabelProblem } from "@/lib/edgeLabel";
import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";

describe("a connection's name", () => {
  it("holds at most 20 characters, counted as you see them", () => {
    expect(EDGE_LABEL_MAX_LENGTH).toBe(20);
    expect(edgeLabelProblem("b".repeat(20))).toBeNull();
    expect(edgeLabelProblem("b".repeat(21))).toBe(
      "A connection's name holds at most 20 characters.",
    );
    expect(edgeLabelProblem("🙂".repeat(20))).toBeNull();
  });

  it("is measured without the spaces around it, and may be empty (no name)", () => {
    expect(edgeLabelProblem(`  ${"b".repeat(20)}  `)).toBeNull();
    expect(edgeLabelProblem("")).toBeNull();
  });

  it("is within the limit on every built-in template", () => {
    for (const t of SWARM_TEMPLATES) {
      for (const e of t.edges) {
        if (typeof e.label === "string") expect(edgeLabelProblem(e.label), t.id).toBeNull();
      }
    }
  });
});

describe("the edit dialog", () => {
  const canvas = readFileSync("src/routes/_authenticated/swarms.tsx", "utf8");
  const dialog = canvas.slice(
    canvas.indexOf("<DialogTitle>Edit edge label</DialogTitle>"),
    canvas.indexOf("</Dialog>", canvas.indexOf("<DialogTitle>Edit edge label</DialogTitle>")),
  );
  const commit = canvas.slice(
    canvas.indexOf("const commitEdgeLabel = useCallback("),
    canvas.indexOf("}, [edgeLabelTarget, setEdges]);"),
  );

  it("stops typing at the limit and counts what is typed", () => {
    expect(dialog).toContain("maxLength={EDGE_LABEL_MAX_LENGTH}");
    expect(dialog).toContain("/{EDGE_LABEL_MAX_LENGTH}");
  });

  it("will not save a name over the limit (one saved before it), by button or Enter", () => {
    expect(dialog).toMatch(/disabled=\{!!edgeLabelProblem\(edgeLabelTarget\?\.value \?\? ""\)\}/);
    expect(commit).toContain("if (edgeLabelProblem(edgeLabelTarget.value)) return;");
    expect(dialog).toContain("commitEdgeLabel();");
  });

  it("says why, rather than cutting the name and renaming a route without saying so", () => {
    expect(dialog).toContain("Shorten it to save.");
    expect(commit).not.toMatch(/slice\(0, EDGE_LABEL_MAX_LENGTH\)|clampName/);
  });
});
