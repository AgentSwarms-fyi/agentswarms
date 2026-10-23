// Creating the kernel a notebook connection runs on.
//
// A session's container runs one kernel at a time: its Kernel Gateway refuses
// a second create with "403 Resource Limit", and it does not list its kernels
// (list_kernels is off), so a kernel whose create was given up on cannot be
// found again from here.
//
// FOUND IN R322. Each create was given 20 s and then asked again. On a slow
// host the first create took 21 s: given up on here, it started the kernel
// anyway, and every later create was refused by that kernel, so the
// connection failed with "kernel unavailable" over a kernel that was running.
// The browser waits 30 s for the connection, so the retries at 40, 60 and
// 80 s could never have helped.
//
// A create is now never asked for again while it may still be starting one:
// it is waited for, for the whole budget (KERNEL_CREATE_TIMEOUT_MS, 28 s by
// default, inside the browser's 30). Only a create that failed outright, such
// as a refusal while the previous connection's kernel is still being deleted
// after a reload, is asked again, until the budget is spent.

/** The default budget: under the browser's 30 s wait (src/lib/serverRuntime.ts). */
export const KERNEL_CREATE_BUDGET_MS = 28000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Create the connection's kernel; resolves to its id, or rejects with the last error. */
export async function ensureKernel(endpoint, opts = {}) {
  const {
    budgetMs = Number(process.env.KERNEL_CREATE_TIMEOUT_MS) || KERNEL_CREATE_BUDGET_MS,
    retryWaitMs = 2000,
    fetchImpl = fetch,
    log = console.log,
  } = opts;
  const deadline = Date.now() + budgetMs;
  let lastErr;
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    try {
      const r = await fetchImpl(`${endpoint}/api/kernels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${endpoint}/api/kernels`);
      const id = String((await r.json()).id);
      log(`[gateway] kernel created ${id.slice(0, 8)} (attempt ${attempt})`);
      return id;
    } catch (e) {
      lastErr = e;
      log(`[gateway] kernel create attempt ${attempt} failed: ${e?.message ?? e}`);
      // Given up on, it may still start its kernel; asking again would only be
      // refused by it.
      if (e?.name === "TimeoutError") break;
      if (deadline - Date.now() <= retryWaitMs) break;
      await sleep(retryWaitMs);
    }
  }
  throw lastErr ?? new Error(`no kernel from ${endpoint}/api/kernels within ${budgetMs} ms`);
}
