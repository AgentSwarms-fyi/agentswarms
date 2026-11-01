// The primary's side of the worker pool, for server.mjs.
//
// A worker that dies is replaced, except during shutdown, where refilling the
// pool would stop the container from ever exiting.
//
// A worker that refuses to start because the credential keyring did not load
// (an external KMS that cannot unwrap the data key) exits with EXIT_KEYRING.
// FOUND FROM THE UI (R430): the primary replaced those like any crash, at
// once and for ever, so a KMS that could not be reached at boot looked like a
// "running" container whose log scrolled one refusal after another, and the
// docs' "refuses to start" was not what an operator saw. Now:
//
// - before any worker has come up, one refusal stops the whole process with
//   the same code, so the container runtime's restart policy and its back-off
//   take over and the state is visible (Exited (78), CrashLoopBackOff);
// - once one has, a refusal is a replacement worker meeting a KMS outage
//   while the others serve with the key they unwrapped at boot. Taking them
//   down would turn the outage into one of ours (KEY_MANAGEMENT's failure
//   modes: unreachable while running changes nothing), so the replacement
//   waits instead, doubling from one second to a minute.

/** EX_CONFIG from sysexits.h: the keyring did not load, so this worker will not serve. */
export const EXIT_KEYRING = 78;

/** The message a worker sends once it is listening. */
export const LISTENING = "agentswarms:listening";

/** In a worker: tell the primary this one is serving. */
export function reportListening(proc = process) {
  proc.send?.({ type: LISTENING });
}

/**
 * Supervise the forked workers. Returns `shutdown(signal)`, which passes the
 * signal on and stops refilling the pool.
 */
export function superviseWorkers({
  cluster,
  log = console,
  exit = (code) => process.exit(code),
  setTimer = setTimeout,
  firstDelayMs = 1000,
  maxDelayMs = 60_000,
}) {
  let shuttingDown = false;
  let anyListening = false;
  let delay = firstDelayMs;

  const killAll = (signal) => {
    for (const w of Object.values(cluster.workers ?? {})) w?.kill(signal);
  };

  cluster.on("message", (_worker, msg) => {
    if (msg?.type !== LISTENING) return;
    anyListening = true;
    delay = firstDelayMs;
  });

  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) return;
    if (code === EXIT_KEYRING && !anyListening) {
      shuttingDown = true;
      log.error(
        `[agentswarms] no worker could load the credential keyring; stopping with exit code ${EXIT_KEYRING} so the container runtime restarts it`,
      );
      killAll("SIGTERM");
      exit(EXIT_KEYRING);
      return;
    }
    if (code === EXIT_KEYRING) {
      const wait = delay;
      delay = Math.min(delay * 2, maxDelayMs);
      log.warn(
        `[agentswarms] worker ${worker.process.pid} could not load the credential keyring; the other workers keep serving, and a replacement starts in ${wait / 1000} s`,
      );
      setTimer(() => {
        if (!shuttingDown) cluster.fork();
      }, wait);
      return;
    }
    log.warn(`[agentswarms] worker ${worker.process.pid} exited (${signal || code}) — restarting`);
    cluster.fork();
  });

  return {
    shutdown(signal) {
      shuttingDown = true;
      killAll(signal);
    },
  };
}
