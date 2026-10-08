// The MCP Builder page says when a server call fails (R361).
//
// FOUND FROM THE UI (R361, queued since R98). With the next server-function
// call made to reject (as a dropped connection does), Deploy on a Builder app
// stayed disabled for good, with no message and "Uncaught (in promise)
// TypeError: Failed to fetch" in the console: the handler awaited the call
// bare. Twelve of the page's thirteen calls did; only Save caught its
// rejection (R280). Stop, Unregister and Revoke also ignored the answer, so
// "Stopped" and "Unregistered" were shown over a refusal. Pinned by source, as
// the page's other rules are (mcpBuilderAutosave, mcpToolApproval).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/routes/_authenticated/mcp-builder_.$appId.tsx", "utf8");
const after = (anchor: string, len = 900) => {
  const i = SRC.indexOf(anchor);
  expect(i, anchor).toBeGreaterThan(0);
  return SRC.slice(i, i + len);
};

describe("every server call on the Builder page", () => {
  it("goes through `reported`, but Save, which catches its own", () => {
    const bare = [...SRC.matchAll(/await ([a-zA-Z]+Fn)\(/g)].map((m) => m[1]);
    expect(bare).toEqual(["saveFn"]);
    expect(after("res = await saveFn({", 600)).toContain("} catch (e) {");
  });

  it("`reported` says what failed, and answers null", () => {
    const fn = after("async function reported<T>(", 400);
    expect(fn).toContain("return await call();");
    expect(fn).toMatch(/catch \(e\) \{\s*toast\.error\(`\$\{what\}: /);
    expect(fn).toContain("return null;");
  });
});

describe("Deploy", () => {
  it("is enabled again however its call ends", () => {
    const fn = after("setDeploying(true);", 500);
    expect(fn).toMatch(/try \{\s*res = await reported\(/);
    expect(fn).toMatch(/\} finally \{\s*setDeploying\(false\);\s*\}/);
    expect(fn).toMatch(/if \(!res\) \{[\s\S]*?void reload\(\);\s*return;/);
  });
});

describe("Stop, Unregister and Revoke", () => {
  it("say success only when the server says it", () => {
    for (const [anchor, success] of [
      ['"Stop did not answer"', 'toast.success("Stopped")'],
      ['"Unregister did not answer"', 'toast.success("Unregistered")'],
    ]) {
      const body = after(anchor, 300);
      const check = body.indexOf("if (!res.ok)");
      expect(check, anchor).toBeGreaterThan(0);
      expect(check, anchor).toBeLessThan(body.indexOf(success));
    }
    expect(after('"Revoke did not answer"', 200)).toContain(
      "if (res && !res.ok) toast.error(`The key was not revoked: ${res.error}`);",
    );
  });
});
