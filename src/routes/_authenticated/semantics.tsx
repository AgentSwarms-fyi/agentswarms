// Semantic Layer — define governed metrics + dimensions over a dataset, then
// query them (the same definitions the metric_query agent tool consumes).
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  BadgeCheck,
  Database,
  FileJson,
  History,
  Layers,
  LayoutDashboard,
  Link2,
  Network,
  Play,
  Plus,
  Save,
  ShieldCheck,
  Gauge,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Target,
  Trash2,
  Sigma,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { llmJson } from "@/lib/biAgent";
import { clickable } from "@/lib/clickable";
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
  CALENDAR_GRAINS,
  COMPARE_PERIODS,
  isRelativeDateOp,
  MAX_ROLLUPS,
  relativeDateRange,
  RELATIVE_DATE_OPS,
  TIME_GRAINS,
  type CalendarGrain,
  type ComparePeriod,
  type RelativeDateOp,
  type SemanticCalendar,
  type TimeGrain,
} from "@/lib/semanticLayer";
import type {
  FilterOp,
  JoinCardinality,
  MetricAgg,
  MetricAssertion,
  SemanticDimension,
  SemanticFilter,
  SemanticHierarchy,
  SemanticJoin,
  SemanticMetric,
  SemanticParameter,
  SemanticRollup,
} from "@/lib/semanticLayer";
import type { JoinMeasurement, ModelWarning } from "@/lib/semanticMeasure";
import {
  semanticDeleteModel,
  semanticListLocalSources,
  semanticListModels,
  semanticListVersions,
  semanticModelDependents,
  semanticRestoreVersion,
  semanticRunQuery,
  semanticSetModelStatus,
  semanticUpsertModel,
  semanticValidateModel,
} from "@/utils/semantic.functions";
import { diffSemanticDefinitions, type SemanticDefinitionDiff } from "@/lib/semanticDiff";
import { DbtImportDialog } from "@/components/semantics/DbtImportDialog";
import type { Json } from "@/integrations/supabase/types";
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
  primary_key: string;
  joins: SemanticJoin[];
  dimensions: SemanticDimension[];
  metrics: SemanticMetric[];
  assertions: MetricAssertion[];
  /** null = calendar year (January). 1–12 = month the fiscal year starts. */
  fiscal_year_start_month: number | null;
  /** Editable fiscal-calendar mapping; all four grain rows exist, "" = unmapped. */
  calendar: CalendarDraft | null;
  parameters: SemanticParameter[];
  hierarchies: SemanticHierarchy[];
  /** Declared pre-aggregated tables (aggregate awareness), persisted shape. */
  rollups: SemanticRollup[];
};

type CalendarDraft = {
  table: string;
  dateColumn: string;
  grains: Record<CalendarGrain, { seq: string; start: string }>;
};

const emptyCalendarDraft = (): CalendarDraft => ({
  table: "",
  dateColumn: "",
  grains: {
    fiscal_year: { seq: "", start: "" },
    fiscal_quarter: { seq: "", start: "" },
    fiscal_period: { seq: "", start: "" },
    fiscal_week: { seq: "", start: "" },
  },
});

/** Stored shape → the fully-populated editable shape. */
function calendarToDraft(cal: SemanticCalendar | null | undefined): CalendarDraft | null {
  if (!cal) return null;
  const d = emptyCalendarDraft();
  d.table = cal.table;
  d.dateColumn = cal.dateColumn;
  for (const g of CALENDAR_GRAINS) {
    const m = cal.grains[g];
    if (m) d.grains[g] = { seq: m.seq, start: m.start };
  }
  return d;
}

/** Editable shape → the save payload: rows with BOTH columns keep, rest drop. */
function calendarToPayload(cal: CalendarDraft | null): SemanticCalendar | null {
  if (!cal || !cal.table.trim()) return null;
  const grains: SemanticCalendar["grains"] = {};
  for (const g of CALENDAR_GRAINS) {
    const { seq, start } = cal.grains[g];
    if (seq.trim() && start.trim()) grains[g] = { seq: seq.trim(), start: start.trim() };
  }
  return { table: cal.table.trim(), dateColumn: cal.dateColumn.trim(), grains };
}

/** Editable rollups -> save payload: blank tables and columns drop out. */
function rollupsToPayload(rollups: SemanticRollup[]): SemanticRollup[] {
  return rollups
    .filter((r) => r.table.trim() !== "")
    .map((r) => ({
      table: r.table.trim(),
      ...(r.label?.trim() ? { label: r.label.trim() } : {}),
      dimensions: r.dimensions.filter((d) => d.column.trim() !== ""),
      metrics: r.metrics.filter((m) => m.column.trim() !== ""),
    }));
}

const CALENDAR_GRAIN_LABELS: Record<CalendarGrain, string> = {
  fiscal_year: "Fiscal year",
  fiscal_quarter: "Fiscal quarter",
  fiscal_period: "Fiscal period",
  fiscal_week: "Fiscal week",
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

/**
 * Join cardinality choices. "unset" is a real option, not a missing answer:
 * Validate MEASURES the join either way and says which declaration the data
 * supports — so the honest starting point is "not sure", never a default
 * guess that silently decides whether metrics double-count.
 */
const CARDINALITY_LABELS: Array<{ value: JoinCardinality | "unset"; label: string }> = [
  { value: "unset", label: "Cardinality? (Validate measures)" },
  { value: "many_to_one", label: "Many → one (lookup)" },
  { value: "one_to_one", label: "One → one" },
  { value: "one_to_many", label: "One → many (fans out)" },
  { value: "many_to_many", label: "Many → many (fans out)" },
];

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
  this_fiscal_year: "this fiscal year",
  last_fiscal_year: "last fiscal year",
  this_fiscal_quarter: "this fiscal quarter",
  last_fiscal_quarter: "last fiscal quarter",
  fiscal_ytd: "fiscal year to date",
  this_fiscal_period: "this fiscal period",
  last_fiscal_period: "last fiscal period",
};

/** Month names for the fiscal-year-start picker — index 0 is January (month 1). */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

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
    primary_key: "",
    joins: [],
    dimensions: [],
    metrics: [],
    assertions: [],
    fiscal_year_start_month: null,
    calendar: null,
    parameters: [],
    hierarchies: [],
    rollups: [],
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
  // The raw DB row being edited — the "last saved" state History diffs against.
  const [draftRow, setDraftRow] = useState<Record<string, unknown> | null>(null);
  // A grantee's enforced share restrictions, when this model is shared TO the
  // viewer with a row filter or field mask. Disclosure only — enforcement is
  // server-side in runSemanticQuery.
  const [viewerPolicy, setViewerPolicy] = useState<{
    row_filters: Array<{ column: string; values: string[] }> | null;
    masked_fields: string[];
  } | null>(null);
  // Which editor pane is showing. Fields (dimensions + metrics) is the work
  // this page exists for, so it leads; a model with no source yet opens on
  // Source instead, because Fields cannot do anything without columns.
  const [editorTab, setEditorTab] = useState<"fields" | "source" | "query" | "history">("fields");
  const [statusBusy, setStatusBusy] = useState(false);
  // Per-field "agent details" expander (label / description / synonyms) —
  // the fields agents read; keyed "d-3" / "m-1".
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set());
  const toggleDetails = (key: string) =>
    setOpenDetails((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  /** Comma-separated input ⇄ synonyms array. */
  const parseSynonyms = (raw: string): string[] | undefined => {
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
    return list.length > 0 ? list : undefined;
  };
  const [versions, setVersions] = useState<
    | Array<{ id: string; changed_by: string | null; definition: Json; created_at: string }>
    | "loading"
    | null
  >(null);
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [deps, setDeps] = useState<
    | {
        dashboards: Array<{ dashboardId: string; dashboardName: string; widgets: string[] }>;
        agents: Array<{ id: string; name: string }>;
        swarms: Array<{ id: string; name: string }>;
        sharedWith: Array<{ principal_type: string; principal_id: string }>;
      }
    | "loading"
    | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [biModel, setBiModel] = useBiModelPref();

  // Run panel
  const [pickedMetrics, setPickedMetrics] = useState<string[]>([]);
  const [pickedDims, setPickedDims] = useState<string[]>([]);
  const [pickedGrains, setPickedGrains] = useState<Record<string, TimeGrain | "">>({});
  const [pickedFilters, setPickedFilters] = useState<SemanticFilter[]>([]);
  const [pickedCompare, setPickedCompare] = useState<ComparePeriod | "">("");
  // Runner overrides for model parameters, as typed. Blank = use the
  // parameter's default — only typed values travel with the query.
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [validating, setValidating] = useState(false);
  const [issues, setIssues] = useState<
    { kind: string; name: string; error: string }[] | "clean" | null
  >(null);
  // Measurement findings that are worth acting on but not wrong (mostly
  // "declare this join's cardinality"), plus the raw counts per join step so
  // the numbers behind a verdict are visible rather than asserted.
  const [valWarnings, setValWarnings] = useState<ModelWarning[]>([]);
  const [valMeasured, setValMeasured] = useState<JoinMeasurement[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    columns: string[];
    rows: Record<string, unknown>[];
    sql: string;
    access_note?: string;
    /** Set when a declared rollup answered instead of the fact table. */
    rollup?: string;
    metrics: string[];
    dimensions: string[];
    grains?: Record<string, TimeGrain>;
    filters?: SemanticFilter[];
    compare?: ComparePeriod;
    /** Overrides this run used — pinned onto a widget by Add to dashboard. */
    params?: Record<string, string | number>;
  } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [dbtOpen, setDbtOpen] = useState(false);

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
    // A grantee's masked fields are hidden here too — the read-only editor
    // must never offer a name the query path would refuse.
    const policy =
      (m.viewer_policy as {
        row_filters: Array<{ column: string; values: string[] }> | null;
        masked_fields: string[];
      } | null) ?? null;
    const masked = new Set((policy?.masked_fields ?? []).map((f) => f.toLowerCase()));
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
      primary_key: (m.primary_key as string) ?? "",
      joins: Array.isArray(m.joins) ? (m.joins as SemanticJoin[]) : [],
      dimensions: (Array.isArray(m.dimensions) ? (m.dimensions as SemanticDimension[]) : []).filter(
        (d) => !masked.has(d.name.toLowerCase()),
      ),
      metrics: (Array.isArray(m.metrics) ? (m.metrics as SemanticMetric[]) : []).filter(
        (x) => !masked.has(x.name.toLowerCase()),
      ),
      assertions: Array.isArray(m.assertions) ? (m.assertions as MetricAssertion[]) : [],
      fiscal_year_start_month:
        typeof m.fiscal_year_start_month === "number" ? m.fiscal_year_start_month : null,
      calendar: calendarToDraft((m.calendar as SemanticCalendar | null) ?? null),
      parameters: Array.isArray(m.parameters) ? (m.parameters as SemanticParameter[]) : [],
      hierarchies: Array.isArray(m.hierarchies) ? (m.hierarchies as SemanticHierarchy[]) : [],
      rollups: Array.isArray(m.rollups) ? (m.rollups as SemanticRollup[]) : [],
    });
    setDraftRow(m);
    setViewerPolicy(policy);
    setVersions(null);
    setDeps(null);
    setOpenDiff(null);
    setParamValues({});
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
    setValWarnings([]);
    setValMeasured([]);
  };

  /**
   * Compile + probe every field, MEASURE joins and grain against the data,
   * and re-compute pinned assertions — all against the real backend, without
   * saving.
   */
  const validate = async () => {
    if (!draft) return;
    setValidating(true);
    setIssues(null);
    setValWarnings([]);
    setValMeasured([]);
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
            primary_key: draft.primary_key.trim() || null,
            joins: draft.joins,
            dimensions: draft.dimensions,
            metrics: draft.metrics,
            assertions: draft.assertions,
            fiscal_year_start_month: draft.fiscal_year_start_month,
            calendar: calendarToPayload(draft.calendar),
            parameters: draft.parameters.map((p) => ({ ...p, default: p.default ?? "" })),
            hierarchies: draft.hierarchies,
            rollups: rollupsToPayload(draft.rollups),
          },
        },
      })) as {
        ok: boolean;
        checked: number;
        issues: { kind: string; name: string; error: string }[];
        warnings: ModelWarning[];
        measured: JoinMeasurement[];
        sampledValues: Record<string, string[]>;
      };
      setIssues(res.ok ? "clean" : res.issues);
      setValWarnings(res.warnings ?? []);
      setValMeasured(res.measured ?? []);
      // Merge freshly sampled values into the draft so the next Save persists
      // them — they become part of what the agent catalog shows.
      const sampled = res.sampledValues ?? {};
      const sampledCount = Object.keys(sampled).length;
      if (sampledCount > 0) {
        setDraft((cur) =>
          cur
            ? {
                ...cur,
                dimensions: cur.dimensions.map((x) =>
                  sampled[x.name] ? { ...x, values: sampled[x.name] } : x,
                ),
              }
            : cur,
        );
      }
      if (res.ok) {
        toast.success(
          `All ${res.checked} checks pass — fields run, joins and grain measure as declared` +
            (draft.assertions.length > 0 ? `, ${draft.assertions.length} assertion(s) hold` : "") +
            (sampledCount > 0
              ? `. Sampled values for ${sampledCount} dimension(s) — save to persist them for agents.`
              : "."),
        );
      } else toast.error(`${res.issues.length} check(s) failed — see the details below.`);
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
            primary_key: draft.primary_key.trim() || null,
            joins: draft.joins,
            dimensions: draft.dimensions,
            metrics: draft.metrics,
            assertions: draft.assertions,
            fiscal_year_start_month: draft.fiscal_year_start_month,
            calendar: calendarToPayload(draft.calendar),
            parameters: draft.parameters.map((p) => ({ ...p, default: p.default ?? "" })),
            hierarchies: draft.hierarchies,
            rollups: rollupsToPayload(draft.rollups),
          },
        },
      })) as { id: string };
      toast.success("Saved");
      setDraft((d) => (d ? { ...d, id: res.id } : d));
      await load();
      // Refresh the raw row: a definition change may have DECERTIFIED the
      // model (DB trigger) and has certainly written a new history version —
      // the badge and the History tab must reflect the database's truth, not
      // the state from before the save.
      try {
        const rows = (await listFn({ data: { accessToken: token } })) as Array<
          Record<string, unknown>
        >;
        const fresh = rows.find((r) => r.id === res.id);
        if (fresh) {
          setDraftRow(fresh);
          setVersions(null);
          setDeps(null);
        }
      } catch {
        /* list refresh is cosmetic here; the save itself succeeded */
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const depsFn = useServerFn(semanticModelDependents);
  const statusFn = useServerFn(semanticSetModelStatus);
  const versionsFn = useServerFn(semanticListVersions);
  const restoreFn = useServerFn(semanticRestoreVersion);

  const remove = async (id: string) => {
    try {
      // Deleting a model silently breaks every widget and agent that names
      // it. List them BEFORE the delete, not in a post-mortem.
      let summary = "";
      try {
        const d = await depsFn({ data: { accessToken: token, modelId: id } });
        const parts: string[] = [];
        if (d.dashboards.length > 0)
          parts.push(
            `${d.dashboards.length} dashboard(s): ${d.dashboards.map((x) => x.dashboardName).join(", ")}`,
          );
        if (d.agents.length > 0)
          parts.push(`${d.agents.length} agent(s): ${d.agents.map((x) => x.name).join(", ")}`);
        if (d.swarms.length > 0)
          parts.push(`${d.swarms.length} swarm(s): ${d.swarms.map((x) => x.name).join(", ")}`);
        if (d.sharedWith.length > 0) parts.push(`shared with ${d.sharedWith.length} principal(s)`);
        summary = parts.join("\n");
      } catch {
        // Dependents are advisory; their lookup failing must not block delete.
      }
      const message = summary
        ? `This model is still in use:\n\n${summary}\n\nDeleting it will break these. Delete anyway?`
        : "Delete this semantic model?";
      if (!window.confirm(message)) return;
      await deleteFn({ data: { accessToken: token, id } });
      if (draft?.id === id) setDraft(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  /** Change certification status; certifying re-validates server-side. */
  const setStatus = async (status: string) => {
    if (!draft?.id) return toast.error("Save the model first");
    setStatusBusy(true);
    try {
      const res = await statusFn({ data: { accessToken: token, id: draft.id, status } });
      if (!res.ok) {
        if ("issues" in res && res.issues) setIssues(res.issues);
        return toast.error(res.error);
      }
      toast.success(
        status === "certified"
          ? "Certified — every validation check passed against the live source."
          : `Status set to ${status}.`,
      );
      setDraftRow((r) => (r ? { ...r, status } : r));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Status change failed");
    } finally {
      setStatusBusy(false);
    }
  };

  /** Load history + dependents when the History tab opens. */
  useEffect(() => {
    if (editorTab !== "history" || !draft?.id) return;
    if (versions === null) {
      setVersions("loading");
      versionsFn({ data: { accessToken: token, modelId: draft.id } })
        .then((rows) => setVersions(rows as Exclude<typeof versions, "loading" | null>))
        .catch((e) => {
          setVersions([]);
          toast.error(e instanceof Error ? e.message : "Could not load history");
        });
    }
    if (deps === null) {
      setDeps("loading");
      depsFn({ data: { accessToken: token, modelId: draft.id } })
        .then((d) => setDeps(d as Exclude<typeof deps, "loading" | null>))
        .catch(() => setDeps({ dashboards: [], agents: [], swarms: [], sharedWith: [] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorTab, draft?.id]);

  const restore = async (versionId: string) => {
    if (!window.confirm("Restore this version? The current definition is snapshotted first."))
      return;
    try {
      const res = await restoreFn({ data: { accessToken: token, versionId } });
      if (!res.ok) return toast.error(res.error);
      toast.success("Restored. The pre-restore state is in history.");
      // Reload and re-open the model so the editor shows the restored truth.
      const rows = (await listFn({ data: { accessToken: token } })) as Array<
        Record<string, unknown>
      >;
      setModels(rows);
      const fresh = rows.find((r) => r.id === draft?.id);
      if (fresh) editModel(fresh);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Restore failed");
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
      // Only parameters the user actually typed travel — a blank input means
      // "use the declared default", which the compiler fills in server-side.
      const params: Record<string, string | number> = {};
      for (const p of draft.parameters) {
        const raw = paramValues[p.name];
        if (raw === undefined || raw.trim() === "") continue;
        params[p.name] = p.type === "number" ? Number(raw) : raw;
      }
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
            params: Object.keys(params).length > 0 ? params : undefined,
            limit: 100,
          },
        },
      })) as {
        columns: string[];
        rows: Record<string, unknown>[];
        sql: string;
        access_note?: string;
        rollup?: string;
      };
      setResult({
        ...res,
        metrics: pickedMetrics,
        dimensions: pickedDims,
        grains: Object.keys(grains).length > 0 ? grains : undefined,
        filters: filters.length > 0 ? filters : undefined,
        compare,
        params: Object.keys(params).length > 0 ? params : undefined,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Query failed");
    } finally {
      setRunning(false);
    }
  };

  /**
   * Run an assertion's metric+filters against the live backend and pin the
   * result as its expected value. The number should be CONFIRMED against a
   * trusted reference before anyone relies on the pin — this button records
   * what the model computes today, it does not certify it.
   */
  const [pinning, setPinning] = useState<number | null>(null);
  const pinAssertion = async (i: number) => {
    const a = draft?.assertions[i];
    if (!draft || !a) return;
    if (!draft.id) return toast.error("Save the model first — pinning runs the real query.");
    if (!a.metric) return toast.error("Pick a metric to pin.");
    setPinning(i);
    try {
      const res = (await runFn({
        data: {
          accessToken: token,
          query: {
            model: draft.name,
            metrics: [a.metric],
            dimensions: [],
            filters: a.filters?.length ? a.filters : undefined,
            limit: 1,
          },
        },
      })) as { rows: Record<string, unknown>[] };
      const raw = res.rows[0]?.[a.metric];
      const val = typeof raw === "bigint" ? Number(raw) : Number(raw);
      if (raw === null || raw === undefined || Number.isNaN(val)) {
        return toast.error("The metric produced no value under these filters — nothing to pin.");
      }
      patch({
        assertions: draft.assertions.map((x, k) => (k === i ? { ...x, expected: val } : x)),
      });
      toast.success(
        `Pinned ${a.metric} = ${val.toLocaleString()}. Confirm it against a trusted reference, then save.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Pin failed");
    } finally {
      setPinning(null);
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
          {/* Offered only with a warehouse connected: a dbt model is a table in
              one, and an import dialog whose first field cannot be filled is a
              dead end rather than a discovery. */}
          {whConns.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => setDbtOpen(true)}
              title="Import models, columns and MetricFlow measures from a dbt manifest"
            >
              <FileJson className="mr-1 h-4 w-4" /> Import from dbt
            </Button>
          )}
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
                  className={`cursor-pointer transition-all hover:shadow-sm ${
                    draft?.id === m.id
                      ? "border-primary bg-primary/[0.03]"
                      : "hover:border-primary/40"
                  }`}
                  {...clickable(() => editModel(m), `Semantic model ${m.name}`)}
                >
                  <CardContent className="flex items-center justify-between gap-2 p-3">
                    <div
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
                        draft?.id === m.id
                          ? "bg-gradient-to-br from-primary/25 to-primary/10 text-primary"
                          : "bg-gradient-to-br from-primary/15 to-primary/5 text-primary/80"
                      }`}
                    >
                      <Layers className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {(m.label as string) || (m.name as string)}
                        {shared && (
                          <Badge variant="outline" className="h-4 px-1 text-[9px] font-normal">
                            Shared
                          </Badge>
                        )}
                        {m.status === "certified" && (
                          <BadgeCheck
                            className="h-3.5 w-3.5 shrink-0 text-emerald-500"
                            aria-label="Certified"
                          />
                        )}
                        {m.status === "deprecated" && (
                          <Badge
                            variant="outline"
                            className="h-4 border-amber-500/50 px-1 text-[9px] font-normal text-amber-600 dark:text-amber-400"
                          >
                            Deprecated
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
            <CardContent className="flex flex-col items-center gap-3 p-14 text-center">
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5">
                <Layers className="h-7 w-7 text-primary/70" />
              </div>
              <div>
                <p className="text-sm font-medium">Pick a model to open it here</p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  Or create a new one — point it at a dataset or warehouse table, define metrics
                  once, and every dashboard and agent inherits the same numbers.
                </p>
              </div>
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
              {/* At-a-glance shape of the model, in the field-class colors
                  used everywhere else on this page. */}
              <div className="hidden items-center gap-3 text-[11px] tabular-nums text-muted-foreground lg:flex">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-sky-500/80" aria-hidden />
                  {draft.dimensions.length} dimension{draft.dimensions.length === 1 ? "" : "s"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-500/80" aria-hidden />
                  {draft.metrics.length} metric{draft.metrics.length === 1 ? "" : "s"}
                </span>
                {draft.joins.length > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <Link2 className="h-3 w-3" aria-hidden />
                    {draft.joins.length} join{draft.joins.length === 1 ? "" : "s"}
                  </span>
                )}
                {draft.hierarchies.length > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <Network className="h-3 w-3" aria-hidden />
                    {draft.hierarchies.length}{" "}
                    {draft.hierarchies.length === 1 ? "hierarchy" : "hierarchies"}
                  </span>
                )}
              </div>
              {draftRow?.status === "certified" && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
                  title={`Certified ${draftRow.certified_at ? new Date(String(draftRow.certified_at)).toLocaleString() : ""} — every validation check passed against the live source. Editing the definition drops this back to draft.`}
                >
                  <BadgeCheck className="h-3 w-3" /> Certified
                </span>
              )}
              {draftRow?.status === "deprecated" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  Deprecated
                </span>
              )}
              {issues === "clean" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck className="h-3 w-3" /> Validated
                </span>
              )}
              {!isShared && draft.id && (
                <Select
                  value={String(draftRow?.status ?? "draft")}
                  onValueChange={(v) => void setStatus(v)}
                  disabled={statusBusy}
                >
                  <SelectTrigger
                    className="h-8 w-36 text-xs"
                    aria-label="Certification status"
                    title="Certifying re-runs every validation check against the live source and refuses if any fail. Editing a certified model's definition drops it back to draft."
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="certified">
                      {statusBusy ? "Validating…" : "Certify"}
                    </SelectItem>
                    <SelectItem value="deprecated">Deprecate</SelectItem>
                  </SelectContent>
                </Select>
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

            {/* A grantee's enforced share restrictions, said out loud. The
                numbers below ARE correct — for the slice this viewer was
                granted — and must never be mistaken for the global truth. */}
            {viewerPolicy && (
              <div className="rounded-md border border-sky-500/40 bg-sky-500/10 p-2.5 text-xs">
                <strong>Your access to this shared model is restricted:</strong>{" "}
                {(viewerPolicy.row_filters ?? [])
                  .map((rf) => `rows limited to ${rf.column} ∈ [${rf.values.join(", ")}]`)
                  .join("; ")}
                {viewerPolicy.row_filters?.length && viewerPolicy.masked_fields.length ? "; " : ""}
                {viewerPolicy.masked_fields.length > 0
                  ? `hidden fields: ${viewerPolicy.masked_fields.join(", ")}`
                  : ""}
                . Every query you run here is scoped accordingly.
              </div>
            )}

            {/* Measurement advisories: not wrong, but worth locking in. */}
            {valWarnings.length > 0 && (
              <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
                {valWarnings.map((w, i) => (
                  <p key={i} className="text-xs">
                    <span className="font-mono font-semibold text-amber-700 dark:text-amber-400">
                      {w.kind}
                      {w.name ? ` ${w.name}` : ""}
                    </span>
                    <span className="text-amber-800/90 dark:text-amber-300/90"> — {w.note}</span>
                  </p>
                ))}
              </div>
            )}

            {/* The raw counts behind the join verdicts — a measured claim
                should show its measurement. */}
            {valMeasured.length > 0 && (
              <p className="px-1 font-mono text-[11px] text-muted-foreground">
                measured:{" "}
                {valMeasured
                  .map(
                    (s) =>
                      `${s.name} ${s.rows.toLocaleString()} rows` +
                      (s.distinct !== undefined ? ` (${s.distinct.toLocaleString()} keys)` : ""),
                  )
                  .join(" → ")}
              </p>
            )}

            <Tabs
              value={editorTab}
              onValueChange={(v) => setEditorTab(v as typeof editorTab)}
              className="space-y-4"
            >
              {/* Ordered as the authoring flow runs: pick a source, define
                  fields over it, query them, then look back. Opening an
                  existing model still lands on Fields — the daily work
                  surface — but the strip reads in build order. */}
              <TabsList>
                <TabsTrigger value="source" className="gap-1.5">
                  <Database className="h-3.5 w-3.5" /> Source &amp; joins
                  {draft.joins.length > 0 && (
                    <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                      {draft.joins.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="fields" className="gap-1.5">
                  <Layers className="h-3.5 w-3.5" /> Fields
                  <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                    {draft.dimensions.length + draft.metrics.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="query" className="gap-1.5">
                  <Play className="h-3.5 w-3.5" /> Query
                </TabsTrigger>
                <TabsTrigger value="history" className="gap-1.5">
                  <History className="h-3.5 w-3.5" /> History &amp; usage
                </TabsTrigger>
              </TabsList>

              <TabsContent value="source" className="space-y-4">
                <Card>
                  <CardHeader className="pb-3">
                    <SectionTitle
                      icon={Database}
                      title="Model & source"
                      hint="What this model is called and which table it reads — plus the grain and fiscal calendar everything else builds on."
                    />
                  </CardHeader>
                  <CardContent className="space-y-4 p-4 pt-0">
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
                    <div className="space-y-1">
                      <Label htmlFor="sem-pk" className="text-xs">
                        Primary key — the model&apos;s grain (optional)
                      </Label>
                      <Input
                        id="sem-pk"
                        value={draft.primary_key}
                        disabled={isShared}
                        placeholder="order_id"
                        className="h-8 max-w-xs font-mono"
                        onChange={(e) => patch({ primary_key: e.target.value })}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        The column that identifies one row of{" "}
                        <code>{draft.source_table || "the source"}</code>. Validate measures that it
                        really is unique, and join measurements use it to catch fan-out an INNER
                        join would otherwise hide.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Fiscal year starts in</Label>
                      <Select
                        // A stored value of 1 IS the calendar year — show it as such.
                        value={
                          draft.fiscal_year_start_month && draft.fiscal_year_start_month !== 1
                            ? String(draft.fiscal_year_start_month)
                            : "calendar"
                        }
                        disabled={isShared || !!draft.calendar}
                        onValueChange={(v) =>
                          patch({
                            fiscal_year_start_month: v === "calendar" ? null : Number(v),
                          })
                        }
                      >
                        <SelectTrigger
                          className="h-8 max-w-xs text-xs"
                          aria-label="Fiscal year start month"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="calendar">January (calendar year)</SelectItem>
                          {MONTH_NAMES.map((name, i) =>
                            // Starting in January IS the calendar year — one
                            // option for it, not two spellings of the same thing.
                            i === 0 ? null : (
                              <SelectItem key={name} value={String(i + 1)}>
                                {name}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">
                        Unlocks <code>fiscal_year</code>/<code>fiscal_quarter</code> rollups and
                        fiscal windows like &ldquo;fiscal year to date&rdquo;. A fiscal year is
                        named by the calendar year it <em>ends</em> in — with a July start, July
                        2025 opens FY 2026.
                      </p>
                    </div>
                    <div className="space-y-2">
                      {draft.calendar === null ? (
                        <div className="space-y-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            disabled={isShared}
                            onClick={() =>
                              patch({
                                calendar: emptyCalendarDraft(),
                                fiscal_year_start_month: null,
                              })
                            }
                          >
                            Use a fiscal calendar table (4-4-5 / custom periods)
                          </Button>
                          <p className="text-[11px] text-muted-foreground">
                            For calendars month arithmetic cannot express — retail 4-4-5, 13-period,
                            ISO weeks. One row per day; comparisons step the period&apos;s sequence
                            number, so &ldquo;previous period&rdquo; is exact even when neighbouring
                            periods differ in length.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-2 rounded-lg border p-3">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium">Fiscal calendar table</span>
                            <span className="flex-1" />
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 text-[11px] text-muted-foreground"
                              disabled={isShared}
                              onClick={() => patch({ calendar: null })}
                            >
                              Remove
                            </Button>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <div className="space-y-1">
                              <Label className="text-[11px]">Table</Label>
                              <Input
                                value={draft.calendar.table}
                                disabled={isShared}
                                placeholder="fiscal_calendar"
                                className="h-8 font-mono text-xs"
                                aria-label="Calendar table"
                                onChange={(e) =>
                                  patch({
                                    calendar: { ...draft.calendar!, table: e.target.value },
                                  })
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-[11px]">Day column</Label>
                              <Input
                                value={draft.calendar.dateColumn}
                                disabled={isShared}
                                placeholder="cal_date"
                                className="h-8 font-mono text-xs"
                                aria-label="Calendar day column"
                                onChange={(e) =>
                                  patch({
                                    calendar: { ...draft.calendar!, dateColumn: e.target.value },
                                  })
                                }
                              />
                            </div>
                          </div>
                          <div className="space-y-1">
                            {CALENDAR_GRAINS.map((g) => (
                              <div key={g} className="flex items-center gap-2">
                                <span className="w-24 shrink-0 text-[11px] text-muted-foreground">
                                  {CALENDAR_GRAIN_LABELS[g]}
                                </span>
                                <Input
                                  value={draft.calendar!.grains[g].seq}
                                  disabled={isShared}
                                  placeholder="seq column"
                                  className="h-7 font-mono text-[11px]"
                                  aria-label={`${CALENDAR_GRAIN_LABELS[g]} sequence column`}
                                  onChange={(e) =>
                                    patch({
                                      calendar: {
                                        ...draft.calendar!,
                                        grains: {
                                          ...draft.calendar!.grains,
                                          [g]: {
                                            ...draft.calendar!.grains[g],
                                            seq: e.target.value,
                                          },
                                        },
                                      },
                                    })
                                  }
                                />
                                <Input
                                  value={draft.calendar!.grains[g].start}
                                  disabled={isShared}
                                  placeholder="start column"
                                  className="h-7 font-mono text-[11px]"
                                  aria-label={`${CALENDAR_GRAIN_LABELS[g]} start column`}
                                  onChange={(e) =>
                                    patch({
                                      calendar: {
                                        ...draft.calendar!,
                                        grains: {
                                          ...draft.calendar!.grains,
                                          [g]: {
                                            ...draft.calendar!.grains[g],
                                            start: e.target.value,
                                          },
                                        },
                                      },
                                    })
                                  }
                                />
                              </div>
                            ))}
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            One row per day. Per grain: a <em>sequence</em> column (a dense integer
                            that steps by one per period, across year boundaries) and the
                            period&apos;s <em>start date</em> column. Map at least one grain; leave
                            the rest blank. Replaces the start-month setting — Validate measures the
                            table (one row per day, no gaps, sequence in date order).
                          </p>
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
                    <SectionTitle
                      icon={Link2}
                      title="Joins"
                      hint={
                        <>
                          Relate other tables to <code>{draft.source_table || "the source"}</code>{" "}
                          so dimensions and metrics can reference their columns. Qualify column
                          names in your SQL (e.g. <code>customers.segment</code>) once a join
                          exists.
                        </>
                      }
                    />
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {draft.joins.map((j, i) => (
                      <div
                        key={i}
                        className="grid gap-2 sm:grid-cols-[96px_1fr_110px_215px_1.6fr_36px]"
                      >
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
                        <Select
                          value={j.cardinality ?? "unset"}
                          onValueChange={(v) =>
                            patch({
                              joins: draft.joins.map((x, k) =>
                                k === i
                                  ? {
                                      ...x,
                                      cardinality:
                                        v === "unset" ? undefined : (v as JoinCardinality),
                                    }
                                  : x,
                              ),
                            })
                          }
                        >
                          <SelectTrigger
                            className="h-8 text-xs"
                            aria-label={`Join ${i + 1} cardinality`}
                            title="How many joined rows one source row matches. Declaring 'fans out' lets the compiler refuse metrics that would double-count; Validate measures the truth either way."
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CARDINALITY_LABELS.map((c) => (
                              <SelectItem key={c.value} value={c.value} className="text-xs">
                                {c.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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

                {/* Rollups — declared pre-aggregated tables. Routing is
                    compile-time and provable; Validate measures each rollup
                    against the fact table. */}
                <Card>
                  <CardHeader className="pb-3">
                    <SectionTitle
                      icon={Gauge}
                      title="Rollups (aggregate awareness)"
                      hint={
                        <>
                          Point queries at a <em>pre-aggregated</em> table when it can provably
                          answer them — a month × region summary serves month, quarter and year
                          questions without scanning the fact table. Map the columns; anything the
                          rollup can&apos;t prove falls back to the source, and a routed query says
                          so in its SQL. Validate compares the rollup&apos;s totals against the
                          source so a stale rollup is a reported drift.
                        </>
                      }
                    />
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {draft.rollups.map((r, i) => {
                      const patchRollup = (p: Partial<SemanticRollup>) =>
                        patch({
                          rollups: draft.rollups.map((x, k) => (k === i ? { ...x, ...p } : x)),
                        });
                      const dimCol = (name: string) =>
                        r.dimensions.find((d) => d.dimension === name);
                      const metCol = (name: string) => r.metrics.find((m) => m.metric === name);
                      const setDim = (name: string, p: { column?: string; grain?: TimeGrain }) => {
                        const rest = r.dimensions.filter((d) => d.dimension !== name);
                        const cur = dimCol(name) ?? { dimension: name, column: "" };
                        const next = { ...cur, ...p };
                        patchRollup({
                          dimensions: next.column.trim() === "" ? rest : [...rest, next],
                        });
                      };
                      const setMet = (name: string, column: string) => {
                        const rest = r.metrics.filter((m) => m.metric !== name);
                        patchRollup({
                          metrics:
                            column.trim() === "" ? rest : [...rest, { metric: name, column }],
                        });
                      };
                      // Only leaf aggregations that re-aggregate are mappable;
                      // offering avg here would bake in the avg-of-avgs lie.
                      const mappable = draft.metrics.filter((m) =>
                        ["sum", "count", "min", "max"].includes(m.agg),
                      );
                      return (
                        <div key={i} className="space-y-2 rounded-lg border p-3">
                          <div className="flex items-center gap-2">
                            <Input
                              value={r.table}
                              disabled={isShared}
                              placeholder="sales_by_month_region"
                              className="h-8 max-w-xs font-mono text-xs"
                              aria-label={`Rollup ${i + 1} table`}
                              onChange={(e) => patchRollup({ table: e.target.value })}
                            />
                            <span className="flex-1" />
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 text-[11px] text-muted-foreground"
                              disabled={isShared}
                              aria-label={`Remove rollup ${i + 1}`}
                              onClick={() =>
                                patch({ rollups: draft.rollups.filter((_, k) => k !== i) })
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1">
                              <p className="text-[11px] font-medium text-muted-foreground">
                                Dimension columns
                              </p>
                              {draft.dimensions.map((d) => (
                                <div key={d.name} className="flex items-center gap-2">
                                  <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                                    {d.name}
                                  </span>
                                  <Input
                                    value={dimCol(d.name)?.column ?? ""}
                                    disabled={isShared}
                                    placeholder="column (blank = not stored)"
                                    className="h-7 font-mono text-[11px]"
                                    aria-label={`Rollup ${i + 1} ${d.name} column`}
                                    onChange={(e) => setDim(d.name, { column: e.target.value })}
                                  />
                                  {d.type === "time" && (
                                    <Select
                                      value={dimCol(d.name)?.grain ?? ""}
                                      disabled={isShared || !dimCol(d.name)}
                                      onValueChange={(v) =>
                                        setDim(d.name, { grain: v as TimeGrain })
                                      }
                                    >
                                      <SelectTrigger
                                        className="h-7 w-28 text-[11px]"
                                        aria-label={`Rollup ${i + 1} ${d.name} stored grain`}
                                      >
                                        <SelectValue placeholder="stored grain" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {["day", "week", "month", "quarter", "year"].map((g) => (
                                          <SelectItem key={g} value={g}>
                                            {g}
                                          </SelectItem>
                                        ))}
                                        {(CALENDAR_GRAINS as readonly string[])
                                          .filter(
                                            (g) =>
                                              calendarToPayload(draft.calendar)?.grains[
                                                g as CalendarGrain
                                              ],
                                          )
                                          .map((g) => (
                                            <SelectItem key={g} value={g}>
                                              {g}
                                            </SelectItem>
                                          ))}
                                      </SelectContent>
                                    </Select>
                                  )}
                                </div>
                              ))}
                            </div>
                            <div className="space-y-1">
                              <p className="text-[11px] font-medium text-muted-foreground">
                                Metric columns (pre-aggregated)
                              </p>
                              {mappable.map((m) => (
                                <div key={m.name} className="flex items-center gap-2">
                                  <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                                    {m.name}
                                  </span>
                                  <Input
                                    value={metCol(m.name)?.column ?? ""}
                                    disabled={isShared}
                                    placeholder="column (blank = not stored)"
                                    className="h-7 font-mono text-[11px]"
                                    aria-label={`Rollup ${i + 1} ${m.name} column`}
                                    onChange={(e) => setMet(m.name, e.target.value)}
                                  />
                                  <span className="w-10 shrink-0 text-[10px] text-muted-foreground">
                                    {m.agg}
                                  </span>
                                </div>
                              ))}
                              {mappable.length === 0 && (
                                <p className="text-[11px] text-muted-foreground">
                                  No re-aggregatable metrics (sum, count, min, max) to map yet.
                                </p>
                              )}
                            </div>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            A time dimension needs its <em>stored grain</em> — a month store serves
                            month/quarter/year queries; day serves everything. <em>avg</em> and{" "}
                            <em>count_distinct</em> never route (an avg of avgs answers a different
                            question) — store sum and count and derive the ratio.
                          </p>
                        </div>
                      );
                    })}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isShared || draft.rollups.length >= MAX_ROLLUPS}
                      onClick={() =>
                        patch({
                          rollups: [...draft.rollups, { table: "", dimensions: [], metrics: [] }],
                        })
                      }
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add rollup
                    </Button>
                  </CardContent>
                </Card>

                {/* Parameters — {{tokens}} usable in dimension/metric SQL.
                    Defaults are REQUIRED so Validate, assertions and scheduled
                    refreshes can always compile without a caller. */}
                <Card>
                  <CardHeader className="pb-3">
                    <SectionTitle
                      icon={SlidersHorizontal}
                      title="Parameters"
                      hint={
                        <>
                          Named values your SQL references as{" "}
                          <code>
                            {"{{"}name{"}}"}
                          </code>{" "}
                          — e.g. a commission rate or a status filter. Callers (the runner, agents,
                          dashboards) may override them per query; the default applies otherwise.
                          Not allowed in join conditions.
                        </>
                      }
                    />
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {draft.parameters.map((p, i) => {
                      const patchParam = (u: Partial<SemanticParameter>) =>
                        patch({
                          parameters: draft.parameters.map((x, k) =>
                            k === i ? { ...x, ...u } : x,
                          ),
                        });
                      return (
                        <div
                          key={i}
                          className="grid gap-2 sm:grid-cols-[1fr_110px_120px_1.4fr_36px]"
                        >
                          <Input
                            value={p.name}
                            placeholder="min_amount"
                            aria-label={`Parameter ${i + 1} name`}
                            className="h-8 font-mono text-xs"
                            disabled={isShared}
                            onChange={(e) => patchParam({ name: slug(e.target.value) })}
                          />
                          <Select
                            value={p.type}
                            disabled={isShared}
                            onValueChange={(v) =>
                              patchParam({ type: v as SemanticParameter["type"] })
                            }
                          >
                            <SelectTrigger
                              className="h-8 text-xs"
                              aria-label={`Parameter ${i + 1} type`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="number">number</SelectItem>
                              <SelectItem value="string">string</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            value={String(p.default ?? "")}
                            placeholder="default (required)"
                            aria-label={`Parameter ${i + 1} default`}
                            className="h-8 font-mono text-xs"
                            disabled={isShared}
                            type={p.type === "number" ? "number" : "text"}
                            onChange={(e) =>
                              patchParam({
                                default:
                                  p.type === "number" && e.target.value !== ""
                                    ? Number(e.target.value)
                                    : e.target.value,
                              })
                            }
                          />
                          <Input
                            value={p.description ?? ""}
                            placeholder="what it means (agents read this)"
                            aria-label={`Parameter ${i + 1} description`}
                            className="h-8 text-xs"
                            disabled={isShared}
                            onChange={(e) =>
                              patchParam({ description: e.target.value || undefined })
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            aria-label={`Remove parameter ${i + 1}`}
                            disabled={isShared}
                            onClick={() =>
                              patch({ parameters: draft.parameters.filter((_, k) => k !== i) })
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      );
                    })}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isShared || draft.parameters.length >= 8}
                      onClick={() =>
                        patch({
                          parameters: [
                            ...draft.parameters,
                            { name: "", type: "number", default: 0 },
                          ],
                        })
                      }
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add parameter
                    </Button>
                  </CardContent>
                </Card>

                {/* Hierarchies — named drill paths agents and BI follow.
                    Validate refuses unknown or duplicate levels. */}
                <Card>
                  <CardHeader className="pb-3">
                    <SectionTitle
                      icon={Network}
                      title="Hierarchies"
                      hint={
                        <>
                          Ordered drill paths over existing dimensions — e.g.{" "}
                          <code>region → country → city</code>. Agents use them to answer
                          &ldquo;break that down&rdquo; with the next level instead of guessing.
                        </>
                      }
                    />
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {draft.hierarchies.map((h, i) => {
                      const patchHierarchy = (u: Partial<SemanticHierarchy>) =>
                        patch({
                          hierarchies: draft.hierarchies.map((x, k) =>
                            k === i ? { ...x, ...u } : x,
                          ),
                        });
                      return (
                        <div key={i} className="grid gap-2 sm:grid-cols-[1fr_2.2fr_36px]">
                          <Input
                            value={h.name}
                            placeholder="geography"
                            aria-label={`Hierarchy ${i + 1} name`}
                            className="h-8 font-mono text-xs"
                            disabled={isShared}
                            onChange={(e) => patchHierarchy({ name: slug(e.target.value) })}
                          />
                          <Input
                            defaultValue={h.levels.join(", ")}
                            placeholder="region, country, city — broadest first"
                            aria-label={`Hierarchy ${i + 1} levels`}
                            title="Comma-separated dimension names, broadest level first."
                            className="h-8 font-mono text-xs"
                            disabled={isShared}
                            onBlur={(e) =>
                              patchHierarchy({
                                levels: e.target.value
                                  .split(",")
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            aria-label={`Remove hierarchy ${i + 1}`}
                            disabled={isShared}
                            onClick={() =>
                              patch({ hierarchies: draft.hierarchies.filter((_, k) => k !== i) })
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      );
                    })}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isShared || draft.hierarchies.length >= 8}
                      onClick={() =>
                        patch({
                          hierarchies: [...draft.hierarchies, { name: "", levels: [] }],
                        })
                      }
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add hierarchy
                    </Button>
                  </CardContent>
                </Card>

                {/* Assertions — pinned numbers Validate re-computes. This is
                    the difference between "the SQL runs" and "revenue still
                    means what the board was told". */}
                <Card>
                  <CardHeader className="pb-3">
                    <SectionTitle
                      icon={Target}
                      title="Assertions"
                      hint={
                        <>
                          Pin a metric&apos;s value under fixed filters. Every{" "}
                          <strong>Validate</strong> re-computes it and fails if a definition edit
                          (or a data change) moves a number someone signed off. Use absolute date
                          ranges — a relative window would drift stale on its own.
                        </>
                      }
                    />
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {draft.assertions.map((a, i) => {
                      const patchAssertion = (p: Partial<MetricAssertion>) =>
                        patch({
                          assertions: draft.assertions.map((x, k) =>
                            k === i ? { ...x, ...p } : x,
                          ),
                        });
                      return (
                        <div key={i} className="space-y-2 rounded-md border border-border p-2.5">
                          <div className="grid gap-2 sm:grid-cols-[1.2fr_130px_130px_1fr_36px]">
                            <Select
                              value={a.metric || undefined}
                              onValueChange={(v) => patchAssertion({ metric: v })}
                            >
                              <SelectTrigger className="h-8 text-xs" aria-label="Assertion metric">
                                <SelectValue placeholder="metric…" />
                              </SelectTrigger>
                              <SelectContent>
                                {draft.metrics.map((m) => (
                                  <SelectItem key={m.name} value={m.name}>
                                    {m.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Input
                              className="h-8 font-mono text-xs"
                              type="number"
                              placeholder="expected"
                              aria-label="Expected value"
                              value={Number.isFinite(a.expected) ? String(a.expected) : ""}
                              onChange={(e) => patchAssertion({ expected: Number(e.target.value) })}
                            />
                            <Input
                              className="h-8 font-mono text-xs"
                              type="number"
                              min={0}
                              placeholder="tolerance (opt.)"
                              aria-label="Tolerance"
                              value={a.tolerance ?? ""}
                              onChange={(e) =>
                                patchAssertion({
                                  tolerance:
                                    e.target.value === "" ? undefined : Number(e.target.value),
                                })
                              }
                            />
                            <Input
                              className="h-8 text-xs"
                              placeholder='label, e.g. "Q1-2025 board deck"'
                              aria-label="Assertion label"
                              value={a.label ?? ""}
                              onChange={(e) =>
                                patchAssertion({ label: e.target.value || undefined })
                              }
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              aria-label={`Remove assertion ${i + 1}`}
                              disabled={isShared}
                              onClick={() =>
                                patch({
                                  assertions: draft.assertions.filter((_, k) => k !== i),
                                })
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>

                          {/* Absolute filters pinning the window/slice. */}
                          {(a.filters ?? []).map((f, fi) => {
                            const isList = f.op === "in" || f.op === "not_in";
                            const patchF = (p: Partial<SemanticFilter>) =>
                              patchAssertion({
                                filters: (a.filters ?? []).map((x, k) =>
                                  k === fi ? ({ ...x, ...p } as SemanticFilter) : x,
                                ),
                              });
                            return (
                              <div
                                key={fi}
                                className="grid gap-2 sm:grid-cols-[1.2fr_110px_1.4fr_32px]"
                              >
                                <Select
                                  value={f.field || undefined}
                                  onValueChange={(v) => patchF({ field: v })}
                                >
                                  <SelectTrigger className="h-7 text-xs">
                                    <SelectValue placeholder="field…" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {draft.dimensions.map((d) => (
                                      <SelectItem key={d.name} value={d.name}>
                                        {d.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <Select
                                  value={f.op}
                                  onValueChange={(v) => patchF({ op: v as FilterOp })}
                                >
                                  <SelectTrigger className="h-7 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {/* Absolute ops only — the server refuses
                                        relative windows in assertions. */}
                                    {FILTER_OPS.map((op) => (
                                      <SelectItem key={op} value={op}>
                                        {op}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <Input
                                  className="h-7 font-mono text-xs"
                                  placeholder={isList ? "a, b, c" : "value"}
                                  value={
                                    Array.isArray(f.value)
                                      ? f.value.join(", ")
                                      : String(f.value ?? "")
                                  }
                                  onChange={(e) => {
                                    const raw = e.target.value;
                                    if (isList) {
                                      patchF({
                                        value: raw
                                          .split(",")
                                          .map((s) => s.trim())
                                          .filter(Boolean),
                                      });
                                    } else {
                                      const n = Number(raw);
                                      patchF({
                                        value: raw !== "" && Number.isFinite(n) ? n : raw,
                                      });
                                    }
                                  }}
                                />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                  aria-label={`Remove assertion filter ${fi + 1}`}
                                  onClick={() =>
                                    patchAssertion({
                                      filters: (a.filters ?? []).filter((_, k) => k !== fi),
                                    })
                                  }
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            );
                          })}
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs"
                              disabled={isShared || draft.dimensions.length === 0}
                              onClick={() =>
                                patchAssertion({
                                  filters: [
                                    ...(a.filters ?? []),
                                    {
                                      field: draft.dimensions[0]?.name ?? "",
                                      op: "=",
                                      value: "",
                                    },
                                  ],
                                })
                              }
                            >
                              <Plus className="mr-1 h-3 w-3" /> Filter
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-xs"
                              disabled={isShared || pinning === i || !a.metric}
                              title={
                                !draft.id
                                  ? "Save the model first — pinning runs the real query"
                                  : "Compute the metric now and record the result as the expected value. Confirm it against a trusted reference before relying on it."
                              }
                              onClick={() => void pinAssertion(i)}
                            >
                              {pinning === i ? "Pinning…" : "Pin current value"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        isShared || draft.metrics.length === 0 || draft.assertions.length >= 50
                      }
                      title={
                        draft.metrics.length === 0 ? "Define a metric first" : "Add an assertion"
                      }
                      onClick={() =>
                        patch({
                          assertions: [
                            ...draft.assertions,
                            { metric: draft.metrics[0]?.name ?? "", expected: 0 },
                          ],
                        })
                      }
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add assertion
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
                    tone="sky"
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
                    <FieldColumnHeader
                      cols={[
                        { label: "Field name", className: "min-w-32 flex-1" },
                        { label: "SQL expression", className: "flex-[1.4]" },
                        { label: "Type", className: "w-[120px] shrink-0" },
                      ]}
                    />
                    {draft.dimensions.map((d, i) => (
                      <div
                        key={i}
                        className="space-y-1.5 rounded-lg border border-transparent p-1.5 transition-colors hover:border-border/60 hover:bg-muted/30"
                      >
                        <div className="@container/row flex flex-wrap items-center gap-2">
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
                            className={`order-3 h-8 w-8 shrink-0 @[30rem]/row:order-4 ${openDetails.has(`d-${i}`) ? "text-primary" : "text-muted-foreground"}`}
                            aria-label={`Agent details for dimension ${d.name || i + 1}`}
                            title="Label, description and synonyms — what agents read"
                            onClick={() => toggleDetails(`d-${i}`)}
                          >
                            <SquarePen className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="order-3 h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive @[30rem]/row:order-5"
                            aria-label={`Remove dimension ${d.name || i + 1}`}
                            onClick={() =>
                              patch({ dimensions: draft.dimensions.filter((_, j) => j !== i) })
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {openDetails.has(`d-${i}`) && (
                          <div className="space-y-1.5 rounded-md border border-dashed border-border p-2">
                            <div className="grid gap-1.5 sm:grid-cols-2">
                              <Input
                                value={d.label ?? ""}
                                placeholder="Label, e.g. Region"
                                aria-label={`Dimension ${d.name || i + 1} label`}
                                className="h-7 text-xs"
                                onChange={(e) =>
                                  patch({
                                    dimensions: draft.dimensions.map((x, j) =>
                                      j === i ? { ...x, label: e.target.value || undefined } : x,
                                    ),
                                  })
                                }
                              />
                              <Input
                                defaultValue={(d.synonyms ?? []).join(", ")}
                                placeholder="Synonyms, comma-separated — e.g. area, territory"
                                aria-label={`Dimension ${d.name || i + 1} synonyms`}
                                title="Business words that mean this field. Agents see them, and metric_query resolves them to this field."
                                className="h-7 text-xs"
                                onBlur={(e) =>
                                  patch({
                                    dimensions: draft.dimensions.map((x, j) =>
                                      j === i
                                        ? { ...x, synonyms: parseSynonyms(e.target.value) }
                                        : x,
                                    ),
                                  })
                                }
                              />
                            </div>
                            <Input
                              value={d.description ?? ""}
                              placeholder="Description agents read — what this slice means, what it excludes"
                              aria-label={`Dimension ${d.name || i + 1} description`}
                              className="h-7 text-xs"
                              onChange={(e) =>
                                patch({
                                  dimensions: draft.dimensions.map((x, j) =>
                                    j === i
                                      ? { ...x, description: e.target.value || undefined }
                                      : x,
                                  ),
                                })
                              }
                            />
                            {d.values && d.values.length > 0 && (
                              <p className="text-[11px] text-muted-foreground">
                                Sampled values (measured by Validate):{" "}
                                <span className="font-mono">{d.values.join(" | ")}</span>
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </FieldSection>

                  {/* Metrics */}
                  <FieldSection
                    title="Metrics"
                    tone="emerald"
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
                    <FieldColumnHeader
                      cols={[
                        { label: "Metric name", className: "min-w-32 flex-1" },
                        { label: "SQL expression", className: "flex-[1.3]" },
                        { label: "Aggregation", className: "w-[130px] shrink-0" },
                      ]}
                    />
                    {draft.metrics.map((m, i) => (
                      <div
                        key={i}
                        className="space-y-1.5 rounded-lg border border-transparent p-1.5 transition-colors hover:border-border/60 hover:bg-muted/30"
                      >
                        <div className="@container/row flex flex-wrap items-center gap-2">
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
                              className="order-2 h-8 w-[104px] shrink-0 @[30rem]/row:order-3 @[30rem]/row:w-[130px]"
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
                            className="order-4 h-8 w-full basis-full font-mono @[30rem]/row:order-2 @[30rem]/row:w-auto @[30rem]/row:flex-[1.3] @[30rem]/row:basis-auto"
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
                            className={`order-3 h-8 w-8 shrink-0 @[30rem]/row:order-4 ${openDetails.has(`m-${i}`) ? "text-primary" : "text-muted-foreground"}`}
                            aria-label={`Agent details for metric ${m.name || i + 1}`}
                            title="Label, description, synonyms and format — what agents read"
                            onClick={() => toggleDetails(`m-${i}`)}
                          >
                            <SquarePen className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="order-3 h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive @[30rem]/row:order-5"
                            aria-label={`Remove metric ${m.name || i + 1}`}
                            onClick={() =>
                              patch({ metrics: draft.metrics.filter((_, j) => j !== i) })
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {openDetails.has(`m-${i}`) && (
                          <div className="space-y-1.5 rounded-md border border-dashed border-border p-2">
                            <div
                              className={`grid gap-1.5 ${
                                m.format === "currency"
                                  ? "sm:grid-cols-[1fr_1fr_120px_80px]"
                                  : "sm:grid-cols-[1fr_1fr_120px]"
                              }`}
                            >
                              <Input
                                value={m.label ?? ""}
                                placeholder="Label, e.g. Net revenue"
                                aria-label={`Metric ${m.name || i + 1} label`}
                                className="h-7 text-xs"
                                onChange={(e) =>
                                  patch({
                                    metrics: draft.metrics.map((x, j) =>
                                      j === i ? { ...x, label: e.target.value || undefined } : x,
                                    ),
                                  })
                                }
                              />
                              <Input
                                defaultValue={(m.synonyms ?? []).join(", ")}
                                placeholder="Synonyms — e.g. turnover, GMV"
                                aria-label={`Metric ${m.name || i + 1} synonyms`}
                                title="Business words that mean this metric. Agents see them, and metric_query resolves them to this metric."
                                className="h-7 text-xs"
                                onBlur={(e) =>
                                  patch({
                                    metrics: draft.metrics.map((x, j) =>
                                      j === i
                                        ? { ...x, synonyms: parseSynonyms(e.target.value) }
                                        : x,
                                    ),
                                  })
                                }
                              />
                              <Select
                                value={m.format ?? "none"}
                                onValueChange={(v) =>
                                  patch({
                                    metrics: draft.metrics.map((x, j) =>
                                      j === i
                                        ? {
                                            ...x,
                                            format:
                                              v === "none"
                                                ? undefined
                                                : (v as SemanticMetric["format"]),
                                          }
                                        : x,
                                    ),
                                  })
                                }
                              >
                                <SelectTrigger
                                  className="h-7 text-xs"
                                  aria-label={`Metric ${m.name || i + 1} format`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">no format</SelectItem>
                                  <SelectItem value="number">number</SelectItem>
                                  <SelectItem value="currency">currency</SelectItem>
                                  <SelectItem value="percent">percent</SelectItem>
                                </SelectContent>
                              </Select>
                              {m.format === "currency" && (
                                <Input
                                  value={m.currency ?? ""}
                                  placeholder="USD"
                                  maxLength={3}
                                  aria-label={`Metric ${m.name || i + 1} currency code`}
                                  title="ISO 4217 code (USD, EUR, …) — charts built from this metric render in it."
                                  className="h-7 font-mono text-xs uppercase"
                                  onChange={(e) =>
                                    patch({
                                      metrics: draft.metrics.map((x, j) =>
                                        j === i
                                          ? {
                                              ...x,
                                              currency: e.target.value.toUpperCase() || undefined,
                                            }
                                          : x,
                                      ),
                                    })
                                  }
                                />
                              )}
                            </div>
                            <Input
                              value={m.description ?? ""}
                              placeholder='Description agents read — e.g. "excludes refunds and internal test orders"'
                              aria-label={`Metric ${m.name || i + 1} description`}
                              className="h-7 text-xs"
                              onChange={(e) =>
                                patch({
                                  metrics: draft.metrics.map((x, j) =>
                                    j === i
                                      ? { ...x, description: e.target.value || undefined }
                                      : x,
                                  ),
                                })
                              }
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </FieldSection>
                </div>
              </TabsContent>

              <TabsContent value="query">
                <Card>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <SectionTitle
                        icon={Play}
                        title="Query runner"
                        hint="Slice governed metrics without writing SQL — the compiled statement ships with every result."
                      />
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
                        tone="emerald"
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
                        tone="sky"
                        options={draft.dimensions.map((d) => d.name).filter(Boolean)}
                        picked={pickedDims}
                        onToggle={(n) =>
                          setPickedDims((p) =>
                            p.includes(n) ? p.filter((x) => x !== n) : [...p, n],
                          )
                        }
                      />
                    </div>
                    {/* Parameter overrides — blank means the declared default */}
                    {draft.parameters.length > 0 && (
                      <div className="space-y-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                          Parameters
                        </span>
                        <div className="flex flex-wrap gap-2">
                          {draft.parameters
                            .filter((p) => p.name)
                            .map((p) => (
                              <div key={p.name} className="flex items-center gap-1.5">
                                <span
                                  className="font-mono text-[11px] text-muted-foreground"
                                  title={p.description || undefined}
                                >
                                  {"{{"}
                                  {p.name}
                                  {"}}"}
                                </span>
                                <Input
                                  className="h-7 w-28 font-mono text-xs"
                                  type={p.type === "number" ? "number" : "text"}
                                  placeholder={String(p.default ?? "")}
                                  aria-label={`Parameter ${p.name} override`}
                                  value={paramValues[p.name] ?? ""}
                                  onChange={(e) =>
                                    setParamValues((cur) => ({
                                      ...cur,
                                      [p.name]: e.target.value,
                                    }))
                                  }
                                />
                              </div>
                            ))}
                        </div>
                        <p className="pl-1 text-[11px] text-muted-foreground">
                          Blank uses the declared default (shown as the placeholder).
                        </p>
                      </div>
                    )}

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
                          if (draft.calendar && f.op.includes("fiscal")) {
                            // The window is calendar-table DATA — the days the
                            // table assigns to the period. No date pair to show.
                            windowHint = "resolved by the fiscal calendar table at run time";
                          } else {
                            try {
                              const { start, end } = relativeDateRange(f.op as RelativeDateOp, {
                                n: Number(f.value),
                                fiscalStartMonth: draft.fiscal_year_start_month ?? undefined,
                              });
                              windowHint = `${start} → ${end} (end exclusive)`;
                            } catch (e) {
                              windowHint = e instanceof Error ? e.message : "invalid window";
                            }
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
                                    RELATIVE_DATE_OPS.filter(
                                      // Period windows are calendar-table data;
                                      // without a mapped fiscal_period grain the
                                      // compiler refuses them, so don't offer.
                                      (op) =>
                                        !(
                                          (op === "this_fiscal_period" ||
                                            op === "last_fiscal_period") &&
                                          !calendarToPayload(draft.calendar)?.grains.fiscal_period
                                        ),
                                    ).map((op) => (
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
                              {TIME_GRAINS.filter((g) => {
                                // Calendar-table grains are offered only when
                                // the model maps them; without a calendar the
                                // month-math fiscal grains stay, period/week go.
                                if (!(CALENDAR_GRAINS as readonly string[]).includes(g))
                                  return true;
                                const cal = calendarToPayload(draft.calendar);
                                if (cal) return !!cal.grains[g as CalendarGrain];
                                return g === "fiscal_year" || g === "fiscal_quarter";
                              }).map((g) => (
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
                        {result.rollup && (
                          <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px]">
                            Answered by rollup <code className="font-mono">{result.rollup}</code> —
                            a pre-aggregated table this model declares, not the fact table. The SQL
                            above says so too; Validate measures the rollup against the source.
                          </p>
                        )}
                        {result.access_note && (
                          <p className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px]">
                            Restricted share — {result.access_note}. These numbers are your scoped
                            view, not the global total.
                          </p>
                        )}
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
                                <TableRow key={i} className="even:bg-muted/20">
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

              {/* History & usage: what depends on this model, and every prior
                  definition with a field-level diff and a restore. */}
              <TabsContent value="history" className="space-y-4">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-1.5 text-sm">
                      <Link2 className="h-4 w-4" /> Used by
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Metric-backed widgets re-run against the CURRENT definition on every refresh —
                      this is what moves when you change this model.
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-1.5 text-xs">
                    {deps === "loading" || deps === null ? (
                      <Skeleton className="h-12 w-full" />
                    ) : deps.dashboards.length === 0 &&
                      deps.agents.length === 0 &&
                      deps.swarms.length === 0 &&
                      deps.sharedWith.length === 0 ? (
                      <p className="text-muted-foreground">
                        Nothing references this model yet — dashboards, agents and swarm nodes that
                        use it will be listed here.
                      </p>
                    ) : (
                      <>
                        {/* div, not p: Badge renders a div, and a div inside
                            a p is invalid HTML that breaks SSR hydration. */}
                        {deps.dashboards.map((d) => (
                          <div key={d.dashboardId}>
                            <Badge variant="secondary" className="mr-1.5 text-[10px]">
                              dashboard
                            </Badge>
                            {d.dashboardName}
                            <span className="text-muted-foreground"> — {d.widgets.join(", ")}</span>
                          </div>
                        ))}
                        {deps.agents.map((a) => (
                          <div key={a.id}>
                            <Badge variant="secondary" className="mr-1.5 text-[10px]">
                              agent
                            </Badge>
                            {a.name}
                          </div>
                        ))}
                        {deps.swarms.map((s) => (
                          <div key={s.id}>
                            <Badge variant="secondary" className="mr-1.5 text-[10px]">
                              swarm
                            </Badge>
                            {s.name}
                          </div>
                        ))}
                        {deps.sharedWith.length > 0 && (
                          <div>
                            <Badge variant="secondary" className="mr-1.5 text-[10px]">
                              shared
                            </Badge>
                            {deps.sharedWith.length} principal
                            {deps.sharedWith.length === 1 ? "" : "s"} (
                            {deps.sharedWith.map((p) => p.principal_type).join(", ")})
                          </div>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-1.5 text-sm">
                      <History className="h-4 w-4" /> Version history
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Written by the database on every change — no save path can skip it. Restoring
                      snapshots the current state first, so a restore is always undoable.
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {versions === "loading" || versions === null ? (
                      <Skeleton className="h-12 w-full" />
                    ) : versions.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No prior versions yet — the first edit after saving will create one.
                      </p>
                    ) : (
                      versions.map((v) => {
                        const diff: SemanticDefinitionDiff | null =
                          openDiff === v.id && draftRow
                            ? diffSemanticDefinitions(v.definition, draftRow as unknown as Json)
                            : null;
                        const renderItemDiff = (
                          label: string,
                          d: SemanticDefinitionDiff["metrics"],
                        ) =>
                          d.added.length === 0 &&
                          d.removed.length === 0 &&
                          d.changed.length === 0 ? null : (
                            <div key={label}>
                              <span className="font-medium">{label}:</span>{" "}
                              {d.added.length > 0 && (
                                <span className="text-emerald-600 dark:text-emerald-400">
                                  +{d.added.join(", +")}{" "}
                                </span>
                              )}
                              {d.removed.length > 0 && (
                                <span className="text-destructive">−{d.removed.join(", −")} </span>
                              )}
                              {d.changed.map((c) => (
                                <span key={c.name} className="text-muted-foreground">
                                  {c.name} (
                                  {c.changes
                                    .map((ch) => `${ch.field}: ${ch.before} → ${ch.after}`)
                                    .join("; ")}
                                  ){" "}
                                </span>
                              ))}
                            </div>
                          );
                        return (
                          <div key={v.id} className="rounded-md border border-border p-2.5 text-xs">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono">
                                {new Date(v.created_at).toLocaleString()}
                              </span>
                              <span className="text-muted-foreground">
                                {v.changed_by === user?.id
                                  ? "changed by you"
                                  : v.changed_by
                                    ? `changed by ${v.changed_by.slice(0, 8)}…`
                                    : "changed by a scheduled job"}
                              </span>
                              <span className="flex-1" />
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs"
                                onClick={() => setOpenDiff(openDiff === v.id ? null : v.id)}
                              >
                                {openDiff === v.id ? "Hide diff" : "Diff vs current"}
                              </Button>
                              {!isShared && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-xs"
                                  onClick={() => void restore(v.id)}
                                >
                                  Restore
                                </Button>
                              )}
                            </div>
                            {diff && (
                              <div className="mt-2 space-y-1 border-t border-border pt-2">
                                {diff.identical ? (
                                  <p className="text-muted-foreground">
                                    Identical to the current saved definition.
                                  </p>
                                ) : (
                                  <>
                                    {diff.model.length > 0 && (
                                      <div>
                                        <span className="font-medium">model:</span>{" "}
                                        {diff.model
                                          .map((c) => `${c.field}: ${c.before} → ${c.after}`)
                                          .join("; ")}
                                      </div>
                                    )}
                                    {renderItemDiff("metrics", diff.metrics)}
                                    {renderItemDiff("dimensions", diff.dimensions)}
                                    {renderItemDiff("joins", diff.joins)}
                                    {renderItemDiff("assertions", diff.assertions)}
                                  </>
                                )}
                                <p className="pt-1 text-[10px] text-muted-foreground">
                                  Reading: this version → current saved definition.
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>

      <DbtImportDialog
        open={dbtOpen}
        onOpenChange={setDbtOpen}
        connections={whConns}
        existingNames={models.map((m) => String(m.name ?? ""))}
        onImport={async (imported) => {
          // Saved ONE AT A TIME, and a failure is collected rather than thrown.
          // A batch that aborts halfway leaves the layer in a state nobody
          // asked for and reports nothing about which half landed.
          const failed: string[] = [];
          let saved = 0;
          for (const m of imported) {
            try {
              await upsertFn({
                data: {
                  accessToken: token,
                  model: {
                    name: m.name,
                    label: m.label,
                    description: m.description,
                    source_kind: "warehouse",
                    connection_id:
                      m.source.kind === "warehouse" ? m.source.connectionId : undefined,
                    source_table: m.source.kind === "warehouse" ? m.source.table : "",
                    primary_key: m.primaryKey,
                    dimensions: m.dimensions,
                    metrics: m.metrics,
                    joins: [],
                    // No status: the save schema does not accept one, so an
                    // import CANNOT land as certified even by mistake.
                    // Certification is its own server fn that re-runs the
                    // validation pipeline, which is exactly right here.
                  },
                },
              });
              saved++;
            } catch (e) {
              failed.push(`${m.name} (${e instanceof Error ? e.message : "save failed"})`);
            }
          }
          await load();
          return { saved, failed };
        }}
      />

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
                params: result.params,
                columns: result.columns,
                rows: result.rows,
                sql: result.sql,
                defaultTitle: draft.label || draft.name,
                // The lead metric's authored display format rides onto the
                // widget, so a currency metric charts as currency.
                format: draft.metrics.find((x) => x.name === result.metrics[0])?.format,
                currency: draft.metrics.find((x) => x.name === result.metrics[0])?.currency,
              }
            : null
        }
      />
    </div>
  );
}

/**
 * One visual voice for every section of the editor: icon chip, title, hint.
 * The Fields tab already spoke this way (FieldSection); the other cards were
 * bare text headings, which is what made the page read flat.
 */
function SectionTitle({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

/**
 * Column labels for a field-editor row, shown only at the width where the
 * row lays out as columns (below that the inputs wrap and stack, and each
 * carries its own placeholder). Widths mirror the row exactly; the trailing
 * spacer stands in for the two icon buttons.
 */
function FieldColumnHeader({ cols }: { cols: Array<{ label: string; className: string }> }) {
  return (
    <div className="@container/rowhead">
      <div className="hidden items-center gap-2 px-1 pb-0.5 @[30rem]/rowhead:flex">
        {cols.map((c) => (
          <span
            key={c.label || c.className}
            className={`text-[10px] font-medium uppercase tracking-wider text-muted-foreground ${c.className}`}
          >
            {c.label}
          </span>
        ))}
        <span className="w-[72px] shrink-0" aria-hidden />
      </div>
    </div>
  );
}

/**
 * The two field classes wear the colors BI users already know — QuickSight
 * and ThoughtSpot both paint dimensions blue and measures green, so the
 * palette carries meaning here instead of decoration. TONES must stay in
 * sync with the picker chips in the Query tab.
 */
const FIELD_TONES = {
  sky: {
    chip: "bg-gradient-to-br from-sky-500/20 to-sky-500/5 text-sky-600 dark:text-sky-400",
    pill: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    topline: "border-t-2 border-t-sky-500/50",
  },
  emerald: {
    chip: "bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 text-emerald-600 dark:text-emerald-400",
    pill: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    topline: "border-t-2 border-t-emerald-500/50",
  },
} as const;
type FieldTone = keyof typeof FIELD_TONES;

function FieldSection({
  title,
  hint,
  count,
  icon: Icon,
  tone,
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
  tone: FieldTone;
  cols: string[];
  onAddFromColumn: (c: string) => void;
  onAddBlank: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const t = FIELD_TONES[tone];
  return (
    <Card className={`flex max-h-[calc(100vh-15rem)] flex-col ${t.topline}`}>
      {/* The header stays put while the list scrolls: with 20+ fields the
          Add control used to leave the screen exactly when you needed it. */}
      <div className="@container/head flex flex-wrap items-center justify-between gap-2 border-b border-border/60 p-4">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${t.chip}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              {title}
              <span
                className={`rounded-full px-1.5 text-[10px] font-medium tabular-nums ${t.pill}`}
              >
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

/** Picked chips wear their field-class color — the same sky/emerald the
 *  Fields tab uses, so "what am I querying" reads at a glance. */
const PICKER_TONES: Record<FieldTone, string> = {
  sky: "border-sky-500/50 bg-sky-500/15 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300",
  emerald:
    "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300",
};

function Picker({
  label,
  tone,
  options,
  picked,
  onToggle,
}: {
  label: string;
  tone: FieldTone;
  options: string[];
  picked: string[];
  onToggle: (n: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="flex items-center gap-1.5 text-xs">
        <span
          className={`h-2 w-2 rounded-full ${tone === "sky" ? "bg-sky-500/80" : "bg-emerald-500/80"}`}
          aria-hidden
        />
        {label}
      </Label>
      <div className="flex flex-wrap gap-1">
        {options.length === 0 ? (
          <span className="text-xs text-muted-foreground">none defined</span>
        ) : (
          options.map((o) => (
            <Badge
              key={o}
              variant="outline"
              className={`cursor-pointer font-mono text-[10px] transition-colors ${
                picked.includes(o) ? PICKER_TONES[tone] : "hover:bg-muted"
              }`}
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
