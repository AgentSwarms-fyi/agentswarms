// The swarm function node's sandbox: a dedicated Worker that runs one user
// snippet. Started by src/lib/sandbox/jsSandbox.ts, which documents why it is
// a Worker and what it guarantees.
//
// A FILE, not a blob: URL (R397). A blob: worker takes the policy of the page
// that made it, so the page's script-src (no 'unsafe-eval') would refuse the
// `new Function` below and the node could not run at all. Loaded from this
// origin, the worker takes the policy of its own response instead, which
// server.mjs sets to `default-src 'none'; script-src 'unsafe-eval'`: it may
// compile the snippet and do nothing else, network included.
//
// Note the ordering: capture the reply channel, strip the globals, THEN run
// anything the user supplied.
//
// All of it inside one function, so `__post` and `__strip` are not globals.
// `new Function` compiles in the global scope, and a classic worker's
// top-level `const` lives there: the snippet could have called `__post`.
(() => {
  // Globals removed from the worker scope before user code runs. Anything that
  // could reach the network, persist data, or spawn more execution contexts.
  // `postMessage` is captured first, then deleted, so the snippet cannot
  // message the parent directly.
  const __post = self.postMessage.bind(self);
  const __strip = [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "importScripts",
    "indexedDB",
    "caches",
    "Worker",
    "SharedWorker",
    "BroadcastChannel",
    "Notification",
    "navigator",
    "location",
    "postMessage",
    "close",
    "crypto",
  ];

  self.onmessage = async (ev) => {
    const { code, ctx, timeoutMs } = ev.data;
    const logs = [];
    const sandboxConsole = {
      log: (...a) => logs.push(a.map(String).join(" ")),
      info: (...a) => logs.push(a.map(String).join(" ")),
      warn: (...a) => logs.push("[warn] " + a.map(String).join(" ")),
      error: (...a) => logs.push("[error] " + a.map(String).join(" ")),
    };

    // Strip AFTER capturing what we need. Some of these are non-configurable in
    // certain engines, so fall back to overwriting with undefined.
    for (const name of __strip) {
      try {
        delete self[name];
        if (self[name] !== undefined) self[name] = undefined;
      } catch {
        try {
          self[name] = undefined;
        } catch {
          /* frozen: best effort */
        }
      }
    }

    // Freeze the context so a snippet can read but not reshape shared state.
    const frozen = Object.freeze({
      input: ctx.input,
      vars: Object.freeze({ ...(ctx.vars || {}) }),
      params: Object.freeze({ ...(ctx.params || {}) }),
    });

    try {
      const fn = new Function(
        "ctx",
        "console",
        `"use strict";
return (async function userFn(ctx, console) {
${code}
})(ctx, console);`,
      );
      const value = await Promise.race([
        Promise.resolve().then(() => fn(frozen, sandboxConsole)),
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error("Function timed out after " + timeoutMs + "ms")),
            timeoutMs,
          ),
        ),
      ]);
      // Structured-clone can't carry functions/symbols; stringify defensively.
      let safe;
      try {
        safe = JSON.parse(JSON.stringify(value === undefined ? null : value));
      } catch {
        safe = String(value);
      }
      __post({ ok: true, value: safe, logs });
    } catch (err) {
      __post({ ok: false, error: err && err.message ? err.message : String(err), logs });
    }
  };
})();
