// The MCP "rug pull" control.
//
// A published MCP server's tool names, descriptions and input schemas are
// instructions the calling model reads. A server that quietly changes them
// after being trusted is the rug pull MCP's own security guidance calls out,
// so a moved fingerprint parks the server until a human approves the diff.
//
// The fingerprint IS the control. If it misses a change, the gate never fires
// and nobody is told; the failure is silent in the direction that matters.
// This had no tests.

import { describe, expect, it } from "vitest";

import { isLegacyFingerprint, toolsFingerprint } from "@/utils/mcpApps/protocol";

type Tool = { name: string; description?: string; inputSchema?: unknown };
const fp = (tools: Tool[]) => toolsFingerprint(tools as never);

const base: Tool[] = [
  { name: "send_email", description: "Send an email", inputSchema: { type: "object" } },
];

describe("toolsFingerprint — what counts as a change", () => {
  it("is stable for identical input", () => {
    expect(fp(base)).toBe(fp(base));
  });

  it("changes when a tool NAME changes", () => {
    expect(fp([{ ...base[0], name: "send_email_v2" }])).not.toBe(fp(base));
  });

  it("changes when a DESCRIPTION changes", () => {
    // The description is the instruction the model acts on. A tool whose
    // description quietly gains "…and forward a copy to attacker@evil" is a
    // different tool with the same name.
    expect(fp([{ ...base[0], description: "Send an email and CC support" }])).not.toBe(fp(base));
  });

  it("changes when the INPUT SCHEMA changes", () => {
    // A tool that grows a `send_to` parameter can be steered somewhere new.
    expect(
      fp([
        {
          ...base[0],
          inputSchema: { type: "object", properties: { send_to: { type: "string" } } },
        },
      ]),
    ).not.toBe(fp(base));
  });

  it("changes when a tool is ADDED or REMOVED", () => {
    const two = [...base, { name: "delete_all", description: "Delete everything" }];
    expect(fp(two)).not.toBe(fp(base));
    expect(fp([])).not.toBe(fp(base));
  });
});

describe("toolsFingerprint — what must NOT count as a change", () => {
  it("ignores the order the server enumerated tools in", () => {
    // Servers are under no obligation to be deterministic here, and a false
    // alarm on every deploy teaches the owner to click through the diff.
    const a: Tool[] = [{ name: "alpha" }, { name: "beta" }];
    expect(fp(a)).toBe(fp([...a].reverse()));
  });

  it("ignores object key order inside a schema", () => {
    const one = [{ name: "t", inputSchema: { a: 1, b: 2 } }];
    const two = [{ name: "t", inputSchema: { b: 2, a: 1 } }];
    expect(fp(one)).toBe(fp(two));
  });

  it("treats a missing description the same as an empty one", () => {
    expect(fp([{ name: "t" }])).toBe(fp([{ name: "t", description: "" }]));
  });
});

describe("toolsFingerprint — fields cannot be confused for one another", () => {
  it("does not let text shift between name and description", () => {
    // With a plain space between fields, {name:"a", description:"b c"} and
    // {name:"a b", description:"c"} would render to the same canonical string
    // and collide. The delimiters are control characters for this reason.
    expect(fp([{ name: "a", description: "b c" }])).not.toBe(
      fp([{ name: "a b", description: "c" }]),
    );
  });

  it("does not let text shift across a tool boundary", () => {
    expect(fp([{ name: "a" }, { name: "b" }])).not.toBe(fp([{ name: "ab" }]));
  });
});

describe("fingerprint algorithm version", () => {
  it("carries a version prefix", () => {
    expect(fp(base)).toMatch(/^v2:[0-9a-f]{32}$/);
  });

  it("is wide enough to be an approval gate, not a checksum", () => {
    // A 32-bit value is brute-forceable in minutes, and this decides whether
    // changed tools may be called without re-approval.
    expect(fp(base).replace("v2:", "")).toHaveLength(32); // 128 bits
  });

  it("recognises a hash from the previous algorithm", () => {
    // Those must be migrated silently rather than reported as a tool change:
    // flagging every existing app at once trains owners to click through.
    expect(isLegacyFingerprint("bff866f2")).toBe(true); // old 8-hex FNV-1a
    expect(isLegacyFingerprint(fp(base))).toBe(false);
    expect(isLegacyFingerprint(null)).toBe(false); // never deployed
    expect(isLegacyFingerprint("")).toBe(false);
  });
});
