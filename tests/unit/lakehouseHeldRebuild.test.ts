// A materialized view Sheets holds (R274): the Lakehouse offered Rebuild,
// which the server always refuses ("… only Sheets changes it"). The button is
// off for a held view now and says why before it is pressed — on a wrapper,
// because a disabled button takes no pointer and its own title never shows.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "src/routes/_authenticated/lakehouse.tsx"), "utf8");
const at = src.indexOf("{matview?.is_owner && (");
const block = src.slice(at, src.indexOf("Rebuild\n", at));

describe("Rebuild on a held view", () => {
  it("is off while Sheets holds the table", () => {
    expect(block).toContain("disabled={refreshingMv || !!detail.sheet_owner}");
  });

  it("says why on a wrapper that takes the pointer, not on the disabled button", () => {
    const wrapper = block.indexOf("<span");
    const button = block.indexOf("<Button");
    expect(wrapper).toBeGreaterThan(-1);
    expect(wrapper).toBeLessThan(button);
    const reason = block.slice(wrapper, button);
    // Given when the table is held, not merely written somewhere.
    expect(reason).toMatch(/title=\{\s*detail\.sheet_owner\s*\?\s*`Held by Sheets:/);
    expect(reason).toContain("Held by Sheets: only Sheets changes ${schema}.${table}");
    expect(reason).toContain('Delete the sheet "${detail.sheet_owner.sheet}" in Sheets');
    // The button itself carries no title of its own.
    expect(block.slice(button)).not.toMatch(/\btitle=/);
  });

  it("still says when an ordinary view was last rebuilt", () => {
    expect(block).toContain(
      "`Last rebuilt ${new Date(matview.last_refreshed_at).toLocaleString()}`",
    );
  });
});
