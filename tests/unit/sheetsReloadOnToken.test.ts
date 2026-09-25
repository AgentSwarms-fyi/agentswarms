// R120: the session's access token changes on every refresh (about hourly).
// The workbook page used to reload the workbook whenever it changed, which
// rebuilt the editor from the saved copy: an edit not yet saved vanished,
// and the save already queued then wrote the older state back. The page
// loads once per workbook and reads the token when it calls the server.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const route = readFileSync(
  resolve(__dirname, "../../src/routes/_authenticated/sheets_.$workbookId.tsx"),
  "utf8",
);

/** The dependency list of the page's `load` callback. */
function loadDeps(src: string): string[] {
  const start = src.indexOf("const load = useCallback(");
  expect(start).toBeGreaterThan(-1);
  // The callback ends at the first "}, [" after it opens; its deps follow.
  const close = src.indexOf("}, [", start);
  const end = src.indexOf("]);", close);
  return src
    .slice(close + 4, end)
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

describe("the workbook page and the session token", () => {
  it("does not reload the workbook when the token refreshes", () => {
    const deps = loadDeps(route);
    expect(deps).not.toContain("token");
    expect(deps).toContain("workbookId");
  });

  it("still reads the current token for each call", () => {
    const body = route.slice(route.indexOf("const load = useCallback("));
    expect(body.slice(0, body.indexOf("}, ["))).toMatch(/const token = tokenRef\.current;/);
  });
});
