// A Data Catalog asset as a pipeline source.
//
// The catalog already knows every table the crawler found - warehouse tables
// and views, the lakehouse's own tables, files and partitioned folders in
// buckets, Iceberg tables - with their columns. Picking one of those is the
// most guided way to start a pipeline, and nothing about HOW it is read is
// new: an asset resolves, at pick time, to the source config the compiler
// already has (a database table, an object-storage path, a lakehouse table),
// and the resolution is stored on the node so a run reads exactly what was
// picked. The asset reference stays beside it for the label and the lineage.
//
// Dependency-free: imported by the compiler, the run service, the editor and
// the tests.
import type { SourceFileFormat } from "@/utils/etl/codegen";

export type ResolvedAssetSource =
  | {
      type: "database";
      connection_id: string;
      provider?: string;
      mode: "table";
      table: string;
    }
  | { type: "object_storage"; catalog_source_id: string; path: string; format: SourceFileFormat }
  | { type: "lakehouse"; schema: string; mode: "table"; table: string };

export type CatalogAssetSourceConfig = {
  type: "catalog_asset";
  asset_id: string;
  source_id: string;
  /** The catalog's fully qualified name: schema.table, an object key, or a folder glob. */
  fqn: string;
  /** The catalog source's name, for the node label and the run log. */
  source_name?: string;
  /** What the asset resolved to when it was picked; the compiler and the run read this. */
  resolved?: ResolvedAssetSource;
  /** Engine-managed incremental, as on the underlying source. */
  incremental?: { cursor_column: string };
};

export type CatalogAssetLike = {
  asset_type: string;
  schema_name: string | null;
  name: string;
  fqn: string;
  format: string | null;
};

export type CatalogSourceLike = {
  id: string;
  kind: string;
  connection_id: string | null;
  name?: string;
};

/** File formats the object-storage source reads, by the name the crawler records. */
const READABLE: Record<string, SourceFileFormat> = {
  csv: "csv",
  tsv: "tsv",
  json: "json",
  jsonl: "jsonl",
  ndjson: "jsonl",
  parquet: "parquet",
  xlsx: "xlsx",
  xls: "xlsx",
};

const IN_PIPELINE = "CSV, TSV, JSON, JSONL, Parquet or Excel";

function extensionOf(key: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(key);
  return m ? m[1].toLowerCase() : "";
}

/**
 * The source config an asset stands for. Refuses, in words the picker shows,
 * what a pipeline cannot read: a bucket format the engine has no reader for,
 * an Iceberg REST table (read it through a lakehouse mount), a warehouse
 * source with no connection.
 */
export function resolveCatalogAsset(
  asset: CatalogAssetLike,
  source: CatalogSourceLike,
  opts: { provider?: string } = {},
): { ok: true; resolved: ResolvedAssetSource } | { ok: false; error: string } {
  if (source.kind === "iceberg_rest") {
    return {
      ok: false,
      error:
        "An Iceberg catalog table is read through the lakehouse: mount its namespace under Lakehouse → Iceberg, then pick it as a Lakehouse table.",
    };
  }
  if (source.kind === "warehouse") {
    if (asset.asset_type !== "table" && asset.asset_type !== "view") {
      return { ok: false, error: `"${asset.fqn}" is not a table or a view.` };
    }
    if (opts.provider === "lakehouse") {
      if (!asset.schema_name) {
        return { ok: false, error: `"${asset.fqn}" has no schema; the lakehouse needs one.` };
      }
      return {
        ok: true,
        resolved: {
          type: "lakehouse",
          schema: asset.schema_name,
          mode: "table",
          table: asset.name,
        },
      };
    }
    if (!source.connection_id) {
      return {
        ok: false,
        error: `The catalog source "${source.name ?? source.id}" has no connection to read through.`,
      };
    }
    return {
      ok: true,
      resolved: {
        type: "database",
        connection_id: source.connection_id,
        ...(opts.provider ? { provider: opts.provider } : {}),
        mode: "table",
        table: asset.fqn,
      },
    };
  }
  if (source.kind === "object_storage") {
    if (asset.asset_type !== "file" && asset.asset_type !== "dataset") {
      return { ok: false, error: `"${asset.fqn}" is not a file or a dataset.` };
    }
    const raw = (asset.format ?? extensionOf(asset.fqn)).toLowerCase();
    const format = READABLE[raw];
    if (!format) {
      return {
        ok: false,
        error: `"${asset.fqn}" is ${raw ? `${raw.toUpperCase()}, ` : ""}not a format a pipeline reads (${IN_PIPELINE}).`,
      };
    }
    // The crawler writes a root-level folder glob as "./*.csv"; the reader
    // joins the path under the bucket prefix, where "./" has no meaning.
    const path = asset.fqn.replace(/^\.\//, "");
    return {
      ok: true,
      resolved: { type: "object_storage", catalog_source_id: source.id, path, format },
    };
  }
  return { ok: false, error: `Catalog sources of kind "${source.kind}" cannot feed a pipeline.` };
}

export function isCatalogAsset(
  c: { type?: string } | null | undefined,
): c is CatalogAssetSourceConfig {
  return Boolean(c) && (c as { type?: string }).type === "catalog_asset";
}

/**
 * The config the compiler and the run see: an asset becomes what it resolved
 * to, with its incremental cursor carried across. Everything else passes
 * through untouched. An asset that was never resolved is an error in the
 * picker's own words, raised where the compiler raises the rest.
 */
export function unwrapSourceConfig<T extends { type: string }>(
  c: T,
): T | (ResolvedAssetSource & { incremental?: { cursor_column: string } }) {
  if (!isCatalogAsset(c)) return c;
  if (!c.resolved) {
    throw new Error(
      `Data Catalog source${c.fqn ? ` "${c.fqn}"` : ""}: pick an asset from the catalog.`,
    );
  }
  return c.incremental ? { ...c.resolved, incremental: c.incremental } : { ...c.resolved };
}

/** What lineage records for a run that read this asset. */
export function catalogAssetLineage(c: CatalogAssetSourceConfig): string {
  return `catalog:${c.fqn}`;
}

/** One line for the node panel: what the pick stands for. */
export function describeResolvedSource(r: ResolvedAssetSource | undefined): string {
  if (!r) return "No asset picked yet.";
  if (r.type === "database") return `Reads table ${r.table} through the source's connection.`;
  if (r.type === "lakehouse") return `Reads lakehouse table ${r.schema}.${r.table}.`;
  return `Reads ${r.format.toUpperCase()} at ${r.path} in the source's bucket.`;
}
