// AWS Glue Data Catalog, the Hive Metastore's model on AWS.
//
// Athena, EMR, Redshift Spectrum and Lake Formation all read this, and a Glue
// table is a Hive table field for field, so it maps through the same rules
// (hive/mapping.ts). What differs is the wire: signed JSON over HTTPS.
//
// KEYS, NOT THE SERVER'S IDENTITY. The app has an AWS identity of its own for
// KMS. It is not offered here, because a source is created by any signed-in
// user: reading through the server's role would hand every one of them the
// organisation's Glue catalog. A source carries the keys of whoever added it.
//
// Crawls are read-only: GetDatabases, GetTables and GetPartitions, so the keys
// need only glue:GetDatabases, glue:GetTables and glue:GetPartitions.
import { isAwsRegion } from "@/lib/awsRegion";
import { signAwsRequest } from "@/utils/aws/sigv4";
import { safeFetch, SsrfRefusedError } from "@/utils/ssrfGuard.server";

import type { HiveCrawl, HiveLineageEdge, HiveUnread } from "./crawl.server";
import {
  hiveTableToAsset,
  hiveViewUpstreams,
  type HiveAsset,
  type HiveDatabase,
  type HiveField,
  type HivePartitions,
  type HiveTable,
} from "./mapping";

export type GlueConfig = {
  region: string;
  access_key_id: string;
  secret_access_key: string;
  /** A VPC interface endpoint. Unset means the regional endpoint. */
  endpoint?: string;
  /** Another account's catalog, when this one has been granted it. */
  catalog_id?: string;
};

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const PAGE = 100;
const MAX_DATABASES = 1_000;
const MAX_TABLES = 10_000;
const PARTITION_PAGE = 1_000;
const MAX_PARTITION_CALLS = 500;

/** The regional endpoint, or the one configured. */
export function glueEndpoint(cfg: Pick<GlueConfig, "region" | "endpoint">): string {
  // A region goes into a host name and into every signature, so it is held to
  // what a region can be even when an endpoint means the host is not built from it.
  if (!isAwsRegion(cfg.region)) throw new Error(`"${cfg.region}" is not an AWS region`);
  if (cfg.endpoint) return cfg.endpoint.replace(/\/+$/, "");
  return `https://glue.${cfg.region}.${cfg.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`;
}

/** Hosts a source's keys may be sent to, for the secret-sharing rule (R419). */
export function glueHosts(cfg: Pick<GlueConfig, "region" | "endpoint">): string[] {
  return [new URL(glueEndpoint(cfg)).hostname];
}

type GlueError = { __type?: string; Message?: string; message?: string };

async function glueCall<T>(
  cfg: GlueConfig,
  operation: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const url = `${glueEndpoint(cfg)}/`;
  const body = JSON.stringify(cfg.catalog_id ? { CatalogId: cfg.catalog_id, ...payload } : payload);
  for (let attempt = 1; ; attempt++) {
    const headers = await signAwsRequest({
      service: "glue",
      region: cfg.region,
      credentials: { accessKeyId: cfg.access_key_id, secretAccessKey: cfg.secret_access_key },
      method: "POST",
      url,
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSGlue.${operation}`,
      },
      body,
    });
    let res: Response;
    try {
      // Private endpoints stay allowed, as for every connector: a VPC endpoint
      // is the point of the setting. Metadata addresses never are.
      res = await safeFetch(url, {
        allowPrivate: true,
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof SsrfRefusedError) throw new Error(`Glue: ${e.message}`);
      throw new Error(`Glue: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text().catch(() => "");
    if (res.ok) {
      try {
        return JSON.parse(text) as T;
      } catch {
        // A 200 that is not JSON is something else at that address: a proxy's
        // sign-in page, or another AWS service behind the same endpoint.
        throw new Error(
          `Glue: ${new URL(url).host} answered, but not as AWS Glue. Check the endpoint.`,
        );
      }
    }
    let err: GlueError = {};
    try {
      err = JSON.parse(text) as GlueError;
    } catch {
      /* not JSON; the status says what there is to say */
    }
    const code = (err.__type ?? "").split("#").pop() ?? "";
    const throttled = res.status === 429 || /Throttling|TooManyRequests/i.test(code);
    if ((throttled || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    const detail = err.Message ?? err.message ?? text.slice(0, 200);
    throw new Error(`Glue ${res.status}${code ? ` ${code}` : ""}: ${detail}`);
  }
}

type GlueColumn = { Name?: string; Type?: string; Comment?: string };
type GlueDatabase = { Name: string; Description?: string; LocationUri?: string };
type GlueTable = {
  Name: string;
  DatabaseName?: string;
  Description?: string;
  Owner?: string;
  CreateTime?: number | string;
  TableType?: string;
  ViewOriginalText?: string;
  ViewExpandedText?: string;
  Parameters?: Record<string, string>;
  PartitionKeys?: GlueColumn[];
  StorageDescriptor?: {
    Columns?: GlueColumn[];
    Location?: string;
    InputFormat?: string;
    OutputFormat?: string;
    Compressed?: boolean;
    NumberOfBuckets?: number;
    BucketColumns?: string[];
    SerdeInfo?: { SerializationLibrary?: string; Parameters?: Record<string, string> };
  };
};

const toFields = (cols: GlueColumn[] | undefined): HiveField[] =>
  (cols ?? []).flatMap((c) =>
    c.Name
      ? [
          {
            name: c.Name,
            type: c.Type ?? "unknown",
            ...(c.Comment ? { comment: c.Comment } : {}),
          },
        ]
      : [],
  );

/**
 * A view's SQL, out of the wrapper Athena stores it in.
 *
 * An Athena view's text is `/* Presto View: <base64 JSON> *\/`. Taken as it is,
 * the catalog would show a blob as the definition and find no upstreams in it.
 */
export function decodeAthenaView(text: string | undefined): string | undefined {
  const m = text && /^\/\*\s*Presto View:\s*([A-Za-z0-9+/=]+)\s*\*\/$/.exec(text.trim());
  if (!m) return text;
  try {
    const doc = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as {
      originalSql?: unknown;
    };
    return typeof doc.originalSql === "string" ? doc.originalSql : text;
  } catch {
    return text;
  }
}

function toEpochSeconds(v: number | string | undefined): number | undefined {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : Math.trunc(ms / 1000);
  }
  return undefined;
}

export function glueTableToHive(t: GlueTable, database: string): HiveTable {
  const sd = t.StorageDescriptor;
  const parameters = { ...(t.Parameters ?? {}) };
  // Glue has a field for what Hive keeps in a property.
  if (t.Description && !parameters.comment) parameters.comment = t.Description;
  const original = decodeAthenaView(t.ViewOriginalText);
  const expanded = decodeAthenaView(t.ViewExpandedText);
  return {
    database: t.DatabaseName ?? database,
    name: t.Name,
    owner: t.Owner,
    createTime: toEpochSeconds(t.CreateTime),
    tableType: t.TableType,
    location: sd?.Location,
    inputFormat: sd?.InputFormat,
    outputFormat: sd?.OutputFormat,
    compressed: sd?.Compressed,
    numBuckets: sd?.NumberOfBuckets,
    bucketCols: sd?.BucketColumns ?? [],
    serde: sd?.SerdeInfo?.SerializationLibrary,
    serdeParameters: sd?.SerdeInfo?.Parameters ?? {},
    columns: toFields(sd?.Columns),
    partitionKeys: toFields(t.PartitionKeys),
    parameters,
    viewOriginalText: original,
    // Athena's expanded text is only a marker. Fall back to what was decoded.
    viewExpandedText: expanded && !/^\/\*/.test(expanded) ? expanded : original,
  };
}

/** Connect, list one page of databases, and report. */
export async function testGlue(cfg: GlueConfig): Promise<{ databases: number; more: boolean }> {
  const res = await glueCall<{ DatabaseList?: GlueDatabase[]; NextToken?: string }>(
    cfg,
    "GetDatabases",
    { MaxResults: PAGE },
  );
  return { databases: res.DatabaseList?.length ?? 0, more: Boolean(res.NextToken) };
}

async function listAll<T>(
  cfg: GlueConfig,
  operation: string,
  payload: Record<string, unknown>,
  key: string,
  cap: number,
): Promise<{ items: T[]; capped: boolean }> {
  const items: T[] = [];
  let token: string | undefined;
  do {
    const res = await glueCall<Record<string, unknown>>(cfg, operation, {
      ...payload,
      MaxResults: PAGE,
      ...(token ? { NextToken: token } : {}),
    });
    items.push(...((res[key] as T[] | undefined) ?? []));
    token = res.NextToken as string | undefined;
    if (items.length >= cap) return { items: items.slice(0, cap), capped: Boolean(token) };
  } while (token);
  return { items, capped: false };
}

async function partitionsOf(cfg: GlueConfig, t: HiveTable): Promise<HivePartitions> {
  const res = await glueCall<{ Partitions?: { Values?: string[] }[]; NextToken?: string }>(
    cfg,
    "GetPartitions",
    {
      DatabaseName: t.database,
      TableName: t.name,
      ExcludeColumnSchema: true,
      MaxResults: PARTITION_PAGE,
    },
  );
  const names = (res.Partitions ?? [])
    .map((p) =>
      (p.Values ?? []).map((v, i) => `${t.partitionKeys[i]?.name ?? `key${i}`}=${v}`).join("/"),
    )
    .sort();
  const capped = Boolean(res.NextToken);
  return {
    count: names.length,
    capped,
    ...(names.length ? { first: names[0] } : {}),
    ...(names.length && !capped ? { last: names[names.length - 1] } : {}),
  };
}

export async function crawlGlue(cfg: GlueConfig): Promise<HiveCrawl> {
  const unread: HiveUnread = { namespaces: [], deeper: [], tables: [], firstError: null };
  const missed = (e: unknown) => {
    unread.firstError ??= e instanceof Error ? e.message : String(e);
  };
  // The first read failing fails the crawl: nothing was read, and nothing is removed.
  const { items: glueDatabases, capped: tooMany } = await listAll<GlueDatabase>(
    cfg,
    "GetDatabases",
    {},
    "DatabaseList",
    MAX_DATABASES,
  );
  if (tooMany) missed(new Error(`Stopped at ${MAX_DATABASES} databases.`));
  const databases: HiveDatabase[] = glueDatabases.map((d) => ({
    name: d.Name,
    description: d.Description,
    location: d.LocationUri,
  }));

  const assets: HiveAsset[] = [];
  const edges: HiveLineageEdge[] = [];
  let partitionCalls = 0;
  for (const db of databases) {
    let tables: GlueTable[];
    let stopped: boolean;
    try {
      const listed = await listAll<GlueTable>(
        cfg,
        "GetTables",
        { DatabaseName: db.name },
        "TableList",
        Math.max(MAX_TABLES - assets.length, 0) || 1,
      );
      tables = listed.items;
      stopped = listed.capped;
    } catch (e) {
      unread.namespaces.push([db.name]);
      missed(e);
      continue;
    }
    // Part of a database was listed: what it held beyond that is unread, and
    // a table not seen there is not a table that went away.
    if (stopped) unread.namespaces.push([db.name]);
    for (const raw of tables) {
      const t = glueTableToHive(raw, db.name);
      let partitions: HivePartitions | undefined;
      if (t.partitionKeys.length > 0 && partitionCalls < MAX_PARTITION_CALLS) {
        partitionCalls++;
        try {
          partitions = await partitionsOf(cfg, t);
        } catch {
          // The table is still a table. Its count is left out, not zeroed.
        }
      }
      assets.push(hiveTableToAsset(t, partitions));
      for (const up of hiveViewUpstreams(t)) {
        edges.push({ upstream_fqn: up, downstream_fqn: `${t.database}.${t.name}`.toLowerCase() });
      }
    }
  }
  if (assets.length === 0 && unread.namespaces.length > 0) {
    throw new Error(
      `None of the catalog's tables could be read. The first failure: ${unread.firstError}`,
    );
  }
  return { assets, sampled: 0, unread, edges, databases, version: null };
}
