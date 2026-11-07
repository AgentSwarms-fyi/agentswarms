// The Thrift reader takes bytes from whatever answered at an address a user
// typed, so these are as much about what it refuses as what it reads.
import { describe, expect, it } from "vitest";

import {
  encodeCall,
  list,
  MESSAGE_REPLY,
  readMessage,
  str,
  stringMap,
  struct,
  T,
  ThriftProtocolError,
  ThriftWriter,
  type ByteSource,
  type ThriftStruct,
} from "@/utils/catalog/hive/thrift";

/** Exactly what the socket reader promises: exact sizes, or a rejection. */
class Bytes implements ByteSource {
  private at = 0;
  constructor(
    private readonly buf: Buffer,
    private readonly budget = 1024 * 1024,
  ) {}
  remaining() {
    return this.budget - this.at;
  }
  read(n: number) {
    if (this.at + n > this.buf.length) return Promise.reject(new Error("ran out of bytes"));
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return Promise.resolve(out);
  }
}

/** A reply as a server would write it. */
function reply(body: (w: ThriftWriter) => void, seqid = 1, name = "m"): Buffer {
  const w = new ThriftWriter();
  w.i32(0x80010000 | MESSAGE_REPLY | 0);
  w.string(name);
  w.i32(seqid);
  body(w);
  w.stop();
  return w.toBuffer();
}

describe("writing a call", () => {
  it("is a strict message: version and type in one i32, then name, seqid, args, stop", () => {
    const buf = encodeCall("get_all_tables", 7, (w) => {
      w.field(T.STRING, 1);
      w.string("sales");
    });
    expect(buf.readUInt32BE(0)).toBe(0x80010001);
    expect(buf.readInt32BE(4)).toBe("get_all_tables".length);
    expect(buf.toString("utf8", 8, 22)).toBe("get_all_tables");
    expect(buf.readInt32BE(22)).toBe(7);
    expect(buf[26]).toBe(T.STRING);
    expect(buf.readInt16BE(27)).toBe(1);
    expect(buf.readInt32BE(29)).toBe(5);
    expect(buf.toString("utf8", 33, 38)).toBe("sales");
    expect(buf[38]).toBe(T.STOP);
    expect(buf.length).toBe(39);
  });

  it("measures a string in bytes, not characters", () => {
    const w = new ThriftWriter();
    w.string("données");
    const b = w.toBuffer();
    expect(b.readInt32BE(0)).toBe(8);
    expect(b.toString("utf8", 4)).toBe("données");
  });
});

describe("reading a reply", () => {
  it("reads a list of strings and nested structs generically", async () => {
    const msg = await readMessage(
      new Bytes(
        reply((w) => {
          w.field(T.LIST, 0);
          w.list(T.STRING, 2);
          w.string("a");
          w.string("b");
          w.field(T.STRUCT, 3);
          w.field(T.STRING, 1);
          w.string("inner");
          w.stop();
        }),
      ),
    );
    expect(msg.type).toBe(MESSAGE_REPLY);
    expect(list(msg.body, 0)).toEqual(["a", "b"]);
    expect(str(struct(msg.body, 3)!, 1)).toBe("inner");
  });

  it("carries a field from a newer metastore it has never heard of", async () => {
    // Why the reader has no fixed schema: this is the next Hive's new field.
    const msg = await readMessage(
      new Bytes(
        reply((w) => {
          w.field(T.I32, 99);
          w.i32(5);
          w.field(T.STRING, 1);
          w.string("still read");
        }),
      ),
    );
    expect(str(msg.body, 1)).toBe("still read");
  });

  it("reads a map<string,string>", async () => {
    const msg = await readMessage(
      new Bytes(
        reply((w) => {
          w.field(T.MAP, 9);
          w.byte(T.STRING);
          w.byte(T.STRING);
          w.i32(1);
          w.string("k");
          w.string("v");
        }),
      ),
    );
    expect(stringMap(msg.body, 9)).toEqual({ k: "v" });
  });
});

describe("what it refuses", () => {
  const refuses = async (buf: Buffer, budget?: number) => {
    await expect(readMessage(new Bytes(buf, budget))).rejects.toBeInstanceOf(ThriftProtocolError);
  };

  it("a port that is not Thrift: an HTTP server's first bytes", async () => {
    await refuses(Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"));
  });

  it("a Thrift version it does not know", async () => {
    const b = Buffer.alloc(12);
    b.writeUInt32BE(0x80020002, 0);
    await refuses(b);
  });

  it("a string claiming more bytes than the reply may hold, before allocating", async () => {
    const w = new ThriftWriter();
    w.i32(0x80010000 | MESSAGE_REPLY | 0);
    w.i32(0x7fffffff); // a 2 GB method name
    await refuses(w.toBuffer());
  });

  it("a negative length", async () => {
    await refuses(
      reply((w) => {
        w.field(T.STRING, 1);
        w.i32(-1);
      }),
    );
  });

  it("a list claiming more items than its bytes could be", async () => {
    await refuses(
      reply((w) => {
        w.field(T.LIST, 0);
        w.list(T.STRING, 0x7ffffff0);
      }),
      4096,
    );
  });

  it("a map claiming more entries than its bytes could be", async () => {
    await refuses(
      reply((w) => {
        w.field(T.MAP, 0);
        w.byte(T.STRING);
        w.byte(T.STRING);
        w.i32(0x7ffffff0);
      }),
      4096,
    );
  });

  it("nesting deep enough to take the stack", async () => {
    await refuses(
      reply((w) => {
        for (let i = 0; i < 5_000; i++) w.field(T.STRUCT, 1);
      }),
    );
  });

  it("a field type that does not exist", async () => {
    await refuses(
      reply((w) => {
        w.field(77, 1);
      }),
    );
  });
});

describe("a key off the wire", () => {
  it("cannot reach the prototype of what comes back", async () => {
    const msg = await readMessage(
      new Bytes(
        reply((w) => {
          w.field(T.MAP, 9);
          w.byte(T.STRING);
          w.byte(T.STRING);
          w.i32(2);
          w.string("__proto__");
          w.string("polluted");
          w.string("safe");
          w.string("yes");
        }),
      ),
    );
    const props = stringMap(msg.body as ThriftStruct, 9);
    expect(props).toEqual({ safe: "yes" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
