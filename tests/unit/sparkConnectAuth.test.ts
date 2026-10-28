// VA-23: the Spark Connect endpoint authenticates, and a run can prove who it is.
//
// The Compose spark-connect server sits on nb-internal with notebook kernels,
// so an unauthenticated kernel could drive the Spark driver. The fix is a
// pre-shared token: the server enforces it, and every governed run carries it.
// A run reaches the plaintext, service-name endpoint over gRPC (no TLS, not
// localhost), where the stock PySpark client refuses to attach a bearer token —
// so the generated program carries a custom channel that adds the token as
// request metadata. Validated live against Spark 4.2 (right token connects,
// wrong token / none is refused UNAUTHENTICATED); this file pins the decisions
// a test can see: who gets a token, and that the generated client knows how to
// send it over the one channel it actually has.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SPARK_CONNECT_FN,
  sparkConnectClientFragment,
  sparkRunToken,
} from "@/utils/etl/sparkConnectClient";
import { compileSparkGraph } from "@/utils/etl/sparkCodegen";
import { compileSparkQuery } from "@/utils/lakehouse/sparkQueryCodegen";
import type { EtlGraph, EtlNode } from "@/utils/etl/codegen";

const rd = (p: string) => readFileSync(p, "utf8");

const node = (id: string, kind: EtlNode["kind"], config: Record<string, unknown>): EtlNode => ({
  id,
  kind,
  config: config as EtlNode["config"],
});
const SPARK_GRAPH: EtlGraph = {
  nodes: [
    node("s1", "source", { type: "object_storage", path: "raw/*.csv", format: "csv" }),
    node("t1", "target", {
      type: "object_storage",
      dataset: "etl",
      table: "items",
      format: "parquet",
      write_mode: "replace",
    }),
  ],
  edges: [{ id: "e0", from: "s1", to: "t1" }],
};
const QUERY = {
  queryId: "q1",
  sql: "SELECT * FROM analytics.orders",
  tables: [
    {
      schema: "analytics",
      table: "orders",
      columns: [{ name: "id", type: "INTEGER" }],
      dataFiles: ["s3://lake/main/analytics/orders/a.parquet"],
      deleteFiles: [],
    },
  ],
  rowCap: 100,
  snapshot: 1,
};

describe("sparkRunToken decides which run carries the pre-shared token", () => {
  const URL = "sc://spark-connect:15002";

  it("gives a static run the configured token", () => {
    expect(sparkRunToken("static", "shh", URL)).toBe("shh");
  });

  it("gives a k8s run none — its per-run driver is tokenless", () => {
    expect(sparkRunToken("k8s", "shh", "sc://run.ns.svc:15002")).toBeNull();
  });

  it("gives none when no token is configured", () => {
    expect(sparkRunToken("static", null, URL)).toBeNull();
    expect(sparkRunToken("static", "", URL)).toBeNull();
    expect(sparkRunToken("static", undefined, URL)).toBeNull();
  });

  it("stands aside when the URL already carries a token (that one rides there)", () => {
    expect(sparkRunToken("static", "shh", "sc://host:15002;token=inurl")).toBeNull();
    expect(sparkRunToken("static", "shh", "sc://host:15002;use_ssl=true;token=inurl")).toBeNull();
    // A URL with other params but no token still gets the configured token.
    expect(sparkRunToken("static", "shh", "sc://host:15002;use_ssl=true")).toBe("shh");
  });
});

describe("the generated Spark program authenticates through a custom channel", () => {
  const fragment = sparkConnectClientFragment();

  it("adds the token as request metadata over an insecure channel", () => {
    // The whole point: not SparkSession.builder.remote (which would force TLS on
    // a plaintext endpoint), but a ChannelBuilder that injects the bearer token.
    expect(fragment).toContain("'authorization', 'Bearer ' + _t");
    expect(fragment).toContain("self._insecure_channel(self.endpoint)");
    expect(fragment).toContain("channelBuilder(_TokenChannel(");
    expect(fragment).toContain("from pyspark.sql.connect.session import SparkSession");
  });

  it("stays out of the way for TLS, localhost, or no token (the stock client copes)", () => {
    expect(fragment).toContain(
      "if _tok and not _ssl and _host not in ('localhost', '127.0.0.1', '::1'):",
    );
    // The fallback is the plain remote path.
    expect(fragment).toContain("_SS.builder.remote(_url).getOrCreate()");
  });

  it("reads the token from its own variable or from the URL", () => {
    expect(fragment).toContain("_os.environ.get('ETL_SPARK_CONNECT_TOKEN')");
    expect(fragment).toContain("_re.search(r'[;?&]token=([^;?&\\s]+)', _url)");
  });

  it("is what both the ETL graph and the lakehouse query call to open a session", () => {
    const graph = compileSparkGraph(SPARK_GRAPH);
    const query = compileSparkQuery(QUERY);
    for (const [label, code] of [
      ["etl graph", graph],
      ["lakehouse query", query],
    ] as const) {
      // Defined exactly once, and used — no lingering direct .builder.remote for
      // the session (the only remote() left is the fallback inside the helper).
      expect(code.split(`def ${SPARK_CONNECT_FN}(`).length - 1, label).toBe(1);
      expect(code, label).toContain(`${SPARK_CONNECT_FN}(_url)`);
      expect(code.match(/SparkSession\.builder\.remote\(_url\)/g)?.length ?? 0, label).toBe(0);
    }
  });
});

describe("the app hands the static token to each run and never logs it", () => {
  const svc = rd("src/utils/etl/service.server.ts");
  const q = rd("src/utils/lakehouse/sparkQuery.server.ts");
  const settings = rd("src/utils/etl/sparkCluster.server.ts");

  it("reads SPARK_CONNECT_TOKEN into the Spark settings", () => {
    expect(settings).toContain("token: process.env.SPARK_CONNECT_TOKEN?.trim() || null");
  });

  it("sets ETL_SPARK_CONNECT_TOKEN for a batch run and scrubs it", () => {
    expect(svc).toContain("sparkRunToken(provider, connectToken, sparkConnectUrl)");
    expect(svc).toContain("env.ETL_SPARK_CONNECT_TOKEN = runToken");
    expect(svc).toContain("secretValues.push(runToken)");
  });

  it("sets it for a lakehouse query and scrubs it on every poll", () => {
    expect(q).toContain("sparkRunToken(s.provider, s.token, url)");
    expect(q).toContain("env.ETL_SPARK_CONNECT_TOKEN = runToken");
    // staticSecrets scrubs the same value from live output without minting.
    expect(q).toContain('sparkRunToken(s.provider, s.token, url ?? "")');
  });
});
