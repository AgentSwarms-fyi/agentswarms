// A connector request that got no answer says where and why (R474).
//
// FOUND FROM THE UI (R426). Integrations → Data Sources → Save & test of an
// Athena interface endpoint, and of BigQuery over Private Service Connect,
// each against a stand-in with a self-signed certificate: "Connection saved
// but the test failed: fetch failed", and the row's status said the same.
// The stand-in saw why: the app abandoned every handshake at the certificate.
// For BigQuery the failing host was the token's (`oauth2-…`), not the API's.
//
// connectorFetch now says Node's bare "fetch failed" in words, naming the
// origin it was asked for, once retrying is over; everything else it throws
// is what it was. A refused connection runs over a real socket here; the
// self-signed certificate is Node's own error shape, as fetch() rejects with
// it (TypeError "fetch failed", the reason in `cause`).
import { generateKeyPairSync } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers: Record<string, string> = {
  "warehouse.r427.test": "127.0.0.1",
  "vpce-0r426test-abc.athena.us-east-1.vpce.amazonaws.com": "172.19.0.12",
  "bigquery-r426ep.p.googleapis.com": "172.19.0.12",
  "oauth2-r426ep.p.googleapis.com": "172.19.0.12",
};
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    const a = answers[host];
    if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return [{ address: a, family: 4 }];
  },
}));

const { connectorFetch, ConnectorUnreachableError } =
  await import("@/utils/http/connectorFetch.server");
const { testWarehouseConnection } = await import("@/utils/warehouse/drivers.server");
type Cfg = Parameters<typeof testWarehouseConnection>[0];

/** What Node's fetch rejects with for a self-signed certificate (Node 24). */
const selfSigned = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(
      new Error(
        "self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca",
      ),
      { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
    ),
  });

/** A port that was just free and is closed again, so a connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

const noSleep = async () => {};
let hosts: string[] = [];

beforeEach(() => {
  hosts = [];
  // Backoff of zero: the retries still happen, without the wait.
  vi.stubEnv("CONNECTOR_RETRY_BASE_MS", "0");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Every request fails the way a self-signed certificate does. */
function refuseAtTheCertificate() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      hosts.push(new URL(String(input)).host);
      throw selfSigned();
    }),
  );
}

describe("a request that got no answer", () => {
  it("names the origin and the refused connection, after retrying it as before", async () => {
    const port = await closedPort();
    const sleeps: number[] = [];
    const err = await connectorFetch(
      `http://warehouse.r427.test:${port}/api/v2/statements?x=1`,
      { method: "POST", body: "{}" },
      { retries: 2, sleepFn: async (ms) => void sleeps.push(ms) },
    ).catch((e: unknown) => e as Error & { code?: string; cause?: Error & { cause?: unknown } });

    expect(err).toBeInstanceOf(ConnectorUnreachableError);
    expect(err.message).toBe(
      `http://warehouse.r427.test:${port} could not be reached: nothing is listening there (connection refused)`,
    );
    expect(err.code).toBe("ECONNREFUSED");
    // Node's own error, kept whole.
    expect(err.cause?.name).toBe("TypeError");
    expect(err.cause?.message).toBe("fetch failed");
    expect((err.cause?.cause as { code?: string }).code).toBe("ECONNREFUSED");
    // Classified on the raw error, as before: a transport failure is retried.
    expect(sleeps).toHaveLength(2);
  }, 15_000);

  it("puts the caller's label first", async () => {
    refuseAtTheCertificate();
    await expect(
      connectorFetch("https://warehouse.r427.test/q", {}, { label: "Snowflake", retries: 0 }),
    ).rejects.toThrow(
      /^Snowflake: https:\/\/warehouse\.r427\.test could not be reached: its TLS certificate was not accepted \(DEPTH_ZERO_SELF_SIGNED_CERT\)$/,
    );
  });

  it("names no path, query or credentials", async () => {
    refuseAtTheCertificate();
    const err = await connectorFetch(
      "https://ann:secret@warehouse.r427.test/api/v2/statements?token=t",
      {},
      { retries: 0, sleepFn: noSleep },
    ).catch((e: unknown) => e as Error);
    expect(err.message.startsWith("https://warehouse.r427.test could not be reached")).toBe(true);
    expect(err.message).not.toMatch(/secret|token|statements|ann/);
  });
});

describe("what it leaves as it was", () => {
  it("a deadline that passed: the same error, not retried", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const fetchSpy = vi.fn(async () => {
      throw timeout;
    });
    vi.stubGlobal("fetch", fetchSpy);
    const err = await connectorFetch(
      "https://warehouse.r427.test/q",
      {},
      { sleepFn: noSleep },
    ).catch((e: unknown) => e);
    expect(err).toBe(timeout);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a name that does not resolve: already said, and callers read its name and code", async () => {
    const err = await connectorFetch(
      "https://nowhere.r427.test/q",
      {},
      { retries: 0, sleepFn: noSleep },
    ).catch((e: unknown) => e as Error & { code?: string });
    expect(err.name).toBe("HostNotResolvedError");
    expect(err.code).toBe("ENOTFOUND");
  });

  it("any other TypeError, which is not a failure to reach anything", async () => {
    const bad = new TypeError('Headers.append: "a\nb" is an invalid header value.');
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw bad;
      }),
    );
    const err = await connectorFetch("https://warehouse.r427.test/q", {}, { retries: 0 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBe(bad);
  });
});

describe("Test connection against a private endpoint whose certificate is refused (R426's round)", () => {
  it("Athena names its interface endpoint and the certificate", async () => {
    refuseAtTheCertificate();
    await expect(
      testWarehouseConnection({
        provider: "athena",
        region: "us-east-1",
        access_key_id: "AKIATEST",
        secret_access_key: "secret-r427",
        output_location: "s3://b/r/",
        endpoint: "https://vpce-0r426test-abc.athena.us-east-1.vpce.amazonaws.com",
      } as unknown as Cfg),
    ).rejects.toThrow(
      /^https:\/\/vpce-0r426test-abc\.athena\.us-east-1\.vpce\.amazonaws\.com could not be reached: its TLS certificate was not accepted \(DEPTH_ZERO_SELF_SIGNED_CERT\)$/,
    );
    // Three handshakes, as the stand-in saw: retried as before.
    expect(hosts).toEqual(Array(3).fill("vpce-0r426test-abc.athena.us-east-1.vpce.amazonaws.com"));
  });

  it("BigQuery names the token host, not the API host, and says it was the token step", async () => {
    refuseAtTheCertificate();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = JSON.stringify({
      client_email: "r427@test.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: "https://oauth2.googleapis.com/token",
    });
    await expect(
      testWarehouseConnection({
        provider: "bigquery",
        project_id: "p",
        service_account_json: sa,
        endpoint: "https://bigquery-r426ep.p.googleapis.com",
      } as unknown as Cfg),
    ).rejects.toThrow(
      /^BigQuery auth: https:\/\/oauth2-r426ep\.p\.googleapis\.com could not be reached: its TLS certificate was not accepted \(DEPTH_ZERO_SELF_SIGNED_CERT\)$/,
    );
    expect(new Set(hosts)).toEqual(new Set(["oauth2-r426ep.p.googleapis.com"]));
  });
});
