// "Not found" only when the read worked and found nothing.
//
// FOUND IN R256, the last unread name in the sweep-6 notes
// (mcpApps.functions.ts:69). ownedApp starts twelve MCP Builder actions -
// deploy, stop, delete, save, approve tools - and answered a failed read with
// "MCP server not found" about a server that was there. Restoring a version did
// the same with "Version not found". Both refused, which was right; both said
// why wrongly, which sends the reader looking for a deletion that never
// happened.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/utils/mcpApps.functions.ts", "utf8");

describe("mcpApps.functions", () => {
  it("drops no read error anywhere in the file", () => {
    const dropped = [...SRC.matchAll(/const \{ data(?::\s*\w+)? \} = await/g)].map((m) => m[0]);
    // Was 2 on 2026-10-04: ownedApp and mcpAppRestoreVersion.
    expect(dropped).toEqual([]);
  });

  it("says a failed read could not be read before it says not found", () => {
    const owned = SRC.slice(SRC.indexOf("async function ownedApp"));
    const body = owned.slice(0, owned.indexOf("\n}\n"));
    const check = body.indexOf(
      "if (error) return { ok: false, error: `Could not read the MCP server",
    );
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf('"MCP server not found"'));

    const restore = SRC.slice(SRC.indexOf("export const mcpAppRestoreVersion"));
    const vcheck = restore.indexOf("if (versionErr) {");
    expect(vcheck).toBeGreaterThan(-1);
    expect(vcheck).toBeLessThan(restore.indexOf('"Version not found"'));
  });
});
