// Diagram SVG is assembled by string concatenation from a model-authored plan.
//
// The audit question was whether any model-supplied string reaches markup
// unescaped. Answer: no. Every text node goes through esc(), and the only
// unescaped element content in the file is a loop index. Colours are the
// interesting case — they land in attributes raw (`fill="${color}"`), and a
// value carrying a quote would close the attribute and open another.
//
// Model-supplied colours were already safe, because build.ts runs plan.accent
// through normalizeHex (strict 6-hex-or-fallback) before it ever gets here.
// But diagramToSvg is EXPORTED and takes colours as an argument, so that
// safety was a property of the caller. hx() now validates, so it is a property
// of the function.
import { describe, expect, it } from "vitest";

import { diagramToSvg, type DiagramColors } from "@/lib/docGen/diagramSvg";

const GOOD: DiagramColors = {
  palette: ["4F46E5", "0EA5E9", "10B981"],
  ink: "0F172A",
  sub: "64748B",
  card: "FFFFFF",
  border: "E7EBF0",
  accent: "4F46E5",
};

/** A process diagram whose every string field is hostile. */
const HOSTILE = {
  kind: "process" as const,
  steps: [
    { title: '"><script>alert(1)</script>', body: "</text><script>alert(2)</script>" },
    { title: "Tom & Jerry <3", body: "a > b && c < d" },
  ],
};

describe("model text cannot break out of the markup", () => {
  const svg = diagramToSvg(HOSTILE as never, GOOD);

  it("produced a diagram at all", () => {
    // A guard that renders nothing would pass every assertion below.
    expect(svg).toContain("<svg");
    expect(svg.length).toBeGreaterThan(200);
  });

  it("emits no script element", () => {
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("</script>");
  });

  it("escapes the angle brackets and ampersands it was given", () => {
    expect(svg).toContain("&lt;");
    expect(svg).toContain("&amp;");
    // The raw sequence would mean a text node was closed early.
    expect(svg).not.toContain("</text><script");
  });

  it("does not let a title close an attribute", () => {
    expect(svg).not.toMatch(/"><script/);
  });
});

describe("a colour cannot inject, whoever passes it", () => {
  const inject = (c: Partial<DiagramColors>) =>
    diagramToSvg({ kind: "process", steps: [{ title: "A", body: "b" }] } as never, {
      ...GOOD,
      ...c,
    });

  it("rejects a colour carrying a quote and an event handler", () => {
    const svg = inject({ ink: 'fff" onload="alert(1)' });
    expect(svg, "an attribute was closed by a colour").not.toContain("onload");
    expect(svg).toContain("#000000");
  });

  it("rejects a colour from the palette array too", () => {
    // The palette is mapped through the same helper; a per-item miss would
    // only show up on whichever element happens to use that index.
    const svg = inject({ palette: ['aaa" onmouseover="x', "0EA5E9", "10B981"] });
    expect(svg).not.toContain("onmouseover");
  });

  it("still renders the valid colours it is given", () => {
    // Fail-safe must not mean fail-always: a correct colour has to survive,
    // or the fallback would have silently blackened every diagram.
    const svg = inject({});
    expect(svg).toContain("#0F172A");
    expect(svg).not.toContain("#000000");
  });

  it("accepts a leading # and normalises case", () => {
    const svg = inject({ ink: "#0f172a" });
    expect(svg.toLowerCase()).toContain("#0f172a");
    expect(svg).not.toContain("##");
  });
});
