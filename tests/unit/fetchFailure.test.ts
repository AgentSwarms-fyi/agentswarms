// A fetch that got no answer is said in words: where, and why (R368).
//
// FOUND FROM THE UI (R368). Data Catalog → Add → Iceberg REST catalog at
// https://catalog.invalid → Connect & crawl: the toast read "fetch failed",
// for a name that does not resolve. The same bare message was what a later
// crawl would have stored as the source's error. And the wizard's last step
// described the catalog as an S3 bucket with an empty path.
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { describeFetchFailure } from "@/lib/fetchFailure";

/** The shape Node's fetch rejects with: "fetch failed", the reason in `cause`. */
const nodeFetchFailure = (code: string, message: string) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });

/** A port that was just free and is closed again, so a connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe("what a failed fetch says", () => {
  it("names a refused connection, from Node's own error", async () => {
    const base = `http://127.0.0.1:${await closedPort()}`;
    const err = await fetch(`${base}/v1/config`).catch((e: unknown) => e);
    expect((err as Error).message).toBe("fetch failed");
    expect(describeFetchFailure(err, base)).toBe(
      `${base} could not be reached: nothing is listening there (connection refused)`,
    );
  }, 15_000);

  it("names a refused connection that tried both of a name's addresses", () => {
    const attempts = ["::1", "127.0.0.1"].map((ip) =>
      Object.assign(new Error(`connect ECONNREFUSED ${ip}:8181`), { code: "ECONNREFUSED" }),
    );
    const err = new TypeError("fetch failed", { cause: new AggregateError(attempts) });
    expect(describeFetchFailure(err, "http://localhost:8181")).toBe(
      "http://localhost:8181 could not be reached: nothing is listening there (connection refused)",
    );
  });

  it("names a host that does not resolve", () => {
    const err = nodeFetchFailure("ENOTFOUND", "getaddrinfo ENOTFOUND catalog.invalid");
    expect(describeFetchFailure(err, "https://catalog.invalid")).toBe(
      "https://catalog.invalid could not be reached: its host name does not resolve",
    );
  });

  it("names a wait that ran out, with the wait", () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(describeFetchFailure(err, "https://cat.example.com", { timeoutMs: 30_000 })).toBe(
      "https://cat.example.com did not answer within 30 s",
    );
  });

  it("names a certificate it would not accept", () => {
    const err = nodeFetchFailure("SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate");
    expect(describeFetchFailure(err, "https://cat.example.com")).toContain(
      "its TLS certificate was not accepted (SELF_SIGNED_CERT_IN_CHAIN)",
    );
  });

  it("passes on any other reason rather than 'fetch failed'", () => {
    const err = nodeFetchFailure("EPROTO", "write EPROTO wrong version number");
    expect(describeFetchFailure(err, "https://cat.example.com")).toBe(
      "https://cat.example.com could not be reached: write EPROTO wrong version number",
    );
  });

  it("shows where without a path, a query or credentials", () => {
    const err = nodeFetchFailure("ENOTFOUND", "x");
    const said = describeFetchFailure(err, "https://ann:secret@cat.example.com/v1/config?token=t");
    expect(said.startsWith("https://cat.example.com could not be reached")).toBe(true);
    expect(said).not.toMatch(/secret|token|v1\/config/);
  });
});

describe("the Iceberg catalog's requests", () => {
  const CRAWLER = readFileSync("src/utils/catalog/crawler.server.ts", "utf8");
  const get = CRAWLER.slice(
    CRAWLER.indexOf("async function icebergGet<T>("),
    CRAWLER.indexOf("/** Connectivity + auth probe used before a source is stored. */"),
  );

  it("say where and why a catalog could not be reached, and stop waiting", () => {
    expect(get).toContain("signal: AbortSignal.timeout(ICEBERG_TIMEOUT_MS),");
    expect(get).toMatch(
      /\} catch \(e\) \{[\s\S]*?throw new Error\(\s*`Iceberg: \$\{describeFetchFailure\(e, base, \{ timeoutMs: ICEBERG_TIMEOUT_MS \}\)\}`/,
    );
  });

  it("are what the save's test and the crawl both go through", () => {
    const probe = CRAWLER.slice(CRAWLER.indexOf("export async function testIcebergCatalog("));
    expect(probe.slice(0, 400)).toContain("await icebergGet(base, `/v1/config${q}`, cfg.token);");
  });
});

describe("the Add source wizard's last step", () => {
  const WIZARD = readFileSync("src/components/catalog/AddSourceWizard.tsx", "utf8");
  const CRAWLER = readFileSync("src/utils/catalog/crawler.server.ts", "utf8");

  it("describes an Iceberg catalog as one, with the crawler's own limits", () => {
    const step = WIZARD.slice(WIZARD.indexOf('{step === "crawl" && ('));
    expect(step).toMatch(
      /: kind === "iceberg_rest"\s*\?[\s\S]*?\$\{icebergUri\.trim\(\)\} — its namespaces and tables are listed/,
    );
    expect(CRAWLER).toContain("const ICEBERG_MAX_NAMESPACES = 300;");
    expect(CRAWLER).toContain("const ICEBERG_MAX_TABLES = 1000;");
    expect(step).toContain("(up to 300 namespaces and 1,000 tables)");
  });

  it("keeps why the source was not saved in the dialog, after the toast is gone", () => {
    const run = WIZARD.slice(WIZARD.indexOf("async function connectAndCrawl() {"));
    expect(run.slice(0, 200)).toContain("setConnectError(null);");
    expect(run).toMatch(
      /\} catch \(e\) \{\s*toast\.error\(\(e as Error\)\.message\);\s*setConnectError\(\(e as Error\)\.message\);/,
    );
    const step = WIZARD.slice(WIZARD.indexOf('{step === "crawl" && ('));
    expect(step).toMatch(
      /\{connectError \? \(\s*<p\s+role="alert"[\s\S]*?Not saved: \{connectError\}/,
    );
  });
});
