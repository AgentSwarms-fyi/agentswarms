// One page per dataset: everything known about it in one place.
//
// A dataset used to be a drawer in the Data Catalog, with its checks in one
// panel, its versions in another, what uses it in the delete dialog, and who
// may read it nowhere its owner could see. Here: whether it can be trusted
// today and why, where its rows come from, what is built on it, a sample,
// what each column holds, its checks and versions, how its columns changed,
// and who else reads it.
//
// The reader decides what is shown. The owner sees all of it. Someone it is
// shared with sees the rows and columns their grant allows, whether their
// grant hides any, and what of theirs is built on it — never the owner's
// checks, versions, masks or other grants. A bundled sample is read-only.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { DeleteDatasetDialog } from "@/components/bi/DeleteDatasetDialog";
import { DatasetQualityPanel } from "@/components/catalog/DatasetQualityPanel";
import {
  AccessList,
  ColumnProfiles,
  FactRow,
  OriginBlock,
  SampleTable,
  SchemaChanges,
  SensitiveBlock,
  TrustSummary,
  UsageBlock,
  type AccessGrant,
} from "@/components/dataset/DatasetSections";
import { HideColumnsDialog } from "@/components/dataset/HideColumnsDialog";
import { PageHeader, TitleCount } from "@/components/PageHeader";
import { StarButton } from "@/components/StarButton";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/use-auth";
import { useTokenRef } from "@/hooks/use-token-ref";
import { useRecordOpened } from "@/hooks/use-object-marks";
import { supabase } from "@/integrations/supabase/client";
import { describeFreshness } from "@/lib/biFreshness";
import { loadLatestQualityResults, listQualityTests } from "@/lib/dataQuality";
import { rollupQuality, type QualityRollup } from "@/lib/dataQualityCore";
import {
  datasetTrust,
  filterSentence,
  originsOf,
  profileColumns,
  schemaChanges,
  type DatasetRole,
  type SchemaChange,
} from "@/lib/datasetPage";
import { datasetWindow } from "@/lib/datasetRowReads";
import { findSensitiveColumns, readersOf } from "@/lib/sensitiveData";
import { isMissingFunction, readSharedDatasets } from "@/lib/sharedDatasetList";
import { deleteDataset } from "@/lib/sqlEngine";
import { datasetDependents } from "@/utils/dataPrep.functions";
import { datasetUsageFn, type DatasetUsage } from "@/utils/datasetPage.functions";
import { listDatasetVersionsFn } from "@/utils/dataQuality.functions";
import { listSaasConnections } from "@/utils/saas.functions";

export const Route = createFileRoute("/_authenticated/data-sql_/$datasetId")({
  component: DatasetPage,
  head: () => ({ meta: [{ title: "Dataset — AgentSwarms" }] }),
});

/** Rows read for the sample and the column profile; the table shows fewer. */
const SAMPLE_READ = 500;
const SAMPLE_SHOWN = 100;

type Col = { name: string; type?: string };
type DatasetRow = {
  id: string;
  name: string;
  user_id: string | null;
  columns: Col[];
  data_loaded_at: string | null;
  created_at: string;
  source_filename: string | null;
  saas_connection_id: string | null;
  saas_stream: string | null;
  is_sample: boolean;
  parquet_rows: number | null;
  parquet_bytes: number | null;
};

type Loaded =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "error"; message: string }
  | { state: "ok"; role: DatasetRole; row: DatasetRow; masked: boolean; filtered: boolean };

const COLS =
  "id, name, user_id, columns, data_loaded_at, created_at, source_filename, saas_connection_id, saas_stream, is_sample, parquet_rows, parquet_bytes";

function asCols(v: unknown): Col[] {
  return Array.isArray(v)
    ? v
        .filter((c): c is Col => !!c && typeof (c as Col).name === "string")
        .map((c) => ({ name: c.name, type: typeof c.type === "string" ? c.type : undefined }))
    : [];
}

function bytesLabel(n: number | null): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function DatasetPage() {
  const { datasetId } = Route.useParams();
  const { user, session } = useAuth();
  const navigate = useNavigate();
  // Keyed on who is signed in, not on the session object or its token: both
  // change on every refresh (about hourly), and the page must not reload then.
  const userId = user?.id ?? null;
  const { tokenRef, signedIn } = useTokenRef(session?.access_token);

  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityRollup | null>(null);
  const [slaHours, setSlaHours] = useState<number | null>(null);
  const [versions, setVersions] = useState<{ at: string; columns: string[] }[] | null>(null);
  const [usage, setUsage] = useState<DatasetUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [grants, setGrants] = useState<AccessGrant[] | null>(null);
  const [grantsMissing, setGrantsMissing] = useState(false);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const [connectionName, setConnectionName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [hiding, setHiding] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useRecordOpened("dataset", loaded.state === "ok" ? loaded.row.id : null);

  // Who is reading, and the dataset as they may see it.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setLoaded({ state: "loading" });
    void (async () => {
      try {
        const own = await supabase
          .from("user_data_tables")
          .select(COLS)
          .eq("id", datasetId)
          .maybeSingle();
        if (own.error && own.error.code !== "PGRST116") throw new Error(own.error.message);
        let row: DatasetRow | null = own.data
          ? ({ ...own.data, columns: asCols(own.data.columns) } as DatasetRow)
          : null;
        let role: DatasetRole = "shared";
        if (row) role = row.user_id === userId ? "owner" : row.is_sample ? "sample" : "shared";
        else {
          // A dataset shared under a mask is not in a direct read: the shared
          // list returns it, with the columns the grant lets this reader see.
          const shared = await readSharedDatasets(supabase);
          const s = shared?.find((d) => d.id === datasetId);
          if (s) {
            row = {
              id: s.id,
              name: s.name,
              user_id: s.user_id,
              columns: asCols(s.columns),
              data_loaded_at: s.data_loaded_at,
              created_at: s.created_at,
              source_filename: null,
              saas_connection_id: null,
              saas_stream: null,
              is_sample: s.is_sample,
              parquet_rows: s.parquet_rows,
              parquet_bytes: s.parquet_bytes,
            };
          }
        }
        if (!alive) return;
        if (!row) return setLoaded({ state: "missing" });
        let masked = false;
        let filtered = false;
        if (role === "shared") {
          const g = await supabase.rpc("my_resource_grants", {
            _resource_type: "data_table",
            _resource_ids: [datasetId],
          });
          for (const x of g.data ?? []) {
            masked ||= !!x.masked;
            filtered ||= !!filterSentence(x.row_filter);
          }
        }
        if (alive) setLoaded({ state: "ok", role, row, masked, filtered });
      } catch (e) {
        if (alive)
          setLoaded({
            state: "error",
            message: e instanceof Error ? e.message : "It could not be read",
          });
      }
    })();
    return () => {
      alive = false;
    };
  }, [datasetId, userId, reloadKey]);

  const ok = loaded.state === "ok" ? loaded : null;
  const role = ok?.role ?? null;
  const name = ok?.row.name ?? "";

  // The sample: through the owner's read, or through the grant.
  useEffect(() => {
    if (!ok) return;
    let alive = true;
    setRows(null);
    setRowsError(null);
    void (async () => {
      try {
        let r: Record<string, unknown>[];
        if (ok.role === "shared") {
          const res = await supabase
            .rpc("shared_dataset_rows", { _table_id: ok.row.id })
            .range(0, SAMPLE_READ - 1);
          if (res.error) throw new Error(res.error.message);
          r = (res.data ?? []) as Record<string, unknown>[];
        } else r = await datasetWindow(ok.row.id, 0, SAMPLE_READ);
        if (alive) setRows(r);
      } catch (e) {
        if (alive) setRowsError(e instanceof Error ? e.message : "The rows could not be read");
      }
    })();
    return () => {
      alive = false;
    };
  }, [ok?.row.id, ok?.role, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The owner's checks, versions and grants; anyone's own use of it.
  useEffect(() => {
    if (!ok) return;
    let alive = true;
    const id = ok.row.id;
    setUsage(null);
    setUsageError(null);
    datasetUsageFn({ data: { tableId: id, tableName: ok.row.name } })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setUsage(r.usage);
        else setUsageError(r.error);
      })
      .catch((e: unknown) => alive && setUsageError((e as Error).message));
    if (ok.row.saas_connection_id && tokenRef.current) {
      listSaasConnections({ data: { access_token: tokenRef.current } })
        .then((list) => {
          const c = (list ?? []).find((x) => x.id === ok.row.saas_connection_id);
          if (alive) setConnectionName(c?.name ?? null);
        })
        .catch(() => undefined);
    }
    // Everything below is the owner's alone: someone it is shared with never
    // reads the owner's checks, versions or other grants.
    if (ok.role !== "owner") {
      return () => {
        alive = false;
      };
    }
    void (async () => {
      try {
        const [tests, latest] = await Promise.all([
          listQualityTests(id),
          loadLatestQualityResults([id]),
        ]);
        const byTest = new Map(latest.map((r) => [r.test_id, r]));
        if (!alive) return;
        setQuality(rollupQuality(tests, byTest));
        const fresh = tests.find((t) => t.enabled && t.kind === "freshness");
        const h = Number((fresh?.config as { max_age_hours?: unknown } | undefined)?.max_age_hours);
        setSlaHours(Number.isFinite(h) && h > 0 ? h : null);
      } catch {
        if (alive) setQuality(null);
      }
    })();
    if (tokenRef.current) {
      listDatasetVersionsFn({ data: { accessToken: tokenRef.current, tableId: id } })
        .then((r) => {
          if (alive && r.ok)
            setVersions(r.versions.map((v) => ({ at: v.created_at, columns: v.column_names })));
        })
        .catch(() => undefined);
    }
    setGrants(null);
    readGrants(id, () => alive);
    return () => {
      alive = false;
    };
  }, [ok?.row.id, ok?.role, signedIn, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The owner's grants, read again after columns are hidden from them. */
  function readGrants(id: string, alive: () => boolean = () => true) {
    setGrantsMissing(false);
    setGrantsError(null);
    void supabase.rpc("dataset_access", { p_dataset_id: id }).then(({ data, error }) => {
      if (!alive()) return;
      if (error) {
        if (isMissingFunction(error)) setGrantsMissing(true);
        else setGrantsError(error.message);
        return;
      }
      setGrants((data ?? []) as AccessGrant[]);
    });
  }

  const columnNames = useMemo(() => {
    if (!ok) return [];
    const listed = ok.row.columns.map((c) => c.name);
    // A grantee's rows carry only the columns their grant lets them see.
    if (ok.role === "shared" && rows?.length) {
      const seen = new Set(rows.flatMap((r) => Object.keys(r)));
      return listed.filter((c) => seen.has(c));
    }
    return listed;
  }, [ok, rows]);
  const types = useMemo(
    () => new Map((ok?.row.columns ?? []).filter((c) => c.type).map((c) => [c.name, c.type!])),
    [ok],
  );
  const profiles = useMemo(
    () => (rows ? profileColumns(rows, columnNames, types) : []),
    [rows, columnNames, types],
  );
  // From the same sample: a grantee's rows carry only what their grant shows.
  const findings = useMemo(
    () => (rows ? findSensitiveColumns(rows, columnNames) : []),
    [rows, columnNames],
  );
  const exposed = useMemo(
    () =>
      grants
        ? readersOf(
            findings,
            grants.map((g) => g.column_mask),
          ).filter((r) => r.readers > 0)
        : [],
    [findings, grants],
  );
  const origins = useMemo(
    () =>
      ok
        ? originsOf(ok.row, {
            flowsProducing: usage?.flowsProducing ?? [],
            connectionName,
          })
        : [],
    [ok, usage, connectionName],
  );
  const usedBy = usage
    ? usage.dashboards.length +
      usage.semanticModels.length +
      usage.analysts.named.length +
      usage.agents.named.length +
      usage.flowsUsing.length +
      usage.savedMetrics
    : 0;
  const trust = useMemo(
    () =>
      ok
        ? datasetTrust({
            role: ok.role,
            loadedAt: ok.row.data_loaded_at,
            freshnessSlaHours: slaHours,
            quality,
            origins,
            usedBy,
            masked: ok.masked,
            filtered: ok.filtered,
          })
        : null,
    [ok, slaHours, quality, origins, usedBy],
  );
  const changes: SchemaChange[] = useMemo(
    () =>
      ok && versions
        ? schemaChanges(versions, {
            at: ok.row.data_loaded_at,
            columns: ok.row.columns.map((c) => c.name),
          })
        : [],
    [ok, versions],
  );

  const loadDependents = useCallback(
    async (tableId: string) => {
      if (!tokenRef.current) throw new Error("Sign in again to check what uses it");
      return datasetDependents({ data: { accessToken: tokenRef.current, tableId } });
    },
    [tokenRef],
  );

  if (loaded.state === "loading")
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (loaded.state !== "ok")
    return (
      <div className="space-y-4 p-6">
        <BackLink />
        <p className="text-sm text-muted-foreground">
          {loaded.state === "missing"
            ? "This dataset is not here, or it is not yours to see."
            : `It could not be read: ${loaded.message}`}
        </p>
      </div>
    );

  const { row } = loaded;
  const fresh = describeFreshness(row.data_loaded_at);
  const owner = role === "owner";
  const chips = [role === "sample" && "Sample", role === "shared" && "Shared with you"].filter(
    Boolean,
  ) as string[];

  return (
    <div className="mx-auto min-w-0 max-w-6xl space-y-6 p-6">
      <BackLink />
      <PageHeader
        title={row.name}
        meta={
          <>
            <StarButton kind="dataset" id={row.id} name={row.name} />
            {chips.map((c) => (
              <TitleCount key={c}>{c}</TitleCount>
            ))}
          </>
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to="/data-sql" search={{ query: row.name } as never}>
                <Play className="mr-1.5 h-3.5 w-3.5" /> Query
              </Link>
            </Button>
            {owner && (
              <Button
                variant="outline"
                size="sm"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleting({ id: row.id, name: row.name })}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
              </Button>
            )}
          </>
        }
      />

      <FactRow
        facts={[
          {
            label: "Rows",
            value:
              row.parquet_rows?.toLocaleString() ??
              (rows
                ? rows.length < SAMPLE_READ
                  ? rows.length.toLocaleString()
                  : `More than ${SAMPLE_READ}`
                : "—"),
          },
          { label: "Columns", value: columnNames.length || row.columns.length },
          { label: "Size", value: bytesLabel(row.parquet_bytes) },
          {
            label: "Rows loaded",
            value: fresh?.relative ?? "—",
            title: fresh?.absolute,
          },
        ]}
      />

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="sample">Sample</TabsTrigger>
          <TabsTrigger value="columns">Columns</TabsTrigger>
          {owner && <TabsTrigger value="checks">Checks and versions</TabsTrigger>}
          {owner && <TabsTrigger value="schema">Schema changes</TabsTrigger>}
          {role !== "sample" && <TabsTrigger value="access">Access</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          {trust && <TrustSummary trust={trust} />}
          {rows && (
            <SensitiveBlock
              findings={findings}
              sampled={rows.length}
              owner={owner}
              grants={owner ? grants : null}
              onHide={() => setHiding(true)}
            />
          )}
          <div className="grid gap-4 md:grid-cols-2">
            {role !== "shared" && <OriginBlock origins={origins} />}
            <UsageBlock usage={usage} error={usageError} shared={role === "shared"} />
          </div>
        </TabsContent>

        <TabsContent value="sample">
          {rowsError ? (
            <p className="text-sm text-muted-foreground">The rows could not be read: {rowsError}</p>
          ) : rows ? (
            <SampleTable rows={rows} columns={columnNames} shown={SAMPLE_SHOWN} />
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </TabsContent>

        <TabsContent value="columns">
          {rows ? (
            <ColumnProfiles profiles={profiles} types={types} findings={findings} />
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </TabsContent>

        {owner && (
          <TabsContent value="checks">
            <DatasetQualityPanel
              tableId={row.id}
              tableName={row.name}
              columns={row.columns}
              onDatasetChanged={() => setReloadKey((k) => k + 1)}
            />
          </TabsContent>
        )}

        {owner && (
          <TabsContent value="schema">
            <SchemaChanges changes={changes} versions={versions?.length ?? 0} />
          </TabsContent>
        )}

        {role !== "sample" && (
          <TabsContent value="access">
            {owner ? (
              <AccessList grants={grants} missing={grantsMissing} error={grantsError} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Someone shared it with you, read-only.{" "}
                {loaded.masked || loaded.filtered
                  ? `Your access leaves out ${[loaded.filtered && "some rows", loaded.masked && "some columns"].filter(Boolean).join(" and ")}; which ones is the owner's to know.`
                  : "You see all of its rows and columns."}
              </p>
            )}
          </TabsContent>
        )}
      </Tabs>

      {owner && grants && (
        <HideColumnsDialog
          open={hiding}
          onOpenChange={setHiding}
          datasetId={row.id}
          datasetName={row.name}
          readable={exposed}
          grants={grants.length}
          onHidden={() => readGrants(row.id)}
        />
      )}

      <DeleteDatasetDialog
        target={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        loadDependents={loadDependents}
        onConfirm={async (t) => {
          await deleteDataset(t.id, t.name);
          toast.success(`Deleted ${t.name}`);
          void navigate({ to: "/data-sql" });
        }}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/data-sql"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-3 w-3" /> Data Catalog
    </Link>
  );
}
