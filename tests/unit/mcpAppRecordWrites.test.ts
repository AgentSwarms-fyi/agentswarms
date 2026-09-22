// The MCP app's records: the status MCP Builder shows, the tools agents
// call, the logs an error tells the owner to read, and the version history a
// rollback needs — each write now reads its answer.
//
// FOUND FROM THE SURVEY (R89). service.server.ts had five writes that dropped
// theirs, and the status one is written by every path that ends a start.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/mcpApps/service.server.ts", "utf8");
const between = (start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const setAppStatus = between(
  "async function setAppStatus(",
  "/**\n * Outcome of waiting on a sandbox.",
);
const touch = between(
  "async function touch(sessionId: string)",
  "Endpoint of an ALREADY-running sandbox",
);
const persistLogs = between("async function persistLogs(", "First Python error line in a log blob");
const deploy = between(
  "export async function deploy(app: McpAppRow)",
  "/** Append an immutable version row",
);
const snapshot = src.slice(src.indexOf("async function snapshotVersion("));

describe("an MCP app's status", () => {
  it("reads the answer of the write MCP Builder shows", () => {
    expect(setAppStatus).toContain("const { error } = await supabaseAdmin");
    expect(setAppStatus).toContain("MCP Builder will show what it showed before");
  });
});

describe("a deploy", () => {
  it("does not answer ok when the tools could not be recorded", () => {
    expect(deploy).toContain("const { error: recordErr } = await supabaseAdmin");
    expect(deploy).toContain("Agents keep calling the previous tool list until they are");
    expect(deploy.indexOf("if (recordErr) {")).toBeLessThan(
      deploy.indexOf("await snapshotVersion(app, shook.tools);"),
    );
  });

  it("says when the version history could not take it", () => {
    expect(snapshot).toContain(
      'const { error } = await supabaseAdmin.from("mcp_app_versions").insert({',
    );
    expect(snapshot).toContain("this deploy cannot be rolled back to");
  });
});

describe("a running MCP server", () => {
  it("says when its use could not be recorded, for the reaper's sake", () => {
    expect(touch).toContain("const { error } = await supabaseAdmin");
    expect(touch).toContain("the idle reaper reads what was recorded");
  });

  it("says when the logs its error message points at could not be saved", () => {
    expect(persistLogs).toContain("const { error } = await supabaseAdmin");
    expect(persistLogs).toContain("the Logs tab will be empty for this attempt");
  });
});
