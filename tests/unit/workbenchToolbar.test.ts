// The SQL Workbench toolbar layout.
//
// RUN QUERY WAS UNCLICKABLE ON A 1366x768 LAPTOP. The editor toolbar is a
// `justify-between` flex row with two groups. A flex item defaults to
// `min-width: auto`, so neither group would shrink, and the right-hand group —
// source select (192px) + Format (94px) + Run Query (115px) = 413px — kept its
// full width inside an editor column that is only 310px at a 1238px viewport.
// With `overflow: visible` it painted past the column and under the AI panel,
// which comes later in the DOM and so painted on top. Measured in the browser:
//
//     viewport 1238 -> column 310, toolbar 413, Run Query occluded by "SQL Chat"
//     viewport 1366 -> column 438, toolbar 413, still occluded
//     viewport 1700 -> column 772, fine
//
// The primary action of the workbench could not be clicked at any width below
// roughly 1340px. tsc, 1,292 unit tests and a production build all passed
// throughout: nothing but a real browser was ever going to catch it.
//
// WHAT THIS TEST CAN AND CANNOT DO. There is no DOM renderer in this suite, so
// it pins the CLASSES that produce the layout rather than the geometry. That is
// weaker than a visual check and it is deliberate: the alternative is no
// regression cover at all on a fault that shipped unnoticed. The geometry was
// verified by hand at 1100, 1238, 1366 and 1700.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/routes/_authenticated/data-sql.tsx", "utf8");

/** The toolbar row: from the SQL Editor header to the end of its button group. */
function toolbar(): string {
  const start = src.indexOf("flex flex-wrap items-center justify-between");
  expect(start, "the SQL editor toolbar row was not found").toBeGreaterThan(0);
  const end = src.indexOf("Run Query", start);
  expect(end, "Run Query is not inside the toolbar row").toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("the editor toolbar can shrink instead of overflowing", () => {
  it("wraps rather than overflowing its column", () => {
    expect(toolbar(), "toolbar row does not wrap").toContain("flex-wrap");
  });

  it("lets the left group shrink so the dataset badge truncates", () => {
    // Without min-w-0 a flex item will not go below its content width.
    expect(toolbar()).toMatch(/flex items-center gap-2 min-w-0/);
  });

  it("does NOT pin the button group at its natural width", () => {
    // `shrink-0` on the right group is what defeated wrapping the row: a
    // single flex item cannot be split, so the group overflowed as one piece
    // even with flex-wrap on its parent. This is the assertion that would have
    // caught the half-fix I shipped first.
    expect(toolbar(), "the button group is pinned with shrink-0 again").not.toMatch(
      /flex shrink-0 items-center gap-1\.5/,
    );
  });

  it("wraps inside the button group too", () => {
    expect(toolbar()).toMatch(/flex min-w-0 flex-wrap items-center justify-end gap-1\.5/);
  });

  it("lets the source select shrink instead of taking half the column", () => {
    // It was 192px of a 310px column on its own.
    const trigger = src.slice(src.indexOf("SelectTrigger", src.indexOf("flex min-w-0 flex-wrap")));
    expect(trigger.slice(0, 120)).toMatch(/min-w-0/);
    expect(trigger.slice(0, 120)).toMatch(/max-w-full/);
  });
});
