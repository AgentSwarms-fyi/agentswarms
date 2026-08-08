// The ontology graph's fullscreen control.
//
// Reported as "the full screen button does nothing". It was worse than a dead
// handler: the ⛶ Maximize2 glyph — which every user reads as fullscreen — was
// wired to "Fit to view", and the graph already auto-fits on mount and on every
// resize. So on an untouched widget the click was a genuine no-op, and there
// was no fullscreen anywhere.
//
// Two follow-on bugs were found by measuring in the browser rather than by
// reading, and both are pinned here because both are invisible to types.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve("src/components/bi/OntologyGraph.tsx"), "utf8");

describe("fullscreen and fit are separate controls", () => {
  it("has a real fullscreen toggle", () => {
    expect(SRC).toMatch(/title=\{isFull \? "Exit fullscreen \(Esc\)" : "Fullscreen"\}/);
    expect(SRC).toMatch(/setIsFull\(\(v\) => !v\)/);
  });

  it("does not use the fullscreen glyph for 'Fit to view'", () => {
    // The whole bug report. Maximize2 belongs to fullscreen; fit gets Scan.
    const fitBtn = SRC.slice(
      SRC.indexOf("onClick={() => setView(fit)}"),
      SRC.indexOf('title="Fit to view"') + 200,
    );
    expect(fitBtn).toContain("Scan");
    expect(fitBtn).not.toContain("Maximize2");
  });

  it("exits on Escape", () => {
    // The button is not where anyone looks first.
    expect(SRC).toMatch(/if \(e\.key === "Escape"\) setIsFull\(false\)/);
  });
});

describe("fullscreen actually covers the viewport", () => {
  it("renders through a portal on document.body", () => {
    // `position: fixed; inset: 0` resolved against the WIDGET CARD, because the
    // card carries `backdrop-filter: blur(12px)` and a backdrop-filter
    // establishes a containing block for fixed descendants exactly as a
    // transform does. Measured live: 1014x530 at y=1780 inside a 1318x702
    // viewport. A portal is immune to whatever an ancestor is styled with.
    expect(SRC).toContain("createPortal");
    expect(SRC).toMatch(/createPortal\(tree, document\.body\)/);
  });

  it("guards the portal against server rendering", () => {
    expect(SRC).toMatch(/typeof document !== "undefined"/);
  });

  it("re-binds the ResizeObserver when fullscreen toggles", () => {
    // Portalling builds NEW DOM nodes. An observer bound with [] keeps watching
    // the old, detached element — which reports 0x0 — so `size.w` fell to 0,
    // the canvas is gated on `size.w > 0`, and fullscreen rendered a toolbar
    // and legend around an empty rectangle. The graph was blank while every
    // other part of the overlay looked correct.
    const effect = SRC.slice(SRC.indexOf("const ro = new ResizeObserver"));
    const deps = effect.slice(0, effect.indexOf("const fit"));
    expect(deps).toMatch(/\}, \[isFull\]\)/);
  });
});
