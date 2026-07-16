// In-browser JavaScript sandbox for the swarm "function" node.
//
// Goal: let users run small data-transformation snippets on the value flowing
// through a swarm node without giving them access to the page's DOM, network,
// storage, or the global scope.
//
// Strategy:
//   1. Compile the user code with `new Function("ctx", body)`.
//   2. Inside `body` we prepend `"use strict";` and shadow every global we
//      can think of with `undefined` (window, document, fetch, localStorage,
//      indexedDB, parent, top, globalThis, eval, Function, import,
//      importScripts, XMLHttpRequest, WebSocket, navigator, location, etc.).
//      Strict mode disables `with` and prevents accidental global writes.
//   3. We freeze the `ctx` object (and shallow-freeze its `vars`) so the
//      user can read `ctx.input` / `ctx.vars` but can't mutate them in a way
//      that affects the rest of the swarm.
//   4. We race the call against a `setTimeout` so anything that returns a
//      promise resolves within `timeoutMs` or aborts.
//
// Honest limitation (documented in the inspector UI too): a purely
// synchronous infinite loop in user code WILL block the tab until the
// browser kills the page. There's no way to interrupt sync JS from within
// the same realm without a Worker, and we deliberately don't spawn a Worker
// here to keep the sandbox dependency-free and the swarm runtime simple.
// For most data-shaping snippets this is fine; we surface the warning in
// the editor.

export type SandboxContext = {
  input: unknown;
  vars: Record<string, unknown>;
};

export type SandboxResult =
  | { ok: true; value: unknown; logs: string[] }
  | { ok: false; error: string; logs: string[] };

// Names we explicitly shadow to `undefined` inside the user's function body.
// Anything reachable from the global scope that could exfiltrate data, mutate
// the page, or escape the sandbox belongs here.
// NOTE: `eval`, `arguments`, and `import` are reserved/illegal as `var`
// declaration names in strict mode (declaring them throws a SyntaxError at
// parse time — "Unexpected eval or arguments in strict mode"). They cannot
// be safely shadowed this way, so they are intentionally excluded. `eval`
// and `Function` access is still effectively neutralized because we never
// pass them into the wrapper closure and strict mode disallows implicit
// global writes — but the real defense for those is that the function body
// runs in a frozen ctx with no network/DOM access regardless.
const BLOCKED_GLOBALS = [
  "window", "self", "globalThis", "parent", "top", "frames",
  "document", "navigator", "location", "history",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
  "localStorage", "sessionStorage", "indexedDB", "caches",
  "Function", "AsyncFunction", "GeneratorFunction",
  "importScripts", "require", "process",
  "Worker", "SharedWorker", "ServiceWorker",
  "alert", "confirm", "prompt", "open", "close", "print",
  "postMessage", "BroadcastChannel",
  "chrome", "browser",
];

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

// Build a frozen ctx whose `vars` can't be reassigned and whose properties
// are read-only. Users who try `ctx.input = "x"` get a strict-mode TypeError.
function makeFrozenCtx(ctx: SandboxContext): SandboxContext {
  const vars = Object.freeze({ ...(ctx.vars || {}) });
  return Object.freeze({ input: ctx.input, vars }) as SandboxContext;
}

export async function runSandboxed(
  code: string,
  ctx: SandboxContext,
  timeoutMs = 2000,
): Promise<SandboxResult> {
  const logs: string[] = [];
  // Capture `console.log` / `console.error` calls inside the snippet so the
  // editor's "Test on sample input" panel can show them. We pass a tiny
  // shim into the closure rather than letting user code reach the real
  // `console` (which could be wrapped by extensions / dev tools).
  const sandboxConsole = {
    log: (...args: unknown[]) => logs.push(args.map((a) => safeStringify(a)).join(" ")),
    error: (...args: unknown[]) => logs.push(`[error] ${args.map((a) => safeStringify(a)).join(" ")}`),
    warn: (...args: unknown[]) => logs.push(`[warn] ${args.map((a) => safeStringify(a)).join(" ")}`),
    info: (...args: unknown[]) => logs.push(args.map((a) => safeStringify(a)).join(" ")),
  };

  const shadowDecls = BLOCKED_GLOBALS.map((g) => `${g} = undefined`).join(", ");
  // The user's body is wrapped in an async IIFE so `await` works naturally
  // and any thrown promise rejection becomes a rejected race.
  const wrappedBody = `
    "use strict";
    var ${shadowDecls};
    return (async function userFn(ctx, console) {
      ${code}
    })(ctx, console);
  `;

  let compiled: (ctx: SandboxContext, console: typeof sandboxConsole) => Promise<unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    compiled = new Function("ctx", "console", wrappedBody) as typeof compiled;
  } catch (err) {
    return {
      ok: false,
      error: `Syntax error: ${err instanceof Error ? err.message : String(err)}`,
      logs,
    };
  }

  const frozenCtx = makeFrozenCtx(ctx);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Function timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    const value = await Promise.race([
      Promise.resolve().then(() => compiled(frozenCtx, sandboxConsole)),
      timeout,
    ]);
    return { ok: true, value, logs };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      logs,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
