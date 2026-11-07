// A read-only client for a Hive Metastore's Thrift service.
//
// Everything Spark, Trino, Flink and Hive itself agree a table is lives here:
// columns, partition keys, location, file format, table type, view text. This
// client reads that and nothing else. It sends no write call at all, so a crawl
// cannot change a metastore however it is pointed.
//
// THE SOCKET IS PINNED LIKE EVERY OTHER DRIVER'S. The host is user-supplied and
// the port is theirs too, so a metastore is held to the rule the wire-protocol
// databases follow (network.server.ts): the host is checked before connecting,
// literal addresses included, because net.connect skips `lookup` for those, and
// the socket then connects only to an address that has just passed.
//
// NOT SPOKEN: SASL. A Kerberos-secured metastore wraps Thrift in a SASL
// exchange this client does not do. It closes on the first plain message, and
// that close is reported as what it most likely means.
import { connect as netConnect, type Socket } from "node:net";

import { assertWarehouseNetwork, connectionLookup } from "@/utils/warehouse/network.server";
import type { WarehouseConfig } from "@/utils/warehouse/types";

import {
  encodeCall,
  int,
  list,
  MESSAGE_EXCEPTION,
  readMessage,
  str,
  stringMap,
  struct,
  T,
  ThriftProtocolError,
  type ByteSource,
  type ThriftStruct,
  type ThriftValue,
  type ThriftWriter,
} from "./thrift";
import type { HiveDatabase, HiveField, HiveTable } from "./mapping";

export type HiveMetastoreConfig = {
  host: string;
  port: number;
  /** TFramedTransport, when the metastore sets metastore.thrift.framed.transport.enabled. */
  framed?: boolean;
  /** Refuse any path to this host that is not private (R422). */
  require_private?: boolean;
};

export const HIVE_DEFAULT_PORT = 9083;

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
/** The most one reply may be. A batch of tables is well under it. */
const MAX_REPLY_BYTES = 64 * 1024 * 1024;

/** A metastore's own "no": a declared exception, or a Thrift application error. */
export class MetastoreError extends Error {
  constructor(
    message: string,
    /** The method is not in this metastore's API (TApplicationException type 1). */
    readonly unknownMethod = false,
  ) {
    super(message);
    this.name = "MetastoreError";
  }
}

/** The connection cannot be used any more: closed, timed out, or out of step. */
export class MetastoreTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetastoreTransportError";
  }
}

const closedMessage = (cfg: HiveMetastoreConfig) =>
  `${cfg.host}:${cfg.port} closed the connection without answering. Check it is a Hive Metastore ` +
  `(the Thrift port, 9083 by default). A metastore secured with Kerberos closes like this too, ` +
  `and this connector does not speak SASL.`;

/** Bytes as they arrive, handed out in exact sizes. */
class SocketBytes implements ByteSource {
  private chunks: Buffer[] = [];
  private available = 0;
  private used = 0;
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null =
    null;
  private failure: Error | null = null;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.available += chunk.length;
    this.settle();
  }

  fail(e: Error): void {
    this.failure ??= e;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(this.failure);
  }

  /** A new message gets the whole budget. */
  startMessage(): void {
    this.used = 0;
  }

  remaining(): number {
    return MAX_REPLY_BYTES - this.used;
  }

  private take(n: number): Buffer {
    this.available -= n;
    this.used += n;
    const first = this.chunks[0];
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0];
      const part = Math.min(c.length, n - at);
      c.copy(out, at, 0, part);
      at += part;
      if (part === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(part);
    }
    return out;
  }

  private settle(): void {
    if (this.waiter && this.available >= this.waiter.n) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(this.take(w.n));
    }
  }

  read(n: number): Promise<Buffer> {
    if (n > this.remaining()) {
      return Promise.reject(
        new ThriftProtocolError(`The reply is larger than the ${MAX_REPLY_BYTES} bytes allowed`),
      );
    }
    // Bytes already here are handed over even after a close: the reply may
    // have arrived whole just before it.
    if (this.available >= n) return Promise.resolve(this.take(n));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
    });
  }
}

/** One connection. Thrift answers in order, so calls run one at a time. */
export class MetastoreConnection {
  private seqid = 0;
  private broken: Error | null = null;
  /** This metastore predates the request-struct call (see getTables). */
  legacyTableCalls = false;

  private constructor(
    private readonly cfg: HiveMetastoreConfig,
    private readonly socket: Socket,
    private readonly bytes: SocketBytes,
  ) {}

  static async open(cfg: HiveMetastoreConfig): Promise<MetastoreConnection> {
    // A metastore is a wire protocol like Postgres, and held to the same check.
    await assertWarehouseNetwork({
      provider: "postgres",
      host: cfg.host,
      require_private: cfg.require_private,
    } as unknown as WarehouseConfig);
    const bytes = new SocketBytes();
    const socket = netConnect({
      host: cfg.host,
      port: cfg.port,
      lookup: connectionLookup({ require_private: cfg.require_private }),
    });
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new MetastoreTransportError(
            `Nothing answered at ${cfg.host}:${cfg.port} within ${CONNECT_TIMEOUT_MS / 1000}s. ` +
              `Check the host, the port, and that this server can reach it.`,
          ),
        );
      }, CONNECT_TIMEOUT_MS);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (e) => {
        clearTimeout(timer);
        const code = (e as NodeJS.ErrnoException).code;
        reject(
          code === "ECONNREFUSED"
            ? new MetastoreTransportError(
                `${cfg.host}:${cfg.port} refused the connection: nothing is listening on that port.`,
              )
            : e,
        );
      });
    });
    socket.on("data", (c: Buffer) => bytes.push(c));
    socket.on("error", (e) => bytes.fail(new MetastoreTransportError(e.message)));
    socket.on("close", () => bytes.fail(new MetastoreTransportError(closedMessage(cfg))));
    return new MetastoreConnection(cfg, socket, bytes);
  }

  close(): void {
    this.socket.destroy();
  }

  /** Whether the last failure left this connection unusable. */
  get isBroken(): boolean {
    return this.broken !== null;
  }

  private async exchange(frame: Buffer): Promise<void> {
    const out = this.cfg.framed
      ? Buffer.concat([
          (() => {
            const size = Buffer.allocUnsafe(4);
            size.writeInt32BE(frame.length);
            return size;
          })(),
          frame,
        ])
      : frame;
    this.socket.write(out);
    if (this.cfg.framed) {
      this.bytes.startMessage();
      const size = (await this.bytes.read(4)).readInt32BE(0);
      if (size <= 0 || size > this.bytes.remaining()) {
        throw new ThriftProtocolError("The port answered, but not with Thrift");
      }
    }
  }

  /**
   * One call: the reply's result struct, or its exception as MetastoreError.
   * A timeout or a protocol fault leaves bytes in flight that belong to no
   * one, so the connection is marked broken rather than reused out of step.
   */
  async call(method: string, args: (w: ThriftWriter) => void): Promise<ThriftStruct> {
    if (this.broken) throw this.broken;
    const seqid = ++this.seqid;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        (async () => {
          this.bytes.startMessage();
          await this.exchange(encodeCall(method, seqid, args));
          return readMessage(this.bytes);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new MetastoreTransportError(
                  `${this.cfg.host}:${this.cfg.port} did not answer ${method} within ` +
                    `${CALL_TIMEOUT_MS / 1000}s.`,
                ),
              ),
            CALL_TIMEOUT_MS,
          );
        }),
      ]);
      if (reply.seqid !== seqid) {
        throw new ThriftProtocolError("The reply answered a different call");
      }
      if (reply.type === MESSAGE_EXCEPTION) {
        // TApplicationException: 1 message, 2 type; 1 is UNKNOWN_METHOD.
        throw new MetastoreError(
          str(reply.body, 1) ?? `${method} failed`,
          int(reply.body, 2) === 1,
        );
      }
      for (const [id, value] of reply.body) {
        // Field 0 is the result. Anything else is a declared exception, and
        // every metastore exception carries its message in field 1.
        if (id !== 0 && value instanceof Map) {
          throw new MetastoreError(str(value as ThriftStruct, 1) ?? `${method} failed`);
        }
      }
      return reply.body;
    } catch (e) {
      if (!(e instanceof MetastoreError)) {
        this.broken = e instanceof Error ? e : new Error(String(e));
        this.socket.destroy();
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Reading what a metastore sends ───────────────────────────────────────

const stringList = (s: ThriftStruct, id: number): string[] =>
  list(s, id).filter((v): v is string => typeof v === "string");

/** FieldSchema: 1 name, 2 type, 3 comment. */
function toField(s: ThriftStruct): HiveField | null {
  const name = str(s, 1);
  if (!name) return null;
  const comment = str(s, 3);
  return { name, type: str(s, 2) ?? "unknown", ...(comment ? { comment } : {}) };
}

const fields = (s: ThriftStruct | undefined, id: number): HiveField[] =>
  s
    ? list(s, id).flatMap((v) => {
        const f = v instanceof Map ? toField(v as ThriftStruct) : null;
        return f ? [f] : [];
      })
    : [];

/** Table (hive_metastore.thrift): the fields a catalog has a use for. */
export function toHiveTable(t: ThriftStruct, database: string): HiveTable | null {
  const name = str(t, 1);
  if (!name) return null;
  const sd = struct(t, 7); // StorageDescriptor
  const serde = sd ? struct(sd, 7) : undefined; // SerDeInfo
  return {
    database: str(t, 2) ?? database,
    name,
    owner: str(t, 3),
    createTime: int(t, 4),
    tableType: str(t, 12),
    location: sd ? str(sd, 2) : undefined,
    inputFormat: sd ? str(sd, 3) : undefined,
    outputFormat: sd ? str(sd, 4) : undefined,
    compressed: sd?.get(5) === true,
    numBuckets: sd ? int(sd, 6) : undefined,
    bucketCols: sd ? stringList(sd, 8) : [],
    serde: serde ? str(serde, 2) : undefined,
    serdeParameters: serde ? stringMap(serde, 3) : {},
    columns: fields(sd, 1),
    partitionKeys: fields(t, 8),
    parameters: stringMap(t, 9),
    viewOriginalText: str(t, 10),
    viewExpandedText: str(t, 11),
  };
}

const oneString = (id: number, value: string) => (w: ThriftWriter) => {
  w.field(T.STRING, id);
  w.string(value);
};

/** getVersion, from fb303. Only a label, so a metastore without it is fine. */
export async function metastoreVersion(c: MetastoreConnection): Promise<string | null> {
  try {
    return str(await c.call("getVersion", () => {}), 0) ?? null;
  } catch (e) {
    if (e instanceof MetastoreError) return null;
    throw e;
  }
}

export async function listDatabases(c: MetastoreConnection): Promise<string[]> {
  return stringList(await c.call("get_all_databases", () => {}), 0);
}

/** Database: 1 name, 2 description, 3 locationUri, 6 ownerName. */
export async function getDatabase(c: MetastoreConnection, name: string): Promise<HiveDatabase> {
  const reply = await c.call("get_database", oneString(1, name));
  const db = struct(reply, 0);
  return {
    name,
    description: db ? str(db, 2) : undefined,
    location: db ? str(db, 3) : undefined,
    owner: db ? str(db, 6) : undefined,
  };
}

export async function listTables(c: MetastoreConnection, database: string): Promise<string[]> {
  return stringList(await c.call("get_all_tables", oneString(1, database)), 0);
}

const tablesFrom = (values: ThriftValue[], database: string): HiveTable[] =>
  values.flatMap((v) => {
    const t = v instanceof Map ? toHiveTable(v as ThriftStruct, database) : null;
    return t ? [t] : [];
  });

/**
 * Tables in one round trip. What the metastore could not load is simply absent.
 *
 * MEASURED against apache/hive:4.0.1: `get_table_objects_by_name`, the call
 * every older client uses, is gone ("Invalid method name"). Its replacement
 * takes a request struct. So the newer one is tried first, and a metastore that
 * has never heard of it gets the older one. The answer is kept on the
 * connection: a crawl is thousands of these, and one wrong guess each would be
 * thousands of calls. Both are proved against real servers, 3.1.3 and 4.0.1.
 */
export async function getTables(
  c: MetastoreConnection,
  database: string,
  names: string[],
): Promise<HiveTable[]> {
  if (!c.legacyTableCalls) {
    try {
      const reply = await c.call("get_table_objects_by_name_req", (w) => {
        w.field(T.STRUCT, 1); // the request
        w.field(T.STRING, 1); // GetTablesRequest.dbName
        w.string(database);
        w.field(T.LIST, 2); // GetTablesRequest.tblNames
        w.list(T.STRING, names.length);
        for (const n of names) w.string(n);
        w.stop();
      });
      const result = struct(reply, 0); // GetTablesResult
      return tablesFrom(result ? list(result, 1) : [], database);
    } catch (e) {
      if (!(e instanceof MetastoreError && e.unknownMethod)) throw e;
      c.legacyTableCalls = true;
    }
  }
  const reply = await c.call("get_table_objects_by_name", (w) => {
    w.field(T.STRING, 1);
    w.string(database);
    w.field(T.LIST, 2);
    w.list(T.STRING, names.length);
    for (const n of names) w.string(n);
  });
  return tablesFrom(list(reply, 0), database);
}

/** Partition names, up to `max`: "dt=2026-01-01/region=emea". Names only: cheap. */
export async function listPartitionNames(
  c: MetastoreConnection,
  database: string,
  table: string,
  max: number,
): Promise<string[]> {
  const reply = await c.call("get_partition_names", (w) => {
    w.field(T.STRING, 1);
    w.string(database);
    w.field(T.STRING, 2);
    w.string(table);
    w.field(T.I16, 3);
    w.i16(max);
  });
  return stringList(reply, 0);
}

/** Open a connection, run `fn`, and close it whatever happened. */
export async function withMetastore<R>(
  cfg: HiveMetastoreConfig,
  fn: (c: MetastoreConnection) => Promise<R>,
): Promise<R> {
  const c = await MetastoreConnection.open(cfg);
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}
