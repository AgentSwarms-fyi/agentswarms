// The notebook gateway never asks for a kernel twice while one may be starting (R322).
//
// FOUND IN R322 (staging R316). A session's container runs one kernel and
// refuses a second create with "403 Resource Limit". The gateway gave each
// create 20 s and then asked again; on a slow host the first create took
// 21 s, started the kernel anyway, and every retry was refused, so the cell
// read "Kernel connect timed out" over a kernel that was running. The Kernel
// Gateway does not list its kernels, so the one that create started cannot be
// found again: the only safe move is not to give up on it.
//
// ensureKernel runs here for real against a fake Kernel Gateway that, like
// the real one, starts the kernel whether or not the caller waits for the
// answer, and refuses a second.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ensureKernel, KERNEL_CREATE_BUDGET_MS } from "../../services/notebook-gateway/kernels.mjs";

type Init = { method?: string; signal?: AbortSignal };

function fakeKernelGateway(opts: {
  firstCreateMs?: number;
  present?: string[];
  goneAfterMs?: number;
  hang?: boolean;
}) {
  const state = { kernels: [...(opts.present ?? [])], posts: 0 };
  if (opts.goneAfterMs !== undefined) {
    setTimeout(() => (state.kernels = []), opts.goneAfterMs);
  }
  const fetchImpl = async (_url: string, init: Init = {}) => {
    state.posts++;
    if (state.kernels.length > 0) return new Response("Resource Limit", { status: 403 });
    const id = `kernel-${state.posts}`;
    const delay = state.posts === 1 ? (opts.firstCreateMs ?? 0) : 0;
    // The kernel starts on its own schedule, whatever the caller does.
    if (!opts.hang) setTimeout(() => state.kernels.push(id), delay);
    await new Promise<void>((resolve, reject) => {
      const t = opts.hang ? undefined : setTimeout(resolve, delay + 1);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(init.signal?.reason);
      });
    });
    return Response.json({ id });
  };
  return { state, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const quiet = () => {};

describe("a slow first boot", () => {
  it("is waited for: one create, and its kernel is the connection's", async () => {
    // Slower than the old per-create 20 s would have allowed, scaled down.
    const gw = fakeKernelGateway({ firstCreateMs: 60 });
    const id = await ensureKernel("http://kg", {
      budgetMs: 200,
      retryWaitMs: 10,
      fetchImpl: gw.fetchImpl,
      log: quiet,
    });
    expect(id).toBe("kernel-1");
    expect(gw.state.posts).toBe(1);
  });

  it("that outlives the budget fails once, and is not asked for again", async () => {
    const gw = fakeKernelGateway({ hang: true });
    await expect(
      ensureKernel("http://kg", {
        budgetMs: 40,
        retryWaitMs: 5,
        fetchImpl: gw.fetchImpl,
        log: quiet,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    // A second create would only have been refused by the kernel the first is starting.
    expect(gw.state.posts).toBe(1);
  });
});

describe("a create that failed outright", () => {
  it("a refusal while the previous kernel is still being deleted is waited out and asked again", async () => {
    const gw = fakeKernelGateway({ present: ["previous"], goneAfterMs: 30 });
    const id = await ensureKernel("http://kg", {
      budgetMs: 500,
      retryWaitMs: 25,
      fetchImpl: gw.fetchImpl,
      log: quiet,
    });
    expect(id).not.toBe("previous");
    expect(gw.state.posts).toBeGreaterThan(1);
  });

  it("a gateway that never answers well fails with its error once the budget is spent", async () => {
    let posts = 0;
    const fetchImpl = (async () => {
      posts++;
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    await expect(
      ensureKernel("http://kg", { budgetMs: 60, retryWaitMs: 10, fetchImpl, log: quiet }),
    ).rejects.toThrow("HTTP 500 from http://kg/api/kernels");
    expect(posts).toBeGreaterThan(1);
  });
});

describe("the ordinary case", () => {
  it("a create that answers is used at once", async () => {
    const gw = fakeKernelGateway({});
    expect(await ensureKernel("http://kg", { fetchImpl: gw.fetchImpl, log: quiet })).toBe(
      "kernel-1",
    );
    expect(gw.state.posts).toBe(1);
  });
});

describe("the gateway", () => {
  it("creates its kernels through ensureKernel, and ships the module", () => {
    const index = readFileSync("services/notebook-gateway/index.mjs", "utf8");
    expect(index).toContain('import { ensureKernel } from "./kernels.mjs";');
    expect(index).toContain("kernelId = await ensureKernel(endpoint);");
    expect(readFileSync("services/notebook-gateway/Dockerfile", "utf8")).toContain(
      "COPY index.mjs kernels.mjs ./",
    );
  });

  it("gives up before the browser does, so its answer reaches the page", () => {
    const browser = readFileSync("src/lib/serverRuntime.ts", "utf8");
    const wait = Number(
      browser
        .match(/new Error\("Kernel connect timed out"\)\);\s*\}, ([\d_]+)\);/)?.[1]
        .replace(/_/g, ""),
    );
    expect(wait).toBe(30000);
    expect(KERNEL_CREATE_BUDGET_MS).toBeLessThan(wait);
  });
});
