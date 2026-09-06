// Streaming sources for ETL: what a node must say, the code a run executes,
// the positions it keeps, and the wiring that resolves its secrets and
// refuses an unlisted host before a sandbox starts.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compileGraph, type EtlGraph } from "@/utils/etl/codegen";
import {
  defaultStreamConfig,
  isStreamSource,
  parseStreamCursor,
  serializeStreamCursor,
  STREAM_SOURCE_TYPES,
  streamEgressHosts,
  streamSecretEnv,
  streamSourcePython,
  validateStreamSource,
  type KafkaSourceConfig,
} from "@/utils/etl/streaming";

const rd = (p: string) => readFileSync(p, "utf8");

const kafka = (over: Partial<KafkaSourceConfig> = {}): KafkaSourceConfig => ({
  ...(defaultStreamConfig("kafka") as KafkaSourceConfig),
  brokers: "redpanda:9092",
  topic: "orders",
  ...over,
});

describe("what a stream node must say", () => {
  it("knows its three types and nothing else", () => {
    for (const t of STREAM_SOURCE_TYPES) expect(isStreamSource(defaultStreamConfig(t))).toBe(true);
    expect(isStreamSource({ type: "database" })).toBe(false);
    expect(isStreamSource(null)).toBe(false);
  });

  it("refuses a missing address, and SASL without its secrets", () => {
    expect(validateStreamSource(kafka({ brokers: " " }))).toContain("Brokers are required");
    expect(validateStreamSource(kafka({ topic: "" }))).toBe("A topic is required.");
    expect(validateStreamSource(kafka({ security: "sasl_ssl" }))).toContain("SASL needs");
    expect(
      validateStreamSource(
        kafka({ security: "sasl_ssl", username_secret: "U", password_secret: "P" }),
      ),
    ).toBeNull();
    expect(validateStreamSource(kafka({ username_secret: "bad-name" }))).toContain(
      "letters, digits and underscores",
    );
    expect(validateStreamSource(kafka({ max_messages: 0 }))).toContain("positive number");
    expect(validateStreamSource(kafka())).toBeNull();
  });

  it("kinesis and pubsub name their own secrets", () => {
    const k = defaultStreamConfig("kinesis");
    expect(validateStreamSource(k)).toBe("A stream name is required.");
    if (k.type === "kinesis") {
      expect(
        validateStreamSource({ ...k, stream: "s", access_key_secret: "A", secret_key_secret: "B" }),
      ).toBeNull();
      expect(
        streamSecretEnv("ETL_N1", { ...k, access_key_secret: "A", secret_key_secret: "B" }),
      ).toEqual([
        { env: "ETL_N1_ACCESS_KEY_ID", secret: "A" },
        { env: "ETL_N1_SECRET_ACCESS_KEY", secret: "B" },
      ]);
    }
    const p = defaultStreamConfig("pubsub");
    if (p.type === "pubsub") {
      expect(validateStreamSource({ ...p, project: "x", subscription: "y" })).toContain(
        "service-account secret",
      );
      expect(
        streamSecretEnv("ETL_N2", {
          ...p,
          project: "x",
          subscription: "y",
          credentials_secret: "G",
        }),
      ).toEqual([{ env: "ETL_N2_CREDENTIALS_JSON", secret: "G" }]);
    }
    // Plaintext Kafka needs no secret at all; SASL needs two.
    expect(streamSecretEnv("ETL_N3", kafka())).toEqual([]);
    expect(
      streamSecretEnv(
        "ETL_N3",
        kafka({ security: "sasl_ssl", username_secret: "U", password_secret: "P" }),
      ),
    ).toEqual([
      { env: "ETL_N3_SASL_USERNAME", secret: "U" },
      { env: "ETL_N3_SASL_PASSWORD", secret: "P" },
    ]);
  });

  it("names the hosts the sandbox must reach", () => {
    expect(streamEgressHosts(kafka({ brokers: "b1.example.com:9092, kafka://b2:9093" }))).toEqual([
      "b1.example.com",
      "b2",
    ]);
    const k = defaultStreamConfig("kinesis");
    if (k.type === "kinesis") {
      expect(streamEgressHosts({ ...k, region: "eu-west-1" })).toEqual([
        "kinesis.eu-west-1.amazonaws.com",
      ]);
      expect(streamEgressHosts({ ...k, endpoint: "http://localstack:4566" })).toEqual([
        "localstack",
      ]);
    }
    expect(streamEgressHosts(defaultStreamConfig("pubsub"))).toContain("pubsub.googleapis.com");
  });
});

describe("the positions a run keeps", () => {
  it("round-trips a cursor and ignores anything that is not a position", () => {
    expect(parseStreamCursor(null)).toEqual({});
    expect(parseStreamCursor("not json")).toEqual({});
    expect(parseStreamCursor('{"0": 12, "1": "7", "x": {"y": 1}}')).toEqual({ "0": 12, "1": "7" });
    expect(serializeStreamCursor({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
});

describe("the code a run executes", () => {
  it("kafka: assigns every partition at the stored offset, never commits, and reports the next positions", () => {
    const py = streamSourcePython("n1", "ETL_N1", kafka({ start: "latest" }));
    expect(py).toContain("def _src_n1():");
    expect(py).toContain("global _stream_last_n1");
    expect(py).toContain("os.environ.get('ETL_N1_CURSOR')");
    expect(py).toContain("'enable.auto.commit': False,");
    expect(py).toContain("int(_cursor[str(p)]) if str(p) in _cursor else OFFSET_END");
    expect(py).toContain("nxt[str(msg.partition())] = msg.offset() + 1");
    expect(py).toContain("_stream_last_n1 = _json.dumps(nxt, sort_keys=True) if nxt else None");
    expect(py).not.toContain("c.commit(");
    expect(py).not.toContain("sasl.username");
    const earliest = streamSourcePython("n1", "ETL_N1", kafka());
    expect(earliest).toContain("else OFFSET_BEGINNING");
    const sasl = streamSourcePython(
      "n1",
      "ETL_N1",
      kafka({
        security: "sasl_ssl",
        sasl_mechanism: "PLAIN",
        username_secret: "U",
        password_secret: "P",
      }),
    );
    expect(sasl).toContain("'security.protocol': \"SASL_SSL\",");
    expect(sasl).toContain("'sasl.mechanism': \"PLAIN\",");
    expect(sasl).toContain("os.environ.get('ETL_N1_SASL_USERNAME', '')");
  });

  it("json payloads become columns and a bad payload survives as a value", () => {
    const py = streamSourcePython("n1", "ETL_N1", kafka({ format: "json" }));
    expect(py).toContain("return v if isinstance(v, dict) else {'value': v}");
    expect(py).toContain("return {'value': s}");
    const text = streamSourcePython("n1", "ETL_N1", kafka({ format: "text" }));
    expect(text).not.toContain("_json.loads(s)");
  });

  it("kinesis resumes after the stored sequence per shard; pubsub acknowledges only on a real run", () => {
    const k = defaultStreamConfig("kinesis");
    if (k.type === "kinesis") {
      const py = streamSourcePython("n2", "ETL_N2", {
        ...k,
        stream: "s",
        access_key_secret: "A",
        secret_key_secret: "B",
      });
      expect(py).toContain(
        "ShardIteratorType='AFTER_SEQUENCE_NUMBER', StartingSequenceNumber=str(_cursor[shard])",
      );
      expect(py).toContain("nxt[shard] = rec['SequenceNumber']");
      expect(py).toContain('"TRIM_HORIZON"');
    }
    const p = defaultStreamConfig("pubsub");
    if (p.type === "pubsub") {
      const py = streamSourcePython("n3", "ETL_N3", {
        ...p,
        project: "x",
        subscription: "y",
        credentials_secret: "G",
      });
      expect(py).toContain("if ack_ids and os.environ.get('AGENTSWARMS_ETL_PREVIEW') != '1':");
      expect(py).toContain("sub.acknowledge(");
    }
  });

  it("the compiler wires a kafka node like the other incremental sources", () => {
    const graph: EtlGraph = {
      nodes: [
        { id: "n1", kind: "source", label: "orders", config: kafka() },
        {
          id: "n2",
          kind: "target",
          label: "lake",
          config: {
            type: "lakehouse",
            schema: "analytics",
            table: "orders_stream",
            write_mode: "append",
          },
        },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2" }],
    } as unknown as EtlGraph;
    const code = compileGraph(graph);
    expect(code).toContain("_stream_last_n1 = None");
    expect(code).toContain("from confluent_kafka import Consumer");
    expect(code).toContain("_watermarks['n1'] = _stream_last_n1");
    // The dictionary must exist before a stream node writes to it: the first
    // live run failed with "name '_watermarks' is not defined" when a stream
    // node was the only incremental source.
    expect(code).toContain("_watermarks = {}");
    expect(code).toContain("'watermarks': _watermarks,");
    // A quiet stream yields an empty frame with only the _stream_* columns;
    // the second live run failed with "table has 9 columns but 5 values were
    // supplied" until the lakehouse target skipped empty batches and
    // inserted by name.
    expect(code).toContain("if len(_src):");
    expect(code).toContain("BY NAME SELECT * FROM _src");
    // A node that cannot run refuses at compile time, with the reason.
    expect(() =>
      compileGraph({
        ...graph,
        nodes: [{ ...graph.nodes[0], config: kafka({ topic: "" }) }, graph.nodes[1]],
      } as EtlGraph),
    ).toThrow(/A topic is required/);
  });
});

describe("the wiring", () => {
  it("the service treats a stream node as incremental, resolves its secrets by name, and refuses an unlisted host", () => {
    const svc = rd("src/utils/etl/service.server.ts");
    expect(svc).toContain("isStreamSource(c)");
    expect(svc).toContain("await streamEnv(node as EtlNode, c, stem);");
    expect(svc).toContain("resolveSecretRefs(pipeline.user_id, `{{secret:${secret}}}`)");
    expect(svc).toContain("is not on the sandbox egress allow-list");
    expect(svc).toContain("secretValues.push(value);");
  });

  it("the editor offers the three sources, the image ships the clients, and the docs say at-least-once", () => {
    const ui = rd("src/routes/_authenticated/etl.tsx");
    expect(ui).toContain('{ type: "kafka", label: "Kafka / Redpanda topic" }');
    expect(ui).toContain("function StreamSourceFields(");
    expect(ui).toContain("return defaultStreamConfig(type);");
    const req = rd("docker/notebook-runtime/requirements.txt");
    for (const dep of ["confluent-kafka", "boto3", "google-cloud-pubsub"])
      expect(req).toContain(dep);
    expect(rd("docs/ETL_PIPELINES.md")).toContain("## Streaming sources (Kafka, Kinesis, Pub/Sub)");
    expect(rd("src/routes/docs.etl.tsx")).toContain("at-least-once");
  });
});
