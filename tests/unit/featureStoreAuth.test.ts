// The online feature store's password (R411, VA-2026-10-25-41).
//
// The bundled valkey took commands from anything on the Compose network:
// `spark-connect` reached it, and a Spark pipeline's Python UDFs run there, so
// any pipeline author could read or overwrite every user's online features.
// valkey now requires VALKEY_PASSWORD, and the client sends AUTH first on every
// connection. These run against a small in-process server that speaks enough
// RESP to demand a password the way valkey does.
import net from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeCommand, parseReplies } from "@/lib/resp";
import { disconnect, ping, storeStatus } from "@/utils/featureStore/client.server";

type Server = { port: number; seen: string[][]; close: () => Promise<void> };

/** A RESP server with an optional password (and optional ACL user), like valkey's requirepass. */
function startServer(opts: { password?: string; user?: string } = {}): Promise<Server> {
  const seen: string[][] = [];
  const server = net.createServer((sock) => {
    let authed = !opts.password;
    let buf = new Uint8Array(0);
    sock.on("data", (chunk) => {
      const grown = new Uint8Array(buf.length + chunk.length);
      grown.set(buf);
      grown.set(chunk, buf.length);
      const { replies, consumed } = parseReplies(grown);
      buf = grown.subarray(consumed);
      for (const r of replies) {
        const cmd = (r as unknown[]).map((x) => String(x));
        seen.push(cmd);
        const name = cmd[0].toUpperCase();
        if (name === "AUTH") {
          const [user, pass] = cmd.length === 3 ? [cmd[1], cmd[2]] : ["default", cmd[1]];
          const ok =
            pass === opts.password && (opts.user ? user === opts.user : user === "default");
          if (!opts.password)
            sock.write("-ERR AUTH <password> called without any password configured\r\n");
          else if (ok) {
            authed = true;
            sock.write("+OK\r\n");
          } else sock.write("-WRONGPASS invalid username-password pair or user is disabled.\r\n");
        } else if (!authed) sock.write("-NOAUTH Authentication required.\r\n");
        else if (name === "PING") sock.write("+PONG\r\n");
        else sock.write("+OK\r\n");
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        seen,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

let srv: Server | null = null;
const saved = { url: process.env.FEATURE_STORE_URL, pw: process.env.VALKEY_PASSWORD };

beforeEach(() => {
  disconnect();
  delete process.env.VALKEY_PASSWORD;
});
afterEach(async () => {
  disconnect();
  await srv?.close();
  srv = null;
  process.env.FEATURE_STORE_URL = saved.url;
  if (saved.pw === undefined) delete process.env.VALKEY_PASSWORD;
  else process.env.VALKEY_PASSWORD = saved.pw;
});

describe("the feature store client authenticates", () => {
  it("sends AUTH with the URL's password before any other command", async () => {
    srv = await startServer({ password: "s3cret r411" });
    process.env.FEATURE_STORE_URL = `redis://:${encodeURIComponent("s3cret r411")}@127.0.0.1:${srv.port}`;
    expect(await ping()).toBe(true);
    expect(srv.seen).toEqual([["AUTH", "s3cret r411"], ["PING"]]);
  });

  it("uses VALKEY_PASSWORD when the URL carries none, as the installers set it up", async () => {
    srv = await startServer({ password: "from-env" });
    process.env.FEATURE_STORE_URL = `redis://127.0.0.1:${srv.port}`;
    process.env.VALKEY_PASSWORD = "from-env";
    expect(await ping()).toBe(true);
    expect(srv.seen[0]).toEqual(["AUTH", "from-env"]);
  });

  it("sends an ACL user when the URL names one", async () => {
    srv = await startServer({ password: "pw", user: "features" });
    process.env.FEATURE_STORE_URL = `redis://features:pw@127.0.0.1:${srv.port}`;
    expect(await ping()).toBe(true);
    expect(srv.seen[0]).toEqual(["AUTH", "features", "pw"]);
  });

  it("treats a refused password as a store that cannot be used, and says so without the password", async () => {
    srv = await startServer({ password: "right" });
    process.env.FEATURE_STORE_URL = `redis://:wrong-r411@127.0.0.1:${srv.port}`;
    expect(await ping()).toBe(false);
    const status = storeStatus();
    expect(status.breakerOpen).toBe(true);
    expect(status.error).toMatch(/^the store refused the credentials: WRONGPASS/);
    expect(status.error).not.toContain("wrong-r411");
    // Nothing after the refused AUTH reached the server.
    expect(srv.seen).toEqual([["AUTH", "wrong-r411"]]);
  });

  it("sends no AUTH when no password is configured", async () => {
    srv = await startServer();
    process.env.FEATURE_STORE_URL = `redis://127.0.0.1:${srv.port}`;
    expect(await ping()).toBe(true);
    expect(srv.seen).toEqual([["PING"]]);
  });

  it("encodes AUTH the way the rest of the client encodes commands", () => {
    // The handshake goes through encodeCommand, not a hand-built string.
    expect(new TextDecoder().decode(encodeCommand(["AUTH", "p w"]))).toBe(
      "*2\r\n$4\r\nAUTH\r\n$3\r\np w\r\n",
    );
  });
});
