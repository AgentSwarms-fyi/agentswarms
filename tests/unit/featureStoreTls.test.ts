// R465: the online feature store over TLS.
//
// A managed store with in-transit encryption (ElastiCache among them) is
// reached as `rediss://host:port`. The client spoke plain TCP only. Now
// `rediss://` (and `valkeys://`) opens a TLS socket and verifies the server's
// certificate against Node's roots plus NODE_EXTRA_CA_CERTS. Nothing turns the
// check off: a store whose certificate nobody vouches for is a store that is
// down, and the breaker treats it so.
//
// The live case runs against a real valkey with TLS when
// FEATURE_STORE_TLS_LIVE_URL names it and NODE_EXTRA_CA_CERTS holds its CA
// (both must be set before the test process starts); see ADVERSARIAL_LOG R465.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseReplies } from "@/lib/resp";
import { call, disconnect, parseUrl, ping, storeStatus } from "@/utils/featureStore/client.server";

afterEach(() => {
  disconnect();
  vi.unstubAllEnvs();
});

describe("which addresses mean TLS", () => {
  it("rediss:// and valkeys:// do; redis://, valkey:// and a bare host:port do not", () => {
    expect(parseUrl("rediss://cache.example.com:6380")).toMatchObject({
      host: "cache.example.com",
      port: 6380,
      tls: true,
    });
    expect(parseUrl("valkeys://cache:6379")?.tls).toBe(true);
    expect(parseUrl("redis://valkey:6379")?.tls).toBe(false);
    expect(parseUrl("valkey://valkey:6379")?.tls).toBe(false);
    expect(parseUrl("127.0.0.1:6379")).toMatchObject({ host: "127.0.0.1", tls: false });
  });

  it("keeps the URL's own credentials, over TLS as without", () => {
    expect(parseUrl("rediss://default:pw@cache:6380")).toMatchObject({
      user: "default",
      password: "pw",
      tls: true,
    });
  });

  it("refuses any other scheme, and never repeats the URL's password", async () => {
    vi.stubEnv("FEATURE_STORE_URL", "http://admin:hunter22@cache:6379");
    expect(parseUrl("http://cache:6379")).toBeNull();
    expect(await ping()).toBe(false);
    const { error } = storeStatus();
    expect(error).toMatch(/redis:\/\/, rediss:\/\/ or host:port/);
    expect(error).not.toContain("hunter22");
    expect(error).not.toContain("admin");
  });
});

const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

/** A certificate for localhost signed by nobody: what an unverified store would present. */
function selfSigned(): { key: Buffer; cert: Buffer; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fs-tls-"));
  const r = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      path.join(dir, "key.pem"),
      "-out",
      path.join(dir, "cert.pem"),
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`openssl: ${r.stderr}`);
  return {
    key: readFileSync(path.join(dir, "key.pem")),
    cert: readFileSync(path.join(dir, "cert.pem")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("the certificate is checked, always", () => {
  it.skipIf(!openssl)(
    "a store whose certificate nobody vouches for gets no command, and opens the breaker",
    async () => {
      const { key, cert, cleanup } = selfSigned();
      const seen: string[] = [];
      const server = tls.createServer({ key, cert }, (sock) => {
        sock.on("data", (chunk) => {
          const { replies } = parseReplies(new Uint8Array(chunk));
          for (const r of replies) seen.push(String((r as unknown[])[0]));
          sock.write("+PONG\r\n");
        });
        sock.on("error", () => undefined);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as { port: number }).port;
      try {
        vi.stubEnv("FEATURE_STORE_URL", `rediss://localhost:${port}`);
        expect(await ping()).toBe(false);
        const status = storeStatus();
        expect(status.breakerOpen).toBe(true);
        expect(status.error).toMatch(/self[- ]signed|certificate/i);
        // Refused at the handshake: not even PING (or AUTH) was sent.
        expect(seen).toEqual([]);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
        cleanup();
      }
    },
    20_000,
  );
});

const LIVE = process.env.FEATURE_STORE_TLS_LIVE_URL?.trim();

describe("a real valkey over TLS", () => {
  it.skipIf(!LIVE)(
    "answers PING, and keeps what it is given, over a verified TLS connection",
    async () => {
      vi.stubEnv("FEATURE_STORE_URL", LIVE!);
      expect(await ping(), storeStatus().error ?? "").toBe(true);
      const key = `tls-live:${Date.now()}`;
      const replies = await call([
        ["SET", key, "over tls", "EX", 60],
        ["GET", key],
        ["DEL", key],
      ]);
      expect(replies).toEqual(["OK", "over tls", 1]);
    },
    20_000,
  );
});
