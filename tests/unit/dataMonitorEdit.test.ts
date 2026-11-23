// A data monitor can be changed after it is made (found in the R525 UI test:
// a check reading the wrong column could only be deleted and made again).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const page = readFileSync("src/routes/_authenticated/data-monitors.tsx", "utf8");

describe("editing a data monitor", () => {
  it("each row has an Edit button with a name", () => {
    expect(page).toContain("aria-label={`Edit ${m.name}`}");
    expect(page).toContain("onClick={() => setEditing(m)}");
  });

  it("saves through the update, not by making a second monitor", () => {
    expect(page).toMatch(
      /onSave=\{async \(id, input\) => \{\s+const r = await updateFn\(\{ data: \{ access_token: token, id, \.\.\.input \} \}\);/,
    );
    expect(page).toMatch(/if \(editing && onSave\) \{[\s\S]*?await onSave\(editing\.id, \{/);
  });

  it("keeps the table and the kind of check, and says so", () => {
    for (const control of [
      "value={sourceKind}",
      "value={lakeTable}",
      "value={warehouseId}",
      "value={schema}",
      "value={table}",
    ]) {
      const at = page.indexOf(control);
      expect(page.slice(at, at + 120)).toContain("disabled={!!editing}");
    }
    expect(page).toContain("disabled={!!editing && editing.kind !== k}");
    expect(page).toContain("The table and the kind of check stay.");
  });

  // Found in the UI test: a freshness check on a text column opened with
  // "Pick a column…" showing, while the text column still sat in state and
  // would have saved again unseen.
  it("shows the column it reads when the list does not offer it", () => {
    expect(page).toMatch(
      /const strayColumn =\s+editing && column && columnOptions\.length && !offeredColumns\.some\(\(c\) => c\.name === column\)/,
    );
    expect(page).toContain("<option value={column}>");
    expect(page).toContain("not a time. Pick a timestamp column.");
    expect(page).toContain("which this table no longer has. Pick a column.");
  });

  it("fills every field from the monitor and hides Run once now", () => {
    expect(page).toContain('setColumn(c.column ?? (c.columns ?? []).join(", "));');
    expect(page).toContain("setSchedule(editing.schedule as");
    expect(page).toContain('className={editing ? "hidden" : "flex items-center gap-2 text-sm"}');
    expect(page).toContain('{editing ? "Save changes" : "Create monitor"}');
  });
});
