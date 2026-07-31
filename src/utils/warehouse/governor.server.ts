// Limits on what the app is allowed to ask a customer's warehouse to do.
//
// The row ceilings used to be constants compiled into the driver, which meant
// an operator whose Snowflake could comfortably return 50k rows had no way to
// say so, and one paying per byte scanned had no way to tighten it. They are
// read per call now, so a deployment can tune them without a rebuild.
//
// Concurrency is the more important half. Every dashboard tile, prep fold,
// semantic query and agent tool call goes through executeWarehouseQuery, and
// nothing bounded how many could be in flight at once — a shared dashboard with
// twelve direct-query widgets, opened by twenty people, is 240 simultaneous
// warehouse queries originating from one process. Warehouses charge for that,
// and some simply start rejecting connections.

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** Default rows returned when a caller doesn't ask for a specific number. */
export function warehouseMaxRows(): number {
  return envInt("WAREHOUSE_MAX_ROWS", 1000);
}

/** Hard ceiling — no caller may exceed this, whatever it asks for. */
export function warehouseAbsMaxRows(): number {
  return Math.max(warehouseMaxRows(), envInt("WAREHOUSE_ABS_MAX_ROWS", 5000));
}

/** Wall-clock budget for one query, including any result polling. */
export function warehouseTimeoutMs(): number {
  return envInt("WAREHOUSE_QUERY_TIMEOUT_MS", 60_000);
}

function maxConcurrent(): number {
  return envInt("WAREHOUSE_MAX_CONCURRENT", 8);
}

function maxConcurrentPerUser(): number {
  return envInt("WAREHOUSE_MAX_CONCURRENT_PER_USER", 3);
}

/** How long a query will wait for a slot before giving up. */
function queueTimeoutMs(): number {
  return envInt("WAREHOUSE_QUEUE_TIMEOUT_MS", 30_000);
}

type Waiter = { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * A counting semaphore with a bounded wait.
 *
 * Queueing rather than rejecting immediately matters: a dashboard opening
 * twelve tiles at once should render, just not all at the same instant.
 * Waiting forever would be worse than refusing, so the wait is bounded and the
 * failure says which limit was hit.
 */
class Gate {
  private inUse = 0;
  private queue: Waiter[] = [];

  constructor(private readonly label: string) {}

  get active(): number {
    return this.inUse;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async acquire(limit: number, waitMs: number): Promise<void> {
    if (this.inUse < limit) {
      this.inUse++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.queue.findIndex((w) => w.timer === timer);
        if (i !== -1) this.queue.splice(i, 1);
        reject(
          new Error(
            `The warehouse query queue is full (${this.label}); it waited ${Math.round(
              waitMs / 1000,
            )}s for a slot. Try again, or raise WAREHOUSE_MAX_CONCURRENT.`,
          ),
        );
      }, waitMs);
      this.queue.push({ resolve, reject, timer });
    });
    this.inUse++;
  }

  release(): void {
    this.inUse = Math.max(0, this.inUse - 1);
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    }
  }
}

const globalGate = new Gate("server-wide");
const userGates = new Map<string, Gate>();

function gateFor(userId: string): Gate {
  let g = userGates.get(userId);
  if (!g) {
    g = new Gate(`per-user`);
    userGates.set(userId, g);
  }
  return g;
}

/** Drop idle per-user gates so the map doesn't grow with every user seen. */
function reapUserGates(): void {
  if (userGates.size < 512) return;
  for (const [id, g] of userGates) {
    if (g.active === 0 && g.waiting === 0) userGates.delete(id);
  }
}

/**
 * Run `fn` inside the concurrency limits.
 *
 * `userId` is the tenant the query is billed to — the DASHBOARD OWNER for a
 * shared dashboard, not the viewer, so one popular dashboard cannot spend
 * everyone else's slots.
 *
 * NOTE: these limits are per process. Behind a load balancer each instance
 * enforces its own, which is the same trade-off the run limiter makes; a
 * cluster-wide budget would need shared state.
 */
export async function withWarehouseSlot<T>(
  userId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const waitMs = queueTimeoutMs();
  await globalGate.acquire(maxConcurrent(), waitMs);
  const userGate = userId ? gateFor(userId) : null;
  try {
    if (userGate) await userGate.acquire(maxConcurrentPerUser(), waitMs);
  } catch (e) {
    globalGate.release();
    throw e;
  }
  try {
    return await fn();
  } finally {
    if (userGate) userGate.release();
    globalGate.release();
    reapUserGates();
  }
}

/**
 * Fail a query that outruns its wall-clock budget.
 *
 * The drivers already time out individual HTTP calls, but a multi-step poll
 * loop could still run far past any single call's timeout. This bounds the
 * whole operation.
 */
export async function withWarehouseTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `The warehouse query exceeded the ${Math.round(timeoutMs / 1000)}s time limit. ` +
            `Narrow the query, or raise WAREHOUSE_QUERY_TIMEOUT_MS.`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Snapshot for /api/metrics and debugging. */
export function warehouseGovernorStats(): {
  active: number;
  waiting: number;
  limit: number;
  perUserLimit: number;
  users: number;
} {
  return {
    active: globalGate.active,
    waiting: globalGate.waiting,
    limit: maxConcurrent(),
    perUserLimit: maxConcurrentPerUser(),
    users: userGates.size,
  };
}
