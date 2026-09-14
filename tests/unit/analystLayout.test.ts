// The AI Analyst page at a narrow window.
//
// Measured live (the user's screenshot, and reproduced at 1000px): the analyst
// rail kept its 256px, the header's six actions never wrapped, so the page
// container — which hides overflow so the transcript can scroll inside a
// pinned height — grew to 1173px of content in 744px of room, and focusing
// the question box scrolled the rail clean out of view. The fix is CSS, so
// the test reads the classes: the header wraps and its labels go icon-only
// below lg, the rail narrows below lg, and on a phone it hides behind a
// button rather than squeezing the thread to nothing.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const route = readFileSync("src/routes/_authenticated/ai-analyst.tsx", "utf8");

describe("the analyst page at a narrow window", () => {
  it("wraps the header and shrinks the title input below lg", () => {
    expect(route).toContain(
      'className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2 md:px-4"',
    );
    expect(route).toContain(
      "h-7 w-40 min-w-0 border-transparent bg-transparent px-1 text-sm font-semibold focus-visible:border-input lg:w-56",
    );
    expect(route).toContain('<div className="ml-auto flex flex-wrap items-center gap-1.5">');
  });

  it("keeps every action reachable as an icon with a title, and shows the label only from lg", () => {
    for (const label of ["New analysis", "Schedule", "Export data", "Save as PDF"]) {
      expect(route).toContain(`<span className="hidden lg:inline">${label}</span>`);
    }
    expect(route).toContain('title="Start a fresh analysis thread"');
    expect(route).toContain('title="Save this analysis as a PDF"');
  });

  it("narrows the rail below lg and hides it behind a button on a phone", () => {
    expect(route).toContain("shrink-0 flex-col border-r border-border md:flex md:w-56 lg:w-64");
    expect(route).toContain('${railOpen ? "flex w-full" : "hidden"}');
    expect(route).toContain('${railOpen ? "hidden md:flex" : "flex"} min-w-0 flex-1 flex-col');
    expect(route).toContain('aria-label="Show analysts"');
    expect(route).toContain('className="h-7 px-2 md:hidden"');
    // Picking an analyst closes the rail again on a phone.
    expect(route).toContain("setSelectedId(a.id);\n                    setRailOpen(false);");
  });

  it("drops the model badge and the source label first, never the actions", () => {
    expect(route).toContain(
      'className="hidden max-w-48 truncate font-mono text-[10px] sm:inline-flex"',
    );
    expect(route).toContain(
      'className="hidden min-w-0 truncate text-[11px] text-muted-foreground xl:inline"',
    );
    expect(route).toContain('className="h-7 max-w-36 gap-1 text-xs lg:max-w-52"');
  });

  it("the analyst just created carries its owner, so its controls show without a reload", () => {
    expect(route).toContain(
      '.select("id, name, model, source, ml_model_names, created_at, user_id")\n      .single();',
    );
  });
});
