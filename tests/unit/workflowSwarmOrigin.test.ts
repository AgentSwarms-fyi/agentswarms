// A workflow's Swarm step calls this app's own /api/chat from the same origin
// every other headless swarm run uses.
//
// FOUND IN R485, while documenting every setting: the step read its own
// APP_ORIGIN with `?? "http://localhost:8080"`, so it ignored PUBLIC_APP_URL
// and SITE_URL (which deployed and scheduled runs follow), and an empty
// APP_ORIGIN was used as the origin itself and the step could not reach
// /api/chat at all. R486 sends it through resolveInternalOrigin() like the
// rest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ origins: [] as string[] }));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = () =>
      Promise.resolve({
        data: { id: "swarm-1", name: "Swarm", nodes: [], edges: [] },
        error: null,
      });
    return b;
  };
  return { supabaseAdmin: { from: () => chain() } };
});

vi.mock("@/utils/swarmExecute.server", () => ({
  executeSwarmServer: async (opts: { origin: string }) => {
    calls.origins.push(opts.origin);
    return { status: "success", runId: "run-1", output: "done" };
  },
}));

vi.mock("@/lib/swarmPublish", () => ({
  resolveDeployedGraph: () => ({ nodes: [], edges: [], source: "live" }),
}));

import { startNode } from "@/utils/workflows/adapters.server";

const ORIGIN_VARS = ["APP_ORIGIN", "PUBLIC_APP_URL", "SITE_URL", "PORT"];

beforeEach(() => {
  calls.origins = [];
  for (const v of ORIGIN_VARS) vi.stubEnv(v, undefined);
});
afterEach(() => vi.unstubAllEnvs());

/** Start a Swarm step and wait for its detached run to settle. */
async function originOfSwarmStep(): Promise<string> {
  let settled!: () => void;
  const done = new Promise<void>((r) => (settled = r));
  const res = await startNode({
    userId: "u1",
    node: { id: "n1", kind: "swarm", label: "Swarm", targetId: "swarm-1" },
    params: {},
    runId: "wf-run-1",
    nodeRunId: "node-run-1",
    settle: async () => settled(),
  });
  expect(res.ok).toBe(true);
  await done;
  expect(calls.origins).toHaveLength(1);
  return calls.origins[0];
}

describe("the origin a workflow's Swarm step calls", () => {
  it("follows PUBLIC_APP_URL, as deployed and scheduled runs do", async () => {
    vi.stubEnv("PUBLIC_APP_URL", "https://agents.example.com/");
    // Before R486: http://localhost:8080.
    expect(await originOfSwarmStep()).toBe("https://agents.example.com");
  });

  it("follows SITE_URL when PUBLIC_APP_URL is not set", async () => {
    vi.stubEnv("SITE_URL", "https://site.example.com");
    expect(await originOfSwarmStep()).toBe("https://site.example.com");
  });

  it("is never an empty origin, whatever APP_ORIGIN holds", async () => {
    // An APP_ORIGIN="" line, as Compose passes it from an .env file.
    vi.stubEnv("APP_ORIGIN", "");
    // Before R486: "", so the step fetched "/api/chat" and failed.
    expect(await originOfSwarmStep()).toBe("http://127.0.0.1:8080");
  });

  it("falls back to loopback on the server's own port", async () => {
    vi.stubEnv("PORT", "3000");
    expect(await originOfSwarmStep()).toBe("http://127.0.0.1:3000");
  });
});
