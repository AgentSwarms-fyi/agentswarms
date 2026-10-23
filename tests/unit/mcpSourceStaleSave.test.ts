// Two tabs on one MCP server's source (R290, sweep 9). The editor autosaves
// the source and packages over whatever is stored, so a second tab's autosave
// undid lines the first had saved. Deploys, the idle reaper and tool approval
// write the row too, so the save compares a fingerprint of the stored source
// with the one the editor read. The projection is tested as a function; the
// wiring is pinned by reading the server function and the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fingerprintOf } from "@/lib/definitionFingerprint";
import { mcpSourceDefinition } from "@/lib/mcpSource";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const server = read("src/utils/mcpApps.functions.ts");
const page = read("src/routes/_authenticated/mcp-builder_.$appId.tsx");

describe("mcpSourceDefinition", () => {
  it("is the source and packages only, blank for missing", async () => {
    expect(mcpSourceDefinition({ source_code: null, requirements: undefined })).toEqual({
      source_code: "",
      requirements: "",
    });
    const row = { source_code: "import x", requirements: "", status: "ready", updated_at: "t" };
    expect(await fingerprintOf(mcpSourceDefinition(row))).toBe(
      await fingerprintOf(mcpSourceDefinition({ source_code: "import x", requirements: "" })),
    );
    expect(await fingerprintOf(mcpSourceDefinition({ ...row, source_code: "import y" }))).not.toBe(
      await fingerprintOf(mcpSourceDefinition(row)),
    );
  });
});

describe("mcpAppSave", () => {
  it("never writes the fingerprint into the row", () => {
    expect(server).toContain(
      "const { id, expected_source_fingerprint: expected, overwrite, ...patch } = data;",
    );
  });

  it("refuses a save whose stored source moved on, before writing", () => {
    expect(server).toMatch(
      /if \(\(await fingerprintOf\(mcpSourceDefinition\(owned\.app\)\)\) !== expected\) \{\s*return \{\s*ok: false,\s*stale: true,/,
    );
  });

  it("lands only on the row it read", () => {
    expect(server).toMatch(
      /\.update\(patch\)\s*\.eq\("id", id\)\s*\.eq\("updated_at", owned\.app\.updated_at\)\s*\.select\("id"\)\s*\.maybeSingle\(\);/,
    );
  });
});

describe("the MCP builder editor", () => {
  it("sends the fingerprint of the source it read or last saved, unless overwriting", () => {
    expect(page).toMatch(
      /const expected =\s*overwrite \|\| !base\s*\? undefined\s*: await fingerprintOf\(\s*mcpSourceDefinition\(\{ source_code: base\.source, requirements: base\.requirements \}\),?\s*\);/,
    );
    expect(page).toContain("expected_source_fingerprint: expected");
    expect(page).toMatch(
      /if \(!res\.ok\) \{\s*if \(res\.stale\) setStale\(true\);\s*return res\.error;\s*\}/,
    );
  });

  it("stops autosaving once stale, and starts again after a reload", () => {
    expect(page).toContain("if (!unsaved || stale) return;");
    expect(page).toMatch(/setSavedAs\(JSON\.stringify\(adopted\)\);\s*setStale\(false\);/);
  });

  it("overwrites even when the editor matches what it opened", () => {
    expect(page).toContain("if (!unsaved && !overwrite) return null;");
  });

  it("says so, with Reload and Overwrite with mine", () => {
    expect(page).toMatch(/\{stale && \(\s*<span[^>]*data-testid="mcp-stale"/);
    expect(page).toContain("onClick={() => void reload(true)}");
    expect(page).toMatch(/void saveNow\(true\)\.then\(/);
  });
});
