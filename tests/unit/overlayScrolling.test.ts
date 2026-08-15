// Overlays you can actually reach the bottom of.
//
// Two bugs lived here for a long time because both are invisible on a large
// monitor and fatal on a laptop:
//
//   1. DialogContent had no max-height and no overflow. It is centred with
//      translate-y-[-50%], so a tall form grew off BOTH edges at once and
//      nothing scrolled — the submit button could not be reached at all.
//   2. A Popover inside a Dialog portalled to <body>, which puts it outside
//      the subtree Radix's scroll lock (react-remove-scroll) allows wheel
//      events in. The list had correct overflow CSS and could be dragged by
//      its scrollbar; the mouse wheel was cancelled one level up. Measured on
//      the model picker: wheel events arrived with defaultPrevented = true
//      while programmatic scrollTop worked fine.
//
// These are structural invariants of two shared primitives — 73 dialogs and
// every popover in the app depend on them — so they are pinned by reading the
// primitives rather than by mounting one consumer and hoping.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const DIALOG = readFileSync("src/components/ui/dialog.tsx", "utf8");
const POPOVER = readFileSync("src/components/ui/popover.tsx", "utf8");
const BI_DASHBOARD = readFileSync("src/routes/_authenticated/bi_.$dashboardId.tsx", "utf8");

/** The single className string DialogContent applies to every dialog. */
const dialogBaseClasses = (): string => {
  const m = /"fixed left-\[50%\][^"]*"/.exec(DIALOG);
  if (!m) throw new Error("DialogContent base classes not found — did the primitive change shape?");
  return m[0];
};

describe("every dialog can be scrolled to its last field", () => {
  it("bounds its height", () => {
    // Without this a 966px form on a 560px screen renders from -203 to 763:
    // the header AND the submit button are both off-screen simultaneously.
    expect(dialogBaseClasses()).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
  });

  it("scrolls its own overflow", () => {
    // A height bound with no overflow just clips the form instead.
    expect(dialogBaseClasses()).toContain("overflow-y-auto");
  });

  it("uses dvh, not vh", () => {
    // On mobile, vh counts the area behind the browser's own chrome, so the
    // last field sits underneath the toolbar and cannot be tapped.
    expect(dialogBaseClasses()).not.toMatch(/max-h-\[calc\(100vh/);
  });

  it("keeps the centring that makes the bound necessary", () => {
    // If this ever changes to a top-anchored dialog the max-height is still
    // right, but the reasoning above stops applying — worth noticing.
    expect(dialogBaseClasses()).toContain("translate-y-[-50%]");
  });
});

describe("a popover inside a dialog stays scrollable by mouse", () => {
  it("portals into the open dialog when there is one", () => {
    expect(POPOVER).toContain('[role="dialog"][data-state="open"]');
    expect(POPOVER).toMatch(/<PopoverPrimitive\.Portal container=\{container \?\? undefined\}>/);
  });

  it("resolves the container AFTER commit, not during render", () => {
    // The first version of this fix read the DOM in a useState initialiser.
    // A dialog and the popover inside it mount in the same React pass, so
    // during the render phase the dialog's node does not exist yet and the
    // query always returned null — the fix shipped and did nothing. Measured,
    // not assumed: the popper's parentElement was still BODY afterwards.
    expect(POPOVER).toContain("useLayoutEffect");
    expect(POPOVER).not.toMatch(/useState<HTMLElement \| null>\(\(\) =>/);
  });

  it("still portals to body outside a dialog", () => {
    // `container={undefined}` is Radix's default. Popovers on ordinary pages
    // must not change behaviour just because dialogs needed a fix.
    expect(POPOVER).toContain("container ?? undefined");
  });
});

describe("the BI dashboard toolbar reaches its last action", () => {
  // Same species of bug as the two above: a control that exists, is enabled,
  // and cannot be reached. The toolbar ROW already wrapped, which hid the
  // problem — the twelve action buttons sat inside one `ml-auto` flex item, so
  // they formed a single unbreakable line that overflowed instead. Measured at
  // 1000px wide before the fix: Scan, Theme, History, Export PDF and Publish &
  // share were all off-screen, so a dashboard could not be published at all on
  // a laptop.

  /** The action group's className, as one string. */
  const actionGroupClasses = (): string => {
    const m = /className="ml-auto flex[^"]*"/.exec(BI_DASHBOARD);
    if (!m) throw new Error("BI toolbar action group not found — did it change shape?");
    return m[0];
  };

  it("lets the action group wrap", () => {
    expect(actionGroupClasses()).toContain("flex-wrap");
  });

  it("keeps wrapped rows aligned to the right edge", () => {
    // Without this a second row starts at the left of the group's box, which
    // reads as a separate unrelated toolbar rather than a continuation.
    expect(actionGroupClasses()).toContain("justify-end");
  });

  it("gives wrapped rows vertical breathing room", () => {
    // gap-0.5 alone is a horizontal gap; wrapped rows would otherwise touch.
    expect(actionGroupClasses()).toMatch(/gap-y-/);
  });
});
