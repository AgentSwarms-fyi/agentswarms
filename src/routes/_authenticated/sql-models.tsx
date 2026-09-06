// Data & BI -> SQL Models: a transformation layer over the lakehouse.
//
// A model is one SELECT that may name other models with ref('name'). The page
// is built around the two questions that matter and that a list of queries
// cannot answer: what order does this build in, and what broke downstream when
// something failed.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AlertTriangle,
  Blocks,
  Check,
  History,
  Loader2,
  Pause,
  Play,
  Plus,
  Table2,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { relTime } from "@/components/ml/mlUi";
import { cn } from "@/lib/utils";
import {
  TEST_LABELS,
  buildPlan,
  describeTest,
  refNames,
  validateModelName,
  type Materialization,
  type SqlModel,
  type SqlModelTest,
  type SqlModelTestKind,
} from "@/lib/sqlModels";
import {
  sqlModelDelete,
  sqlModelPreview,
  sqlModelRunsList,
  sqlModelSave,
  sqlModelToggle,
  sqlModelsBuild,
  sqlModelsList,
  type SqlModelRunRow,
} from "@/utils/sqlModels.functions";
import type { ModelResult, SqlModelRow } from "@/utils/sqlModels/run.server";

export const Route = createFileRoute("/_authenticated/sql-models")({
  head: () => ({
    meta: [
      { title: "SQL Models — AgentSwarms" },
      {
        name: "description",
        content:
          "Define lakehouse tables as SQL models that reference each other, built in dependency order on a schedule, with tests that stop a broken model reaching everything downstream.",
      },
    ],
  }),
  component: SqlModelsPage,
});

const SCHEDULES = ["manual", "hourly", "daily", "weekly", "cron"] as const;
type Schedule = (typeof SCHEDULES)[number];

const TEST_KINDS: SqlModelTestKind[] = [
  "not_null",
  "unique",
  "accepted_values",
  "range",
  "row_count_min",
];

const STARTER_SQL = `-- A model is one SELECT. Name another model with ref('its_name')
-- and it is built first.
select
  *
from ref('stg_orders')
where status = 'complete'
`;

type Draft = {
  id: string | null;
  name: string;
  description: string;
  schema_name: string;
  sql: string;
  materialization: Materialization;
  tests: SqlModelTest[];
  schedule: Schedule;
  cron_expr: string;
  timezone: string;
  is_active: boolean;
};

function emptyDraft(schema: string): Draft {
  return {
    id: null,
    name: "",
    description: "",
    schema_name: schema,
    sql: STARTER_SQL,
    materialization: "table",
    tests: [],
    schedule: "manual",
    cron_expr: "",
    timezone: "UTC",
    is_active: true,
  };
}

function draftOf(m: SqlModelRow): Draft {
  return {
    id: m.id,
    name: m.name,
    description: m.description ?? "",
    schema_name: m.schema_name,
    sql: m.sql,
    materialization: m.materialization,
    tests: m.tests ?? [],
    schedule: m.schedule,
    cron_expr: m.cron_expr ?? "",
    timezone: m.timezone ?? "UTC",
    is_active: m.is_active,
  };
}

function StatusDot({ status, active }: { status: string | null; active: boolean }) {
  if (!active) return <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />;
  const tone =
    status === "built"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-destructive"
        : status === "skipped"
          ? "bg-amber-500"
          : "bg-muted-foreground/40";
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", tone)} />;
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  if (outcome === "built" || outcome === "success") {
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">{outcome}</Badge>;
  }
  if (outcome === "failed" || outcome === "error")
    return <Badge variant="destructive">{outcome}</Badge>;
  if (outcome === "partial" || outcome === "skipped") {
    return <Badge className="bg-amber-600 hover:bg-amber-600">{outcome}</Badge>;
  }
  return <Badge variant="secondary">{outcome}</Badge>;
}

/**
 * The build graph as levels: everything on one row can build at the same time,
 * and a row only starts once the one above it is done. It is the plan the
 * runner actually follows, drawn — not a separate idea of the graph that could
 * disagree with it.
 */
function BuildGraph({ models, deps }: { models: SqlModelRow[]; deps: Record<string, string[]> }) {
  const levels = useMemo(() => {
    const active = models.filter((m) => m.is_active);
    const depth = new Map<string, number>();
    const of = (name: string, seen: Set<string>): number => {
      if (depth.has(name)) return depth.get(name) as number;
      if (seen.has(name)) return 0; // a cycle is refused on save; do not hang here
      seen.add(name);
      const d = (deps[name] ?? []).reduce((acc, p) => Math.max(acc, of(p, seen) + 1), 0);
      depth.set(name, d);
      return d;
    };
    const out = new Map<number, SqlModelRow[]>();
    for (const m of active) {
      const d = of(m.name, new Set());
      out.set(d, [...(out.get(d) ?? []), m]);
    }
    return [...out.entries()].sort((a, b) => a[0] - b[0]);
  }, [models, deps]);

  if (levels.length === 0) {
    return <p className="text-sm text-muted-foreground">No active models to build.</p>;
  }
  return (
    <div className="space-y-3">
      {levels.map(([depth, group]) => (
        <div key={depth} className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {depth === 0 ? "Built first" : `After step ${depth}`}
          </p>
          <div className="flex flex-wrap gap-2">
            {group.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs"
                title={
                  (deps[m.name] ?? []).length
                    ? `reads ${(deps[m.name] ?? []).join(", ")}`
                    : "reads no other model"
                }
              >
                <StatusDot status={m.last_status ?? null} active={m.is_active} />
                {m.name}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Why a model in a build log reads the way it does, as one sentence.
 *
 * The reason and the failing tests used to render as two adjacent expressions
 * and ran together with no separator — "…failed: 1 row(s)row_count_min failed
 * (1)". A `warn` test that failed is still worth naming even when the model
 * built, so both parts stay; they are now joined.
 */
function whyLine(m: ModelResult): string {
  const parts: string[] = [];
  if (m.blocked_by) parts.push(`skipped because ${m.blocked_by} failed`);
  else if (m.error) parts.push(m.error);
  const broken = (m.tests ?? [])
    .filter((t) => t.status !== "pass")
    .map((t) => `${t.kind} ${t.status === "error" ? "could not run" : `failed (${t.failing})`}`);
  // The model-level error already names the test that failed it; only add a
  // test line when it says something the error does not.
  for (const b of broken) if (!parts.some((p) => p.includes(b.split(" ")[0]))) parts.push(b);
  return parts.join(" · ");
}

function SqlModelsPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const listFn = useServerFn(sqlModelsList);
  const saveFn = useServerFn(sqlModelSave);
  const deleteFn = useServerFn(sqlModelDelete);
  const buildFn = useServerFn(sqlModelsBuild);
  const runsFn = useServerFn(sqlModelRunsList);
  const previewFn = useServerFn(sqlModelPreview);
  const toggleFn = useServerFn(sqlModelToggle);

  const [models, setModels] = useState<SqlModelRow[]>([]);
  const [schemas, setSchemas] = useState<{ name: string; writable: boolean }[]>([]);
  const [deps, setDeps] = useState<Record<string, string[]>>({});
  const [missing, setMissing] = useState<Record<string, string[]>>({});
  const [runs, setRuns] = useState<SqlModelRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"editor" | "graph" | "runs">("editor");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<{
    columns: { name: string; type: string }[];
    rows: unknown[][];
  } | null>(null);

  const writable = useMemo(() => schemas.filter((s) => s.writable), [schemas]);

  const reload = useCallback(async () => {
    if (!token) return;
    const [l, r] = await Promise.all([
      listFn({ data: { access_token: token } }),
      runsFn({ data: { access_token: token, limit: 25 } }),
    ]);
    if (l.ok) {
      setModels(l.models);
      setSchemas(l.schemas);
      setDeps(l.deps);
      setMissing(l.missing);
    } else toast.error(l.error);
    if (r.ok) setRuns(r.runs);
    setLoading(false);
  }, [listFn, runsFn, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selected = draft?.id ? models.find((m) => m.id === draft.id) : null;
  const draftRefs = draft ? refNames(draft.sql) : [];
  const unknownRefs = draftRefs.filter(
    (r) => !models.some((m) => m.name === r && m.id !== draft?.id),
  );

  async function save() {
    if (!draft) return;
    const nameError = validateModelName(draft.name);
    if (nameError) return toast.error(nameError);
    if (!draft.schema_name) return toast.error("Choose a schema to build into");
    setBusy(true);
    try {
      const res = await saveFn({
        data: {
          access_token: token,
          id: draft.id,
          name: draft.name,
          description: draft.description || null,
          schema_name: draft.schema_name,
          sql: draft.sql,
          materialization: draft.materialization,
          tests: draft.tests,
          is_active: draft.is_active,
          schedule: draft.schedule,
          cron_expr: draft.cron_expr || null,
          timezone: draft.timezone,
        },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(draft.id ? `Saved ${draft.name}` : `Created ${draft.name}`);
      await reload();
      setDraft((d) => (d ? { ...d, id: res.id } : d));
    } finally {
      setBusy(false);
    }
  }

  async function build(names?: string[]) {
    setBusy(true);
    try {
      const res = await buildFn({ data: { access_token: token, selected: names } });
      if (!res.ok) return toast.error(res.error);
      const built = res.models.filter((m: ModelResult) => m.outcome === "built").length;
      const failed = res.models.filter((m: ModelResult) => m.outcome === "failed").length;
      const skipped = res.models.filter((m: ModelResult) => m.outcome === "skipped").length;
      if (res.status === "success") toast.success(`Built ${built} model${built === 1 ? "" : "s"}`);
      else if (res.error) toast.error(res.error);
      else {
        toast.error(`${failed} failed, ${skipped} skipped, ${built} built`, {
          description: res.models.find((m: ModelResult) => m.outcome === "failed")?.error,
        });
      }
      setTab("runs");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    if (!draft) return;
    setBusy(true);
    setPreview(null);
    try {
      const res = await previewFn({
        data: { access_token: token, sql: draft.sql, limit: 50 },
      });
      if (!res.ok) return toast.error(res.error);
      setPreview({ columns: res.columns, rows: res.rows as unknown[][] });
      toast.success(`${res.rows.length} row${res.rows.length === 1 ? "" : "s"}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: SqlModelRow) {
    const ok = await confirmAsk({
      title: `Delete the model ${m.name}?`,
      body: "The definition goes; the table it built stays where it is, because a dashboard or an agent may still be reading it. Drop the table from the Lakehouse page if you want it gone.",
      actionLabel: "Delete model",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await deleteFn({ data: { access_token: token, id: m.id } });
      if (!res.ok) return toast.error(res.error);
      if (res.dependants.length) {
        toast.warning(`Deleted ${m.name}`, {
          description: `${res.dependants.join(", ")} still ref it and will fail until you edit them.`,
          duration: 10000,
        });
      } else toast.success(`Deleted ${m.name}`);
      setDraft(null);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(m: SqlModelRow) {
    setBusy(true);
    try {
      const res = await toggleFn({
        data: { access_token: token, id: m.id, is_active: !m.is_active },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(m.is_active ? `Paused ${m.name}` : `Resumed ${m.name}`);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const cycleWarning = useMemo(() => {
    if (!draft?.name || !draft.sql) return null;
    const others = models.filter((m) => m.id !== draft.id);
    try {
      buildPlan([
        ...others,
        {
          id: draft.id ?? "new",
          name: draft.name,
          schema_name: draft.schema_name,
          sql: draft.sql,
          materialization: draft.materialization,
          tests: draft.tests,
          is_active: draft.is_active,
        } as SqlModel,
      ]);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [draft, models]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Blocks className="h-5 w-5" /> SQL Models
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            A model is one SELECT that becomes a lakehouse table. Name another model with{" "}
            <code className="font-mono text-xs">ref(&apos;name&apos;)</code> and it is built first,
            every time. Tests run after a model builds; a failing one stops everything downstream
            rather than rebuilding it from data you already know is wrong.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || models.length === 0}
            onClick={() => void build()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1 h-3.5 w-3.5" />
            )}
            Build all
          </Button>
          <Button
            size="sm"
            disabled={writable.length === 0}
            onClick={() => {
              setPreview(null);
              setDraft(emptyDraft(writable[0]?.name ?? ""));
              setTab("editor");
            }}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> New model
          </Button>
        </div>
      </div>

      {writable.length === 0 && !loading ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            A model needs a lakehouse schema you own to build into. Create one on the Lakehouse page
            first — a mounted data lake is read-only and cannot hold a model.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* The project */}
        <Card className="h-fit">
          <CardContent className="space-y-1 p-2">
            <div className="flex items-center justify-between px-2 py-1">
              <p className="text-xs font-medium text-muted-foreground">
                {models.length} model{models.length === 1 ? "" : "s"}
              </p>
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setTab("graph")}
              >
                Build order
              </button>
            </div>
            {loading ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">Loading…</p>
            ) : models.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                No models yet. A first one usually reads a table you already have and gives it a
                name your dashboards can rely on.
              </p>
            ) : (
              models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setPreview(null);
                    setDraft(draftOf(m));
                    setTab("editor");
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                    draft?.id === m.id && "bg-muted",
                  )}
                >
                  <StatusDot status={m.last_status ?? null} active={m.is_active} />
                  <span className={cn("flex-1 truncate", !m.is_active && "text-muted-foreground")}>
                    {m.name}
                  </span>
                  {missing[m.name]?.length ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  ) : null}
                  {m.materialization === "view" ? (
                    <span className="text-[10px] uppercase text-muted-foreground">view</span>
                  ) : null}
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <div className="flex items-center gap-1 border-b">
            {(
              [
                ["editor", "Model", Table2],
                ["graph", "Build order", Workflow],
                ["runs", "Builds", History],
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
                  tab === key
                    ? "border-primary font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>

          {tab === "graph" ? (
            <Card>
              <CardContent className="p-4">
                <BuildGraph models={models} deps={deps} />
                {Object.keys(missing).length > 0 ? (
                  <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                    <p className="font-medium">Refs that name no model</p>
                    {Object.entries(missing).map(([name, refs]) => (
                      <p key={name} className="text-muted-foreground">
                        {name} reads {refs.join(", ")} — the build will fail until these exist.
                      </p>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {tab === "runs" ? (
            <Card>
              <CardContent className="p-0">
                {runs.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">No builds yet.</p>
                ) : (
                  <div className="divide-y">
                    {runs.map((r) => (
                      <div key={r.id} className="space-y-2 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <OutcomeBadge outcome={r.status} />
                          <span className="text-muted-foreground">
                            {r.trigger} · {relTime(r.started_at)}
                            {r.duration_ms != null
                              ? ` · ${(r.duration_ms / 1000).toFixed(1)}s`
                              : ""}
                          </span>
                          {r.selected.length ? (
                            <span className="text-xs text-muted-foreground">
                              selected {r.selected.join(", ")}
                            </span>
                          ) : null}
                        </div>
                        {r.error ? <p className="text-xs text-destructive">{r.error}</p> : null}
                        {(r.models ?? []).length ? (
                          <div className="overflow-x-auto rounded border">
                            <table className="w-full text-xs">
                              <tbody>
                                {(r.models ?? []).map((m) => (
                                  <tr key={m.name} className="border-t first:border-t-0">
                                    <td className="px-2 py-1.5 font-medium">{m.name}</td>
                                    <td className="px-2 py-1.5">
                                      <OutcomeBadge outcome={m.outcome} />
                                    </td>
                                    <td className="px-2 py-1.5 tabular-nums text-muted-foreground">
                                      {m.rows != null ? `${m.rows.toLocaleString()} rows` : "—"}
                                    </td>
                                    <td className="px-2 py-1.5 text-muted-foreground">
                                      {whyLine(m)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}

          {tab === "editor" ? (
            draft ? (
              <Card>
                <CardContent className="space-y-4 p-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="m-name">Name</Label>
                      <Input
                        id="m-name"
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        placeholder="stg_orders"
                        className="font-mono"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Also the table name, and what other models ref.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="m-schema">Schema</Label>
                      <select
                        id="m-schema"
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                        value={draft.schema_name}
                        onChange={(e) => setDraft({ ...draft, schema_name: e.target.value })}
                      >
                        {writable.map((s) => (
                          <option key={s.name} value={s.name}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="m-mat">Stored as</Label>
                      <select
                        id="m-mat"
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                        value={draft.materialization}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            materialization: e.target.value as Materialization,
                          })
                        }
                      >
                        <option value="table">Table — rows written at build time</option>
                        <option value="view">View — the query runs on every read</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="m-sql">SQL</Label>
                      <span className="text-[11px] text-muted-foreground">
                        {draftRefs.length ? `reads ${draftRefs.join(", ")}` : "reads no model"}
                      </span>
                    </div>
                    <Textarea
                      id="m-sql"
                      value={draft.sql}
                      onChange={(e) => setDraft({ ...draft, sql: e.target.value })}
                      rows={14}
                      className="font-mono text-xs"
                    />
                    {unknownRefs.length ? (
                      <p className="text-xs text-amber-600 dark:text-amber-500">
                        ref({unknownRefs.map((r) => `'${r}'`).join(", ")}) names no model yet.
                      </p>
                    ) : null}
                    {cycleWarning ? (
                      <p className="text-xs text-destructive">{cycleWarning}</p>
                    ) : null}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="m-schedule">Rebuild</Label>
                      <select
                        id="m-schedule"
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                        value={draft.schedule}
                        onChange={(e) =>
                          setDraft({ ...draft, schedule: e.target.value as Schedule })
                        }
                      >
                        {SCHEDULES.map((s) => (
                          <option key={s} value={s}>
                            {s === "manual" ? "only when asked" : s}
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-muted-foreground">
                        A rebuild also rebuilds everything this model reads.
                      </p>
                    </div>
                    {draft.schedule === "cron" ? (
                      <>
                        <div className="space-y-1">
                          <Label htmlFor="m-cron">Cron</Label>
                          <Input
                            id="m-cron"
                            value={draft.cron_expr}
                            onChange={(e) => setDraft({ ...draft, cron_expr: e.target.value })}
                            placeholder="0 6 * * *"
                            className="font-mono"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="m-tz">Timezone</Label>
                          <Input
                            id="m-tz"
                            value={draft.timezone}
                            onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                            placeholder="UTC"
                          />
                        </div>
                      </>
                    ) : (
                      <div className="space-y-1 sm:col-span-2">
                        <Label htmlFor="m-desc">Description</Label>
                        <Input
                          id="m-desc"
                          value={draft.description}
                          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                          placeholder="One line on what this model is for"
                        />
                      </div>
                    )}
                  </div>

                  {/* Tests */}
                  <div className="space-y-2 rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Tests</p>
                      <select
                        className="h-8 rounded-md border bg-background px-2 text-xs"
                        value=""
                        onChange={(e) => {
                          const kind = e.target.value as SqlModelTestKind;
                          if (!kind) return;
                          setDraft({
                            ...draft,
                            tests: [
                              ...draft.tests,
                              {
                                kind,
                                column: kind === "row_count_min" ? null : "",
                                severity: "error",
                                ...(kind === "accepted_values" ? { values: [] } : {}),
                                ...(kind === "row_count_min" ? { count: 1 } : {}),
                                ...(kind === "range" ? { min: null, max: null } : {}),
                              },
                            ],
                          });
                          e.target.value = "";
                        }}
                      >
                        <option value="">Add a test…</option>
                        {TEST_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {TEST_LABELS[k]}
                          </option>
                        ))}
                      </select>
                    </div>
                    {draft.tests.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No tests. A model with none always counts as built, however wrong the rows
                        are.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {draft.tests.map((t, i) => (
                          <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="w-32 shrink-0 font-medium">{TEST_LABELS[t.kind]}</span>
                            {t.kind !== "row_count_min" ? (
                              <Input
                                className="h-8 w-40 font-mono text-xs"
                                placeholder="column"
                                value={t.column ?? ""}
                                onChange={(e) => {
                                  const tests = [...draft.tests];
                                  tests[i] = { ...t, column: e.target.value };
                                  setDraft({ ...draft, tests });
                                }}
                              />
                            ) : null}
                            {t.kind === "accepted_values" ? (
                              <Input
                                className="h-8 w-56 text-xs"
                                placeholder="one, two, three"
                                value={(t.values ?? []).join(", ")}
                                onChange={(e) => {
                                  const tests = [...draft.tests];
                                  tests[i] = {
                                    ...t,
                                    values: e.target.value
                                      .split(",")
                                      .map((v) => v.trim())
                                      .filter(Boolean),
                                  };
                                  setDraft({ ...draft, tests });
                                }}
                              />
                            ) : null}
                            {t.kind === "range" ? (
                              <>
                                <Input
                                  className="h-8 w-24 text-xs"
                                  type="number"
                                  placeholder="min"
                                  value={t.min ?? ""}
                                  onChange={(e) => {
                                    const tests = [...draft.tests];
                                    tests[i] = {
                                      ...t,
                                      min: e.target.value === "" ? null : Number(e.target.value),
                                    };
                                    setDraft({ ...draft, tests });
                                  }}
                                />
                                <Input
                                  className="h-8 w-24 text-xs"
                                  type="number"
                                  placeholder="max"
                                  value={t.max ?? ""}
                                  onChange={(e) => {
                                    const tests = [...draft.tests];
                                    tests[i] = {
                                      ...t,
                                      max: e.target.value === "" ? null : Number(e.target.value),
                                    };
                                    setDraft({ ...draft, tests });
                                  }}
                                />
                              </>
                            ) : null}
                            {t.kind === "row_count_min" ? (
                              <Input
                                className="h-8 w-28 text-xs"
                                type="number"
                                value={t.count ?? 0}
                                onChange={(e) => {
                                  const tests = [...draft.tests];
                                  tests[i] = { ...t, count: Number(e.target.value) };
                                  setDraft({ ...draft, tests });
                                }}
                              />
                            ) : null}
                            <select
                              className="h-8 rounded-md border bg-background px-2 text-xs"
                              value={t.severity}
                              onChange={(e) => {
                                const tests = [...draft.tests];
                                tests[i] = {
                                  ...t,
                                  severity: e.target.value as SqlModelTest["severity"],
                                };
                                setDraft({ ...draft, tests });
                              }}
                            >
                              <option value="error">error — stop the downstream models</option>
                              <option value="warn">warn — record it and carry on</option>
                            </select>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 px-2"
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  tests: draft.tests.filter((_, j) => j !== i),
                                })
                              }
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {preview ? (
                    <div className="space-y-1">
                      <p className="text-xs font-medium">Preview</p>
                      <div className="max-h-64 overflow-auto rounded border">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-muted text-left">
                            <tr>
                              {preview.columns.map((c) => (
                                <th key={c.name} className="px-2 py-1 font-medium">
                                  {c.name}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {preview.rows.map((row, i) => (
                              <tr key={i} className="border-t">
                                {row.map((cell, j) => (
                                  <td key={j} className="px-2 py-1 font-mono">
                                    {cell === null ? "—" : String(cell)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={() => void save()} disabled={busy}>
                      {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                      {draft.id ? "Save" : "Create"}
                    </Button>
                    <Button variant="outline" onClick={() => void runPreview()} disabled={busy}>
                      Preview
                    </Button>
                    {draft.id ? (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void build([draft.name])}
                      >
                        <Play className="mr-1 h-3.5 w-3.5" /> Build this and what it reads
                      </Button>
                    ) : null}
                    {selected ? (
                      <>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => void toggle(selected)}
                        >
                          {selected.is_active ? (
                            <>
                              <Pause className="mr-1 h-3.5 w-3.5" /> Pause
                            </>
                          ) : (
                            <>
                              <Play className="mr-1 h-3.5 w-3.5" /> Resume
                            </>
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          className="text-destructive"
                          disabled={busy}
                          onClick={() => void remove(selected)}
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                        </Button>
                      </>
                    ) : null}
                    <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                      Close
                    </Button>
                  </div>

                  {selected ? (
                    <div className="flex flex-wrap items-center gap-3 border-t pt-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <StatusDot
                          status={selected.last_status ?? null}
                          active={selected.is_active}
                        />
                        {selected.last_status ?? "never built"}
                        {selected.last_run_at ? ` · ${relTime(selected.last_run_at)}` : ""}
                      </span>
                      {selected.last_row_count != null ? (
                        <span>{selected.last_row_count.toLocaleString()} rows</span>
                      ) : null}
                      <span>
                        builds into {selected.schema_name}.{selected.name}
                      </span>
                      {/* The next step after a model exists, and the one thing
                          nothing in the product used to point at: a table is
                          rows, a semantic model is what those rows mean. Shown
                          only once it has been built, because there is nothing
                          to describe until then. */}
                      {selected.last_status === "built" ? (
                        <Link
                          to="/semantics"
                          search={{
                            source: "lakehouse",
                            schema: selected.schema_name,
                            table: selected.name,
                            create: true,
                          }}
                          className="text-primary hover:underline"
                          title="Name what these columns mean, so dashboards, the AI Analyst and agents all compute them the same way"
                        >
                          Define metrics on this
                        </Link>
                      ) : null}
                      {selected.last_error ? (
                        <span className="text-destructive">{selected.last_error}</span>
                      ) : null}
                      {(draft.tests ?? []).length ? (
                        <span className="flex items-center gap-1">
                          <Check className="h-3 w-3" />
                          {draft.tests.map(describeTest).join("; ")}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">
                  Pick a model on the left, or create one. Models are built in dependency order, so
                  a staging table is always rebuilt before the fact that reads it.
                </CardContent>
              </Card>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
