// Approving an MCP server's tool list has to approve the list that was READ.
//
// A tool description is an instruction the calling model obeys, which is the
// whole reason a changed one parks the server until a human looks. The gate at
// the edge is a timestamp comparison:
//
//   blocked while tools_changed_at > tools_approved_at
//
// so "approve" meant "stamp tools_approved_at = now", and now is always later
// than any change that already landed. That leaves a window:
//
//   1. owner opens the diff and reads tool list A
//   2. a deploy lands; tools become list B; tools_changed_at moves
//   3. owner clicks Approve; tools_approved_at > tools_changed_at
//   4. list B is approved and nobody read it
//
// An approval that can attach to an unseen list is not the control it claims
// to be. It is now bound to the fingerprint the review actually rendered.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/utils/mcpApps.functions.ts", "utf8");
const FN = SRC.slice(
  SRC.indexOf("export const mcpAppApproveTools"),
  SRC.indexOf("export const mcpAppTest"),
);

describe("the approval is bound to the reviewed fingerprint", () => {
  it("accepts the fingerprint the reviewer saw", () => {
    expect(FN, "approval still takes only an id").toMatch(/tools_hash:\s*z\.string\(\)/);
  });

  it("refuses when the stored fingerprint has moved on", () => {
    // The comparison itself — not merely accepting the parameter, which an
    // earlier draft did while ignoring it.
    expect(FN).toMatch(/owned\.app\.tools_hash !== data\.tools_hash/);
    const branch = FN.slice(FN.indexOf("owned.app.tools_hash !== data.tools_hash"));
    expect(branch.slice(0, branch.indexOf("}"))).toMatch(/ok: false/);
  });

  it("narrows the write by fingerprint as well", () => {
    // Closes the gap between reading the row and updating it: a deploy landing
    // in between must lose the race rather than win it silently.
    const update = FN.slice(FN.indexOf(".update({ tools_approved_at"));
    expect(update).toMatch(/\.eq\("tools_hash"/);
  });

  it("records what was approved", () => {
    // "Tools approved" with no fingerprint cannot answer "approved WHAT".
    expect(FN).toMatch(/detail: \{ tools_hash/);
  });
});

describe("the fingerprint reaches the reviewer in the first place", () => {
  it("is selected by the read path", () => {
    // The UI can only send back a fingerprint it was given. Omitting the
    // column would make every approval fall through to the unbound path with
    // no error anywhere — the check would still be present and never fire.
    const cols = SRC.slice(SRC.indexOf("const LIST_COLUMNS"), SRC.indexOf("/** Fetch one app"));
    expect(cols, "tools_hash is not selected").toContain("tools_hash");
  });

  it("is on the type the UI consumes", () => {
    const type = SRC.slice(
      SRC.indexOf("export type McpAppSummary"),
      SRC.indexOf("const LIST_COLUMNS"),
    );
    expect(type).toMatch(/tools_hash: string \| null/);
  });

  it("is sent by the approve button", () => {
    const ui = readFileSync("src/routes/_authenticated/mcp-builder_.$appId.tsx", "utf8");
    const call = ui.slice(ui.indexOf("approveFn({"), ui.indexOf("approveFn({") + 260);
    expect(call, "the button still approves by id alone").toContain("tools_hash");
  });
});

describe("the gate this protects still works the way it is described", () => {
  const edge = readFileSync("src/routes/api/mcp.s.$slug.ts", "utf8");

  it("blocks calls while the change is newer than the approval", () => {
    expect(edge).toMatch(
      /new Date\(app\.tools_changed_at\)\.getTime\(\) > new Date\(app\.tools_approved_at\)\.getTime\(\)/,
    );
    expect(edge).toContain("tools_changed");
  });

  it("treats a never-approved change as blocking", () => {
    expect(edge).toMatch(/if \(!app\.tools_approved_at\) return true/);
  });

  it("does not block an app that has never changed", () => {
    // A first deploy must not open with a re-approval banner, or owners learn
    // to click it without reading.
    expect(edge).toMatch(/if \(!app\.tools_changed_at\) return false/);
  });
});
