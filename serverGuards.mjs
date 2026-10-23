// Process-level guards for server.mjs.
//
// FOUND IN R325, by the browser checks' first full run (R324). undici, the
// fetch inside Node, can close a response body's stream twice when the body
// is cancelled while it is still being read. The second close throws
// "ReadableStream is already closed" from a microtask nothing can catch, and
// the process exits. In a cluster that is one worker, restarted, with every
// request, stream and swarm run it held; with WEB_CONCURRENCY=1 it is the
// whole server. The stream was already closed, so nothing is left half-done:
// this one error is logged and survived. Every other uncaught exception still
// ends the process, as Node's default does.

/** Is this undici closing a response stream it had already closed? */
export function isUndiciDoubleClose(err) {
  return (
    err?.code === "ERR_INVALID_STATE" &&
    /ReadableStream is already closed/.test(String(err?.message ?? "")) &&
    /undici/.test(String(err?.stack ?? ""))
  );
}

/** The handler: survive the double close, end the process on anything else. */
export function uncaughtExceptionHandler({
  log = console,
  exit = (code) => process.exit(code),
} = {}) {
  return (err, origin) => {
    if (isUndiciDoubleClose(err)) {
      log.warn(
        `[agentswarms] survived undici closing a response stream twice (${err.message}); nothing was left half-done`,
      );
      return;
    }
    log.error(`[agentswarms] uncaught ${origin ?? "exception"}:`, err?.stack ?? err);
    exit(1);
  };
}

export function installServerGuards(proc = process) {
  proc.on("uncaughtException", uncaughtExceptionHandler());
}

// A browser that leaves mid-request is not a server fault (R362).
//
// FOUND IN R342, SHOWN IN R362. Reloading a page while its requests were in
// flight printed an 18-line "Error: aborted ... code: 'ECONNRESET' ...
// status: 500, unhandled: true" stack, so an operator reading the log saw a
// server fault where a client had only gone away. srvx aborts the request's
// signal when the connection closes first, with Node's own error as the
// reason. TanStack Start then throws that reason on purpose, which stops the
// work for a page nobody will read. h3 prints any error that is not its own
// HTTPError as unhandled, without looking at the signal, and offers no hook to
// say otherwise. So each request's abort reason is remembered as it happens,
// and h3's report of exactly that reason is not printed. Every other error,
// an abort the app raised itself included, is printed as before.

/** The abort reasons of requests whose client went away. */
const clientGone = new WeakSet();

function remember(reason) {
  if (reason !== null && typeof reason === "object") clientGone.add(reason);
}

/** The app's fetch, remembering the abort reason of a request whose client left. */
export function rememberClientAborts(fetch) {
  return (request, ...rest) => {
    const signal = request?.signal;
    if (signal?.aborted) remember(signal.reason);
    else signal?.addEventListener("abort", () => remember(signal.reason), { once: true });
    return fetch(request, ...rest);
  };
}

/** Is this h3's report of a request whose client left? */
export function isClientGoneReport(err) {
  return (
    err instanceof Error &&
    err.name === "HTTPError" &&
    err.unhandled === true &&
    clientGone.has(err.cause)
  );
}

/** `log.error` without h3's report of a client that left; answers the undo. */
export function quietClientGone(log = console) {
  const print = log.error;
  log.error = function (...args) {
    if (args.length === 1 && isClientGoneReport(args[0])) return;
    return print.apply(this, args);
  };
  return () => {
    log.error = print;
  };
}
