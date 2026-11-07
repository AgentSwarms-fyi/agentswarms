// Where a lake table lives and how it is laid out.
//
// These are the facts an engineer opens a metastore to find, and an asset with
// a location is worth little without them: which path, external or managed,
// what it is partitioned by and how far back the partitions run. Nothing here
// is editable. It is what the source said on the last crawl.
import { useState } from "react";
import { ChevronRight, Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { AssetMetadata } from "@/lib/catalogAssetMetadata";

const TABLE_TYPE_LABEL: Record<string, string> = {
  MANAGED_TABLE: "Managed table",
  EXTERNAL_TABLE: "External table",
  VIRTUAL_VIEW: "View",
  MATERIALIZED_VIEW: "Materialized view",
};

/** `org.apache.hadoop.hive.ql.io.orc.OrcSerde` reads as `OrcSerde`. */
const shortClass = (c: string) => c.split(".").pop() ?? c;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-[11px]">{children}</dd>
    </>
  );
}

export function AssetStorageFacts({ metadata }: { metadata?: AssetMetadata }) {
  const [showSql, setShowSql] = useState(false);
  const [showProps, setShowProps] = useState(false);
  const m = metadata ?? {};
  const properties = Object.entries(m.properties ?? {});
  const hasFacts =
    m.location ||
    m.table_type ||
    m.partition_keys?.length ||
    m.serde ||
    m.view_sql ||
    m.source_owner ||
    m.format_version;
  if (!hasFacts && !m.note) return null;

  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Storage
      </p>
      {m.note && (
        <p className="mb-2 flex items-start gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{m.note}</span>
        </p>
      )}
      {hasFacts && (
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1">
          {m.location && (
            <Fact label="Location">
              <code className="font-mono text-[10.5px]">{m.location}</code>
            </Fact>
          )}
          {m.table_type && (
            <Fact label="Table type">{TABLE_TYPE_LABEL[m.table_type] ?? m.table_type}</Fact>
          )}
          {m.partition_keys && m.partition_keys.length > 0 && (
            <Fact label="Partitioned by">
              <span className="flex flex-wrap gap-1">
                {m.partition_keys.map((k) => (
                  <Badge key={k} variant="outline" className="h-4 px-1 font-mono text-[10px]">
                    {k}
                  </Badge>
                ))}
              </span>
            </Fact>
          )}
          {m.partition_count !== undefined && (
            <Fact label="Partitions">
              <span className="tabular-nums">
                {m.partition_count.toLocaleString("en-US")}
                {m.partition_count_capped ? "+" : ""}
              </span>
              {m.first_partition && (
                <span className="block font-mono text-[10px] text-muted-foreground">
                  {m.first_partition}
                  {m.last_partition && m.last_partition !== m.first_partition
                    ? ` → ${m.last_partition}`
                    : ""}
                </span>
              )}
            </Fact>
          )}
          {m.bucket_count !== undefined && (
            <Fact label="Buckets">
              {m.bucket_count}
              {m.bucket_columns?.length ? ` on ${m.bucket_columns.join(", ")}` : ""}
            </Fact>
          )}
          {m.serde && (
            <Fact label="SerDe">
              <span title={m.serde}>{shortClass(m.serde)}</span>
            </Fact>
          )}
          {m.input_format && (
            <Fact label="Input format">
              <span title={m.input_format}>{shortClass(m.input_format)}</span>
            </Fact>
          )}
          {m.format_version !== undefined && (
            <Fact label="Format version">v{m.format_version}</Fact>
          )}
          {m.snapshot_count !== undefined && (
            <Fact label="Versions">{m.snapshot_count.toLocaleString("en-US")}</Fact>
          )}
          {m.source_owner && <Fact label="Source owner">{m.source_owner}</Fact>}
          {m.created_at && (
            <Fact label="Created">{new Date(m.created_at).toLocaleDateString()}</Fact>
          )}
        </dl>
      )}
      {m.view_sql && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={showSql}
            onClick={() => setShowSql((v) => !v)}
            className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${showSql ? "rotate-90" : ""}`}
            />
            View definition
          </button>
          {showSql && (
            <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[10.5px] whitespace-pre-wrap">
              {m.view_sql}
            </pre>
          )}
        </div>
      )}
      {properties.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={showProps}
            onClick={() => setShowProps((v) => !v)}
            className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${showProps ? "rotate-90" : ""}`}
            />
            Table properties ({properties.length})
          </button>
          {showProps && (
            <dl className="mt-1 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-md bg-muted/50 p-2 font-mono text-[10.5px]">
              {properties.map(([k, v]) => (
                <Fact key={k} label={k}>
                  {v}
                </Fact>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
