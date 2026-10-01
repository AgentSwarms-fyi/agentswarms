// Data Prep's "Save as" says what is known about the lakehouse (R204).
//
// FOUND IN R204, driven in BI → Data preparation with the lakehouse-tables
// call held back and then failed: while it loaded, and after it failed, the
// "Save as" select's title said "The lakehouse is not configured on this
// deployment", on a deployment whose lakehouse works; the failed read said
// only "Could not list lakehouse tables.", without the reason or a way to try
// again (the Reload button reloaded local datasets only).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { lakeStateOf, saveAsHint } from "@/lib/prepSaveAs";

describe("saveAsHint", () => {
  it("says not configured only when the lakehouse is not configured", () => {
    expect(saveAsHint("off")).toBe("The lakehouse is not configured on this deployment");
    expect(saveAsHint("loading")).toBe("Checking the lakehouse…");
    expect(saveAsHint("error", "catalog unreachable")).toBe(
      "The lakehouse tables could not be read: catalog unreachable. A local dataset can still be saved.",
    );
    expect(saveAsHint("error")).toBe(
      "The lakehouse tables could not be read. A local dataset can still be saved.",
    );
    expect(saveAsHint("on")).toMatch(/^A dataset lives in the workspace/);
  });

  it("reads the component's state", () => {
    expect(lakeStateOf(null)).toBe("loading");
    expect(lakeStateOf("error")).toBe("error");
    expect(lakeStateOf({ enabled: false })).toBe("off");
    expect(lakeStateOf({ enabled: true })).toBe("on");
  });
});

describe("the Data Prep tab", () => {
  const tab = readFileSync("src/components/bi/DataPrepTab.tsx", "utf8");

  it("titles Save as by the lakehouse's state, not one sentence for three", () => {
    expect(tab).toContain("title={saveAsHint(lakeStateOf(lake), lakeError)}");
    expect(tab).not.toMatch(/\? "The lakehouse is not configured on this deployment"/);
  });

  it("keeps the reason a read failed, and reads again on Try again and Reload", () => {
    expect(tab).toMatch(/setLakeError\(e instanceof Error \? e\.message : String\(e\)\)/);
    expect(tab).toMatch(
      /Could not list lakehouse tables\{lakeError \? `: \$\{lakeError\}` : "\."\}/,
    );
    expect(tab).toMatch(/\[token, lakeTablesFn, lakeAttempt\]\);/);
    expect(tab.match(/setLakeAttempt\(\(n\) => n \+ 1\)/g)?.length).toBe(2);
  });
});
