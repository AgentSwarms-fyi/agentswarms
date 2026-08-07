// The execution half of the JS sandbox: one worker thread per request.
//
// CONTRACT — must stay identical to the browser sandbox
// (src/lib/sandbox/jsSandbox.ts), because the same snippet runs on the canvas
// and in a deployed run, and "it worked when I tested it" has to mean
// something:
//   • the snippet body becomes `async function userFn(ctx, console)`
//   • ctx = { input, vars, params }, all frozen
//   • console.log/info/warn/error are captured into `logs`, never printed
//   • the wrapper is STRICT — writing to the frozen ctx throws here exactly as
//     it does in the browser, instead of failing silently in sloppy mode
//   • the return value is JSON round-tripped
//   • exceeding timeoutMs is an error, not a hang
// tests/unit/sandboxParity.test.ts pins that equivalence.
//
// ── THE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────────────
// NOTHING FROM THE HOST REALM MAY ENTER THE vm CONTEXT. Not an object, not a
// function, not even a console shim.
//
// This is not theoretical tidiness. The first version of this file passed a
// host `console` object in, which looked harmless — it only pushes strings to
// an array. But every host function carries the HOST Function constructor on
// its prototype chain, so a snippet could write:
//
//     console.log.constructor("return process")()
//
// and get the real `process` — meaning `process.env` (this container's
// INTERNAL_RUN_SECRET) and `require`. A probe caught it returning
// "ESCAPED:process,global,Buffer" before any of this shipped.
//
// So the context starts EMPTY, a bootstrap compiled *inside* it builds the
// console and ctx out of vm-realm intrinsics, and only PRIMITIVES (JSON
// strings, booleans) ever cross the boundary in either direction. A snippet
// walking any prototype chain now finds the vm realm's own Function, whose
// global has no Node internals — and `codeGeneration` is off anyway.
//
// The worker thread on top gives what the browser's Worker gives: terminate()
// kills a synchronous infinite loop, which a Promise race alone cannot.
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

const { code, ctx, timeoutMs } = workerData;

// The context is created with NO host properties at all.
const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});

/** Run a snippet in the context and hand back only what it returns. */
const inVm = (src, opts = {}) =>
  new vm.Script(src, { filename: opts.filename ?? "sandbox-internal.js" }).runInContext(context, {
    timeout: opts.timeout ?? 1000,
  });

// Serialised INPUTS cross as a string and are parsed by the vm's own JSON, so
// every object the snippet touches belongs to the vm realm.
let ctxJson;
try {
  ctxJson = JSON.stringify({
    input: ctx?.input ?? null,
    vars: ctx?.vars ?? {},
    params: ctx?.params ?? {},
  });
} catch {
  ctxJson = JSON.stringify({ input: String(ctx?.input ?? ""), vars: {}, params: {} });
}

// Bootstrap: build console + ctx from vm intrinsics, and prepare the slots the
// host will read back as primitives.
inVm(`
  globalThis.__logs = [];
  globalThis.__done = false;
  globalThis.__ok = false;
  globalThis.__out = "null";
  globalThis.__err = "";
  const push = (prefix) => function () {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
    globalThis.__logs.push(prefix + parts.join(" "));
  };
  globalThis.console = Object.freeze({
    log: push(""), info: push(""), warn: push("[warn] "), error: push("[error] "),
  });
  const raw = JSON.parse(${JSON.stringify(ctxJson)});
  globalThis.ctx = Object.freeze({
    input: raw.input,
    vars: Object.freeze(raw.vars || {}),
    params: Object.freeze(raw.params || {}),
  });
`);

// The user snippet, wrapped exactly as the browser wraps it. Completion is
// recorded INSIDE the vm; the host never awaits a vm promise (a snippet could
// return a thenable and capture the host callback that way).
const wrapped = `
  "use strict";
  (async function userFn(ctx, console) {
${code}
  })(globalThis.ctx, globalThis.console).then(
    function (v) {
      try { globalThis.__out = JSON.stringify(v === undefined ? null : v); }
      catch (e) { globalThis.__out = JSON.stringify(String(v)); }
      globalThis.__ok = true;
      globalThis.__done = true;
    },
    function (e) {
      globalThis.__err = (e && e.message) ? String(e.message) : String(e);
      globalThis.__ok = false;
      globalThis.__done = true;
    }
  );
`;

const readLogs = () => {
  try {
    return JSON.parse(inVm("JSON.stringify(globalThis.__logs || [])"));
  } catch {
    return [];
  }
};

async function main() {
  const started = Date.now();
  try {
    // Synchronous CPU burn is stopped here; anything still pending afterwards
    // is handled by the poll loop and the parent's hard kill.
    inVm(wrapped, { filename: "component.js", timeout: timeoutMs });
  } catch (e) {
    return { ok: false, error: e && e.message ? String(e.message) : String(e), logs: readLogs() };
  }

  for (;;) {
    const done = inVm("!!globalThis.__done");
    if (done) break;
    if (Date.now() - started > timeoutMs) {
      return { ok: false, error: `Function timed out after ${timeoutMs}ms`, logs: readLogs() };
    }
    await new Promise((r) => setTimeout(r, 2));
  }

  const ok = inVm("!!globalThis.__ok");
  const logs = readLogs();
  if (!ok) return { ok: false, error: inVm("String(globalThis.__err)"), logs };
  let value;
  try {
    value = JSON.parse(inVm("String(globalThis.__out)"));
  } catch {
    value = null;
  }
  return { ok: true, value, logs };
}

main().then(
  (payload) => parentPort.postMessage(payload),
  (err) =>
    parentPort.postMessage({
      ok: false,
      error: err && err.message ? err.message : String(err),
      logs: [],
    }),
);
