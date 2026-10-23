// Two teardowns of one sandbox: the second said the container would stay.
//
// FOUND IN R292, FIXED IN R302. The result callback removes a batch sandbox
// once it reports, and a refresh that read the session a moment earlier
// removes it too (R93/R94). Docker answers the second DELETE 409, "removal of
// container ... is already in progress" - measured: two `docker rm -f` at once,
// the second says exactly that and the container is gone a moment later - and
// the app logged "was not removed ... it will stay on this host until somebody
// removes it by hand". The removal now waits for the one in progress, and says
// the container is still there only if it is.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const docker = vi.hoisted(() => ({
  deleteStatus: 409,
  deleteBody: '{"message":"removal of container nb-1 is already in progress"}',
  /** How many inspects answer 200 before the container is gone (404). */
  presentFor: 2,
  inspects: 0,
}));

beforeEach(() => {
  process.env.DOCKER_PROXY_URL = "http://docker.test";
  process.env.NOTEBOOK_TEARDOWN_WAIT_MS = "2000";
  docker.inspects = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/_ping")) return new Response("OK");
      if (method === "POST" && url.includes("/stop")) return new Response(null, { status: 204 });
      if (method === "DELETE")
        return new Response(docker.deleteBody, { status: docker.deleteStatus });
      if (method === "GET" && url.includes("/json")) {
        docker.inspects++;
        return docker.inspects > docker.presentFor
          ? new Response('{"message":"No such container"}', { status: 404 })
          : new Response("{}", { status: 200 });
      }
      return new Response(null, { status: 500 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NOTEBOOK_TEARDOWN_WAIT_MS;
});

const { DockerOrchestrator } = await import("@/utils/notebookRuntime/docker.server");

describe("removing a sandbox another removal is already taking off", () => {
  it("waits for that removal and reports the container removed", async () => {
    docker.deleteStatus = 409;
    docker.presentFor = 2;
    const out = await new DockerOrchestrator().stop("nb-1");
    expect(out).toEqual({ removed: true });
    expect(docker.inspects).toBeGreaterThan(2);
  });

  it("says it is still there only when it is, and why", async () => {
    docker.deleteStatus = 409;
    docker.presentFor = 10_000;
    const out = await new DockerOrchestrator().stop("nb-1");
    expect(out.removed).toBe(false);
    expect(out.error).toMatch(
      /another removal was already in progress and had not finished after 2 s/,
    );
  });

  it("any other refusal is still a refusal", async () => {
    docker.deleteStatus = 500;
    docker.deleteBody = '{"message":"driver failed"}';
    const out = await new DockerOrchestrator().stop("nb-1");
    expect(out).toEqual({
      removed: false,
      error: 'docker DELETE answered 500: {"message":"driver failed"}',
    });
    docker.deleteBody = '{"message":"removal of container nb-1 is already in progress"}';
  });
});
