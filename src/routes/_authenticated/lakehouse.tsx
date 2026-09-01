// Lakehouse: the built-in columnar warehouse. Browse schemas and tables,
// run governed SQL (typed or NL-generated), inspect snapshots, import
// platform datasets — all through the server chokepoint that enforces
// schema access, audits every statement, and writes query history.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Database as DatabaseIcon,
  Download,
  HardDrive,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Table2,
  Trash2,
  Gauge,
  Layers,
  Mountain,
  Rows3,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { downloadCsv } from "@/lib/exportData";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { parseModelChoice } from "@/utils/providers/modelChoice";
import {
  createLakehouseSchema,
  createLakehouseTable,
  dropLakehouseSchema,
  getLakehouseOverview,
  getLakehouseTable,
  importDatasetToLakehouse,
  listLakeMountCandidates,
  listLakehouseHistory,
  mountLakeSource,
  getLakehousePolicy,
  listLakehouseMatviews,
  profileLakehouseQuery,
  refreshLakehouseMatview,
  saveLakehouseMatview,
  setLakehousePartitioning,
  setLakehousePolicy,
  type LakehousePolicy,
  type LakehouseMatview,
  type LakehouseProfile,
  runLakehouseQuery,
  type LakehouseOverview,
  type LakehouseTableDetail,
  type LakehouseTableSummary,
} from "@/utils/lakehouse.functions";
import type { LakehouseResult } from "@/utils/lakehouse/core.server";

export const Route = createFileRoute("/_authenticated/lakehouse")({
  component: LakehousePage,
});

function fmtBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function LakehousePage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const overviewFn = useServerFn(getLakehouseOverview);

  const [data, setData] = useState<LakehouseOverview | null>(null);
  /** Why the overview could not be read, or null. Rendered — see reload(). */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ schema: string; table: string } | null>(null);
  const [tab, setTab] = useState("query");
  const [sql, setSql] = useState("");

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      setData(await overviewFn({ data: { access_token: token } }));
      setLoadError(null);
    } catch (e) {
      // FOUND FROM THE UI. A toast was the only signal, so a failed load left
      // the page as a permanent pair of skeletons: the toast expires, and after
      // that nothing on screen distinguishes "still loading" from "the catalog
      // is unreachable". The page has to hold the reason, not announce it once.
      setLoadError((e as Error).message);
      toast.error((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const openTable = (schema: string, table: string) => {
    setSelected({ schema, table });
    setTab("table");
  };

  return (
    // Full-height workbench: the explorer is a fixed rail, the working pane
    // scrolls on its own. Stacking these (the old xl-only grid) put the schema
    // tree above the editor on every laptop screen, which is not what a
    // database explorer is.
    <div className="flex h-[calc(100vh-3.5rem)] w-full flex-col overflow-hidden p-3 lg:p-4">
      <div className="mb-3 flex flex-none flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <HardDrive className="h-5 w-5" /> Lakehouse
          </h1>
          <p className="text-sm text-muted-foreground">
            Your local data warehouse — columnar SQL over Parquet in your own storage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw className="mr-1 h-4 w-4" /> Refresh
          </Button>
          {data?.enabled && <MountLakeDialog onMounted={reload} />}
          {data?.enabled && <NewSchemaDialog onCreated={reload} />}
        </div>
      </div>

      {data === null && loadError !== null ? (
        <Card>
          <CardContent className="space-y-3 py-8 text-sm">
            <p className="font-medium">The lakehouse could not be reached.</p>
            <p className="rounded bg-muted px-2 py-1.5 font-mono text-xs break-all">{loadError}</p>
            <p className="text-muted-foreground">
              Both halves have to be reachable from this server: the catalog Postgres (
              <code className="font-mono">LAKEHOUSE_CATALOG_URL</code>) and the object store (
              <code className="font-mono">LAKEHOUSE_S3_ENDPOINT</code>). The tables themselves are
              fine — this is a connection problem, not a data one.
            </p>
            <Button variant="outline" size="sm" onClick={reload}>
              <RefreshCw className="mr-1 h-4 w-4" /> Try again
            </Button>
          </CardContent>
        </Card>
      ) : data === null ? (
        <div className="flex min-h-0 flex-1 gap-3">
          <Skeleton className="hidden w-64 flex-none lg:block xl:w-72" />
          <Skeleton className="min-w-0 flex-1" />
        </div>
      ) : !data.enabled ? (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            The lakehouse isn&apos;t configured on this deployment. Set{" "}
            <code className="font-mono">LAKEHOUSE_CATALOG_URL</code> and the{" "}
            <code className="font-mono">LAKEHOUSE_*</code> storage variables (see{" "}
            <code className="font-mono">.env.example</code> and docs/LAKEHOUSE.md), then restart.
          </CardContent>
        </Card>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          <SchemaRail data={data} selected={selected} onOpenTable={openTable} onChanged={reload} />
          <Tabs
            value={tab}
            onValueChange={setTab}
            className="flex min-w-0 flex-1 flex-col overflow-hidden"
          >
            <TabsList className="flex-none self-start">
              <TabsTrigger value="query">Query</TabsTrigger>
              <TabsTrigger value="table" disabled={!selected}>
                {selected ? `${selected.schema}.${selected.table}` : "Table"}
              </TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="query" className="mt-2 min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
              <QueryTab
                sql={sql}
                setSql={setSql}
                hasSchemas={data.schemas.length > 0}
                onDataChanged={() => void reload()}
              />
            </TabsContent>
            <TabsContent value="table" className="mt-2 min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
              {selected && (
                <TableTab
                  key={`${selected.schema}.${selected.table}`}
                  schema={selected.schema}
                  table={selected.table}
                  onDropped={() => {
                    setSelected(null);
                    setTab("query");
                    void reload();
                  }}
                  onQueryIt={(q) => {
                    setSql(q);
                    setTab("query");
                  }}
                />
              )}
            </TabsContent>
            <TabsContent
              value="history"
              className="mt-2 min-h-0 min-w-0 flex-1 overflow-y-auto pr-1"
            >
              <HistoryTab
                onPick={(q) => {
                  setSql(q);
                  setTab("query");
                }}
              />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}

// ── Left rail ───────────────────────────────────────────────────────────────

function SchemaRail({
  data,
  selected,
  onOpenTable,
  onChanged,
}: {
  data: LakehouseOverview;
  selected: { schema: string; table: string } | null;
  onOpenTable: (schema: string, table: string) => void;
  onChanged: () => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const dropFn = useServerFn(dropLakehouseSchema);
  const [filter, setFilter] = useState("");
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(new Set());

  const bySchema = useMemo(() => {
    const m = new Map<string, LakehouseTableSummary[]>();
    for (const t of data.tables) {
      const list = m.get(t.schema) ?? [];
      list.push(t);
      m.set(t.schema, list);
    }
    return m;
  }, [data.tables]);

  const q = filter.trim().toLowerCase();
  const visible = data.schemas.filter(
    (s) => !q || s.name.includes(q) || (bySchema.get(s.name) ?? []).some((t) => t.name.includes(q)),
  );

  return (
    <aside className="hidden w-64 flex-none flex-col overflow-hidden rounded-lg border bg-card lg:flex xl:w-72">
      <div className="flex-none space-y-2 border-b px-3 py-2.5">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <DatabaseIcon className="h-3.5 w-3.5" /> Object explorer
        </div>
        <Input
          placeholder="Search schemas and tables…"
          className="h-8"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {visible.length === 0 && (
          <p className="px-1 py-4 text-xs text-muted-foreground">
            {data.schemas.length === 0
              ? "No schemas yet — create one to start loading tables."
              : "Nothing matches the search."}
          </p>
        )}
        {visible.map((s) => {
          const open = openSchemas.has(s.name) || Boolean(q);
          const tables = (bySchema.get(s.name) ?? []).filter(
            (t) => !q || t.name.includes(q) || s.name.includes(q),
          );
          return (
            <div key={s.id}>
              <div className="group flex items-center justify-between rounded-md px-1 py-1 hover:bg-muted">
                <button
                  className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm"
                  onClick={() =>
                    setOpenSchemas((prev) => {
                      const next = new Set(prev);
                      if (next.has(s.name)) next.delete(s.name);
                      else next.add(s.name);
                      return next;
                    })
                  }
                >
                  {open ? (
                    <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                  )}
                  <span className="truncate font-medium">{s.name}</span>
                  <span className="text-[11px] text-muted-foreground">({s.table_count})</span>
                  {!s.owned && (
                    <Badge variant="outline" className="ml-1 text-[10px]">
                      shared
                    </Badge>
                  )}
                  {s.lake_source_id && (
                    <Badge
                      variant="outline"
                      className="ml-1 text-[10px]"
                      title="A read-only mount of a data-lake storage source"
                    >
                      lake
                    </Badge>
                  )}
                </button>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                  {!s.lake_source_id && <NewTableDialog schema={s.name} onCreated={onChanged} />}
                  {s.owned && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      title="Drop schema and everything in it"
                      onClick={async () => {
                        if (!confirm(`Drop schema "${s.name}" and all its tables?`)) return;
                        try {
                          await dropFn({ data: { access_token: token, name: s.name } });
                          toast.success(`Dropped ${s.name}`);
                          onChanged();
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
              {open &&
                tables.map((t) => {
                  const active = selected?.schema === s.name && selected?.table === t.name;
                  return (
                    <button
                      key={t.name}
                      className={`flex w-full items-center justify-between gap-2 rounded-md py-1 pl-7 pr-2 text-left text-[13px] hover:bg-muted ${active ? "bg-muted font-medium" : ""}`}
                      onClick={() => onOpenTable(s.name, t.name)}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Table2 className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                        <span className="truncate">{t.name}</span>
                      </span>
                      <span className="flex-none font-mono text-[10px] tabular-nums text-muted-foreground">
                        {t.row_count === null ? "" : `${t.row_count.toLocaleString()} · `}
                        {fmtBytes(t.size_bytes)}
                      </span>
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>
      <div className="flex-none border-t px-3 py-2 text-[11px] text-muted-foreground">
        {data.schemas.length} schema{data.schemas.length === 1 ? "" : "s"} · {data.tables.length}{" "}
        table{data.tables.length === 1 ? "" : "s"}
      </div>
    </aside>
  );
}

// ── Query tab ───────────────────────────────────────────────────────────────

function QueryTab({
  sql,
  setSql,
  hasSchemas,
  onDataChanged,
}: {
  sql: string;
  setSql: (s: string) => void;
  hasSchemas: boolean;
  onDataChanged: () => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const runFn = useServerFn(runLakehouseQuery);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LakehouseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nl, setNl] = useState("");
  const profileFn = useServerFn(profileLakehouseQuery);
  const [profile, setProfile] = useState<LakehouseProfile | null>(null);
  const [profiling, setProfiling] = useState(false);
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [explanation, setExplanation] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const run = async (statement?: string) => {
    const s = (statement ?? sql).trim();
    if (!s) return;
    setRunning(true);
    setError(null);
    setProfile(null);
    try {
      const res = await runFn({ data: { access_token: token, sql: s } });
      setResult(res);
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const generate = async () => {
    if (!nl.trim()) return;
    setGenerating(true);
    setExplanation("");
    try {
      const parsed = parseModelChoice(modelChoice);
      const resp = await fetch("/api/lakehouse/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          question: nl.trim(),
          provider: parsed?.provider,
          model: parsed?.model,
        }),
      });
      const out = (await resp.json()) as { sql?: string; explanation?: string; error?: string };
      if (!resp.ok || !out.sql) throw new Error(out.error ?? "Generation failed");
      setSql(out.sql);
      setExplanation(out.explanation ?? "");
      toast.success("SQL drafted — review, then run");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const exportCsv = () => {
    if (!result) return;
    // The ONE shared CSV writer — quoting and formula-injection guards live
    // there, and a test hunts down any local reimplementation.
    downloadCsv(
      result.columns.map((c) => c.name),
      result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c.name, r[i]]))),
      "lakehouse-result",
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <Card className="flex-none">
        <CardContent className="space-y-2 p-3">
          {/* One row: the hint lives in the placeholder rather than a label
              line, so the ask bar costs 40px instead of three stacked rows. */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-full min-w-40 flex-1 sm:w-auto"
              value={nl}
              onChange={(e) => setNl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void generate()}
              placeholder="Ask in plain language — e.g. total amount by customer, largest first"
              disabled={!hasSchemas}
            />
            <div className="w-44 flex-none">
              <BiModelSelect value={modelChoice} onChange={setModelChoice} allowUnset />
            </div>
            <Button
              size="sm"
              className="flex-none"
              onClick={() => void generate()}
              disabled={generating || !hasSchemas}
            >
              {generating ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-4 w-4" />
              )}
              Draft SQL
            </Button>
          </div>
          {explanation && <p className="text-xs text-muted-foreground">{explanation}</p>}
          <Textarea
            ref={areaRef}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
            rows={6}
            spellCheck={false}
            className="min-h-24 resize-y font-mono text-[13px]"
            placeholder={
              "SELECT …\n\nOne statement per run. Tables are schema.table. Ctrl+Enter runs."
            }
          />
          <div className="flex items-center gap-2">
            <Button onClick={() => void run()} disabled={running || !sql.trim()}>
              {running ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1 h-4 w-4" />
              )}
              Run
            </Button>
            <Button
              variant="outline"
              disabled={profiling || !sql.trim()}
              title="Show the plan the engine chose and what it actually cost"
              onClick={async () => {
                setProfiling(true);
                setError(null);
                try {
                  setProfile(await profileFn({ data: { access_token: token, sql: sql.trim() } }));
                } catch (e) {
                  setProfile(null);
                  setError((e as Error).message);
                } finally {
                  setProfiling(false);
                }
              }}
            >
              {profiling ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Gauge className="mr-1 h-4 w-4" />
              )}
              Explain
            </Button>
            <SaveMatviewDialog sql={sql} onSaved={onDataChanged} />
            {result && (
              <>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {result.row_count.toLocaleString()} row(s) · {result.duration_ms} ms
                  {result.truncated ? " · truncated" : ""}
                  {result.cached && (
                    <Badge
                      variant="secondary"
                      className="text-[10px]"
                      title="Served from the result cache — invalidated automatically by any write"
                    >
                      cached
                    </Badge>
                  )}
                </span>
                <Button variant="ghost" size="sm" onClick={exportCsv}>
                  <Download className="mr-1 h-3.5 w-3.5" /> CSV
                </Button>
              </>
            )}
          </div>
          {error && (
            <p className="whitespace-pre-wrap rounded-md bg-red-500/10 p-2 font-mono text-xs text-red-500">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
      {profile && (
        <div className="flex-none overflow-hidden rounded-lg border bg-card">
          <div className="flex flex-wrap items-center gap-3 border-b px-2.5 py-1.5 text-[11px]">
            <span className="font-medium uppercase tracking-wide text-muted-foreground">
              Query profile
            </span>
            {profile.rows_scanned !== null && (
              <span className="flex items-center gap-1">
                <Rows3 className="h-3 w-3 text-muted-foreground" />
                {profile.rows_scanned.toLocaleString()} rows scanned
              </span>
            )}
            {profile.latency_ms !== null && <span>{profile.latency_ms} ms engine time</span>}
            {profile.result_rows !== null && <span>{profile.result_rows} returned</span>}
            <button
              className="ml-auto text-muted-foreground hover:text-foreground"
              onClick={() => setProfile(null)}
            >
              Close
            </button>
          </div>
          <pre className="max-h-56 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-4">
            {profile.plan}
          </pre>
        </div>
      )}
      {result && (
        <div className="min-h-0 flex-1">
          <ResultGrid result={result} fill />
        </div>
      )}
    </div>
  );
}

function ResultGrid({ result, fill }: { result: LakehouseResult; fill?: boolean }) {
  if (!result.columns.length) {
    return (
      <div className="rounded-lg border bg-card px-3 py-2.5 text-sm text-muted-foreground">
        Statement completed — no result set.
      </div>
    );
  }
  return (
    <div className={`overflow-hidden rounded-lg border bg-card ${fill ? "h-full" : ""}`}>
      <div className={fill ? "h-full overflow-auto" : "max-h-[26rem] overflow-auto"}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              {result.columns.map((c) => (
                <th key={c.name} className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                  {c.name}
                  <span className="ml-1 font-normal lowercase text-muted-foreground">{c.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {result.rows.map((r, i) => (
              <tr key={i} className="border-t">
                {r.map((v, j) => (
                  <td
                    key={j}
                    className="max-w-72 truncate px-2 py-1"
                    title={v === null ? "" : String(v)}
                  >
                    {v === null ? <span className="text-muted-foreground">∅</span> : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Table tab ───────────────────────────────────────────────────────────────

function TableTab({
  schema,
  table,
  onDropped,
  onQueryIt,
}: {
  schema: string;
  table: string;
  onDropped: () => void;
  onQueryIt: (sql: string) => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const detailFn = useServerFn(getLakehouseTable);
  const policyFn = useServerFn(getLakehousePolicy);
  const matviewsFn = useServerFn(listLakehouseMatviews);
  const refreshMvFn = useServerFn(refreshLakehouseMatview);
  const [refreshingMv, setRefreshingMv] = useState(false);
  const runFn = useServerFn(runLakehouseQuery);
  const [detail, setDetail] = useState<LakehouseTableDetail | null>(null);
  const [policy, setPolicy] = useState<LakehousePolicy | null>(null);
  const [matview, setMatview] = useState<LakehouseMatview | null>(null);
  const [preview, setPreview] = useState<LakehouseResult | null>(null);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        setDetail(await detailFn({ data: { access_token: token, schema, table } }));
        // Only an owner gets a policy back; for everyone else it stays null
        // and the badge simply never appears.
        setPolicy(await policyFn({ data: { access_token: token, schema, table } }));
        const views = await matviewsFn({ data: { access_token: token } });
        setMatview(views.find((v) => v.schema_name === schema && v.table_name === table) ?? null);
        setPreview(
          await runFn({
            data: {
              access_token: token,
              sql: `SELECT * FROM "${schema}"."${table}" LIMIT 100`,
              row_cap: 100,
            },
          }),
        );
      } catch (e) {
        toast.error((e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, table, token]);

  if (!detail) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-none flex-wrap items-center gap-2">
        <Badge variant="secondary" className="font-mono">
          {schema}.{table}
        </Badge>
        {detail.row_count !== null && (
          <span className="text-xs text-muted-foreground">
            {detail.row_count.toLocaleString()} row(s)
          </span>
        )}
        {detail.partitioned_by.length > 0 && (
          <Badge
            variant="outline"
            className="font-mono text-[10px]"
            title="Queries filtering on these columns open only the matching files"
          >
            partitioned by {detail.partitioned_by.join(", ")}
          </Badge>
        )}
        {matview && (
          <Badge
            variant="outline"
            className="gap-1 text-[10px]"
            title={
              matview.last_status === "error"
                ? `Last rebuild failed: ${matview.last_error ?? ""}`
                : `Rebuilt ${matview.schedule}`
            }
          >
            <Layers className="h-3 w-3" />
            {matview.schedule === "manual" ? "materialized" : `rebuilt ${matview.schedule}`}
          </Badge>
        )}
        {policy && (
          <Badge
            variant="outline"
            className="gap-1 text-[10px]"
            title={
              [
                policy.row_filter ? `Rows: ${policy.row_filter}` : null,
                policy.masked_columns.length ? `Masked: ${policy.masked_columns.join(", ")}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "Secured"
            }
          >
            <ShieldCheck className="h-3 w-3" /> secured
          </Badge>
        )}
        <div className="ml-auto flex gap-2">
          {matview?.is_owner && (
            <Button
              size="sm"
              variant="outline"
              disabled={refreshingMv}
              title={
                matview.last_refreshed_at
                  ? `Last rebuilt ${new Date(matview.last_refreshed_at).toLocaleString()}`
                  : "Never rebuilt"
              }
              onClick={async () => {
                setRefreshingMv(true);
                try {
                  const res = await refreshMvFn({
                    data: { access_token: token, id: matview.id },
                  });
                  if (res.error) toast.error(`Rebuild failed: ${res.error}`);
                  else toast.success(`Rebuilt — ${res.rows ?? 0} row(s) in ${res.ms} ms`);
                  const views = await matviewsFn({ data: { access_token: token } });
                  setMatview(
                    views.find((v) => v.schema_name === schema && v.table_name === table) ?? null,
                  );
                  setDetail(await detailFn({ data: { access_token: token, schema, table } }));
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setRefreshingMv(false);
                }
              }}
            >
              {refreshingMv ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              Rebuild
            </Button>
          )}
          <PolicyDialog
            schema={schema}
            table={table}
            columns={detail.columns.map((c) => c.name)}
            current={policy}
            onChanged={setPolicy}
          />
          <PartitionDialog
            schema={schema}
            table={table}
            columns={detail.columns.map((c) => c.name)}
            current={detail.partitioned_by}
            onChanged={(cols) => setDetail({ ...detail, partitioned_by: cols })}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => onQueryIt(`SELECT *\nFROM "${schema}"."${table}"\nLIMIT 100`)}
          >
            <Play className="mr-1 h-3.5 w-3.5" /> Query
          </Button>
          <InsertRowDialog schema={schema} table={table} columns={detail.columns} />
          <Button
            size="sm"
            variant="ghost"
            className="text-red-500"
            onClick={async () => {
              if (!confirm(`Drop table ${schema}.${table}?`)) return;
              try {
                await runFn({
                  data: { access_token: token, sql: `DROP TABLE "${schema}"."${table}"` },
                });
                toast.success("Table dropped");
                onDropped();
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Drop
          </Button>
        </div>
      </div>

      {/* Metadata on top (columns + snapshots, each scrolling in place), data
          below filling the rest — the shape you read top-down, not a sidebar
          that steals width from the rows. */}
      <div className="grid flex-none gap-2 md:grid-cols-2">
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="border-b px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Columns ({detail.columns.length})
          </div>
          <div className="max-h-32 overflow-y-auto px-2.5 py-1.5">
            {detail.columns.map((c) => (
              <div
                key={c.name}
                className="flex items-center justify-between gap-3 text-xs leading-5"
              >
                <span className="truncate font-mono">{c.name}</span>
                <span className="flex-none text-muted-foreground">
                  {c.type.toLowerCase()}
                  {c.nullable ? "" : " · not null"}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="flex items-center gap-1 border-b px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Clock3 className="h-3 w-3" /> Snapshots
            <span className="ml-auto font-normal normal-case tracking-normal">
              click to time-travel
            </span>
          </div>
          <div className="max-h-32 overflow-y-auto px-2.5 py-1.5">
            {detail.snapshots.length === 0 && (
              <p className="text-xs text-muted-foreground">No snapshots yet.</p>
            )}
            {detail.snapshots.map((snap) => (
              <button
                key={snap.id}
                className="block w-full rounded px-1 py-0.5 text-left text-[11px] leading-5 hover:bg-muted"
                title={`Query this table as of snapshot ${snap.id}`}
                onClick={() =>
                  onQueryIt(
                    `SELECT *\nFROM "${schema}"."${table}" AT (VERSION => ${snap.id})\nLIMIT 100`,
                  )
                }
              >
                <span className="font-mono">v{snap.id}</span>{" "}
                <span className="text-muted-foreground">
                  {snap.time ? new Date(snap.time).toLocaleString() : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {preview ? (
          <ResultGrid result={preview} fill />
        ) : (
          <Skeleton className="h-full min-h-32 w-full" />
        )}
      </div>
    </div>
  );
}

// ── History tab ─────────────────────────────────────────────────────────────

function HistoryTab({ onPick }: { onPick: (sql: string) => void }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const historyFn = useServerFn(listLakehouseHistory);
  const [rows, setRows] = useState<
    Awaited<ReturnType<typeof listLakehouseHistory>>["history"] | null
  >(null);
  useEffect(() => {
    if (!token) return;
    void historyFn({ data: { access_token: token } })
      .then((r) => setRows(r.history))
      .catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  if (rows === null) return <Skeleton className="h-40 w-full" />;
  return (
    <Card>
      <CardContent className="space-y-1 pt-4">
        {rows.length === 0 && (
          <p className="py-4 text-sm text-muted-foreground">Nothing run yet.</p>
        )}
        {rows.map((h) => (
          <button
            key={h.id}
            className="flex w-full items-center gap-3 rounded-md border px-2 py-1.5 text-left hover:bg-muted"
            onClick={() => onPick(h.sql)}
          >
            <Badge
              variant={h.status === "ok" ? "secondary" : "destructive"}
              className="w-14 justify-center text-[10px]"
            >
              {h.status === "ok" ? h.kind : "error"}
            </Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{h.sql}</span>
            <span className="flex-none font-mono text-[10px] tabular-nums text-muted-foreground">
              {h.cached ? "cached · " : ""}
              {h.retries > 0 ? `retried ${h.retries}× · ` : ""}
              {h.row_count !== null ? `${h.row_count} rows · ` : ""}
              {h.duration_ms ?? 0} ms
            </span>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

/**
 * Turn the query in the editor into a materialized view: a real table holding
 * the answer, rebuilt on a schedule.
 */
function SaveMatviewDialog({ sql, onSaved }: { sql: string; onSaved: () => void }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const saveFn = useServerFn(saveLakehouseMatview);
  const [open, setOpen] = useState(false);
  const [schema, setSchema] = useState("");
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState<"manual" | "hourly" | "daily" | "weekly">("daily");
  const [busy, setBusy] = useState(false);
  const overviewFn = useServerFn(getLakehouseOverview);
  const [schemas, setSchemas] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !token) return;
    void (async () => {
      try {
        const data = await overviewFn({ data: { access_token: token } });
        // Only schemas you own — a view writes a table, and a mount or a
        // shared schema is not yours to write into.
        const own = data.schemas.filter((sch) => sch.owned && !sch.lake_source_id);
        setSchemas(own.map((sch) => sch.name));
        setSchema((cur) => cur || own[0]?.name || "");
      } catch {
        setSchemas([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          disabled={!sql.trim()}
          title="Store this query's answer as a table, rebuilt on a schedule"
        >
          <Layers className="mr-1 h-4 w-4" /> Save as view
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Save as materialized view</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            The answer is stored as a real table and rebuilt on the schedule you pick. Queries then
            read the stored rows instead of recomputing — the usual reason a dashboard goes from
            seconds to instant.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium">Schema</label>
              <Select value={schema} onValueChange={setSchema}>
                <SelectTrigger className="text-xs">
                  <SelectValue placeholder="Pick one" />
                </SelectTrigger>
                <SelectContent>
                  {schemas.map((sch) => (
                    <SelectItem key={sch} value={sch} className="font-mono text-xs">
                      {sch}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Table name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="daily_revenue"
                className="font-mono text-xs"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Rebuild</label>
            <div className="flex gap-1.5">
              {(["manual", "hourly", "daily", "weekly"] as const).map((opt) => (
                <Button
                  key={opt}
                  size="sm"
                  variant={schedule === opt ? "default" : "outline"}
                  className="flex-1 text-xs capitalize"
                  onClick={() => setSchedule(opt)}
                >
                  {opt}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Rebuilding replaces the table in one commit, so readers see the old rows until the new
              ones are ready — never a half-built table. A rebuild that fails leaves the previous
              data in place.
            </p>
          </div>
          <Button
            className="w-full"
            disabled={busy || !schema || !name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await saveFn({
                  data: {
                    access_token: token,
                    schema,
                    table: name.trim(),
                    sql: sql.trim(),
                    schedule,
                  },
                });
                if (res.error) toast.error(`Saved, but the first build failed: ${res.error}`);
                else toast.success(`Built ${schema}.${name.trim()} — ${res.rows ?? 0} row(s)`);
                onSaved();
                setOpen(false);
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Save and build
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Row and column security for one table. Only the owner sees this; everyone
 * else reads through whatever it says without being told what it says.
 */
function PolicyDialog({
  schema,
  table,
  columns,
  current,
  onChanged,
}: {
  schema: string;
  table: string;
  columns: string[];
  current: LakehousePolicy | null;
  onChanged: (policy: LakehousePolicy | null) => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const setFn = useServerFn(setLakehousePolicy);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [masked, setMasked] = useState<string[]>([]);
  const [style, setStyle] = useState<"null" | "hash">("null");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFilter(current?.row_filter ?? "");
    setMasked(current?.masked_columns ?? []);
    setStyle(current?.mask_style ?? "null");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" title="Row and column security">
          <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Security
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Security for {schema}.{table}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Applies to everyone you share this schema with. You are never filtered — a rule you
            can&apos;t see through would be impossible to check.
          </p>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Rows they can see</label>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="owner_email = @me"
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              A condition over this table&apos;s columns. <code className="font-mono">@me</code>{" "}
              becomes the reader&apos;s email and <code className="font-mono">@user_id</code> their
              id, so one rule can give each person their own slice. Leave empty for all rows.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Columns they can&apos;t read</label>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {columns.map((col) => {
                const on = masked.includes(col);
                return (
                  <button
                    key={col}
                    className={`flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left text-xs ${on ? "border-primary/60 bg-primary/5" : ""}`}
                    onClick={() =>
                      setMasked(on ? masked.filter((x) => x !== col) : [...masked, col])
                    }
                  >
                    <span className="font-mono">{col}</span>
                    {on && <span className="text-[10px] text-muted-foreground">hidden</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {masked.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium">How to hide them</label>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={style === "null" ? "default" : "outline"}
                  className="flex-1 text-xs"
                  onClick={() => setStyle("null")}
                >
                  Blank
                </Button>
                <Button
                  size="sm"
                  variant={style === "hash" ? "default" : "outline"}
                  className="flex-1 text-xs"
                  onClick={() => setStyle("hash")}
                >
                  Scramble
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {style === "null"
                  ? "Values come back empty. Works for every column type."
                  : "Text columns come back as a digest — still groupable and joinable, but unreadable. Other types are blanked."}
              </p>
            </div>
          )}

          <Button
            className="w-full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await setFn({
                  data: {
                    access_token: token,
                    schema,
                    table,
                    row_filter: filter.trim() || null,
                    masked_columns: masked,
                    mask_style: style,
                  },
                });
                onChanged(res);
                toast.success(res ? "Security applied" : "Security removed");
                setOpen(false);
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {filter.trim() || masked.length ? "Apply security" : "Remove security"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Set or clear a table's partition columns — the biggest scan-reduction lever. */
function PartitionDialog({
  schema,
  table,
  columns,
  current,
  onChanged,
}: {
  schema: string;
  table: string;
  columns: string[];
  current: string[];
  onChanged: (cols: string[]) => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const setFn = useServerFn(setLakehousePartitioning);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setPicked(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" title="Partitioning">
          <Rows3 className="mr-1 h-3.5 w-3.5" /> Partition
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            Partition {schema}.{table}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Files are written one set per partition value, so a query filtering on these columns
            opens only the matching files. Pick columns with few distinct values (a date, a region,
            a tenant) — never a high-cardinality id, which produces a file per row.
          </p>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {columns.map((col) => {
              const on = picked.includes(col);
              return (
                <button
                  key={col}
                  className={`flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left text-xs ${on ? "border-primary/60 bg-primary/5" : ""}`}
                  onClick={() =>
                    setPicked(on ? picked.filter((x) => x !== col) : [...picked, col].slice(0, 4))
                  }
                >
                  <span className="font-mono">{col}</span>
                  {on && (
                    <span className="text-[10px] text-muted-foreground">
                      key {picked.indexOf(col) + 1}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Applies to files written from now on; run maintenance or rewrite the table to
            re-partition what already exists.
          </p>
          <Button
            className="w-full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await setFn({
                  data: { access_token: token, schema, table, columns: picked },
                });
                onChanged(res.partitioned_by);
                toast.success(
                  res.partitioned_by.length
                    ? `Partitioned by ${res.partitioned_by.join(", ")}`
                    : "Partitioning cleared",
                );
                setOpen(false);
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {picked.length ? "Apply partitioning" : "Clear partitioning"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MountLakeDialog({ onMounted }: { onMounted: () => void }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const listFn = useServerFn(listLakeMountCandidates);
  const mountFn = useServerFn(mountLakeSource);
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<{ id: string; name: string; asset_count: number }[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !token) return;
    void listFn({ data: { access_token: token } })
      .then((r) => setSources(r.sources))
      .catch(() => setSources([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Mountain className="mr-1 h-4 w-4" /> Mount data lake
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mount a data lake</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Query files in an object-storage source as lakehouse tables. Each crawled dataset
            becomes a read-only view — no copying, no path handling, and you can join lake data
            against lakehouse tables in one query.
          </p>
          <div>
            <Label className="text-xs">Storage source</Label>
            <Select
              value={sourceId}
              onValueChange={(v) => {
                setSourceId(v);
                const src = sources.find((x) => x.id === v);
                if (src && !name) {
                  setName(
                    src.name
                      .toLowerCase()
                      .replace(/[^a-z0-9_]/g, "_")
                      .slice(0, 40),
                  );
                }
              }}
            >
              <SelectTrigger className="h-8">
                <SelectValue placeholder="Choose a crawled source" />
              </SelectTrigger>
              <SelectContent>
                {sources.map((src) => (
                  <SelectItem key={src.id} value={src.id}>
                    {src.name} ({src.asset_count} dataset{src.asset_count === 1 ? "" : "s"})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Mount as schema</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              className="h-8 font-mono"
              placeholder="raw_lake"
            />
          </div>
          <Button
            className="w-full"
            disabled={busy || !sourceId || !name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await mountFn({
                  data: { access_token: token, catalog_source_id: sourceId, name: name.trim() },
                });
                toast.success(
                  `Mounted ${res.views} table(s)${res.skipped ? ` — ${res.skipped} skipped` : ""}`,
                );
                setOpen(false);
                setName("");
                setSourceId("");
                onMounted();
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Mount
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NewSchemaDialog({ onCreated }: { onCreated: () => void }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const createFn = useServerFn(createLakehouseSchema);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" /> New schema
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New schema</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="analytics"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Lowercase letters, digits and underscores. Share it from Admin → IAM.
          </p>
          <Button
            className="w-full"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await createFn({ data: { access_token: token, name: name.trim() } });
                toast.success(`Schema "${name.trim()}" created`);
                setOpen(false);
                setName("");
                onCreated();
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const NEW_TABLE_TYPES = [
  "VARCHAR",
  "INTEGER",
  "BIGINT",
  "DOUBLE",
  "DECIMAL(18,4)",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP",
  "JSON",
] as const;

function NewTableDialog({ schema, onCreated }: { schema: string; onCreated: () => void }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const createFn = useServerFn(createLakehouseTable);
  const importFn = useServerFn(importDatasetToLakehouse);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"columns" | "import">("columns");
  const [name, setName] = useState("");
  const [cols, setCols] = useState<{ name: string; type: (typeof NEW_TABLE_TYPES)[number] }[]>([
    { name: "id", type: "INTEGER" },
  ]);
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void supabase
      .from("user_data_tables")
      .select("id, name")
      .order("name")
      .then(({ data }) => setDatasets((data ?? []) as typeof datasets));
  }, [open]);

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "columns") {
        await createFn({
          data: { access_token: token, schema, table: name.trim(), columns: cols },
        });
      } else {
        if (!datasetId) throw new Error("Pick a dataset to import");
        const res = await importFn({
          data: { access_token: token, table_id: datasetId, schema, table: name.trim() },
        });
        toast.success(`Imported ${res.rows.toLocaleString()} row(s)`);
      }
      toast.success(`Table ${schema}.${name.trim()} ready`);
      setOpen(false);
      setName("");
      onCreated();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" className="h-6 w-6" title="New table in this schema">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New table in {schema}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant={mode === "columns" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("columns")}
            >
              Define columns
            </Button>
            <Button
              variant={mode === "import" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("import")}
            >
              <Upload className="mr-1 h-3.5 w-3.5" /> Import dataset
            </Button>
          </div>
          <div>
            <Label className="text-xs">Table name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="orders"
              className="h-8 font-mono"
            />
          </div>
          {mode === "columns" ? (
            <div className="space-y-1.5">
              {cols.map((c, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input
                    value={c.name}
                    onChange={(e) =>
                      setCols(
                        cols.map((x, j) =>
                          j === i ? { ...x, name: e.target.value.toLowerCase() } : x,
                        ),
                      )
                    }
                    placeholder="column"
                    className="h-8 flex-1 font-mono text-xs"
                  />
                  <Select
                    value={c.type}
                    onValueChange={(v) =>
                      setCols(
                        cols.map((x, j) =>
                          j === i ? { ...x, type: v as (typeof NEW_TABLE_TYPES)[number] } : x,
                        ),
                      )
                    }
                  >
                    <SelectTrigger className="h-8 w-36 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NEW_TABLE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => setCols(cols.filter((_, j) => j !== i))}
                    disabled={cols.length === 1}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setCols([...cols, { name: "", type: "VARCHAR" }])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add column
              </Button>
            </div>
          ) : (
            <div>
              <Label className="text-xs">Platform dataset</Label>
              <Select value={datasetId} onValueChange={setDatasetId}>
                <SelectTrigger className="h-8">
                  <SelectValue placeholder="Choose a dataset" />
                </SelectTrigger>
                <SelectContent>
                  {datasets.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Uploads, prep outputs and connector-synced tables — column types inferred.
              </p>
            </div>
          )}
          <Button className="w-full" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {mode === "columns" ? "Create table" : "Import"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InsertRowDialog({
  schema,
  table,
  columns,
}: {
  schema: string;
  table: string;
  columns: { name: string; type: string }[];
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const runFn = useServerFn(runLakehouseQuery);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const names = columns.map((c) => `"${c.name}"`).join(", ");
      const lits = columns
        .map((c) => {
          const v = values[c.name] ?? "";
          if (v === "") return "NULL";
          const numeric = /INT|DOUBLE|DECIMAL|BIGINT/i.test(c.type) && !Number.isNaN(Number(v));
          const boolish = /BOOL/i.test(c.type);
          if (numeric) return v;
          if (boolish) return v.toLowerCase() === "true" ? "true" : "false";
          return `'${v.replace(/'/g, "''")}'`;
        })
        .join(", ");
      await runFn({
        data: {
          access_token: token,
          sql: `INSERT INTO "${schema}"."${table}" (${names}) VALUES (${lits})`,
        },
      });
      toast.success("Row inserted");
      setOpen(false);
      setValues({});
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="mr-1 h-3.5 w-3.5" /> Insert row
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            Insert into {schema}.{table}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {columns.map((c) => (
            <div key={c.name}>
              <Label className="text-xs">
                {c.name} <span className="text-muted-foreground">({c.type.toLowerCase()})</span>
              </Label>
              <Input
                value={values[c.name] ?? ""}
                onChange={(e) => setValues({ ...values, [c.name]: e.target.value })}
                className="h-8 font-mono text-xs"
                placeholder="NULL"
              />
            </div>
          ))}
        </div>
        <Button className="w-full" disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          Insert
        </Button>
      </DialogContent>
    </Dialog>
  );
}
