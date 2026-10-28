// In-browser JavaScript sandbox for the swarm "function" node.
//
// Goal: let users run small data-transformation snippets on the value flowing
// through a swarm node without giving them access to the page's DOM, network,
// storage, or the surrounding application state.
//
// WHY A WORKER (and why the previous approach was not enough)
// ───────────────────────────────────────────────────────────
// The first implementation compiled user code with `new Function` in the page
// realm and shadowed dangerous globals (window, fetch, localStorage…) as
// `undefined` variables. That is porous: shadowing only hides *identifiers*,
// and the real Function constructor is still reachable through any object's
// prototype chain —
//
//     ({}).constructor.constructor("return fetch")()
//
// — which compiles a fresh function in the GLOBAL scope, where none of the
// shadow variables apply. From there user code had the page's `fetch` and
// `localStorage`, i.e. the signed-in Supabase session token. That mattered
// because swarms are shareable: importing someone's swarm JSON and pressing
// Run would have executed their code with your session in scope.
//
// This version runs the snippet in a dedicated Worker instead:
//
//   1. A Worker has its own realm — no `window`, no `document`, no access to
//      the page's variables or storage. `localStorage` does not exist there at
//      all.
//   2. Before any user code runs, the bootstrap DELETES the remaining
//      dangerous globals from the worker's own `globalThis`. Deleting (rather
//      than shadowing) is what makes the constructor escape harmless: escaped
//      code resolves names against the global object, and those names are
//      simply gone.
//   3. The parent holds the only reference to `postMessage` needed to reply;
//      user code cannot see the bootstrap's module-scope bindings.
//   4. Timeouts are enforced with `worker.terminate()`, which kills even a
//      synchronous infinite loop — the previous version could hang the tab,
//      and documented that as an accepted limitation. It no longer applies.
//
//   5. The worker is a FILE on this origin (public/sandbox/function-node.js),
//      not a blob: URL (R397). A blob: worker takes the page's
//      Content-Security-Policy, and the page's script-src has no
//      'unsafe-eval', so the snippet could not have been compiled. A file
//      takes the policy of its own response, which server.mjs sets to
//      `default-src 'none'; script-src 'unsafe-eval'`: compile the snippet,
//      and reach nothing, even if deleting a global in step 2 fails.
//
// Residual, and deliberately so: the snippet can still burn CPU for up to
// `timeoutMs` on a background thread, and can read the `ctx` it was given
// (that is the entire point of the node).

export type SandboxContext = {
  input: unknown;
  vars: Record<string, unknown>;
  /**
   * Declared parameters of a saved component (see swarm_components). Plain
   * data, frozen like `vars` — a component reads its configuration here
   * instead of hard-coding it, which is what makes one component reusable
   * across swarms.
   */
  params?: Record<string, unknown>;
};

export type SandboxResult =
  { ok: true; value: unknown; logs: string[] } | { ok: false; error: string; logs: string[] };

// Safe stringify: handles circular refs and converts non-JSON values to
// readable strings. Returned to the caller when the user code returns an
// object (the swarm context only stores strings).
export function safeStringify(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_k, v) => {
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
        if (v && typeof v === "object") {
          if (seen.has(v as object)) return "[Circular]";
          seen.add(v as object);
        }
        return v;
      },
      2,
    );
  } catch (err) {
    return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

// The worker, served from this origin: public/sandbox/function-node.js holds
// the bootstrap (the reply channel, the globals it strips, the snippet's
// wrapper). server.mjs gives that one path its own Content-Security-Policy.
export const SANDBOX_WORKER_URL = "/sandbox/function-node.js";

export async function runSandboxed(
  code: string,
  ctx: SandboxContext,
  timeoutMs = 2000,
): Promise<SandboxResult> {
  if (typeof Worker === "undefined") {
    // No worker available (SSR / non-browser). Refuse rather than fall back to
    // an in-realm eval — an unsandboxed path is worse than an unavailable one.
    return {
      ok: false,
      error: "Function nodes require a browser environment with Web Workers.",
      logs: [],
    };
  }

  // `ctx` crosses a structured-clone boundary, so strip anything unclonable
  // (functions, symbols, class instances) before handing it over.
  let cloneableCtx: SandboxContext;
  try {
    cloneableCtx = JSON.parse(
      JSON.stringify({ input: ctx.input, vars: ctx.vars ?? {}, params: ctx.params ?? {} }),
    );
  } catch {
    cloneableCtx = { input: String(ctx.input ?? ""), vars: {}, params: {} };
  }

  const worker = new Worker(SANDBOX_WORKER_URL);
  // The worker's own timer rejects a well-behaved (async) snippet; this one is
  // the hard stop that also kills a synchronous infinite loop. Slightly longer
  // so the in-worker message wins when it can.
  const HARD_STOP_GRACE_MS = 250;

  return new Promise<SandboxResult>((resolve) => {
    let settled = false;
    const finish = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardStop);
      worker.terminate();
      resolve(r);
    };

    const hardStop = setTimeout(
      () =>
        finish({
          ok: false,
          error: `Function timed out after ${timeoutMs}ms and was terminated.`,
          logs: [],
        }),
      timeoutMs + HARD_STOP_GRACE_MS,
    );

    worker.onmessage = (ev: MessageEvent) => {
      const d = ev.data as
        { ok: true; value: unknown; logs: string[] } | { ok: false; error: string; logs: string[] };
      finish(d.ok ? { ok: true, value: d.value, logs: d.logs ?? [] } : d);
    };
    worker.onerror = (ev: ErrorEvent) => {
      finish({ ok: false, error: ev.message || "Function node failed to run.", logs: [] });
    };

    worker.postMessage({ code, ctx: cloneableCtx, timeoutMs });
  });
}
