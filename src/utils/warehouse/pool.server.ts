// Connection pooling for the wire-protocol drivers (PostgreSQL and MySQL
// families). The HTTP drivers need none of this — fetch already keeps sockets
// alive underneath.
//
// WHY: measured against a local Postgres, opening a connection cost 24.9ms of
// a 27.1ms `SELECT 1` — 92% of the query. That is the friendliest possible
// case: it is a loopback socket with no TLS. A managed database over the
// internet with ssl=require pays a TCP handshake, a TLS handshake and SCRAM
// auth — four to five extra round trips — before the first byte of SQL. The
// catalog crawler, schema browsing, connection tests and dashboard tiles are
// all short queries, and they were paying that every single time.
//
// THE POOL KEY IS THE SECURITY BOUNDARY. It is a hash of EVERY connection
// parameter including the password, not the connection's row id and not its
// host. Two consequences, both deliberate:
//
//   * Two tenants pointed at the same host and database with different
//     credentials get different pools. Keying on host+database would hand one
//     tenant a session authenticated as the other.
//   * Rotating a password changes the key, so the next query builds a fresh
//     pool rather than reusing a session authenticated with the old one. The
//     stale pool then ages out on the idle sweep.
//
// Pools are per process. Behind a load balancer each instance keeps its own,
// the same trade-off the concurrency governor makes.

import { createHash } from "node:crypto";

import { FAMILY_DEFAULT_PORT } from "./types";

type PgPool = import("pg").Pool;
type MySqlPool = import("mysql2/promise").Pool;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** Pooling is on by default; set WAREHOUSE_POOL=off to go back to per-query connections. */
export function poolingEnabled(): boolean {
  return !/^(0|off|false|no)$/i.test((process.env.WAREHOUSE_POOL ?? "").trim());
}

/** Sockets held open per distinct credential set. */
function maxPerPool(): number {
  return envInt("WAREHOUSE_POOL_MAX", 4);
}

/** How long an unused socket is kept before the driver closes it. */
function idleMs(): number {
  return envInt("WAREHOUSE_POOL_IDLE_MS", 30_000);
}

/**
 * How long a whole pool is kept after its last use.
 *
 * Distinct from idleMs: that closes sockets, this drops the pool object and
 * its cached credentials. Without it, every connection ever queried would keep
 * an entry — and its password — resident for the life of the process.
 */
function poolTtlMs(): number {
  return envInt("WAREHOUSE_POOL_TTL_MS", 5 * 60_000);
}

/** Distinct credential sets held at once, before the least-recently-used goes. */
function maxPools(): number {
  return envInt("WAREHOUSE_POOL_MAX_KEYS", 64);
}

export type PoolConnConfig = {
  host: string;
  port?: string | number;
  database: string;
  username: string;
  password: string;
  ssl?: string;
};

type Entry = {
  key: string;
  family: "postgres" | "mysql";
  pool: PgPool | MySqlPool;
  lastUsed: number;
  /** Set when the pool is being torn down, so a racing borrow doesn't use it. */
  closing?: boolean;
};

const pools = new Map<string, Entry>();
let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Identity of a pool: every parameter that affects WHO the session is
 * authenticated as, hashed.
 *
 * Hashed rather than stored raw so a password never lands in a log line, a
 * heap dump keyed by string, or an error message. Truncated to 32 hex chars —
 * 128 bits, far past collision risk for a map that holds at most 64 entries.
 */
export function poolKey(family: string, cfg: PoolConnConfig): string {
  const parts = [
    family,
    cfg.host,
    String(cfg.port ?? ""),
    cfg.database,
    cfg.username,
    cfg.password,
    cfg.ssl ?? "",
  ];
  // Length-prefixed so ("ab","c") and ("a","bc") cannot produce one string.
  const canonical = parts.map((p) => `${p.length}:${p}`).join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function touchSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepIdlePools();
  }, 60_000);
  // Never hold the process open for the sweep alone — this matters for the
  // CLI scripts and for tests, which would otherwise hang on exit.
  sweepTimer.unref?.();
}

async function destroy(entry: Entry): Promise<void> {
  if (entry.closing) return;
  entry.closing = true;
  pools.delete(entry.key);
  try {
    await entry.pool.end();
  } catch {
    // A pool whose server already went away throws on end(). Dropping it is
    // the whole point of this call, so there is nothing to recover.
  }
}

/** Close pools unused for longer than the TTL. */
export async function sweepIdlePools(): Promise<number> {
  const cutoff = Date.now() - poolTtlMs();
  const stale = [...pools.values()].filter((e) => e.lastUsed < cutoff);
  await Promise.all(stale.map(destroy));
  if (pools.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  return stale.length;
}

/** Drop the least-recently-used pools until we are back under the cap. */
async function evictOverflow(): Promise<void> {
  if (pools.size <= maxPools()) return;
  const byAge = [...pools.values()].sort((a, b) => a.lastUsed - b.lastUsed);
  await Promise.all(byAge.slice(0, pools.size - maxPools()).map(destroy));
}

async function createPgPool(cfg: PoolConnConfig): Promise<PgPool> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    host: cfg.host,
    port: Number(cfg.port) || FAMILY_DEFAULT_PORT.postgres,
    database: cfg.database,
    user: cfg.username,
    password: cfg.password,
    ssl: cfg.ssl === "require" ? { rejectUnauthorized: false } : undefined,
    max: maxPerPool(),
    idleTimeoutMillis: idleMs(),
    connectionTimeoutMillis: 15_000,
    query_timeout: 60_000,
  });
  // MANDATORY, not defensive. `pg` emits 'error' on an IDLE client when the
  // server closes the socket — a database restart, an idle-session timeout, a
  // failover. An 'error' event with no listener is an unhandled exception in
  // Node and takes the whole process down. Without this line, pooling would
  // turn a routine database restart into an app outage.
  pool.on("error", (err) => {
    console.warn("[warehouse-pool] idle postgres client error:", err.message);
  });
  return pool;
}

async function createMySqlPool(cfg: PoolConnConfig): Promise<MySqlPool> {
  const mysql = await import("mysql2/promise");
  const pool = mysql.createPool({
    host: cfg.host,
    port: Number(cfg.port) || FAMILY_DEFAULT_PORT.mysql,
    database: cfg.database,
    user: cfg.username,
    password: cfg.password,
    ssl: cfg.ssl === "require" ? { rejectUnauthorized: false } : undefined,
    connectionLimit: maxPerPool(),
    idleTimeout: idleMs(),
    connectTimeout: 15_000,
    waitForConnections: true,
    // Bounded rather than unlimited: a burst that outruns the pool should fail
    // with the driver's own queue error, not accumulate callbacks for ever.
    queueLimit: 64,
  });
  // NO 'error' LISTENER HERE, AND THAT IS DELIBERATE — do not add one to match
  // the Postgres pool above. mysql2 attaches its own `once('error')` to every
  // pooled connection (lib/pool_connection.js) which evicts it from the pool,
  // so an error is never unhandled. The Pool object itself emits no events at
  // all, so a listener here would be dead code that looks like protection.
  return pool;
}

/**
 * Borrow the pool for this exact credential set, creating it if needed.
 *
 * Returns null when pooling is disabled, so callers fall back to their
 * original per-query connection rather than branching on config themselves.
 */
export async function getPool(
  family: "postgres" | "mysql",
  cfg: PoolConnConfig,
): Promise<PgPool | MySqlPool | null> {
  if (!poolingEnabled()) return null;

  const key = poolKey(family, cfg);
  const existing = pools.get(key);
  if (existing && !existing.closing) {
    existing.lastUsed = Date.now();
    return existing.pool;
  }

  const pool = family === "postgres" ? await createPgPool(cfg) : await createMySqlPool(cfg);

  // Re-check: two queries for a cold connection race here, and both awaited a
  // dynamic import. Keep the pool that landed first and discard ours, or we
  // leak one that nothing will ever close.
  const raced = pools.get(key);
  if (raced && !raced.closing) {
    void pool.end().catch(() => {});
    raced.lastUsed = Date.now();
    return raced.pool;
  }

  pools.set(key, { key, family, pool, lastUsed: Date.now() });
  touchSweep();
  await evictOverflow();
  return pool;
}

/** Snapshot for /api/metrics and debugging. Never exposes a key's inputs. */
export function warehousePoolStats(): {
  enabled: boolean;
  pools: number;
  maxPools: number;
  maxPerPool: number;
} {
  return {
    enabled: poolingEnabled(),
    pools: pools.size,
    maxPools: maxPools(),
    maxPerPool: maxPerPool(),
  };
}

/** Close every pool. For test teardown and graceful shutdown. */
export async function closeAllPools(): Promise<void> {
  await Promise.all([...pools.values()].map(destroy));
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
