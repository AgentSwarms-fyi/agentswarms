// Shutdown and connection timing for the production server (server.mjs).
//
// FOUND MEASURING (R463): a SIGTERM cut every in-flight response at once. srvx
// installs its own SIGTERM handler (gracefulShutdownPlugin) unless told not
// to, and server.mjs installed a second one. Both called close(); Node fails
// the second close at once ("server is not running"), and the handler's
// `.finally(() => process.exit(0))` then exited with the stream still open.
// Measured on Linux, with srvx 0.11.22 and a 20-tick stream, SIGTERM at 2 s:
//
//   srvx plugin on (as shipped)   stream cut after 2 ticks, at 2.0 s
//   srvx plugin off, this drain   stream finished all 20 ticks, at 24.1 s
//
// So every `docker compose up -d`, Kubernetes rollout or ECS deployment cut a
// chat reply mid-sentence. This module owns shutdown instead: one handler,
// a readiness flip, a bounded wait, then a forced close of whatever is left.
//
// The same module sets Node's keep-alive window. Node closes an idle
// keep-alive socket after 5 s by default; a load balancer (an AWS ALB keeps
// them 60 s or more) can send the next request down a socket Node is closing,
// which comes back as an intermittent 502. The server must keep idle sockets
// LONGER than the balancer does, so the balancer is always the one to close.

/** The flag the app's readiness probe reads; a Symbol.for key so the bundle sees the same one. */
export const DRAINING = Symbol.for("agentswarms.draining");

// Each setting is read by its literal name (env.DRAIN_TIMEOUT_MS, not
// env[name]) so the docs check can see what this file reads.
function ms(raw, fallback) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

/**
 * How long open requests get after SIGTERM. 25 s by default: under the 30 s
 * docker-compose.yml gives the container (stop_grace_period) and the 45 s the
 * Kubernetes manifest gives the pod, so the drain ends on our terms rather
 * than with SIGKILL. Behind an AWS load balancer the balancer has already
 * stopped sending new requests and waited out its deregistration delay before
 * the signal arrives, so this only covers what is left.
 */
export function drainTimeoutMs(env = process.env) {
  return ms(env.DRAIN_TIMEOUT_MS, 25_000);
}

/**
 * How long to keep accepting connections after SIGTERM while readiness already
 * answers 503. 0 by default. On Kubernetes without a preStop hook, a few
 * seconds let the endpoint controller take the pod out of the Service before
 * the port closes, so nothing arriving in that window is refused.
 */
export function drainDelayMs(env = process.env) {
  return ms(env.DRAIN_DELAY_MS, 0);
}

/**
 * Node's idle keep-alive window and header timeout. The default of 75 s keeps
 * idle sockets longer than an ALB's 60 s default; raise it with
 * HTTP_KEEPALIVE_TIMEOUT_MS if your balancer's idle timeout is longer (the
 * AWS templates set the ALB to 120 s and this to 125 s). headersTimeout must
 * exceed keepAliveTimeout, or Node can drop a request whose headers arrive
 * just as the socket idles out.
 */
export function keepAliveSettings(env = process.env) {
  const keepAliveTimeout = ms(env.HTTP_KEEPALIVE_TIMEOUT_MS, 75_000);
  return { keepAliveTimeout, headersTimeout: keepAliveTimeout + 5_000 };
}

/** Apply keepAliveSettings() to a node:http server. A no-op when there is none. */
export function applyKeepAlive(nodeServer, env = process.env) {
  if (!nodeServer) return null;
  const s = keepAliveSettings(env);
  nodeServer.keepAliveTimeout = s.keepAliveTimeout;
  nodeServer.headersTimeout = s.headersTimeout;
  return s;
}

/**
 * Drain `server` (an srvx server: close() waits for open requests, close(true)
 * also ends them) and exit. Returns the function so a caller can drain without
 * a signal, which is how the tests drive it on hosts that cannot deliver one.
 *
 * Order: mark draining (readiness answers 503), wait drainDelayMs, stop
 * accepting, let open requests finish for up to drainTimeoutMs, then close the
 * rest and exit 0.
 */
export function createDrain({
  server,
  who = `process ${process.pid}`,
  log = console,
  exit = (code) => process.exit(code),
  env = process.env,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
}) {
  const timeoutMs = drainTimeoutMs(env);
  const delayMs = drainDelayMs(env);
  let started = false;
  return function drain(reason = "SIGTERM") {
    if (started) return;
    started = true;
    globalThis[DRAINING] = true;
    const t0 = now();
    log.log(
      `[agentswarms] ${who} draining on ${reason}: readiness now answers 503` +
        (delayMs ? `, still accepting for ${delayMs / 1000} s` : "") +
        `; open requests get up to ${timeoutMs / 1000} s`,
    );
    let done = false;
    const finish = (forced) => {
      if (done) return;
      done = true;
      const secs = ((now() - t0) / 1000).toFixed(1);
      if (forced) {
        log.warn(
          `[agentswarms] ${who} drain timed out after ${secs} s; closed the requests still open`,
        );
      } else {
        log.log(`[agentswarms] ${who} drained in ${secs} s`);
      }
      exit(0);
    };
    const close = () => {
      const timer = setTimer(() => {
        // close(true) ends every connection, so the pending close() below
        // settles too; `done` makes sure only one of them exits.
        Promise.resolve()
          .then(() => server.close?.(true))
          .catch(() => {})
          .finally(() => finish(true));
      }, timeoutMs);
      Promise.resolve()
        .then(() => server.close?.())
        .catch(() => {})
        .finally(() => {
          clearTimer(timer);
          finish(false);
        });
    };
    if (delayMs > 0) setTimer(close, delayMs);
    else close();
  };
}

/** Install createDrain() on SIGTERM and SIGINT. Returns the drain function. */
export function installDrain(options, proc = process) {
  const drain = createDrain(options);
  for (const signal of ["SIGTERM", "SIGINT"]) proc.on(signal, () => drain(signal));
  return drain;
}
