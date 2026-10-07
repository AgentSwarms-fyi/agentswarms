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
