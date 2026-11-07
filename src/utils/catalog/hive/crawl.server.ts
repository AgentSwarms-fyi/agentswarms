// A crawl of a Hive Metastore: every database, every table, in batches.
//
// The rule from R369 applies as it does to an Iceberg catalog, and it is the
// reason this returns `unread` beside its assets: what could not be read is
// not what is gone. A crawl that lost the metastore halfway would otherwise
// call the second half removed, and take its owners and descriptions with it.
import {
  getDatabase,
  getTables,
  listDatabases,
  listPartitionNames,
  listTables,
  metastoreVersion,
  MetastoreConnection,
  MetastoreError,
  withMetastore,
  type HiveMetastoreConfig,
} from "./metastore.server";
import {
  hiveTableToAsset,
  hiveViewUpstreams,
  type HiveAsset,
  type HiveDatabase,
  type HivePartitions,
} from "./mapping";

const MAX_DATABASES = 1_000;
const MAX_TABLES = 10_000;
/** Tables per round trip. A table with 2,000 columns is still a small reply. */
const BATCH = 100;
/** Past this many partitions a count stops being useful and starts being a cost. */
const PARTITION_SAMPLE = 1_000;
/** Partition listings per crawl. Each is a round trip. */
const MAX_PARTITION_CALLS = 2_000;

export type HiveUnread = {
  /** Databases whose tables could not be listed: everything in them is kept. */
  namespaces: string[][];
  /** Always empty: Hive databases do not nest. Here so the shape matches Iceberg's. */
  deeper: string[][];
  /** Tables that were listed but could not be loaded. */
  tables: string[];
  firstError: string | null;
};

export type HiveLineageEdge = { upstream_fqn: string; downstream_fqn: string };

export type HiveCrawl = {
  assets: HiveAsset[];
  sampled: number;
  unread: HiveUnread;
  edges: HiveLineageEdge[];
  databases: HiveDatabase[];
  version: string | null;
};

export type HiveProbe = {
  version: string | null;
  databases: number;
  framed: boolean;
};

/**
 * Connect, ask for the databases, and report what answered.
 *
 * A metastore is buffered unless its admin turned framing on, and a client on
 * the wrong one gets a closed socket and nothing else, so the transport is
 * found here rather than asked of someone who may never have seen that
 * setting. Whichever worked is what the source stores.
 */
export async function testHiveMetastore(cfg: HiveMetastoreConfig): Promise<HiveProbe> {
  const probe = (framed: boolean) =>
    withMetastore({ ...cfg, framed }, async (c) => {
      const databases = await listDatabases(c);
      return { version: await metastoreVersion(c), databases: databases.length, framed };
    });
  try {
    return await probe(cfg.framed === true);
  } catch (first) {
    // Only a metastore that hung up gets a second try. A refusal, a timeout or
    // a blocked address will say the same thing again.
    if (!(first instanceof Error) || !/closed the connection/.test(first.message)) throw first;
    try {
      return await probe(cfg.framed !== true);
    } catch {
      throw first;
    }
  }
}

async function partitionsOf(
  c: MetastoreConnection,
  database: string,
  table: string,
): Promise<HivePartitions> {
  const names = await listPartitionNames(c, database, table, PARTITION_SAMPLE + 1);
  const capped = names.length > PARTITION_SAMPLE;
  const seen = capped ? names.slice(0, PARTITION_SAMPLE) : names;
  return {
    count: seen.length,
    capped,
    ...(seen.length ? { first: seen[0] } : {}),
    // The real last one is unknown past the cap, so none is claimed.
    ...(seen.length && !capped ? { last: seen[seen.length - 1] } : {}),
  };
}

export async function crawlHiveMetastore(cfg: HiveMetastoreConfig): Promise<HiveCrawl> {
  const unread: HiveUnread = { namespaces: [], deeper: [], tables: [], firstError: null };
  const missed = (e: unknown) => {
    unread.firstError ??= e instanceof Error ? e.message : String(e);
  };
  const assets: HiveAsset[] = [];
  const edges: HiveLineageEdge[] = [];
  const databases: HiveDatabase[] = [];

  return withMetastore(cfg, async (c) => {
    const version = await metastoreVersion(c);
    // The first read failing fails the crawl: nothing was read, which is not
    // an empty metastore, and nothing is removed.
    const all = await listDatabases(c);
    const names = all.slice(0, MAX_DATABASES);
    // Past the cap they were not read, and they are not gone.
    for (const d of all.slice(MAX_DATABASES)) unread.namespaces.push([d]);

    let partitionCalls = 0;
    for (const database of names) {
      // A connection lost mid-crawl is lost for what is left of it.
      if (c.isBroken) {
        unread.namespaces.push([database]);
        continue;
      }
      try {
        databases.push(await getDatabase(c, database));
      } catch (e) {
        // Its description is a nicety. Its tables are the point.
        if (c.isBroken) {
          unread.namespaces.push([database]);
          missed(e);
          continue;
        }
      }
      let tables: string[];
      try {
        tables = await listTables(c, database);
      } catch (e) {
        unread.namespaces.push([database]);
        missed(e);
        continue;
      }
      if (assets.length + tables.length > MAX_TABLES) {
        unread.namespaces.push([database]);
        missed(new Error(`Stopped at ${MAX_TABLES} tables; the rest were not read.`));
        continue;
      }
      for (let i = 0; i < tables.length; i += BATCH) {
        const batch = tables.slice(i, i + BATCH);
        let loaded;
        try {
          if (c.isBroken) throw new MetastoreError("The connection was lost");
          loaded = await getTables(c, database, batch);
        } catch (e) {
          for (const t of batch) unread.tables.push(`${database}.${t}`);
          missed(e);
          continue;
        }
        // Absent from the reply is how a metastore says it could not load one.
        const got = new Set(loaded.map((t) => t.name.toLowerCase()));
        for (const t of batch) {
          if (!got.has(t.toLowerCase())) unread.tables.push(`${database}.${t}`);
        }
        for (const t of loaded) {
          let partitions: HivePartitions | undefined;
          if (t.partitionKeys.length > 0 && partitionCalls < MAX_PARTITION_CALLS && !c.isBroken) {
            partitionCalls++;
            try {
              partitions = await partitionsOf(c, t.database, t.name);
            } catch {
              // The table is still a table. Its count is left out, not zeroed.
            }
          }
          assets.push(hiveTableToAsset(t, partitions));
          for (const up of hiveViewUpstreams(t)) {
            edges.push({
              upstream_fqn: up,
              downstream_fqn: `${t.database}.${t.name}`.toLowerCase(),
            });
          }
        }
      }
    }
    // Tables were listed and not one could be read: the metastore went away.
    if (assets.length === 0 && (unread.tables.length > 0 || unread.namespaces.length > 0)) {
      throw new Error(
        `None of the metastore's tables could be read. The first failure: ${unread.firstError}`,
      );
    }
    return { assets, sampled: 0, unread, edges, databases, version };
  });
}
