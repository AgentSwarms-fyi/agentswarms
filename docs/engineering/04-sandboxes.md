# 04 · Sandboxes

> Part of [The engineering behind AgentSwarms](./README.md).

Three places in this product execute code somebody else wrote. They have three
different isolation designs, because they have three different threat models —
and the differences are not arbitrary.

| Sandbox                        | Runs                                  | Threat                                                                  | Isolation                                       |
| ------------------------------ | ------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| `src/lib/sandbox/jsSandbox.ts` | Function nodes on the canvas          | A shared swarm carrying hostile JS, executed with your session in scope | Web Worker with globals deleted                 |
| `services/js-sandbox/`         | Function nodes in headless runs       | Same code, unattended, on the server that holds every secret            | Separate container, no secrets, no egress       |
| `docker/notebook-runtime/`     | Python kernels and hosted MCP servers | Long-lived user code that is _supposed_ to reach the network            | Container per server, default-deny egress proxy |

---

## The browser Worker

The threat here is specific and was real before it was fixed: **swarms are
shareable.** Importing someone's swarm JSON and pressing Run executes their
`function` nodes in your tab.

The first implementation compiled user code with `new Function` in the page realm
and shadowed the dangerous globals — `window`, `fetch`, `localStorage` — as
`undefined` variables. That is porous, and the source spells out exactly how:

```js
({}).constructor.constructor("return fetch")();
```

Shadowing hides _identifiers_. The real `Function` constructor is still reachable
through any object's prototype chain, and it compiles the new function in the
**global** scope, where none of the shadow variables apply. From there user code
had the page's `fetch` and `localStorage` — which is to say, the signed-in
Supabase session token.

The current design closes that with four properties, and the second is the one
that matters:

1. A Worker has its own realm. No `window`, no `document`, no page variables.
   `localStorage` does not exist there at all.
2. The bootstrap **deletes** the remaining dangerous globals from the worker's
   own `globalThis` before any user code runs. Deleting rather than shadowing is
   what makes the constructor escape harmless — escaped code resolves names
   against the global object, and those names are simply gone.
3. User code cannot see the bootstrap's module-scope bindings, so it cannot reach
   the `postMessage` the parent uses to reply.
4. Timeouts are enforced with `worker.terminate()`, which kills even a
   synchronous infinite loop. The previous version could hang the tab and
   documented that as an accepted limitation; it no longer applies.

**Residual risk, deliberately kept:** the snippet can burn CPU for up to
`timeoutMs` on a background thread, and it can read the `ctx` it was handed —
that being the entire point of the node.

---

## The JS sandbox service

Headless runs cannot use a Worker, and the app process is the worst possible
place to make up the difference: it holds the service-role key, provider
credentials and the database connection. Before this service existed, the
executor simply refused custom code.

`services/js-sandbox/server.mjs` is a stateless HTTP service whose entire job is
to be a safe place to lose. The defences stack:

- **It holds no secrets.** Nothing in the process is worth stealing.
- **No route out.** It sits on an internal Docker network with no egress.
- **Non-root, read-only filesystem, every capability dropped.**
- **A fresh realm per request**, inside a worker thread that is terminated
  afterwards.
- **It refuses to start without `INTERNAL_RUN_SECRET`** (or the service-role key
  as fallback), so an accidentally-exposed port is not an open
  code-execution endpoint. Callers are checked with `timingSafeEqual`.

The ceilings are ones **the caller cannot raise** — a deployed swarm is
unattended, so a bad snippet must not be able to pin a core indefinitely:

| Variable                    | Default | Bounds                  |
| --------------------------- | ------- | ----------------------- |
| `JS_SANDBOX_MAX_TIMEOUT_MS` | 5000    | One execution           |
| `JS_SANDBOX_MAX_CONCURRENT` | 4       | Simultaneous executions |
| `JS_SANDBOX_MEM_MB`         | 128     | Heap per execution      |
| `JS_SANDBOX_MAX_BODY_BYTES` | 1000000 | Request size            |

`JS_SANDBOX_URL` is optional, and _optional does not mean in-process_.
`src/utils/jsSandbox.server.ts` probes `http://js-sandbox:8091` (the Compose
service name) then `http://127.0.0.1:8091` (the published port, for host
development), caching the result for 60 seconds. If nothing answers, the node is
refused with a message explaining how to enable it — "rather than pretending the
node ran".

### Keeping the two honest

Two sandboxes implementing one contract is a divergence waiting to happen, so
`tests/unit/sandboxParity.test.ts` pins them to the same behaviour. A component
that works on the canvas must work identically in a scheduled run; if it does
not, that test is where you find out.

---

## Hosted MCP servers

The third sandbox is the notebook runtime, wearing a different hat. A deployed
MCP server is a container from the sandbox image running with `NB_MODE=mcp`,
which is why it inherits the kernel hardening, reconcile loop and reaper rather
than growing its own.

`docker/notebook-runtime/mcp_runner.py` serves **one** user-authored FastMCP
server over Streamable HTTP on `:8888/mcp`. That port is never exposed;
`/api/mcp/s/<slug>` authenticates and proxies inward.

```mermaid
sequenceDiagram
    participant X as External caller
    participant P as /api/mcp/s/&lt;slug&gt;
    participant D as Orchestrator
    participant C as Container (NB_MODE=mcp)

    X->>P: JSON-RPC + API key
    P->>P: key · IP allowlist · origin · method list
    P->>P: tool approval gate · rate + concurrency
    P->>D: ensure a live session
    alt none running
        D->>D: acquire start lease (conditional UPDATE)
        D->>C: start container
        C->>P: fetch source + secrets (authenticated)
        C->>C: pip install declared packages
    end
    P->>C: forward the call
    C-->>X: result
```

**Secrets arrive over HTTP, not in the environment.** The session token already
authenticates the container to the platform, and a response body is not visible
to `docker inspect` or in a Kubernetes pod spec the way env vars are. Bound
secrets therefore exist only in that process's memory — and are scrubbed from
stdout, because container logs surface in the owner's Logs tab and a traceback
through a tool that took a secret as an argument would otherwise print it
verbatim.

**One container per server, not per request.** Concurrent callers share it. Two
mechanisms prevent duplicates: a live-session check, and a start lease
implemented as a single conditional `UPDATE` on the app row — concurrent updates
to one row serialize in Postgres, so exactly one app replica wins and the rest
wait. Without it, two replicas taking a simultaneous first request would each
cold-start a container and orphan one.

**Scale-to-zero.** No container exists until the first call. `COLD_START_MS` is
90 seconds, and the comment explains the number: on an idle machine with the
image pulled, the container appears at ~3s and the session reports ready at ~23s,
with the app's `pip install` happening _inside_ that window. The previous 45s
budget left barely one healthy start of headroom, and the old failure path
destroyed the container it had given up on, so the next attempt paid the full
cold start again instead of finding it seconds from ready.

**Known limit, stated in the product:** egress filtering is a single shared
proxy, so the allow-list applies to every sandbox on the instance. There is no
per-server egress isolation — adding a host for one server adds it for all of
them.

---

## Where this bites you

**"Just run it in-process for now" is never the shortcut it looks like.** Every
one of these designs exists because the alternative put user code next to the
service-role key. The refusal path is the feature.

**Deleting globals is not the same as shadowing them.** If you extend the Worker
bootstrap, add to the delete list — a shadowed binding is bypassed by the
prototype-chain trick above.

**A sandbox with no reachable service should fail loudly.** The pattern this
codebase follows is refuse-and-explain, never silently succeed. A node that
reports success without running is worse than one that errors.

---

Next: [05 · Security model](./05-security-model.md) — the guards that sit in
front of everything else.
