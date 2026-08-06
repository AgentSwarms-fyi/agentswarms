// Semantic Layer — define governed metrics + dimensions over a dataset, then
// query them (the same definitions the metric_query agent tool consumes).
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Layers,
  LayoutDashboard,
  Play,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Sigma,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { llmJson } from "@/lib/biAgent";
import { BiModelSelect, useBiModelPref } from "@/components/bi/BiModelSelect";
import { AddMetricToDashboardDialog } from "@/components/bi/AddMetricToDashboardDialog";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  COMPARE_PERIODS,
  isRelativeDateOp,
  relativeDateRange,
  RELATIVE_DATE_OPS,
  TIME_GRAINS,
  type ComparePeriod,
  type RelativeDateOp,
  type TimeGrain,
} from "@/lib/semanticLayer";
import type {
  FilterOp,
  MetricAgg,
  SemanticDimension,
  SemanticFilter,
  SemanticJoin,
  SemanticMetric,
} from "@/lib/semanticLayer";
import {
  semanticDeleteModel,
  semanticListLocalSources,
  semanticListModels,
  semanticRunQuery,
  semanticUpsertModel,
  semanticValidateModel,
} from "@/utils/semantic.functions";
import { listWarehouseConnections } from "@/utils/warehouse.functions";

export const Route = createFileRoute("/_authenticated/semantics")({
  head: () => ({
    meta: [
      { title: "Semantic Layer — AgentSwarms" },
      {
        name: "description",
        content:
          "Define governed metrics and dimensions once; BI and AI agents query the same definitions.",
      },
    ],
  }),
  component: SemanticsPage,
});

type LocalSource = {
  id: string;
  name: string;
  is_sample: boolean;
  columns: { name: string; type: string }[];
};

type Draft = {
  id?: string;
  /** Owner — when it differs from the signed-in user the model is shared (read-only). */
  user_id?: string;
  name: string;
  label: string;
  description: string;
  source_kind: "data_table" | "warehouse";
  source_table: string;
  table_id: string | null;
  connection_id: string | null;
  joins: SemanticJoin[];
  dimensions: SemanticDimension[];
  metrics: SemanticMetric[];
};

type WhConn = { id: string; name: string; provider: string };
type WhTable = { schema: string; name: string; columns: { name: string; type: string }[] };

const AGGS: MetricAgg[] = [
  "sum",
  "avg",
  "count",
  "count_distinct",
  "min",
  "max",
  "custom",
  "derived",
];

const FILTER_OPS: FilterOp[] = ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "contains"];

/** Readable names for the comparison periods; the raw values are snake_case. */
const COMPARE_LABELS: Record<ComparePeriod, string> = {
  prior_period: "vs previous period",
  mom: "vs a month earlier",
  yoy: "vs a year earlier",
};

/** Readable names for the relative-date ops; the raw values are snake_case. */
const RELATIVE_OP_LABELS: Record<RelativeDateOp, string> = {
  last_n_days: "in the last N days",
  this_month: "this month",
  last_month: "last month",
  this_quarter: "this quarter",
  last_quarter: "last quarter",
  ytd: "year to date",
};

function slug(s: string): string {
  const out = s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z_]/.test(out) ? out : `f_${out}`;
}

function emptyDraft(): Draft {
  return {
    name: "",
    label: "",
    description: "",
    source_kind: "data_table",
    source_table: "",
    table_id: null,
    connection_id: null,
    joins: [],
    dimensions: [],
    metrics: [],
  };
}

function SemanticsPage() {
  const { session, user } = useAuth();
  const token = session?.access_token ?? "";

  const listFn = useServerFn(semanticListModels);
  const sourcesFn = useServerFn(semanticListLocalSources);
  const upsertFn = useServerFn(semanticUpsertModel);
  const deleteFn = useServerFn(semanticDeleteModel);
  const runFn = useServerFn(semanticRunQuery);
  const validateFn = useServerFn(semanticValidateModel);

  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<Array<Record<string, unknown>>>([]);
  const [sources, setSources] = useState<LocalSource[]>([]);
  const [whConns, setWhConns] = useState<WhConn[]>([]);
  const [whTables, setWhTables] = useState<Record<string, WhTable[] | "loading" | "error">>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  // Which editor pane is showing. Fields (dimensions + metrics) is the work
  // this page exists for, so it leads; a model with no source yet opens on
  // Source instead, because Fields cannot do anything without columns.
  const [editorTab, setEditorTab] = useState<"fields" | "source" | "query">("fields");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [biModel, setBiModel] = useBiModelPref();

  // Run panel
  const [pickedMetrics, setPickedMetrics] = useState<string[]>([]);
  const [pickedDims, setPickedDims] = useState<string[]>([]);
  const [pickedGrains, setPickedGrains] = useState<Record<string, TimeGrain | "">>({});
  const [pickedFilters, setPickedFilters] = useState<SemanticFilter[]>([]);
  const [pickedCompare, setPickedCompare] = useState<ComparePeriod | "">("");
  const [validating, setValidating] = useState(false);
  const [issues, setIssues] = useState<
    { kind: string; name: string; error: string }[] | "clean" | null
  >(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    columns: string[];
    rows: Record<string, unknown>[];
    sql: string;
    metrics: string[];
    dimensions: string[];
    grains?: Record<string, TimeGrain>;
    filters?: SemanticFilter[];
    compare?: ComparePeriod;
  } | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [ms, ss] = await Promise.all([
        listFn({ data: { accessToken: token } }),
        sourcesFn({ data: { accessToken: token } }),
      ]);
      setModels(ms as Array<Record<string, unknown>>);
      setSources(ss as LocalSource[]);
      // Warehouse connections are optional — the local path must never break
      // because a connector call failed.
      try {
        const conns = (await listWarehouseConnections({ data: { access_token: token } })) as
          | { ok: true; connections: WhConn[] }
          | { ok: false };
        setWhConns(conns.ok ? conns.connections : []);
      } catch {
        setWhConns([]);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load semantic models");
    } finally {
      setLoading(false);
    }
  }, [token, listFn, sourcesFn]);

  /** Fetch a warehouse connection's tables once (schema browser for authoring). */
  const ensureWhTables = useCallback(
    (connId: string) => {
      setWhTables((cur) => {
        if (cur[connId]) return cur;
        void (async () => {
          try {
            const r = await fetch("/api/warehouse/schema", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ connection_id: connId }),
            });
            const j = (await r.json()) as { tables?: WhTable[]; message?: string };
            if (!r.ok || !Array.isArray(j.tables)) throw new Error(j.message || "Schema failed");
            setWhTables((c) => ({ ...c, [connId]: j.tables! }));
          } catch {
            setWhTables((c) => ({ ...c, [connId]: "error" }));
          }
        })();
        return { ...cur, [connId]: "loading" };
      });
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const editModel = (m: Record<string, unknown>) => {
    const kind = m.source_kind === "warehouse" ? "warehouse" : "data_table";
    setDraft({
      id: m.id as string,
      user_id: (m.user_id as string) ?? undefined,
      name: (m.name as string) ?? "",
      label: (m.label as string) ?? "",
      description: (m.description as string) ?? "",
      source_kind: kind,
      source_table: (m.source_table as string) ?? "",
      table_id: (m.table_id as string) ?? null,
      connection_id: (m.connection_id as string) ?? null,
      joins: Array.isArray(m.joins) ? (m.joins as SemanticJoin[]) : [],
      dimensions: Array.isArray(m.dimensions) ? (m.dimensions as SemanticDimension[]) : [],
      metrics: Array.isArray(m.metrics) ? (m.metrics as SemanticMetric[]) : [],
    });
    if (kind === "warehouse" && m.connection_id) ensureWhTables(m.connection_id as string);
    // A model with no source cannot have fields yet — land on Source so the
    // first action is the one that unblocks everything else.
    setEditorTab(m.source_table ? "fields" : "source");
    setResult(null);
    setPickedMetrics([]);
    setPickedDims([]);
    setPickedGrains({});
    setPickedFilters([]);
    setIssues(null);
  };

  /** Compile + probe every field against the real backend, without saving. */
  const validate = async () => {
    if (!draft) return;
    setValidating(true);
    setIssues(null);
    try {
      const res = (await validateFn({
        data: {
          accessToken: token,
          model: {
            id: draft.id,
            name: draft.name.trim() || "model",
            source_kind: draft.source_kind,
            table_id: draft.source_kind === "data_table" ? draft.table_id : null,
            connection_id: draft.source_kind === "warehouse" ? draft.connection_id : null,
            source_table: draft.source_table,
            joins: draft.joins,
            dimensions: draft.dimensions,
            metrics: draft.metrics,
          },
        },
      })) as {
        ok: boolean;
        checked: number;
        issues: { kind: string; name: string; error: string }[];
      };
      setIssues(res.ok ? "clean" : res.issues);
      if (res.ok) toast.success(`All ${res.checked} field(s) compile and run.`);
      else toast.error(`${res.issues.length} field(s) failed — see the details below.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Validation failed");
    } finally {
      setValidating(false);
    }
  };

  const selectedSource = useMemo(
    () => sources.find((s) => s.name === draft?.source_table),
    [sources, draft?.source_table],
  );

  // Columns of whatever source is selected (local dataset or warehouse table)
  // — drives the badges and the AI generator uniformly.
  const sourceColumns = useMemo((): { name: string; type: string }[] | null => {
    if (!draft) return null;
    if (draft.source_kind === "data_table") return selectedSource?.columns ?? null;
    if (!draft.connection_id || !draft.source_table) return null;
    const tables = whTables[draft.connection_id];
    if (!Array.isArray(tables)) return null;
    const t = tables.find((x) => `${x.schema}.${x.name}` === draft.source_table);
    return t?.columns ?? null;
  }, [draft, selectedSource, whTables]);

  // A model owned by someone else (shared via IAM) is read-only: run + add to
  // dashboard are allowed, but editing/saving/deleting is the owner's.
  const isShared = !!draft?.user_id && !!user?.id && draft.user_id !== user.id;

  /**
   * The grained time dimensions currently selected — the candidate comparison
   * axes. A comparison needs exactly one, so this drives whether the control is
   * offered at all and what it says when it is not.
   */
  const comparableAxes = pickedDims.filter(
    (n) =>
      pickedGrains[n] &&
      draft?.dimensions.find((d) => d.name === n && d.type === "time") !== undefined,
  );
  const compareIsAvailable = comparableAxes.length === 1 && pickedMetrics.length > 0;

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const save = async () => {
    if (!draft) return;
    if (isShared)
      return toast.error("This model is shared read-only — only its owner can edit it.");
    if (!draft.name.trim()) return toast.error("Model needs a name");
    if (!draft.source_table) return toast.error("Pick a source table");
    if (draft.source_kind === "warehouse" && !draft.connection_id)
      return toast.error("Pick a warehouse connection");
    setSaving(true);
    try {
      const res = (await upsertFn({
        data: {
          accessToken: token,
          model: {
            id: draft.id,
            name: draft.name.trim(),
            label: draft.label || undefined,
            description: draft.description || undefined,
            source_kind: draft.source_kind,
            table_id: draft.source_kind === "data_table" ? draft.table_id : null,
            connection_id: draft.source_kind === "warehouse" ? draft.connection_id : null,
            source_table: draft.source_table,
            joins: draft.joins,
            dimensions: draft.dimensions,
            metrics: draft.metrics,
          },
        },
      })) as { id: string };
      toast.success("Saved");
      setDraft((d) => (d ? { ...d, id: res.id } : d));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteFn({ data: { accessToken: token, id } });
      if (draft?.id === id) setDraft(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const run = async () => {
    if (!draft?.id) return toast.error("Save the model first");
    if (pickedMetrics.length === 0 && pickedDims.length === 0)
      return toast.error("Pick at least one metric or dimension");
    setRunning(true);
    setResult(null);
    try {
      // Only grains for currently-picked TIME dimensions travel with the query.
      const grains: Record<string, TimeGrain> = {};
      for (const [dim, g] of Object.entries(pickedGrains)) {
        if (!g || !pickedDims.includes(dim)) continue;
        if (draft.dimensions.find((d) => d.name === dim)?.type === "time") grains[dim] = g;
      }
      // Only filters whose field is still a known metric/dimension travel.
      const known = new Set([
        ...draft.metrics.map((m) => m.name),
        ...draft.dimensions.map((d) => d.name),
      ]);
      const filters = pickedFilters.filter((f) => f.field && known.has(f.field));
      // A comparison only travels while its axis is still selected — the
      // compiler rejects it otherwise, and sending it anyway would turn
      // deselecting a dimension into a confusing error.
      const compare = pickedCompare && compareIsAvailable ? pickedCompare : undefined;
      const res = (await runFn({
        data: {
          accessToken: token,
          query: {
            model: draft.name,
            metrics: pickedMetrics,
            dimensions: pickedDims,
            grains: Object.keys(grains).length > 0 ? grains : undefined,
            filters: filters.length > 0 ? filters : undefined,
            compare,
            limit: 100,
          },
        },
      })) as { columns: string[]; rows: Record<string, unknown>[]; sql: string };
      setResult({
        ...res,
        metrics: pickedMetrics,
        dimensions: pickedDims,
        grains: Object.keys(grains).length > 0 ? grains : undefined,
        filters: filters.length > 0 ? filters : undefined,
        compare,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Query failed");
    } finally {
      setRunning(false);
    }
  };

  const generateWithAI = async () => {
    if (isShared) return;
    if (!draft || !sourceColumns || sourceColumns.length === 0)
      return toast.error("Pick a source table first");
    if (!biModel) return toast.error("Pick an AI model — connect a provider under Integrations");
    setGenerating(true);
    try {
      // Local columns are shown quoted so a name with a space survives; the
      // quoting style here does NOT lock the model to an engine, because
      // compileSemanticQuery re-quotes authored fragments for whichever
      // dialect it targets (see normaliseIdentQuotes). Warehouse columns keep
      // their bare names in the connection's native dialect.
      const isLocal = draft.source_kind === "data_table";
      const cols = sourceColumns
        .map((c) => `- ${isLocal ? `"${c.name}"` : c.name} (${c.type})`)
        .join("\n");
      type Gen = {
        label?: string;
        description?: string;
        dimensions?: Array<{ name?: string; label?: string; sql?: string; type?: string }>;
        metrics?: Array<{
          name?: string;
          label?: string;
          agg?: string;
          sql?: string;
          format?: string;
        }>;
      };
      const res = await llmJson<Gen>({
        systemPrompt:
          "You design a semantic-layer model for analytics over a single table. " +
          "Return STRICT JSON: {label, description, dimensions:[{name,label,sql,type}], metrics:[{name,label,agg,sql,format}]}. " +
          "Rules: `name` is a snake_case identifier matching ^[a-z_][a-z0-9_]*$. " +
          "`sql` is the column reference EXACTLY as listed below (keep any backticks shown) — never invent columns. " +
          "Dimensions are categorical or time columns (type one of categorical|time|number|boolean). " +
          "Metrics aggregate numeric columns: agg one of sum|avg|count|count_distinct|min|max. " +
          "Use sum for additive amounts; ALWAYS include one {name:'row_count', label:'Row count', agg:'count'} with no sql. " +
          "Set format:'currency' for money columns, 'percent' for rates. Output JSON only, no prose.",
        userPrompt: `Table: ${draft.source_table}\nColumns:\n${cols}\n\nDesign the semantic model.`,
        model: biModel ?? undefined,
        temperature: 0.2,
      });

      const validAgg = new Set<MetricAgg>([
        "sum",
        "avg",
        "count",
        "count_distinct",
        "min",
        "max",
        "custom",
      ]);
      const seen = new Set<string>();
      const dims: SemanticDimension[] = [];
      for (const d of (res.dimensions ?? []).slice(0, 20)) {
        const name = slug(d.name || d.label || "");
        if (!name || seen.has(name)) continue;
        seen.add(name);
        dims.push({
          name,
          label: d.label || undefined,
          sql: d.sql?.trim() || `"${d.name ?? name}"`,
          type: (["categorical", "time", "number", "boolean"].includes(d.type || "")
            ? d.type
            : "categorical") as SemanticDimension["type"],
        });
      }
      const mets: SemanticMetric[] = [];
      for (const m of (res.metrics ?? []).slice(0, 15)) {
        const name = slug(m.name || m.label || "");
        if (!name || seen.has(name)) continue;
        const agg = (validAgg.has(m.agg as MetricAgg) ? m.agg : "sum") as MetricAgg;
        const sql = m.sql?.trim() || undefined;
        if (agg !== "count" && !sql) continue; // needs a column
        seen.add(name);
        mets.push({
          name,
          label: m.label || undefined,
          agg,
          sql,
          format: (["number", "currency", "percent"].includes(m.format || "")
            ? m.format
            : undefined) as SemanticMetric["format"],
        });
      }
      if (dims.length === 0 && mets.length === 0)
        throw new Error("The AI didn't return any fields");

      patch({
        name: draft.name || slug(draft.source_table),
        label: draft.label || res.label || "",
        description: draft.description || res.description || "",
        dimensions: dims,
        metrics: mets,
      });
      toast.success(
        `Generated ${dims.length} dimensions and ${mets.length} metrics — review and save.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "AI generation failed");
    } finally {
      setGenerating(false);
    }
  };

  // Field editors
  const addDimFromColumn = (col: string) =>
    patch({
      dimensions: [
        ...(draft?.dimensions ?? []),
        { name: slug(col), label: col, sql: `"${col}"`, type: "categorical" },
      ],
    });
  const addMetricFromColumn = (col: string) =>
    patch({
      metrics: [
        ...(draft?.metrics ?? []),
        { name: slug(col), label: col, agg: "sum", sql: `"${col}"` },
      ],
    });

  return (
    <div className="space-y-6 p-6">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          Data &amp; BI
        </p>
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-tight">
          <Layers className="h-6 w-6 text-primary" /> Semantic Layer
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Define governed <strong>metrics</strong> and <strong>dimensions</strong> once. The BI
          engine and your AI agents (via the <code>metric_query</code> tool) query the same
          definitions, so &ldquo;revenue&rdquo; always computes the same way — and the AI picks
          names, never writes SQL.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        {/* Model list */}
        <div className="space-y-2">
          <Button
            size="sm"
            className="w-full"
            onClick={() => {
              setDraft(emptyDraft());
              setEditorTab("source");
              setResult(null);
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> New model
          </Button>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : models.length === 0 ? (
            <p className="px-1 py-3 text-xs text-muted-foreground">
              No models yet. Create one from a dataset.
            </p>
          ) : (
            models.map((m) => {
              const shared = !!m.user_id && !!user?.id && m.user_id !== user.id;
              return (
                <Card
                  key={m.id as string}
                  className={`cursor-pointer transition-colors ${draft?.id === m.id ? "border-primary" : ""}`}
                  onClick={() => editModel(m)}
                >
                  <CardContent className="flex items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {(m.label as string) || (m.name as string)}
                        {shared && (
                          <Badge variant="outline" className="h-4 px-1 text-[9px] font-normal">
                            Shared
                          </Badge>
                        )}
                      </p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {m.name as string} · {m.source_table as string}
                      </p>
                    </div>
                    {!shared && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        aria-label={`Delete model ${(m.label as string) || (m.name as string) || ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(m.id as string);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        {/* Editor */}
        {!draft ? (
          <Card>
            <CardContent className="p-10 text-center text-sm text-muted-foreground">
              Select a model to edit, or create a new one.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {/* Sticky command bar: what this model is, whether it compiles,
                and the two actions you reach for from any tab. */}
            <div className="sticky top-12 z-20 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background/95 px-4 py-2.5 backdrop-blur">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {draft.label || draft.name || "Untitled model"}
                </p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {draft.name || "unnamed"}
                  {draft.source_table ? ` · ${draft.source_table}` : " · no source yet"}
                </p>
              </div>
              {issues === "clean" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck className="h-3 w-3" /> Validated
                </span>
              )}
              {Array.isArray(issues) && issues.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                  {issues.length} issue{issues.length === 1 ? "" : "s"}
                </span>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={validate}
                disabled={validating || !draft.source_table}
                title="Compile every field and run it against the real source — catches typo'd columns before they reach a dashboard"
              >
                <ShieldCheck className="mr-1 h-4 w-4" />
                {validating ? "Validating…" : "Validate"}
              </Button>
              {!isShared && (
                <Button size="sm" onClick={save} disabled={saving}>
                  <Save className="mr-1 h-4 w-4" /> {saving ? "Saving…" : "Save model"}
                </Button>
              )}
            </div>

            {Array.isArray(issues) && issues.length > 0 && (
              <div
                role="alert"
                className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-2.5"
              >
                {issues.map((it, i) => (
                  <p key={i} className="text-xs">
                    <span className="font-mono font-semibold text-destructive">
                      {it.kind}
                      {it.name ? ` ${it.name}` : ""}
                    </span>
                    <span className="text-destructive/90"> — {it.error}</span>
                  </p>
                ))}
              </div>
            )}

            <Tabs
              value={editorTab}
              onValueChange={(v) => setEditorTab(v as typeof editorTab)}
              className="space-y-4"
            >
              <TabsList>
                <TabsTrigger value="fields" className="gap-1.5">
                  Fields
                  <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                    {draft.dimensions.length + draft.metrics.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="source" className="gap-1.5">
                  Source &amp; joins
                  {draft.joins.length > 0 && (
                    <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                      {draft.joins.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="query">Query</TabsTrigger>
              </TabsList>

              <TabsContent value="source" className="space-y-4">
                <Card>
                  <CardContent className="space-y-4 p-4">
                    {isShared && (
                      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                        <strong>Shared with you — read-only.</strong> Run it and add it to
                        dashboards; only the owner can edit this model.
                      </div>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="sem-name" className="text-xs">
                          Name (id)
                        </Label>
                        <Input
                          id="sem-name"
                          value={draft.name}
                          placeholder="orders"
                          disabled={isShared}
                          onChange={(e) => patch({ name: e.target.value })}
                          className="h-8 font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="sem-label" className="text-xs">
                          Label
                        </Label>
                        <Input
                          id="sem-label"
                          value={draft.label}
                          placeholder="Orders"
                          disabled={isShared}
                          onChange={(e) => patch({ label: e.target.value })}
                          className="h-8"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="sem-description" className="text-xs">
                        Description
                      </Label>
                      <Textarea
                        id="sem-description"
                        value={draft.description}
                        disabled={isShared}
                        onChange={(e) => patch({ description: e.target.value })}
                        className="min-h-[48px] text-sm"
                        placeholder="What this model represents…"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                      <div className="space-y-1">
                        <Label className="text-xs">Source kind</Label>
                        <Select
                          value={draft.source_kind}
                          disabled={isShared}
                          onValueChange={(v) =>
                            patch({
                              source_kind: v as Draft["source_kind"],
                              source_table: "",
                              table_id: null,
                              connection_id: null,
                            })
                          }
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="data_table">Local dataset</SelectItem>
                            <SelectItem value="warehouse">Warehouse table</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {draft.source_kind === "data_table" ? (
                        <div className="space-y-1">
                          <Label className="text-xs">Source dataset</Label>
                          <Select
                            value={draft.source_table}
                            disabled={isShared}
                            onValueChange={(v) => {
                              const s = sources.find((x) => x.name === v);
                              patch({ source_table: v, table_id: s?.id ?? null });
                            }}
                          >
                            <SelectTrigger className="h-8">
                              <SelectValue placeholder="Pick a dataset…" />
                            </SelectTrigger>
                            <SelectContent>
                              {sources.map((s) => (
                                <SelectItem key={s.id} value={s.name}>
                                  {s.name} {s.is_sample ? "(sample)" : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <Label className="text-xs">Connection</Label>
                            <Select
                              value={draft.connection_id ?? ""}
                              disabled={isShared}
                              onValueChange={(v) => {
                                patch({ connection_id: v, source_table: "", table_id: null });
                                ensureWhTables(v);
                              }}
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue
                                  placeholder={
                                    whConns.length === 0
                                      ? "No warehouses connected (Integrations → Data Sources)"
                                      : "Pick a connection…"
                                  }
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {whConns.map((c) => (
                                  <SelectItem key={c.id} value={c.id}>
                                    {c.name} ({c.provider})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Table</Label>
                            {draft.connection_id && whTables[draft.connection_id] === "loading" ? (
                              <p className="pt-2 text-xs text-muted-foreground">Loading tables…</p>
                            ) : draft.connection_id && whTables[draft.connection_id] === "error" ? (
                              <p className="pt-2 text-xs text-destructive">
                                Couldn't list tables — test the connection under Integrations.
                              </p>
                            ) : (
                              <Select
                                value={draft.source_table}
                                disabled={isShared || !draft.connection_id}
                                onValueChange={(v) => patch({ source_table: v })}
                              >
                                <SelectTrigger className="h-8">
                                  <SelectValue placeholder="Pick a table…" />
                                </SelectTrigger>
                                <SelectContent>
                                  {(Array.isArray(whTables[draft.connection_id ?? ""])
                                    ? (whTables[draft.connection_id ?? ""] as WhTable[])
                                    : []
                                  ).map((t) => (
                                    <SelectItem
                                      key={`${t.schema}.${t.name}`}
                                      value={`${t.schema}.${t.name}`}
                                    >
                                      {t.schema}.{t.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                    {sourceColumns && sourceColumns.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {sourceColumns.map((c) => (
                          <Badge key={c.name} variant="secondary" className="font-mono text-[10px]">
                            {c.name}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">AI model</span>
                        <BiModelSelect
                          value={biModel}
                          onChange={setBiModel}
                          className="max-w-md flex-1"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={generateWithAI}
                          disabled={generating || !sourceColumns?.length || !biModel || isShared}
                          title={
                            isShared
                              ? "Shared models are read-only"
                              : !sourceColumns?.length
                                ? "Pick a source table first"
                                : !biModel
                                  ? "Pick an AI model (connect a provider under Integrations)"
                                  : ""
                          }
                        >
                          <Sparkles className="mr-1 h-4 w-4" />
                          {generating ? "Generating…" : "Generate with AI"}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Joins — relate the source table to others so dimensions and
                metrics can span a star schema without pre-joining. */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm">Joins</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Relate other tables to <code>{draft.source_table || "the source"}</code> so
                      dimensions and metrics can reference their columns. Qualify column names in
                      your SQL (e.g. <code>customers.segment</code>) once a join exists.
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {draft.joins.map((j, i) => (
                      <div key={i} className="grid gap-2 sm:grid-cols-[110px_1fr_130px_1.6fr_36px]">
                        <Select
                          value={j.type ?? "left"}
                          onValueChange={(v) =>
                            patch({
                              joins: draft.joins.map((x, k) =>
                                k === i ? { ...x, type: v as SemanticJoin["type"] } : x,
                              ),
                            })
                          }
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="left">LEFT</SelectItem>
                            <SelectItem value="inner">INNER</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          value={j.table}
                          placeholder="customers"
                          className="h-8 font-mono"
                          onChange={(e) =>
                            patch({
                              joins: draft.joins.map((x, k) =>
                                k === i ? { ...x, table: e.target.value } : x,
                              ),
                            })
                          }
                        />
                        <Input
                          value={j.alias ?? ""}
                          placeholder="alias (opt.)"
                          className="h-8 font-mono"
                          onChange={(e) =>
                            patch({
                              joins: draft.joins.map((x, k) =>
                                k === i ? { ...x, alias: e.target.value || undefined } : x,
                              ),
                            })
                          }
                        />
                        <Input
                          value={j.on}
                          placeholder="orders.customer_id = customers.id"
                          className="h-8 font-mono"
                          onChange={(e) =>
                            patch({
                              joins: draft.joins.map((x, k) =>
                                k === i ? { ...x, on: e.target.value } : x,
                              ),
                            })
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          aria-label={`Remove join ${i + 1}`}
                          onClick={() => patch({ joins: draft.joins.filter((_, k) => k !== i) })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isShared || draft.joins.length >= 8}
                      onClick={() =>
                        patch({ joins: [...draft.joins, { table: "", on: "", type: "left" }] })
                      }
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add join
                    </Button>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Fields — the work this page exists for. Side by side at wide
                widths so dimensions and metrics are both on screen; each
                column scrolls on its own so a long list of one cannot push
                the other off the page. */}
              <TabsContent value="fields">
                <div className="grid items-start gap-4 xl:grid-cols-2">
                  <FieldSection
                    title="Dimensions"
                    hint="How you slice — a column or SQL expression."
                    count={draft.dimensions.length}
                    icon={Layers}
                    cols={selectedSource?.columns.map((c) => c.name) ?? []}
                    disabled={isShared}
                    onAddFromColumn={addDimFromColumn}
                    onAddBlank={() =>
                      patch({
                        dimensions: [
                          ...draft.dimensions,
                          { name: "", sql: "", type: "categorical" },
                        ],
                      })
                    }
                  >
                    {draft.dimensions.map((d, i) => (
                      <div key={i} className="@container/row flex flex-wrap items-center gap-2">
                        <Input
                          value={d.name}
                          placeholder="region"
                          aria-label="Dimension name"
                          className="order-1 h-8 min-w-32 flex-1 font-mono"
                          onChange={(e) =>
                            patch({
                              dimensions: draft.dimensions.map((x, j) =>
                                j === i ? { ...x, name: e.target.value } : x,
                              ),
                            })
                          }
                        />
                        <Input
                          value={d.sql}
                          placeholder="`Region`"
                          aria-label="Dimension SQL expression"
                          className="order-4 h-8 w-full basis-full font-mono @[30rem]/row:order-2 @[30rem]/row:w-auto @[30rem]/row:flex-[1.4] @[30rem]/row:basis-auto"
                          onChange={(e) =>
                            patch({
                              dimensions: draft.dimensions.map((x, j) =>
                                j === i ? { ...x, sql: e.target.value } : x,
                              ),
                            })
                          }
                        />
                        <Select
                          value={d.type ?? "categorical"}
                          onValueChange={(v) =>
                            patch({
                              dimensions: draft.dimensions.map((x, j) =>
                                j === i ? { ...x, type: v as SemanticDimension["type"] } : x,
                              ),
                            })
                          }
                        >
                          <SelectTrigger
                            className="order-2 h-8 w-[104px] shrink-0 @[30rem]/row:order-3 @[30rem]/row:w-[120px]"
                            aria-label="Dimension type"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {["categorical", "time", "number", "boolean"].map((t) => (
                              <SelectItem key={t} value={t}>
                                {t}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="order-3 h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive @[30rem]/row:order-4"
                          aria-label={`Remove dimension ${d.name || i + 1}`}
                          onClick={() =>
                            patch({ dimensions: draft.dimensions.filter((_, j) => j !== i) })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </FieldSection>

                  {/* Metrics */}
                  <FieldSection
                    title="Metrics"
                    hint="What you measure — an aggregation over a column."
                    count={draft.metrics.length}
                    icon={Sigma}
                    cols={selectedSource?.columns.map((c) => c.name) ?? []}
                    disabled={isShared}
                    onAddFromColumn={addMetricFromColumn}
                    onAddBlank={() =>
                      patch({ metrics: [...draft.metrics, { name: "", agg: "sum", sql: "" }] })
                    }
                  >
                    {draft.metrics.map((m, i) => (
                      <div key={i} className="@container/row flex flex-wrap items-center gap-2">
                        <Input
                          value={m.name}
                          placeholder="revenue"
                          aria-label="Metric name"
                          className="order-1 h-8 min-w-32 flex-1 font-mono"
                          onChange={(e) =>
                            patch({
                              metrics: draft.metrics.map((x, j) =>
                                j === i ? { ...x, name: e.target.value } : x,
                              ),
                            })
                          }
                        />
                        <Select
                          value={m.agg}
                          onValueChange={(v) =>
                            patch({
                              metrics: draft.metrics.map((x, j) =>
                                j === i ? { ...x, agg: v as MetricAgg } : x,
                              ),
                            })
                          }
                        >
                          <SelectTrigger
                            className="order-2 h-8 w-[104px] shrink-0 @[30rem]/row:w-[130px]"
                            aria-label="Aggregation"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {AGGS.map((a) => (
                              <SelectItem key={a} value={a}>
                                {a}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          value={m.sql ?? ""}
                          placeholder={
                            m.agg === "count"
                              ? "(optional)"
                              : m.agg === "derived"
                                ? "{revenue} / NULLIF({orders}, 0)"
                                : "`Amount`"
                          }
                          title={
                            m.agg === "derived"
                              ? "Formula over other metrics — reference them as {metric_name}"
                              : undefined
                          }
                          aria-label="Metric SQL expression"
                          className="order-4 h-8 w-full basis-full font-mono @[30rem]/row:order-3 @[30rem]/row:w-auto @[30rem]/row:flex-[1.3] @[30rem]/row:basis-auto"
                          onChange={(e) =>
                            patch({
                              metrics: draft.metrics.map((x, j) =>
                                j === i ? { ...x, sql: e.target.value } : x,
                              ),
                            })
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="order-3 h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive @[30rem]/row:order-4"
                          aria-label={`Remove metric ${m.name || i + 1}`}
                          onClick={() =>
                            patch({ metrics: draft.metrics.filter((_, j) => j !== i) })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </FieldSection>
                </div>
              </TabsContent>

              <TabsContent value="query">
                <Card>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold">Query runner</h3>
                      <Button size="sm" onClick={run} disabled={running || !draft.id}>
                        <Play className="mr-1 h-4 w-4" /> {running ? "Running…" : "Run"}
                      </Button>
                    </div>
                    {!draft.id && (
                      <p className="text-xs text-muted-foreground">
                        Save the model to run queries.
                      </p>
                    )}
                    {draft.id && pickedMetrics.length > 0 && pickedDims.length === 0 && (
                      // A metrics-only query is perfectly valid — it is a grand
                      // total — so this cannot be an error. But nothing otherwise
                      // distinguishes "I wanted one number" from "the dimension I
                      // thought I picked did not register", and the second reads
                      // as the runner ignoring you.
                      <p className="text-xs text-muted-foreground">
                        No dimension selected — this returns a single total. Pick a dimension to
                        break it down.
                      </p>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Picker
                        label="Metrics"
                        options={draft.metrics.map((m) => m.name).filter(Boolean)}
                        picked={pickedMetrics}
                        onToggle={(n) =>
                          setPickedMetrics((p) =>
                            p.includes(n) ? p.filter((x) => x !== n) : [...p, n],
                          )
                        }
                      />
                      <Picker
                        label="Dimensions"
                        options={draft.dimensions.map((d) => d.name).filter(Boolean)}
                        picked={pickedDims}
                        onToggle={(n) =>
                          setPickedDims((p) =>
                            p.includes(n) ? p.filter((x) => x !== n) : [...p, n],
                          )
                        }
                      />
                    </div>
                    {/* Filters — dimension filters become WHERE, metric filters HAVING */}
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">Filters</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() =>
                            setPickedFilters((f) => [
                              ...f,
                              { field: draft.dimensions[0]?.name ?? "", op: "=", value: "" },
                            ])
                          }
                          disabled={draft.dimensions.length === 0 && draft.metrics.length === 0}
                        >
                          <Plus className="mr-1 h-3 w-3" /> Add filter
                        </Button>
                      </div>
                      {pickedFilters.map((f, i) => {
                        const isList = f.op === "in" || f.op === "not_in";
                        const isRelative = isRelativeDateOp(f.op);
                        // Only a time dimension can carry a relative window; the
                        // compiler rejects anything else, so the picker should not
                        // offer a combination that cannot run.
                        const fieldIsTime =
                          draft.dimensions.find((d) => d.name === f.field)?.type === "time";
                        const patchFilter = (p: Partial<SemanticFilter>) =>
                          setPickedFilters((cur) =>
                            cur.map((x, j) => (j === i ? ({ ...x, ...p } as SemanticFilter) : x)),
                          );
                        // Show the dates the window resolves to. "Last 30 days"
                        // with no way to see WHICH 30 days is how someone ends up
                        // unable to reproduce a number they are disputing.
                        let windowHint = "";
                        if (isRelative) {
                          try {
                            const { start, end } = relativeDateRange(f.op as RelativeDateOp, {
                              n: Number(f.value),
                            });
                            windowHint = `${start} → ${end} (end exclusive)`;
                          } catch (e) {
                            windowHint = e instanceof Error ? e.message : "invalid window";
                          }
                        }
                        return (
                          <div key={i} className="space-y-1">
                            <div className="grid gap-2 sm:grid-cols-[1.2fr_110px_1.4fr_32px]">
                              <Select
                                value={f.field}
                                onValueChange={(v) => patchFilter({ field: v })}
                              >
                                <SelectTrigger className="h-7 text-xs">
                                  <SelectValue placeholder="field…" />
                                </SelectTrigger>
                                <SelectContent>
                                  {draft.dimensions.map((d) => (
                                    <SelectItem key={`d-${d.name}`} value={d.name}>
                                      {d.name} (dim)
                                    </SelectItem>
                                  ))}
                                  {draft.metrics.map((m) => (
                                    <SelectItem key={`m-${m.name}`} value={m.name}>
                                      {m.name} (metric)
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Select
                                value={f.op}
                                onValueChange={(v) => patchFilter({ op: v as FilterOp })}
                              >
                                <SelectTrigger className="h-7 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {FILTER_OPS.map((op) => (
                                    <SelectItem key={op} value={op}>
                                      {op}
                                    </SelectItem>
                                  ))}
                                  {fieldIsTime &&
                                    RELATIVE_DATE_OPS.map((op) => (
                                      <SelectItem key={op} value={op}>
                                        {RELATIVE_OP_LABELS[op]}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                              {isRelative && f.op !== "last_n_days" ? (
                                // These windows take no value at all.
                                <div className="flex h-7 items-center text-xs text-muted-foreground">
                                  no value needed
                                </div>
                              ) : (
                                <Input
                                  className="h-7 font-mono text-xs"
                                  type={f.op === "last_n_days" ? "number" : "text"}
                                  min={f.op === "last_n_days" ? 1 : undefined}
                                  placeholder={
                                    f.op === "last_n_days" ? "30" : isList ? "a, b, c" : "value"
                                  }
                                  value={
                                    Array.isArray(f.value)
                                      ? f.value.join(", ")
                                      : String(f.value ?? "")
                                  }
                                  onChange={(e) => {
                                    const raw = e.target.value;
                                    if (isList) {
                                      patchFilter({
                                        value: raw
                                          .split(",")
                                          .map((s) => s.trim())
                                          .filter(Boolean),
                                      });
                                    } else {
                                      // Numeric-looking input is sent as a number so
                                      // comparisons work on numeric columns.
                                      const n = Number(raw);
                                      patchFilter({
                                        value: raw !== "" && Number.isFinite(n) ? n : raw,
                                      });
                                    }
                                  }}
                                />
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                aria-label={`Remove filter ${i + 1}`}
                                onClick={() =>
                                  setPickedFilters((cur) => cur.filter((_, j) => j !== i))
                                }
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                            {windowHint && (
                              <p className="pl-1 font-mono text-[11px] text-muted-foreground">
                                {windowHint}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Time rollup per picked time dimension */}
                    {draft.dimensions
                      .filter((d) => d.type === "time" && pickedDims.includes(d.name))
                      .map((d) => (
                        <div key={d.name} className="flex items-center gap-2">
                          <span className="font-mono text-xs text-muted-foreground">{d.name}</span>
                          <Select
                            value={pickedGrains[d.name] || "raw"}
                            onValueChange={(v) =>
                              setPickedGrains((g) => ({
                                ...g,
                                [d.name]: v === "raw" ? "" : (v as TimeGrain),
                              }))
                            }
                          >
                            <SelectTrigger className="h-7 w-36 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="raw">raw values</SelectItem>
                              {TIME_GRAINS.map((g) => (
                                <SelectItem key={g} value={g}>
                                  by {g}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}

                    {/* Period-over-period. Shown only when the query has exactly
                    one grained time axis to compare along — the compiler
                    refuses anything else, so offering it would be a trap. */}
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">Compare</span>
                        <Select
                          value={pickedCompare || "none"}
                          onValueChange={(v) =>
                            setPickedCompare(v === "none" ? "" : (v as ComparePeriod))
                          }
                          disabled={!compareIsAvailable}
                        >
                          <SelectTrigger className="h-7 w-48 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">no comparison</SelectItem>
                            {COMPARE_PERIODS.map((c) => (
                              <SelectItem key={c} value={c}>
                                {COMPARE_LABELS[c]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {!compareIsAvailable && (
                        <p className="pl-1 text-[11px] text-muted-foreground">
                          {pickedMetrics.length === 0
                            ? "Pick a metric to compare."
                            : comparableAxes.length === 0
                              ? "Pick a time dimension and give it a rollup — that becomes the comparison axis."
                              : `Only one time axis can be compared at a time (${comparableAxes.join(", ")}).`}
                        </p>
                      )}
                      {compareIsAvailable && pickedCompare && (
                        <p className="pl-1 text-[11px] text-muted-foreground">
                          Adds <span className="font-mono">_prev</span>,{" "}
                          <span className="font-mono">_change</span> and{" "}
                          <span className="font-mono">_pct_change</span> per metric, along{" "}
                          <span className="font-mono">{comparableAxes[0]}</span>. A period with no
                          predecessor shows blank rather than zero.
                        </p>
                      )}
                    </div>

                    {result && (
                      <div className="space-y-2">
                        <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px]">
                          {result.sql}
                        </pre>
                        <div className="max-h-72 overflow-auto rounded border">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                {result.columns.map((c) => (
                                  <TableHead key={c} className="font-mono text-xs">
                                    {c}
                                  </TableHead>
                                ))}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {result.rows.map((r, i) => (
                                <TableRow key={i}>
                                  {result.columns.map((c) => (
                                    <TableCell key={c} className="font-mono text-xs">
                                      {String(r[c] ?? "")}
                                    </TableCell>
                                  ))}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                        <div className="flex items-center justify-between">
                          <p className="text-[11px] text-muted-foreground">
                            {result.rows.length} row(s)
                          </p>
                          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
                            <LayoutDashboard className="mr-1 h-4 w-4" /> Add to dashboard
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>

      <AddMetricToDashboardDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        userId={user?.id ?? null}
        payload={
          draft && result
            ? {
                model: draft.name,
                metrics: result.metrics,
                dimensions: result.dimensions,
                grains: result.grains,
                filters: result.filters,
                compare: result.compare,
                columns: result.columns,
                rows: result.rows,
                sql: result.sql,
                defaultTitle: draft.label || draft.name,
              }
            : null
        }
      />
    </div>
  );
}

function FieldSection({
  title,
  hint,
  count,
  icon: Icon,
  cols,
  onAddFromColumn,
  onAddBlank,
  disabled = false,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  icon: LucideIcon;
  cols: string[];
  onAddFromColumn: (c: string) => void;
  onAddBlank: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex max-h-[calc(100vh-15rem)] flex-col">
      {/* The header stays put while the list scrolls: with 20+ fields the
          Add control used to leave the screen exactly when you needed it. */}
      <div className="@container/head flex flex-wrap items-center justify-between gap-2 border-b border-border/60 p-4">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              {title}
              <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                {count}
              </span>
            </h3>
            <p className="truncate text-xs text-muted-foreground">{hint}</p>
          </div>
        </div>
        {!disabled && (
          <div className="flex w-full shrink-0 gap-2 @[26rem]/head:w-auto">
            {cols.length > 0 && (
              <Select onValueChange={onAddFromColumn}>
                <SelectTrigger
                  className="h-8 flex-1 text-xs @[26rem]/head:w-[132px] @[26rem]/head:flex-none"
                  aria-label={`Add ${title.toLowerCase()} from a source column`}
                >
                  <SelectValue placeholder="+ from column" />
                </SelectTrigger>
                <SelectContent>
                  {cols.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button variant="outline" size="sm" onClick={onAddBlank}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add
            </Button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {count === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No {title.toLowerCase()} yet — add one from a source column, or use Generate with AI on
            the Source tab.
          </p>
        ) : (
          children
        )}
      </div>
    </Card>
  );
}

function Picker({
  label,
  options,
  picked,
  onToggle,
}: {
  label: string;
  options: string[];
  picked: string[];
  onToggle: (n: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex flex-wrap gap-1">
        {options.length === 0 ? (
          <span className="text-xs text-muted-foreground">none defined</span>
        ) : (
          options.map((o) => (
            <Badge
              key={o}
              variant={picked.includes(o) ? "default" : "outline"}
              className="cursor-pointer font-mono text-[10px]"
              onClick={() => onToggle(o)}
            >
              {o}
            </Badge>
          ))
        )}
      </div>
    </div>
  );
}
