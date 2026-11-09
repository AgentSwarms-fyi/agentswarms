// Whether this process is shutting down.
//
// server.mjs sets the flag the moment SIGTERM arrives (serverDrain.mjs), before
// it stops taking connections. The app reads it in two places: the readiness
// probe answers 503 so a balancer stops sending new work, and the scheduler
// stops starting steps so a pass never begins work it will be killed in the
// middle of. A Symbol.for key, because server.mjs and the server bundle are
// different modules in the same process and must agree on one global.
const DRAINING = Symbol.for("agentswarms.draining");

export function isDraining(): boolean {
  return (globalThis as Record<symbol, unknown>)[DRAINING] === true;
}
