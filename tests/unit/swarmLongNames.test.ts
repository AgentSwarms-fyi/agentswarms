// A long agent name on the swarm canvas is cut, never stretched to fit.
//
// Importing an agent from the library into a node copies its name (up to 120
// characters) onto the node. The node had a minimum width and no maximum, so it
// grew as wide as the name, over its neighbours and off the canvas; its
// `truncate` did nothing, because nothing bounded the box. The library picker's
// list was as wide as its longest name the same way, past the inspector and off
// the screen.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const canvas = readFileSync("src/routes/_authenticated/swarms.tsx", "utf8");
const inspector = readFileSync("src/components/swarms/NodeInspector.tsx", "utf8");

describe("a canvas node", () => {
  const shell = canvas.slice(
    canvas.indexOf("function nodeShellClass("),
    canvas.indexOf("if (status ===", canvas.indexOf("function nodeShellClass(")),
  );

  it("has a maximum width, so its name is cut rather than the node stretched", () => {
    expect(shell).toMatch(/min-w-\[180px\] max-w-\[260px\]/);
  });

  it("cuts its name and model and shows them whole on hover", () => {
    expect(canvas).toMatch(
      /<p className="text-sm font-semibold truncate" title=\{data\.label\}>\s*\{data\.label\}/,
    );
    expect(canvas).toMatch(/truncate font-mono" title=\{data\.model\}>\s*\{data\.model\}/);
  });
});

describe("the inspector's agent library picker", () => {
  const picker = inspector.slice(
    inspector.indexOf('<Section label="Import from agent library">'),
    inspector.indexOf("Copies prompt, model, tools"),
  );

  it("bounds its list and cuts each name, with the whole name on hover", () => {
    expect(picker).toContain('<SelectContent className="max-w-80">');
    expect(picker).toContain("<SelectItem key={a.id} value={a.id} title={a.name}>");
    expect(picker).toContain('<span className="block max-w-60 truncate">{a.name}</span>');
  });
});
