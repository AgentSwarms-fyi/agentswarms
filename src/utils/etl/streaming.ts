// Streaming sources for ETL pipelines, the pure half: Kafka (and everything
// that speaks its protocol - Redpanda, Confluent, MSK, Event Hubs), Kinesis
// and Pub/Sub as source nodes, read in micro-batches on the pipeline's own
// schedule.
//
// A run reads from where the previous run durably loaded, up to a message
// cap or until the stream goes quiet, and reports the new positions as the
// engine-managed watermark the CDC source already uses: the cursor is server
// state, persisted only when the run's load committed, so a crash between
// read and load re-reads the same messages - at-least-once, never lost. No
// consumer-group offsets are committed; the platform is the record.
//
// Credentials arrive as secrets the owner bound by name (the pipeline's
// KEY={{secret:NAME}} contract), resolved server-side into the node's env
// stem. Everything below is data and text; the runner and the code generator
// import it, and so do the tests.

export const STREAM_SOURCE_TYPES = ["kafka", "kinesis", "pubsub"] as const;
export type StreamSourceType = (typeof STREAM_SOURCE_TYPES)[number];

export const STREAM_SOURCE_LABELS: Record<StreamSourceType, string> = {
  kafka: "Kafka / Redpanda topic",
  kinesis: "Amazon Kinesis stream",
  pubsub: "Google Pub/Sub subscription",
};

/** How a message's payload becomes columns. */
export type StreamPayloadFormat = "json" | "text";

export type KafkaSourceConfig = {
  type: "kafka";
  /** host:port[,host:port] */
  brokers: string;
  topic: string;
  format: StreamPayloadFormat;
  /** Where the first run starts when no cursor exists. */
  start: "earliest" | "latest";
  max_messages: number;
  /** Stop a batch after this long with nothing new. */
  idle_ms: number;
  security: "plaintext" | "ssl" | "sasl_plaintext" | "sasl_ssl";
  sasl_mechanism: "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512";
  /** Secret names (Settings → Secrets) holding the SASL username and password. */
  username_secret: string;
  password_secret: string;
};

export type KinesisSourceConfig = {
  type: "kinesis";
  stream: string;
  region: string;
  format: StreamPayloadFormat;
  start: "trim_horizon" | "latest";
  max_messages: number;
  idle_ms: number;
  /** Secret names holding the AWS access key id and secret access key. */
  access_key_secret: string;
  secret_key_secret: string;
  /** Custom endpoint (LocalStack et al.); empty on AWS. */
  endpoint: string;
};

export type PubSubSourceConfig = {
  type: "pubsub";
  project: string;
  subscription: string;
  format: StreamPayloadFormat;
  max_messages: number;
  idle_ms: number;
  /** Secret name holding the service-account JSON. */
  credentials_secret: string;
};

export type StreamSourceConfig = KafkaSourceConfig | KinesisSourceConfig | PubSubSourceConfig;

export function isStreamSource(
  cfg: { type?: string } | null | undefined,
): cfg is StreamSourceConfig {
  return Boolean(cfg && (STREAM_SOURCE_TYPES as readonly string[]).includes(cfg.type ?? ""));
}

export function defaultStreamConfig(type: StreamSourceType): StreamSourceConfig {
  switch (type) {
    case "kafka":
      return {
        type,
        brokers: "",
        topic: "",
        format: "json",
        start: "earliest",
        max_messages: 10_000,
        idle_ms: 5_000,
        security: "plaintext",
        sasl_mechanism: "SCRAM-SHA-256",
        username_secret: "",
        password_secret: "",
      };
    case "kinesis":
      return {
        type,
        stream: "",
        region: "us-east-1",
        format: "json",
        start: "trim_horizon",
        max_messages: 10_000,
        idle_ms: 5_000,
        access_key_secret: "",
        secret_key_secret: "",
        endpoint: "",
      };
    case "pubsub":
      return {
        type,
        project: "",
        subscription: "",
        format: "json",
        max_messages: 10_000,
        idle_ms: 5_000,
        credentials_secret: "",
      };
  }
}

const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The first thing wrong with a stream source, in the words the node editor shows. */
export function validateStreamSource(cfg: StreamSourceConfig): string | null {
  if (!(cfg.max_messages > 0)) return "Messages per run must be a positive number.";
  if (!(cfg.idle_ms >= 0)) return "The idle wait must be zero or more milliseconds.";
  const secretOk = (s: string) => !s || SECRET_NAME.test(s);
  switch (cfg.type) {
    case "kafka": {
      if (!cfg.brokers.trim()) return "Brokers are required (host:port, comma-separated).";
      if (!cfg.topic.trim()) return "A topic is required.";
      if (cfg.security.startsWith("sasl")) {
        if (!cfg.username_secret || !cfg.password_secret) {
          return "SASL needs the username and password secrets.";
        }
      }
      if (!secretOk(cfg.username_secret) || !secretOk(cfg.password_secret)) {
        return "A secret name is letters, digits and underscores.";
      }
      return null;
    }
    case "kinesis": {
      if (!cfg.stream.trim()) return "A stream name is required.";
      if (!cfg.region.trim()) return "A region is required.";
      if (!cfg.access_key_secret || !cfg.secret_key_secret) {
        return "Kinesis needs the access key and secret key secrets.";
      }
      if (!secretOk(cfg.access_key_secret) || !secretOk(cfg.secret_key_secret)) {
        return "A secret name is letters, digits and underscores.";
      }
      return null;
    }
    case "pubsub": {
      if (!cfg.project.trim()) return "A project id is required.";
      if (!cfg.subscription.trim()) return "A subscription is required.";
      if (!cfg.credentials_secret) return "Pub/Sub needs the service-account secret.";
      if (!secretOk(cfg.credentials_secret)) {
        return "A secret name is letters, digits and underscores.";
      }
      return null;
    }
  }
}

/** Columns every message row carries beside its payload. */
export const STREAM_META_COLUMNS: Record<StreamSourceType, string[]> = {
  kafka: [
    "_stream_topic",
    "_stream_partition",
    "_stream_offset",
    "_stream_key",
    "_stream_timestamp",
  ],
  kinesis: ["_stream_shard", "_stream_sequence", "_stream_key", "_stream_timestamp"],
  pubsub: ["_stream_message_id", "_stream_publish_time", "_stream_attributes"],
};

/**
 * The secrets a node needs, as (env variable, secret name) pairs the runner
 * resolves as the owner into the node's env stem.
 */
export function streamSecretEnv(
  stem: string,
  cfg: StreamSourceConfig,
): { env: string; secret: string }[] {
  switch (cfg.type) {
    case "kafka":
      return cfg.security.startsWith("sasl")
        ? [
            { env: `${stem}_SASL_USERNAME`, secret: cfg.username_secret },
            { env: `${stem}_SASL_PASSWORD`, secret: cfg.password_secret },
          ]
        : [];
    case "kinesis":
      return [
        { env: `${stem}_ACCESS_KEY_ID`, secret: cfg.access_key_secret },
        { env: `${stem}_SECRET_ACCESS_KEY`, secret: cfg.secret_key_secret },
      ];
    case "pubsub":
      return [{ env: `${stem}_CREDENTIALS_JSON`, secret: cfg.credentials_secret }];
  }
}

/** Hosts the sandbox must be allowed to reach for this source. */
export function streamEgressHosts(cfg: StreamSourceConfig): string[] {
  switch (cfg.type) {
    case "kafka":
      return cfg.brokers
        .split(",")
        .map(
          (b) =>
            b
              .trim()
              .replace(/^[a-z]+:\/\//i, "")
              .split("/")[0]
              .split(":")[0],
        )
        .filter(Boolean);
    case "kinesis": {
      if (cfg.endpoint.trim()) {
        const host = cfg.endpoint
          .trim()
          .replace(/^[a-z]+:\/\//i, "")
          .split("/")[0]
          .split(":")[0];
        return host ? [host] : [];
      }
      return [`kinesis.${cfg.region.trim()}.amazonaws.com`];
    }
    case "pubsub":
      return ["pubsub.googleapis.com", "oauth2.googleapis.com"];
  }
}

/** The engine cursor: next position per partition / shard, as JSON text. */
export function parseStreamCursor(raw: string | null | undefined): Record<string, string | number> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string | number> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "number" || typeof x === "string") out[k] = x;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeStreamCursor(cursor: Record<string, string | number>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(cursor)
        .sort()
        .map((k) => [k, cursor[k]]),
    ),
  );
}

const pyStr = (s: string) => JSON.stringify(s);

/** The payload parser, shared by the three readers. */
function payloadLines(format: StreamPayloadFormat): string[] {
  return format === "json"
    ? [
        `    def _payload(raw):`,
        `        if raw is None:`,
        `            return {}`,
        `        s = raw.decode('utf-8', 'replace') if isinstance(raw, (bytes, bytearray)) else str(raw)`,
        `        try:`,
        `            v = _json.loads(s)`,
        `        except Exception:`,
        `            return {'value': s}`,
        `        return v if isinstance(v, dict) else {'value': v}`,
      ]
    : [
        `    def _payload(raw):`,
        `        if raw is None:`,
        `            return {'value': None}`,
        `        return {'value': raw.decode('utf-8', 'replace') if isinstance(raw, (bytes, bytearray)) else str(raw)}`,
      ];
}

/**
 * The source function for a stream node, one micro-batch. `nodeId` names the
 * function and its watermark global (the code generator's convention); `stem`
 * is the node's env prefix. The generated code never commits offsets to the
 * broker: the position it reports becomes the engine cursor when the run's
 * load has committed.
 */
export function streamSourcePython(nodeId: string, stem: string, cfg: StreamSourceConfig): string {
  const head = [
    `def _src_${nodeId}():`,
    `    global _stream_last_${nodeId}`,
    `    import json as _json, time as _time`,
    `    _cursor = _json.loads(os.environ.get('${stem}_CURSOR') or '{}')`,
    `    _max = ${Math.max(1, Math.floor(cfg.max_messages))}`,
    `    _idle = ${Math.max(0, cfg.idle_ms) / 1000}`,
    ...payloadLines(cfg.format),
    `    rows = []`,
    `    nxt = dict(_cursor)`,
  ];
  const tail = (meta: string[]) => [
    `    _stream_last_${nodeId} = _json.dumps(nxt, sort_keys=True) if nxt else None`,
    `    print('[etl] stream: ' + str(len(rows)) + ' message(s)')`,
    `    return pd.DataFrame(rows, columns=(list(rows[0].keys()) if rows else ${JSON.stringify(meta)}))`,
  ];
  switch (cfg.type) {
    case "kafka": {
      const sasl = cfg.security.startsWith("sasl");
      return [
        ...head,
        `    from confluent_kafka import Consumer, TopicPartition, KafkaError, OFFSET_BEGINNING, OFFSET_END`,
        `    _topic = ${pyStr(cfg.topic.trim())}`,
        `    conf = {`,
        `        'bootstrap.servers': os.environ['${stem}_BROKERS'],`,
        `        'group.id': 'agentswarms-etl-${nodeId.toLowerCase().replace(/[^a-z0-9_-]/g, "")}',`,
        `        'enable.auto.commit': False,`,
        `        'enable.partition.eof': True,`,
        `        'security.protocol': ${pyStr(cfg.security.toUpperCase())},`,
        ...(sasl
          ? [
              `        'sasl.mechanism': ${pyStr(cfg.sasl_mechanism)},`,
              `        'sasl.username': os.environ.get('${stem}_SASL_USERNAME', ''),`,
              `        'sasl.password': os.environ.get('${stem}_SASL_PASSWORD', ''),`,
            ]
          : []),
        `    }`,
        `    c = Consumer(conf)`,
        `    try:`,
        `        md = c.list_topics(_topic, timeout=20)`,
        `        if _topic not in md.topics or md.topics[_topic].error is not None:`,
        `            raise RuntimeError('Kafka topic not found: ' + _topic)`,
        `        parts = sorted(md.topics[_topic].partitions.keys())`,
        `        # Assign every partition at the stored position; a partition never`,
        `        # seen starts where the node says (earliest or latest). No group`,
        `        # offsets are committed: the engine cursor is the record.`,
        `        c.assign([TopicPartition(_topic, p, int(_cursor[str(p)]) if str(p) in _cursor else ${cfg.start === "earliest" ? "OFFSET_BEGINNING" : "OFFSET_END"}) for p in parts])`,
        `        eof = set()`,
        `        deadline = _time.monotonic() + _idle`,
        `        while len(rows) < _max:`,
        `            msg = c.poll(1.0)`,
        `            if msg is None:`,
        `                if _time.monotonic() > deadline:`,
        `                    break`,
        `                continue`,
        `            if msg.error():`,
        `                if msg.error().code() == KafkaError._PARTITION_EOF:`,
        `                    eof.add(msg.partition())`,
        `                    if len(eof) >= len(parts):`,
        `                        break`,
        `                    continue`,
        `                raise RuntimeError('Kafka: ' + str(msg.error()))`,
        `            deadline = _time.monotonic() + _idle`,
        `            row = _payload(msg.value())`,
        `            _k = msg.key()`,
        `            row['_stream_topic'] = msg.topic()`,
        `            row['_stream_partition'] = msg.partition()`,
        `            row['_stream_offset'] = msg.offset()`,
        `            row['_stream_key'] = _k.decode('utf-8', 'replace') if isinstance(_k, (bytes, bytearray)) else _k`,
        `            row['_stream_timestamp'] = msg.timestamp()[1]`,
        `            rows.append(row)`,
        `            nxt[str(msg.partition())] = msg.offset() + 1`,
        `    finally:`,
        `        c.close()`,
        ...tail(STREAM_META_COLUMNS.kafka),
      ].join("\n");
    }
    case "kinesis":
      return [
        ...head,
        `    import boto3`,
        `    _stream = ${pyStr(cfg.stream.trim())}`,
        `    kw = {'region_name': ${pyStr(cfg.region.trim())},`,
        `          'aws_access_key_id': os.environ.get('${stem}_ACCESS_KEY_ID', ''),`,
        `          'aws_secret_access_key': os.environ.get('${stem}_SECRET_ACCESS_KEY', '')}`,
        ...(cfg.endpoint.trim() ? [`    kw['endpoint_url'] = ${pyStr(cfg.endpoint.trim())}`] : []),
        `    k = boto3.client('kinesis', **kw)`,
        `    shards = []`,
        `    token = None`,
        `    while True:`,
        `        r = k.list_shards(StreamName=_stream, **({'NextToken': token} if token else {}))`,
        `        shards += [s['ShardId'] for s in r.get('Shards', [])]`,
        `        token = r.get('NextToken')`,
        `        if not token:`,
        `            break`,
        `    for shard in shards:`,
        `        if len(rows) >= _max:`,
        `            break`,
        `        if shard in _cursor:`,
        `            it = k.get_shard_iterator(StreamName=_stream, ShardId=shard, ShardIteratorType='AFTER_SEQUENCE_NUMBER', StartingSequenceNumber=str(_cursor[shard]))['ShardIterator']`,
        `        else:`,
        `            it = k.get_shard_iterator(StreamName=_stream, ShardId=shard, ShardIteratorType=${pyStr(cfg.start === "latest" ? "LATEST" : "TRIM_HORIZON")})['ShardIterator']`,
        `        deadline = _time.monotonic() + _idle`,
        `        while it and len(rows) < _max:`,
        `            r = k.get_records(ShardIterator=it, Limit=min(1000, _max - len(rows)))`,
        `            it = r.get('NextShardIterator')`,
        `            recs = r.get('Records', [])`,
        `            if not recs:`,
        `                if r.get('MillisBehindLatest', 0) == 0 or _time.monotonic() > deadline:`,
        `                    break`,
        `                _time.sleep(0.2)`,
        `                continue`,
        `            deadline = _time.monotonic() + _idle`,
        `            for rec in recs:`,
        `                row = _payload(rec['Data'])`,
        `                row['_stream_shard'] = shard`,
        `                row['_stream_sequence'] = rec['SequenceNumber']`,
        `                row['_stream_key'] = rec.get('PartitionKey')`,
        `                row['_stream_timestamp'] = rec['ApproximateArrivalTimestamp'].isoformat() if rec.get('ApproximateArrivalTimestamp') else None`,
        `                rows.append(row)`,
        `                nxt[shard] = rec['SequenceNumber']`,
        ...tail(STREAM_META_COLUMNS.kinesis),
      ].join("\n");
    case "pubsub":
      return [
        ...head,
        `    from google.cloud import pubsub_v1`,
        `    from google.oauth2 import service_account`,
        `    _creds = service_account.Credentials.from_service_account_info(_json.loads(os.environ['${stem}_CREDENTIALS_JSON']))`,
        `    sub = pubsub_v1.SubscriberClient(credentials=_creds)`,
        `    path = sub.subscription_path(${pyStr(cfg.project.trim())}, ${pyStr(cfg.subscription.trim())})`,
        `    deadline = _time.monotonic() + _idle`,
        `    while len(rows) < _max:`,
        `        resp = sub.pull(request={'subscription': path, 'max_messages': min(1000, _max - len(rows))}, timeout=max(5, _idle))`,
        `        if not resp.received_messages:`,
        `            if _time.monotonic() > deadline:`,
        `                break`,
        `            continue`,
        `        deadline = _time.monotonic() + _idle`,
        `        ack_ids = []`,
        `        for rm in resp.received_messages:`,
        `            m = rm.message`,
        `            row = _payload(m.data)`,
        `            row['_stream_message_id'] = m.message_id`,
        `            row['_stream_publish_time'] = m.publish_time.isoformat() if m.publish_time else None`,
        `            row['_stream_attributes'] = _json.dumps(dict(m.attributes)) if m.attributes else None`,
        `            rows.append(row)`,
        `            ack_ids.append(rm.ack_id)`,
        `        # Pub/Sub has no replayable position: a message is acknowledged as it`,
        `        # is read, so a run that fails after this point loses it. Use a`,
        `        # dead-letter topic on the subscription, or Kafka, when that matters.`,
        `        if ack_ids and os.environ.get('AGENTSWARMS_ETL_PREVIEW') != '1':`,
        `            sub.acknowledge(request={'subscription': path, 'ack_ids': ack_ids})`,
        `    nxt = {'acked': int(_cursor.get('acked', 0)) + len(rows)}`,
        ...tail(STREAM_META_COLUMNS.pubsub),
      ].join("\n");
  }
}
