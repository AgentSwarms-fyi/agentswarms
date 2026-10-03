// What an ML run may do in the lakehouse, and nothing else.
//
// Training and prediction run in a sandbox, which since R231 holds no
// lakehouse credential: the app reads the source, loads the prediction output
// and hands out one URL per model artifact (sandboxLake.server). This builds
// the manifest the app pins on the session and serves every call from.
//
// The SQL is built HERE rather than in the sandbox, because what the sandbox
// may read has to be a thing the app decided. That also puts a prep step's own
// SQL through the SQL editor's checks, which it never went through before.
import type { LakeManifest } from "@/utils/lakehouse/sandboxLake.server";

/** A SQL identifier, quoted. */
function qi(v: string): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

/**
 * The SELECT an ML run reads, as `_source_sql` used to build it in the
 * sandbox: the table, narrowed by a prep step's WHERE or replaced by its own
 * SQL, and then by a data-parallel worker's share of the rows.
 */
export function mlSourceSelect(args: {
  schema: string;
  table: string;
  prep?: { sql?: string; where?: string } | null;
  /** A data-parallel worker's hash predicate, when this is one. */
  partitionSql?: string | null;
}): string {
  const rel = `${qi(args.schema)}.${qi(args.table)}`;
  const prepSql = args.prep?.sql?.trim().replace(/;\s*$/, "");
  const where = args.prep?.where?.trim();
  let body = prepSql ? `(${prepSql}) AS _prep` : where ? `${rel} WHERE (${where})` : rel;
  if (args.partitionSql?.trim()) {
    body = `(SELECT * FROM ${body} WHERE ${args.partitionSql.trim()}) AS _part`;
  }
  return `SELECT * FROM ${body}`;
}

/** The artifact's key inside the lake's bucket, from its s3:// URI. */
export function artifactKeyOf(uri: string): string {
  return /^s3a?:\/\/[^/]+\/(.+)$/.exec(uri)?.[1] ?? uri.replace(/^\/+/, "");
}

/** A training run's manifest: one read, one artifact to write, no loads. */
export function mlTrainManifest(args: {
  source: { schema: string; table: string };
  prep?: { sql?: string; where?: string } | null;
  partitionSql?: string | null;
  /** 0 or absent means "no limit", as the trainer's config has always meant. */
  maxRows?: number;
  /** A forecast cannot be sampled: its rows are a series. */
  task: string;
  artifactUri: string;
  /** An assemble step reads what the workers wrote instead of training. */
  partUris?: string[];
}): LakeManifest {
  const assembling = Boolean(args.partUris?.length);
  const max = args.maxRows && args.maxRows > 0 ? Math.floor(args.maxRows) : 0;
  return {
    reads: assembling
      ? {}
      : {
          source: {
            label: `${args.source.schema}.${args.source.table}`,
            sql: mlSourceSelect({
              ...args.source,
              prep: args.prep,
              partitionSql: args.partitionSql,
            }),
            ...(max && args.task === "forecast"
              ? {
                  refuseOver: {
                    rows: max,
                    message:
                      `The series has %d rows, above the ${max}-row training limit. Aggregate it to one row ` +
                      `per period first, or raise the ML training row limit under Admin -> Developer runtime.`,
                  },
                }
              : max
                ? { sampleTo: max }
                : {}),
          },
        },
    writes: {},
    artifacts: {
      put: artifactKeyOf(args.artifactUri),
      get: (args.partUris ?? []).map(artifactKeyOf),
    },
  };
}

/** A prediction's manifest: the batch it scores, the table it writes, its model. */
export function mlPredictManifest(args: {
  input: { kind: string; schema?: string; table?: string; where?: string };
  output?: { schema: string; table: string } | null;
  maxRows?: number;
  artifactUri: string;
}): LakeManifest {
  const max = args.maxRows && args.maxRows > 0 ? Math.floor(args.maxRows) : 0;
  const reads: LakeManifest["reads"] = {};
  // "rows" scores a payload the caller sent; there is nothing to read.
  if (args.input.kind !== "rows" && args.input.schema && args.input.table) {
    reads.input = {
      label: `${args.input.schema}.${args.input.table}`,
      sql: mlSourceSelect({
        schema: args.input.schema,
        table: args.input.table,
        prep: args.input.where ? { where: args.input.where } : null,
      }),
      ...(max
        ? {
            refuseOver: {
              rows: max,
              message:
                `%d rows to score, above the ${max}-row prediction limit. Add a WHERE filter, ` +
                `or raise the limit under Admin -> Developer runtime.`,
            },
          }
        : {}),
    };
  }
  return {
    reads,
    writes: args.output
      ? {
          output: {
            label: `${args.output.schema}.${args.output.table}`,
            schema: args.output.schema,
            table: args.output.table,
            // A prediction replaces its output table, as it always has.
            mode: "replace",
            primaryKey: [],
          },
        }
      : {},
    artifacts: { get: [artifactKeyOf(args.artifactUri)] },
  };
}
