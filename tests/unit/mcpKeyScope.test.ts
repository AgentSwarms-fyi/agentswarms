// An MCP key's reach must be stated, especially when it is unlimited.
//
// The list rendered `allowlist.length ? "· N tools" : ""`, so a key narrowed to
// three tools said "· 3 tools" and a key that can call EVERY tool said nothing.
// The proxy uses the same encoding — `allowed.length > 0` gates tools/call, so
// empty means unrestricted — but the screen inverted its meaning: the most
// powerful key was the row with the least written on it.
//
// This is the third instance of one pattern in this campaign. In the swarm
// import, an empty sql_table_names meant every table. In the model policy, an
// empty rule array meant deny-all. Here an empty allow-list means every tool.
// The encoding differs each time; what repeats is a UI reading "empty" as
// "nothing to say".
import { describe, expect, it } from "vitest";

import { isUnrestrictedKey, toolScopeLabel } from "@/lib/mcpKeyScope";

describe("the unrestricted case is never silent", () => {
  it("says 'all tools' for an empty allow-list", () => {
    // The central regression: this used to render as an empty string.
    expect(toolScopeLabel([])).toBe("all tools");
  });

  it("says 'all tools' when the allow-list is missing entirely", () => {
    expect(toolScopeLabel(null)).toBe("all tools");
    expect(toolScopeLabel(undefined)).toBe("all tools");
  });

  it("never returns a blank label for any input", () => {
    for (const input of [null, undefined, [], ["a"], ["a", "b"]]) {
      expect(toolScopeLabel(input).trim()).not.toBe("");
    }
  });
});

describe("a narrowed key states its count", () => {
  it("counts a single tool in the singular", () => {
    expect(toolScopeLabel(["search"])).toBe("1 tool");
  });

  it("counts several tools in the plural", () => {
    expect(toolScopeLabel(["search", "fetch", "write"])).toBe("3 tools");
  });
});

describe("isUnrestrictedKey agrees with the proxy's own gate", () => {
  // /api/mcp.s.$slug gates on `allowed.length > 0`, so anything that fails that
  // test is unrestricted. These two must never drift apart.
  it("is true exactly when the proxy would skip its allow-list check", () => {
    expect(isUnrestrictedKey([])).toBe(true);
    expect(isUnrestrictedKey(null)).toBe(true);
    expect(isUnrestrictedKey(undefined)).toBe(true);
    expect(isUnrestrictedKey(["one"])).toBe(false);
  });

  it("flags the unrestricted key, not the narrow one", () => {
    const keys = [
      { name: "prod", allow: [] as string[] },
      { name: "readonly", allow: ["search", "fetch", "list"] },
    ];
    expect(keys.filter((k) => isUnrestrictedKey(k.allow)).map((k) => k.name)).toEqual(["prod"]);
  });
});
