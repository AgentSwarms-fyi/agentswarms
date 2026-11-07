// The client against a socket it does not trust: a port that hangs up, one that
// speaks something else, a metastore that goes away halfway. A real metastore
// behaves; these are for what answers when it is not one.
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { crawlHiveMetastore, testHiveMetastore } from "@/utils/catalog/hive/crawl.server";
import {
  getTables,
  MetastoreConnection,
  MetastoreError,
} from "@/utils/catalog/hive/metastore.server";
import { MESSAGE_EXCEPTION, MESSAGE_REPLY, T, ThriftWriter } from "@/utils/catalog/hive/thrift";

const servers: Server[] = [];

/** A TCP server on a free loopback port. */
async function serve(onData: (socket: Socket, data: Buffer) => void): Promise<number> {
  const server = createServer((s) => {
    s.on("data", (d) => onData(s, d));
    s.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Name and seqid of a call, enough to answer it. */
function parseCall(buf: Buffer): { method: string; seqid: number } {
  const n = buf.readInt32BE(4);
  return { method: buf.toString("utf8", 8, 8 + n), seqid: buf.readInt32BE(8 + n) };
}

function reply(
  seqid: number,
  method: string,
  body: (w: ThriftWriter) => void,
  type = MESSAGE_REPLY,
) {
  const w = new ThriftWriter();
  w.i32(0x80010000 | type | 0);
  w.string(method);
  w.i32(seqid);
  body(w);
  w.stop();
  return w.toBuffer();
}

const stringList = (values: string[]) => (w: ThriftWriter) => {
  w.field(T.LIST, 0);
  w.list(T.STRING, values.length);
  for (const v of values) w.string(v);
};

/** A Table with the fields a crawl needs: name, database, table type. */
const tableReply = (names: string[]) => (w: ThriftWriter) => {
  w.field(T.LIST, 0);
  w.list(T.STRUCT, names.length);
  for (const name of names) {
    w.field(T.STRING, 1);
    w.string(name);
    w.field(T.STRING, 2);
    w.string("db");
    w.field(T.STRING, 12);
    w.string("MANAGED_TABLE");
    w.stop();
  }
};

const unknownMethod = (w: ThriftWriter) => {
  w.field(T.STRING, 1);
  w.string("Invalid method name");
  w.field(T.I32, 2);
  w.i32(1);
};

describe("connecting", () => {
  it("a closed port says nothing is listening", async () => {
    const port = await serve(() => {});
    await new Promise((r) => servers.pop()!.close(r));
    await expect(testHiveMetastore({ host: "127.0.0.1", port })).rejects.toThrow(
      /nothing is listening/,
    );
  });

  it("a port that hangs up names what that usually means, Kerberos included", async () => {
    const port = await serve((s) => s.destroy());
    await expect(testHiveMetastore({ host: "127.0.0.1", port })).rejects.toThrow(
      /closed the connection.*Kerberos/s,
    );
  });

  it("a port that speaks something else is told apart from a metastore", async () => {
    const port = await serve((s) => s.write("HTTP/1.1 400 Bad Request\r\n\r\n"));
    await expect(testHiveMetastore({ host: "127.0.0.1", port })).rejects.toThrow(/not with Thrift/);
  });

  it("the cloud metadata address is refused before any socket opens", async () => {
    await expect(testHiveMetastore({ host: "169.254.169.254", port: 9083 })).rejects.toThrow(
      /metadata|link-local|Refusing/i,
    );
  });

  it("require_private refuses a public address", async () => {
    await expect(
      testHiveMetastore({ host: "8.8.8.8", port: 9083, require_private: true }),
    ).rejects.toThrow(/private/i);
  });

  it("finds a framed metastore on its own, and stores which worked", async () => {
    const port = await serve((s, d) => {
      // Buffered bytes read as an absurd frame size; a real server hangs up.
      const size = d.readInt32BE(0);
      if (size <= 0 || size !== d.length - 4) return s.destroy();
      const { method, seqid } = parseCall(d.subarray(4));
      const body =
        method === "get_all_databases"
          ? reply(seqid, method, stringList(["default"]))
          : reply(seqid, method, unknownMethod, MESSAGE_EXCEPTION);
      const head = Buffer.alloc(4);
      head.writeInt32BE(body.length);
      s.write(Buffer.concat([head, body]));
    });
    const probe = await testHiveMetastore({ host: "127.0.0.1", port });
    expect(probe).toEqual({ framed: true, databases: 1, version: null });
  });
});

describe("a call", () => {
  it("a metastore's own error keeps the connection, and says what it said", async () => {
    const port = await serve((s, d) => {
      const { method, seqid } = parseCall(d);
      s.write(
        reply(seqid, method, (w) => {
          w.field(T.STRUCT, 1);
          w.field(T.STRING, 1);
          w.string("Database nope not found");
          w.stop();
        }),
      );
    });
    const c = await MetastoreConnection.open({ host: "127.0.0.1", port });
    await expect(c.call("get_database", () => {})).rejects.toThrow("Database nope not found");
    expect(c.isBroken).toBe(false);
    c.close();
  });

  it("names an unknown method, so a caller can tell it from a refusal", async () => {
    const port = await serve((s, d) => {
      const { method, seqid } = parseCall(d);
      s.write(reply(seqid, method, unknownMethod, MESSAGE_EXCEPTION));
    });
    const c = await MetastoreConnection.open({ host: "127.0.0.1", port });
    const err = await c.call("future_method", () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetastoreError);
    expect((err as MetastoreError).unknownMethod).toBe(true);
    c.close();
  });

  it("a reply to some other call is refused, and the connection with it", async () => {
    const port = await serve((s, d) => {
      const { method, seqid } = parseCall(d);
      s.write(reply(seqid + 40, method, stringList([])));
    });
    const c = await MetastoreConnection.open({ host: "127.0.0.1", port });
    await expect(c.call("get_all_databases", () => {})).rejects.toThrow(/different call/);
    expect(c.isBroken).toBe(true);
    await expect(c.call("get_all_databases", () => {})).rejects.toThrow();
    c.close();
  });

  it("reads a reply that arrives a byte at a time", async () => {
    const port = await serve((s, d) => {
      const { method, seqid } = parseCall(d);
      const body = reply(seqid, method, stringList(["one", "two"]));
      for (let i = 0; i < body.length; i++) s.write(body.subarray(i, i + 1));
    });
    const c = await MetastoreConnection.open({ host: "127.0.0.1", port });
    const out = await c.call("get_all_databases", () => {});
    expect(out.get(0)).toEqual(["one", "two"]);
    c.close();
  });
});

describe("a metastore from before the request-struct call", () => {
  it("falls back, and does not ask the newer call again", async () => {
    const calls: string[] = [];
    const port = await serve((s, d) => {
      const { method, seqid } = parseCall(d);
      calls.push(method);
      if (method === "get_table_objects_by_name_req") {
        return s.write(reply(seqid, method, unknownMethod, MESSAGE_EXCEPTION));
      }
      s.write(reply(seqid, method, tableReply(["a"])));
    });
    const c = await MetastoreConnection.open({ host: "127.0.0.1", port });
    expect((await getTables(c, "db", ["a"])).map((t) => t.name)).toEqual(["a"]);
    expect((await getTables(c, "db", ["a"])).map((t) => t.name)).toEqual(["a"]);
    c.close();
    // A crawl is thousands of these; one wrong guess each would be thousands.
    expect(calls).toEqual([
      "get_table_objects_by_name_req",
      "get_table_objects_by_name",
      "get_table_objects_by_name",
    ]);
  });
});

describe("a crawl that loses the metastore", () => {
  /** Answers as a metastore until `dieOn` is called, then hangs up. */
  const metastore = (dieOn: string, tables: Record<string, string[]>) =>
    serve((s, d) => {
      const { method, seqid } = parseCall(d);
      if (method === dieOn) return s.destroy();
      if (method === "get_all_databases") {
        return s.write(reply(seqid, method, stringList(Object.keys(tables))));
      }
      if (method === "get_all_tables") {
        const name = d.toString("utf8", 8 + method.length + 4 + 7);
        const db = Object.keys(tables).find((k) => name.includes(k));
        return s.write(reply(seqid, method, stringList(tables[db ?? ""] ?? [])));
      }
      if (method === "get_table_objects_by_name") {
        const asked = Object.values(tables)
          .flat()
          .filter((t) => d.includes(Buffer.from(t)));
        return s.write(reply(seqid, method, tableReply(asked)));
      }
      s.write(reply(seqid, method, unknownMethod, MESSAGE_EXCEPTION));
    });

  it("nothing readable fails the crawl, which removes nothing", async () => {
    const port = await metastore("get_all_databases", {});
    await expect(crawlHiveMetastore({ host: "127.0.0.1", port })).rejects.toThrow(
      /closed the connection/,
    );
  });

  it("a table the metastore could not load is unread, not gone", async () => {
    const port = await serve((s, d) => {
      const { method, seqid } = parseCall(d);
      if (method === "get_all_databases") return s.write(reply(seqid, method, stringList(["db"])));
      if (method === "get_all_tables") {
        return s.write(reply(seqid, method, stringList(["good", "broken"])));
      }
      if (method === "get_table_objects_by_name") {
        return s.write(reply(seqid, method, tableReply(["good"])));
      }
      s.write(reply(seqid, method, unknownMethod, MESSAGE_EXCEPTION));
    });
    const crawl = await crawlHiveMetastore({ host: "127.0.0.1", port });
    expect(crawl.assets.map((a) => a.fqn)).toEqual(["db.good"]);
    expect(crawl.unread.tables).toEqual(["db.broken"]);
  });

  it("every table failing is an error, not an empty metastore", async () => {
    const port = await metastore("get_table_objects_by_name", { aa: ["t1"] });
    await expect(crawlHiveMetastore({ host: "127.0.0.1", port })).rejects.toThrow(
      /None of the metastore's tables could be read/,
    );
  });
});
