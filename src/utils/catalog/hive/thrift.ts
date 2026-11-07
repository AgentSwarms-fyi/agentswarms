// Thrift's binary protocol, as much of it as a Hive Metastore client needs.
//
// A metastore speaks nothing else: there is no HTTP, no information_schema, no
// SQL. The `thrift` package on npm would bring a code generator's output and a
// server's worth of transports for the five calls the crawl makes, and every
// other driver here takes a socket it can pin (network.server.ts), so this is
// the protocol itself: a writer for the calls and a reader for the replies.
//
// THE READER IS GENERIC ON PURPOSE. A reply decodes to field ids and values,
// with no generated structs behind it, and that is what makes it work across
// metastore versions: a field a newer Hive added is one more entry in a Map,
// where a fixed schema would have to know how to skip it. Thrift's wire format
// carries every field's type for exactly this reason.
//
// THE BYTES ARE HOSTILE. The host is typed by a user, so what answers may be
// anything: a port that is not a metastore, or a server built to hurt the one
// reading it. A length on the wire is a claim, not a fact. Every length is
// checked against a budget BEFORE anything is allocated or waited for, a
// declared collection size cannot exceed what the budget could hold, and
// nesting has a floor, so a reply cannot exhaust the heap or the stack.

export const T = {
  STOP: 0,
  BOOL: 2,
  BYTE: 3,
  DOUBLE: 4,
  I16: 6,
  I32: 8,
  I64: 10,
  STRING: 11,
  STRUCT: 12,
  MAP: 13,
  SET: 14,
  LIST: 15,
} as const;

const VERSION_1 = 0x80010000;
const VERSION_MASK = 0xffff0000;

export const MESSAGE_CALL = 1;
export const MESSAGE_REPLY = 2;
export const MESSAGE_EXCEPTION = 3;

/** Nesting a metastore's own structs never come near. */
const MAX_DEPTH = 32;

/** Thrown when the bytes are not what a Thrift server would send. */
export class ThriftProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThriftProtocolError";
  }
}

/** A struct as it arrived: field id to value. */
export type ThriftStruct = Map<number, ThriftValue>;
/** A Thrift map. Its keys are strings once read: metastores key by name. */
export interface ThriftMap {
  [key: string]: ThriftValue;
}
export type ThriftValue = boolean | number | string | ThriftStruct | ThriftValue[] | ThriftMap;

/** What the reader pulls from: exactly `n` bytes, or a rejection. */
export interface ByteSource {
  read(n: number): Promise<Buffer>;
  /** Bytes this reply may still use. Checked before a length is believed. */
  remaining(): number;
}

// ── Writing ──────────────────────────────────────────────────────────────

export class ThriftWriter {
  private readonly parts: Buffer[] = [];

  private push(size: number, write: (b: Buffer) => void): void {
    const b = Buffer.allocUnsafe(size);
    write(b);
    this.parts.push(b);
  }

  byte(v: number): void {
    this.push(1, (b) => b.writeInt8(v));
  }

  i16(v: number): void {
    this.push(2, (b) => b.writeInt16BE(v));
  }

  i32(v: number): void {
    this.push(4, (b) => b.writeInt32BE(v));
  }

  string(v: string): void {
    const bytes = Buffer.from(v, "utf8");
    this.i32(bytes.length);
    this.parts.push(bytes);
  }

  field(type: number, id: number): void {
    this.byte(type);
    this.i16(id);
  }

  stop(): void {
    this.byte(T.STOP);
  }

  list(elementType: number, size: number): void {
    this.byte(elementType);
    this.i32(size);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/** One call, whole: message header, the arguments struct, its stop byte. */
export function encodeCall(method: string, seqid: number, args: (w: ThriftWriter) => void): Buffer {
  const w = new ThriftWriter();
  // A strict header: the version and the message type share the first i32.
  w.i32(VERSION_1 | MESSAGE_CALL | 0);
  w.string(method);
  w.i32(seqid);
  args(w);
  w.stop();
  return w.toBuffer();
}

// ── Reading ──────────────────────────────────────────────────────────────

async function readI32(src: ByteSource): Promise<number> {
  return (await src.read(4)).readInt32BE(0);
}

/** A length off the wire, refused before it is believed. */
function checkedLength(n: number, minElementBytes: number, what: string, src: ByteSource): number {
  if (n < 0 || n * minElementBytes > src.remaining()) {
    throw new ThriftProtocolError(`The reply declared a ${what} of ${n}, which it cannot hold`);
  }
  return n;
}

async function readString(src: ByteSource): Promise<string> {
  const n = checkedLength(await readI32(src), 1, "string", src);
  return n === 0 ? "" : (await src.read(n)).toString("utf8");
}

/** The smallest a value of this type can be, for sizing a declared collection. */
function minBytes(type: number): number {
  switch (type) {
    case T.BOOL:
    case T.BYTE:
    case T.STRUCT:
      return 1;
    case T.I16:
      return 2;
    case T.I32:
    case T.STRING:
      return 4;
    case T.MAP:
      return 6;
    case T.SET:
    case T.LIST:
      return 5;
    default:
      return 8;
  }
}

async function readValue(src: ByteSource, type: number, depth: number): Promise<ThriftValue> {
  if (depth > MAX_DEPTH) throw new ThriftProtocolError("The reply is nested too deeply");
  switch (type) {
    case T.BOOL:
      return (await src.read(1)).readInt8(0) !== 0;
    case T.BYTE:
      return (await src.read(1)).readInt8(0);
    case T.I16:
      return (await src.read(2)).readInt16BE(0);
    case T.I32:
      return readI32(src);
    case T.I64: {
      // Metastore i64s are ids and epoch times. Past 2^53 a Number would
      // round silently; a string says exactly what arrived.
      const v = (await src.read(8)).readBigInt64BE(0);
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(v)
        : v.toString();
    }
    case T.DOUBLE:
      return (await src.read(8)).readDoubleBE(0);
    case T.STRING:
      return readString(src);
    case T.STRUCT:
      return readStruct(src, depth + 1);
    case T.MAP: {
      const head = await src.read(6);
      const keyType = head.readInt8(0);
      const valueType = head.readInt8(1);
      const size = checkedLength(
        head.readInt32BE(2),
        minBytes(keyType) + minBytes(valueType),
        "map",
        src,
      );
      // Not `{}`: a key off the wire named __proto__ would write to the
      // prototype of what came back, and a metastore's keys are its own.
      const out: ThriftMap = Object.create(null);
      for (let i = 0; i < size; i++) {
        const key = await readValue(src, keyType, depth + 1);
        out[String(key)] = await readValue(src, valueType, depth + 1);
      }
      return out;
    }
    case T.SET:
    case T.LIST: {
      const head = await src.read(5);
      const elementType = head.readInt8(0);
      const size = checkedLength(head.readInt32BE(1), minBytes(elementType), "list", src);
      const out: ThriftValue[] = [];
      for (let i = 0; i < size; i++) out.push(await readValue(src, elementType, depth + 1));
      return out;
    }
    default:
      throw new ThriftProtocolError(`The reply carries an unknown field type (${type})`);
  }
}

async function readStruct(src: ByteSource, depth: number): Promise<ThriftStruct> {
  const out: ThriftStruct = new Map();
  for (;;) {
    const type = (await src.read(1)).readInt8(0);
    if (type === T.STOP) return out;
    const id = (await src.read(2)).readInt16BE(0);
    out.set(id, await readValue(src, type, depth));
  }
}

export type ThriftMessage = {
  name: string;
  type: number;
  seqid: number;
  body: ThriftStruct;
};

/** One whole message. Anything but a strict Thrift header is refused. */
export async function readMessage(src: ByteSource): Promise<ThriftMessage> {
  const head = await readI32(src);
  // A server built on TBinaryProtocol writes a strict header unless told not
  // to. The usual way to land here is a port that speaks something else: an
  // HTTP server's "HTTP" is a positive i32.
  if (head >= 0 || (head & VERSION_MASK) !== (VERSION_1 | 0)) {
    throw new ThriftProtocolError("The port answered, but not with Thrift");
  }
  const name = await readString(src);
  const seqid = await readI32(src);
  const body = await readStruct(src, 0);
  return { name, type: head & 0xff, seqid, body };
}

// ── Reading what was read ────────────────────────────────────────────────

export const str = (s: ThriftStruct, id: number): string | undefined => {
  const v = s.get(id);
  return typeof v === "string" ? v : undefined;
};

export const int = (s: ThriftStruct, id: number): number | undefined => {
  const v = s.get(id);
  return typeof v === "number" ? v : undefined;
};

export const struct = (s: ThriftStruct, id: number): ThriftStruct | undefined => {
  const v = s.get(id);
  return v instanceof Map ? (v as ThriftStruct) : undefined;
};

export const list = (s: ThriftStruct, id: number): ThriftValue[] => {
  const v = s.get(id);
  return Array.isArray(v) ? v : [];
};

/** A map<string,string> field, with anything else in it dropped. */
export const stringMap = (s: ThriftStruct, id: number): Record<string, string> => {
  const v = s.get(id);
  const out: Record<string, string> = {};
  if (v === undefined || v === null || typeof v !== "object" || Array.isArray(v)) return out;
  if (v instanceof Map) return out;
  for (const [k, value] of Object.entries(v)) {
    // The prototype-less map came from the wire; a plain one goes back out,
    // so a key is refused here rather than carried to whoever reads this.
    if (typeof value === "string" && k !== "__proto__") out[k] = value;
  }
  return out;
};
