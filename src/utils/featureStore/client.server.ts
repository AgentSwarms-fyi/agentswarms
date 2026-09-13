/**
 * The connection to the online feature store.
 *
 * One socket per process, lazily opened, speaking RESP2 to valkey (or to any
 * redis-compatible server an operator points FEATURE_STORE_URL at).
 *
 * THE RULE THIS FILE IS BUILT AROUND: a feature store that is down, slow or
 * broken must never make a lookup worse than it was before the store existed.
 * That is not achieved by a try/catch — a catch still pays the timeout, on
 * every request, and a serving path that waits 2 s to discover the same dead
 * socket 500 times has turned an optimisation into an outage. So a failure
 * OPENS A BREAKER: calls return null immediately for a cooldown, the lookup
 * goes to the lakehouse exactly as it always did, and one probe after the
 * cooldown decides whether to close it again.
 */
import net from "node:net";

import { encodeCommand, parseReplies, RespError, type RespValue } from "@/lib/resp";

/** How long a connect or a command may take before the socket is abandoned. */
const CONNECT_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 2_000;
/** How long the breaker stays open after a failure. */
const BREAKER_MS = 30_000;

type Pending = {
  want: number;
  got: RespValue[];
  resolve: (v: RespValue[]) => void;
  timer: NodeJS.Timeout;
};

let socket: net.Socket | null = null;
let connecting: Promise<net.Socket | null> | null = null;
let buffer = new Uint8Array(0);
let queue: Pending[] = [];
let breakerUntil = 0;
let lastError: string | null = null;

/** Where the store is. Unset means the feature is off and nothing is attempted. */
export function featureStoreUrl(): string | null {
  const raw = process.env.FEATURE_STORE_URL?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function parseUrl(url: string): { host: string; port: number } | null {
  try {
    // `redis://host:port` and `valkey://host:port` both parse; a bare
    // `host:port` is accepted too, because that is what an operator types.
    const withScheme = /:\/\//.test(url) ? url : `redis://${url}`;
    const u = new URL(withScheme);
    return { host: u.hostname, port: Number(u.port || 6379) };
  } catch {
    return null;
  }
}

function fail(why: string): void {
  lastError = why;
  breakerUntil = Date.now() + BREAKER_MS;
  const s = socket;
  socket = null;
  buffer = new Uint8Array(0);
  const waiting = queue;
  queue = [];
  for (const p of waiting) {
    clearTimeout(p.timer);
    // An empty array, never a rejection: every caller here treats "no answer"
    // as "read it from the lakehouse", and a throw would make each of them
    // write the same catch.
    p.resolve([]);
  }
  s?.destroy();
}

function onData(chunk: Buffer): void {
  const grown = new Uint8Array(buffer.length + chunk.length);
  grown.set(buffer);
  grown.set(chunk, buffer.length);
  const { replies, consumed } = parseReplies(grown);
  buffer = grown.subarray(consumed);
  for (const r of replies) {
    const head = queue[0];
    if (!head) continue;
    head.got.push(r);
    if (head.got.length >= head.want) {
      queue.shift();
      clearTimeout(head.timer);
      head.resolve(head.got);
    }
  }
}

async function connect(): Promise<net.Socket | null> {
  const url = featureStoreUrl();
  if (!url) return null;
  const addr = parseUrl(url);
  if (!addr) {
    fail(`FEATURE_STORE_URL is not a host:port — ${url}`);
    return null;
  }
  return new Promise<net.Socket | null>((resolve) => {
    const s = net.createConnection({ host: addr.host, port: addr.port });
    const timer = setTimeout(() => {
      s.destroy();
      fail(`no answer from ${addr.host}:${addr.port} within ${CONNECT_TIMEOUT_MS} ms`);
      resolve(null);
    }, CONNECT_TIMEOUT_MS);
    s.once("connect", () => {
      clearTimeout(timer);
      s.setNoDelay(true);
      s.on("data", onData);
      s.on("error", (e) => fail(e.message));
      s.on("close", () => {
        if (socket === s) fail("connection closed");
      });
      socket = s;
      lastError = null;
      resolve(s);
    });
    s.once("error", (e) => {
      clearTimeout(timer);
      fail(e.message);
      resolve(null);
    });
  });
}

/**
 * Send commands and wait for their replies, or give up at once.
 *
 * Commands are written in ONE go and their replies counted in order, which is
 * pipelining: a refresh writing 50,000 keys as 50,000 round trips would be
 * slower than the lakehouse it is replacing.
 */
export async function call(commands: (string | number)[][]): Promise<RespValue[] | null> {
  if (commands.length === 0) return [];
  if (!featureStoreUrl()) return null;
  if (Date.now() < breakerUntil) return null;

  if (!socket) {
    connecting = connecting ?? connect();
    const s = await connecting;
    connecting = null;
    if (!s) return null;
  }
  const live = socket;
  if (!live) return null;

  let size = 0;
  const encoded = commands.map((c) => encodeCommand(c));
  for (const e of encoded) size += e.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const e of encoded) {
    out.set(e, at);
    at += e.length;
  }

  return new Promise<RespValue[] | null>((resolve) => {
    const pending: Pending = {
      want: commands.length,
      got: [],
      resolve: (v) => resolve(v.length === commands.length ? v : null),
      timer: setTimeout(() => {
        // A server that accepted the write and never answered leaves this
        // connection desynchronised — the reply may still arrive and would be
        // handed to whoever asked next. Dropping the socket is the only way
        // to be sure that cannot happen.
        fail(`no reply within ${COMMAND_TIMEOUT_MS} ms`);
      }, COMMAND_TIMEOUT_MS),
    };
    queue.push(pending);
    live.write(out, (err) => {
      if (err) fail(err.message);
    });
  });
}

/** One command, for the common case. Null means "the store did not answer". */
export async function one(command: (string | number)[]): Promise<RespValue | null> {
  const r = await call([command]);
  if (!r || r.length === 0) return null;
  return r[0];
}

/**
 * Whether the last thing the store did was fail, and what it said.
 *
 * `breakerOpen` carries the CONVENTIONAL sense: open means calls are being
 * short-circuited and nothing is being sent. A first version called the same
 * field `open` and meant the opposite — usable — which reads as fine until
 * somebody writes `if (status.open) useTheStore()` and gets it exactly
 * backwards on the one path where it matters.
 */
export function storeStatus(): { configured: boolean; breakerOpen: boolean; error: string | null } {
  return {
    configured: featureStoreUrl() !== null,
    breakerOpen: Date.now() < breakerUntil,
    error: lastError,
  };
}

/** Is the server actually answering? Used by the admin probe and the panel. */
export async function ping(): Promise<boolean> {
  const r = await one(["PING"]);
  return r === "PONG";
}

/** Close the socket — for tests and for a clean shutdown. */
export function disconnect(): void {
  const s = socket;
  socket = null;
  buffer = new Uint8Array(0);
  for (const p of queue) clearTimeout(p.timer);
  queue = [];
  breakerUntil = 0;
  lastError = null;
  s?.destroy();
}

export { RespError };
