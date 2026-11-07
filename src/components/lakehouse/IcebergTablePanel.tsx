// A mounted Iceberg table, read from its own metadata (R457): the format and
// the v3 features in use, branches, tags and snapshots (each one a click away
// from the table as it was), partition spec and sort order, how the schema
// evolved, and upkeep. Shown on the table tab in place of the lakehouse's own
// snapshot list, which a mount does not have.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Clock3, Copy, GitBranch, Loader2, Tag } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { useTokenRef } from "@/hooks/use-token-ref";
import { icebergMountInspect, icebergMountTimeTravel } from "@/utils/icebergCatalogs.functions";
import type { LakehouseResult } from "@/utils/lakehouse/core.server";
import type { IcebergInspection } from "@/utils/lakehouse/icebergInspect";
import { reportFailure } from "@/lib/silentFailureNet";

type Inspection = IcebergInspection & { namespace: string; table: string; catalog: string };

const FEATURE_LABELS: [keyof IcebergInspection["features"], string, string][] = [
  [
    "deletion_vectors",
    "deletion vectors",
    "Deletes are recorded as bitmaps in Puffin files (v3), not as delete files to join",
  ],
  [
    "row_lineage",
    "row lineage",
    "Every row carries an id and the sequence number of its last change (v3)",
  ],
  ["variant", "VARIANT", "Semi-structured columns stored as Iceberg's variant type (v3)"],
  ["nanosecond_timestamps", "ns timestamps", "Timestamps with nanosecond precision (v3)"],
  ["geospatial", "geospatial", "Geometry or geography columns (v3)"],
  ["column_defaults", "column defaults", "Columns added with a default for older rows (v3)"],
];

const count = (n: number | null) => (n === null ? "—" : n.toLocaleString());
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");

export function IcebergSnapshotsCard({
  schema,
  table,
  onResult,
  inspection,
}: {
  schema: string;
  table: string;
  inspection: Inspection | null;
  onResult: (result: LakehouseResult, label: string) => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const travelFn = useServerFn(icebergMountTimeTravel);
  const [busy, setBusy] = useState("");

  async function travel(ref: string, label: string) {
    setBusy(ref);
    try {
      const r = await travelFn({ data: { access_token: token, schema, table, ref, row_cap: 100 } });
      if (!r.ok) return toast.error(r.error);
      onResult(r.result, `${label} (snapshot ${r.snapshot_id})`);
    } catch (e) {
      reportFailure("read the table as of that snapshot", e);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card" data-testid="iceberg-snapshots">
      <div className="flex items-center gap-1 border-b px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Clock3 className="h-3 w-3" /> Snapshots
        {inspection && (
          <span className="font-normal normal-case tracking-normal">
            · {inspection.snapshot_count.toLocaleString()}
          </span>
        )}
        <span className="ml-auto font-normal normal-case tracking-normal">
          click to time-travel
        </span>
      </div>
      <div className="max-h-32 overflow-y-auto px-2.5 py-1.5">
        {!inspection && (
          <p className="text-xs text-muted-foreground">Reading the table's metadata…</p>
        )}
        {inspection?.refs.map((r) => (
          <button
            key={`ref-${r.name}`}
            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] leading-5 hover:bg-muted"
            title={`The table as ${r.type} ${r.name} has it`}
            disabled={Boolean(busy)}
            onClick={() => void travel(r.name, `${r.type === "tag" ? "Tag" : "Branch"} ${r.name}`)}
          >
            {r.type === "tag" ? (
              <Tag className="h-3 w-3 flex-none text-amber-600 dark:text-amber-400" />
            ) : (
              <GitBranch className="h-3 w-3 flex-none text-sky-600 dark:text-sky-400" />
            )}
            <span className="font-mono">{r.name}</span>
            <span className="text-muted-foreground">{r.type}</span>
            {busy === r.name && <Loader2 className="ml-auto h-3 w-3 animate-spin" />}
          </button>
        ))}
        {inspection?.snapshots.map((s) => (
          <button
            key={s.id}
            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] leading-5 hover:bg-muted"
            title={`Query this table as of snapshot ${s.id}`}
            disabled={Boolean(busy)}
            onClick={() => void travel(s.id, `As of ${when(s.time)}`)}
          >
            <span className="font-mono">{s.operation}</span>
            {s.refs.map((r) => (
              <Badge
                key={r}
                variant="outline"
                className="h-4 px-1 text-[9px]"
                title={`The head of ${r}`}
              >
                {r}
              </Badge>
            ))}
            <span className="truncate text-muted-foreground">
              {s.added_records ? `+${count(s.added_records)}` : ""}
              {s.deleted_records ? ` −${count(s.deleted_records)}` : ""}
              {s.rows !== null
                ? ` · ${count(s.rows)} rows`
                : s.total_records !== null
                  ? ` · ${count(s.total_records)} records before equality deletes`
                  : ""}
            </span>
            <span className="ml-auto flex-none text-muted-foreground">{when(s.time)}</span>
            {busy === s.id && <Loader2 className="h-3 w-3 animate-spin" />}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Loads the inspection once per table; the snapshots card and the details panel share it. */
export function useIcebergInspection(schema: string, table: string, enabled: boolean) {
  const { session } = useAuth();
  // Keyed on being signed in, not on the token: the token changes on every
  // session refresh, and keying on it blanked the panel and read the catalog
  // again each time (tokenReloadSweep.test.ts).
  const { tokenRef, signedIn } = useTokenRef(session?.access_token);
  const inspectFn = useServerFn(icebergMountInspect);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setInspection(null);
    setError("");
    if (!enabled || !signedIn) return;
    let live = true;
    void (async () => {
      try {
        const r = await inspectFn({
          data: { access_token: tokenRef.current, schema, table },
        });
        if (!live) return;
        if (r.ok) setInspection(r.inspection);
        else setError(r.error);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, table, signedIn, enabled]);
  return { inspection, error };
}

export function IcebergTablePanel({
  inspection,
  error,
}: {
  inspection: Inspection | null;
  error: string;
}) {
  if (error) {
    return (
      <p className="flex-none rounded-lg border border-destructive/40 px-3 py-2 text-xs text-destructive">
        Could not read this table&apos;s Iceberg metadata: {error}
      </p>
    );
  }
  if (!inspection) return null;
  const t = inspection;
  const features = FEATURE_LABELS.filter(([k]) => t.features[k]);
  return (
    <div
      className="flex-none space-y-2 rounded-lg border bg-card px-3 py-2"
      data-testid="iceberg-table"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge variant="secondary" className="font-mono" title="Iceberg table format version">
          Iceberg v{t.format_version ?? "?"}
        </Badge>
        {features.map(([key, label, title]) => (
          <Badge key={key} variant="outline" className="text-[10px]" title={title}>
            {label}
          </Badge>
        ))}
        <span className="min-w-0 truncate text-muted-foreground" title={t.location ?? undefined}>
          {t.catalog} · {t.namespace}.{t.table}
          {t.last_updated ? ` · updated ${when(t.last_updated)}` : ""}
        </span>
      </div>
      <div className="grid gap-3 text-xs md:grid-cols-3">
        <section className="min-w-0 space-y-1">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Layout
          </h3>
          <p>
            <span className="text-muted-foreground">Partitioned by </span>
            <span className="font-mono">
              {t.partition_spec.length
                ? t.partition_spec
                    .map((p) =>
                      p.transform === "identity" ? p.source : `${p.transform}(${p.source})`,
                    )
                    .join(", ")
                : "nothing"}
            </span>
            {t.partition_spec_versions > 1 && (
              <span className="text-muted-foreground">
                {" "}
                · spec changed {t.partition_spec_versions - 1}×
              </span>
            )}
          </p>
          <p>
            <span className="text-muted-foreground">Sorted by </span>
            <span className="font-mono">
              {t.sort_order.length
                ? t.sort_order
                    .map(
                      (s) =>
                        `${s.transform === "identity" ? s.source : `${s.transform}(${s.source})`} ${s.direction}`,
                    )
                    .join(", ")
                : "nothing"}
            </span>
          </p>
          {t.files && (
            <p className="text-muted-foreground">
              {count(t.files.data_files)} data file{t.files.data_files === 1 ? "" : "s"},{" "}
              {count(
                t.files.position_delete_files +
                  t.files.deletion_vector_files +
                  t.files.equality_delete_files,
              )}{" "}
              delete file
              {t.files.position_delete_files +
                t.files.deletion_vector_files +
                t.files.equality_delete_files ===
              1
                ? ""
                : "s"}
              {t.files.deletion_vector_files
                ? ` (${count(t.files.deletion_vector_files)} deletion vectors)`
                : ""}
            </p>
          )}
        </section>
        <section className="min-w-0 space-y-1">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Schema history · {t.schema_versions} version{t.schema_versions === 1 ? "" : "s"}
          </h3>
          {t.schema_changes.length === 0 ? (
            <p className="text-muted-foreground">Unchanged since the table was created.</p>
          ) : (
            <ul className="max-h-24 space-y-0.5 overflow-y-auto">
              {t.schema_changes.map((c) => (
                <li key={c} className="font-mono text-[11px]">
                  {c}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="min-w-0 space-y-1">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Upkeep
          </h3>
          <ul className="max-h-28 space-y-1.5 overflow-y-auto">
            {t.advice.map((a) => (
              <li key={a.kind + a.title}>
                <p className="font-medium">{a.title}</p>
                <p className="text-muted-foreground">{a.detail}</p>
                {a.sql && (
                  <button
                    className="mt-0.5 inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-left font-mono text-[10px] hover:bg-muted"
                    title="Copy the Spark SQL that does this, for the engine that maintains the table"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(a.sql ?? "");
                        toast.success("Copied the Spark SQL");
                      } catch {
                        toast.error(
                          "The clipboard is not available here; select the text instead.",
                        );
                      }
                    }}
                  >
                    <Copy className="h-3 w-3 flex-none" />
                    <span className="truncate">{a.sql}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
