// Every path that runs a user's notebook asks the admin's runtime switches.
//
// FOUND FROM THE SURVEY (R96). Only the interactive kernel route and MCP
// deploys asked. A published notebook's API, a workflow's Notebook step and
// minting a notebook API key ran, or enabled, server kernels with the runtime
// switched off.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runtimeRefusalFor } from "@/utils/notebookRuntime/refusal";

const flat = (s: string) => s.replace(/\s+/g, " ");
const run = flat(readFileSync("src/routes/api/notebook.run.ts", "utf8"));
const adapters = flat(readFileSync("src/utils/workflows/adapters.server.ts", "utf8"));
const keys = flat(readFileSync("src/utils/notebookApiKeys.functions.ts", "utf8"));
const config = flat(readFileSync("src/utils/notebookRuntime/config.server.ts", "utf8"));

describe("the reason a user may not run notebook code", () => {
  it("is the disabled runtime first, whatever the grant says", () => {
    expect(runtimeRefusalFor({ enabled: false, permitted: true })?.code).toBe("runtime_disabled");
    expect(runtimeRefusalFor({ enabled: false, permitted: false })?.code).toBe("runtime_disabled");
  });

  it("is the missing grant when the runtime is on", () => {
    const r = runtimeRefusalFor({ enabled: true, permitted: false });
    expect(r?.code).toBe("not_permitted");
    expect(r?.message).toContain("has not granted you access");
  });

  it("is nothing when the runtime is on and the user may use it", () => {
    expect(runtimeRefusalFor({ enabled: true, permitted: true })).toBeNull();
  });

  it("never asks about the grant when the runtime is off", () => {
    expect(config).toContain("permitted: settings.enabled && (await canUseRuntime(userId)),");
  });
});

describe("each path that runs a user's notebook asks before it starts one", () => {
  it("a published notebook's API refuses before it counts a use or starts a kernel", () => {
    const ask = run.indexOf("const refused = await notebookRuntimeRefusal(key.user_id);");
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(run.indexOf("use_count: (key.use_count ?? 0) + 1,"));
    expect(ask).toBeLessThan(run.indexOf("await startSession({"));
    expect(run).toContain("if (refused) {");
    // Each code gets its own sentence: the caller is told which switch stopped it.
    expect(run).toContain(
      'refused.code === "runtime_disabled" ? "The server runtime is not enabled on this instance, so published notebooks cannot run." : "This notebook\'s owner has not been granted access to the server runtime.",',
    );
    // And it is a refusal, not a server error the caller should retry.
    const refusal = run.slice(ask, run.indexOf("let body:", ask));
    expect(refusal).toContain("403");
  });

  it("a workflow's Notebook step fails with the reason instead of starting one", () => {
    const step = adapters.slice(
      adapters.indexOf('case "notebook": {'),
      adapters.indexOf('case "sub_workflow": {'),
    );
    const ask = step.indexOf("const refused = await notebookRuntimeRefusal(userId);");
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(step.indexOf("await startSession({"));
    expect(step).toContain(
      "if (refused) return { ok: false, error: `The notebook step cannot run: ${refused.message}` };",
    );
  });

  it("minting a notebook API key is refused to anyone the runtime would refuse", () => {
    const create = keys.slice(
      keys.indexOf("export const nbApiKeyCreate"),
      keys.indexOf("export const nbApiKeyRevoke"),
    );
    const ask = create.indexOf("const refused = await notebookRuntimeRefusal(owner.userId);");
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(create.indexOf("const plaintext = generateNotebookApiKey();"));
    expect(create).toContain("if (refused) return { ok: false, error: refused.message };");
  });
});
