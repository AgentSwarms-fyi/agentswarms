// A sandbox whose kernel ended on its own must still be taken off the host.
//
// FOUND FROM THE SURVEY (R93). stopSession removes the container, but it is
// only reached from reapSessions, which reads rows that are still live.
// refreshSession - the only path a kernel that ends BY ITSELF passes through -
// wrote the terminal status and left the container standing. And the removal
// itself dropped its answer: dockerFetch resolves with the Response, so a
// failed DELETE never reached the catch around it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const orc = readFileSync("src/utils/notebookRuntime/orchestrator.ts", "utf8");
const dockerSrc = readFileSync("src/utils/notebookRuntime/docker.server.ts", "utf8");
const k8sSrc = readFileSync("src/utils/notebookRuntime/k8s.server.ts", "utf8");
const svc = readFileSync("src/utils/notebookRuntime/service.server.ts", "utf8");

const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i, `missing anchor: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i);
  expect(j, `missing anchor: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
};
const flat = (s: string) => s.replace(/\s+/g, " ");

const refresh = flat(
  between(
    svc,
    "export async function refreshSession(",
    "export async function reconcileUserSessions(",
  ),
);
const stopFn = flat(
  between(
    svc,
    "export async function stopSession(",
    "export async function reconcileUserSessions(",
  ),
);
const dockerStop = flat(between(dockerSrc, "async stop(ref: string)", "async logs(ref: string)"));
const k8sStop = flat(between(k8sSrc, "async stop(ref: string)", "async logs("));

describe("the teardown contract", () => {
  it("answers whether the sandbox is gone instead of returning void", () => {
    expect(orc).toContain("export type TeardownResult = { removed: boolean; error?: string };");
    expect(flat(orc)).toContain("stop(ref: string): Promise<TeardownResult>;");
    expect(flat(orc)).not.toContain("stop(ref: string): Promise<void>;");
  });
});

describe("removing the sandbox", () => {
  it("docker reads the DELETE's answer, and counts 404 as gone", () => {
    expect(dockerStop).toContain("const res = await dockerFetch(");
    expect(dockerStop).toContain("if (res.ok || res.status === 404) return { removed: true };");
    expect(dockerStop).toContain("docker DELETE answered ${res.status}");
  });

  it("kubernetes does the same with its own DELETE", () => {
    expect(k8sStop).toContain('const res = await k8sFetch(path, { method: "DELETE" });');
    expect(k8sStop).toContain("if (res.ok || res.status === 404) return { removed: true };");
    expect(k8sStop).toContain("kubernetes DELETE answered ${res.status}");
  });
});

describe("a kernel that ended on its own", () => {
  it("has its sandbox removed when its row goes terminal", () => {
    expect(refresh).toContain('if (terminal.includes(String(patch.status ?? ""))) {');
    expect(refresh).toContain("await orch .stop(row.container_ref)");
    expect(refresh).toContain("was not removed:");
    expect(refresh).toContain("until somebody removes it by hand");
  });

  it("keeps the failure's logs before the sandbox that holds them goes", () => {
    const errBranch = refresh.slice(refresh.indexOf('patch.error = st.message ?? "kernel error";'));
    expect(errBranch.slice(0, 260)).toContain("patch.logs = await orch.logs(row.container_ref)");
  });
});

describe("stopping a live session", () => {
  it("does not record it stopped in silence when the sandbox is still there", () => {
    expect(stopFn).toContain("const teardown = await orch .stop(row.container_ref)");
    expect(stopFn).toContain("if (!teardown.removed) {");
    expect(stopFn).toContain("still holding its CPU and memory");
  });
});
