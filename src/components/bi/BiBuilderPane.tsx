// Right-hand builder pane of the BI project editor. Two tabs:
//   Build — pick a source, multi-select tables (JOIN skeletons are seeded
//           with auto-detected join keys), write/run SQL, choose a visual
//           via icon picker, configure fields, add/save the widget.
//   AI    — the GenBI analyst (plan → SQL → execute → chart → narrative);
//           insert any answer as a widget.
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AreaChart,
  BadgeCheck,
  BarChart2,
  BarChart3,
  BarChart4,
  BarChartHorizontal,
  CandlestickChart,
  FastForward,
  Flower2,
  Layers,
  Radar,
  Rows3,
  Workflow,
  ChevronRight,
  ChevronsUpDown,
  Filter,
  Flame,
  Gauge,
  Grid3x3,
  Hash,
  LayoutGrid,
  LineChart,
  Loader2,
  Map as MapIcon,
  MapPin,
  Network,
  PieChart,
  Play,
  Plus,
  ScatterChart,
  Send,
  Sparkles,
  Table2,
  Cloud,
  X,
} from "lucide-react";

import { VIZ_REQUIREMENTS } from "@/lib/biVizMeta";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BiChatMessage } from "@/components/data-sql/BiChatMessage";
import { BiChartRender, fmtBiValue } from "@/components/bi/BiChartRender";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { keyFromSource, sourceFromKey, type BiDataContext } from "@/components/bi/biDataContext";
import { OntologyGraph } from "@/components/bi/OntologyGraph";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import {
  runBiTurn,
  type BiCondFormat,
  type BiCondRule,
  type BiDoc,
  type BiTurn,
  type ChartSpec,
} from "@/lib/biAgent";
import type { BiColumnFormat, SavedMetric } from "@/lib/biAgent";
import { COND_COLORS } from "@/lib/biChartMath";
import { snapshotRows, widgetFromBiTurn, type BiWidget } from "@/lib/biDashboards";
import { isAggregatableChart } from "@/lib/biAggregate";
import { buildOntology, type OntologyBuildStage, type OntologySpec } from "@/lib/biOntology";
import { listPrepFlows, parsePrepConfig, prepTables } from "@/lib/dataPrep";
import type { QueryResult } from "@/lib/sqlEngine";

// Common ISO 4217 codes offered in format pickers (any code still works
// via saved specs; Intl validates at render time with a safe fallback).
const CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CNY",
  "INR",
  "AUD",
  "CAD",
  "CHF",
  "BRL",
  "SGD",
  "AED",
];
import { warehouseTablesAsDatasets } from "@/lib/warehouseClient";
import { WAREHOUSE_LABELS } from "@/utils/warehouse/types";

export type BuilderTab = "build" | "ai";

type ChartType = ChartSpec["type"];

const VIZ_TYPES: {
  value: ChartType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "bar", label: "Column", icon: BarChart3 },
  { value: "hbar", label: "Bar", icon: BarChartHorizontal },
  { value: "scolumn", label: "Stacked column", icon: Layers },
  { value: "shbar", label: "Stacked bar", icon: Rows3 },
  { value: "barrace", label: "Bar race", icon: FastForward },
  { value: "line", label: "Line", icon: LineChart },
  { value: "area", label: "Area", icon: AreaChart },
  { value: "combo", label: "Combo", icon: BarChart2 },
  { value: "scatter", label: "Scatter", icon: ScatterChart },
  { value: "pie", label: "Pie", icon: PieChart },
  { value: "nightingale", label: "Nightingale", icon: Flower2 },
  { value: "radar", label: "Radar", icon: Radar },
  { value: "funnel", label: "Funnel", icon: Filter },
  { value: "sankey", label: "Sankey", icon: Workflow },
  { value: "treemap", label: "Treemap", icon: LayoutGrid },
  { value: "wordcloud", label: "Word cloud", icon: Cloud },
  { value: "heatmap", label: "Heatmap", icon: Flame },
  { value: "boxplot", label: "Box plot", icon: CandlestickChart },
  { value: "waterfall", label: "Waterfall", icon: BarChart4 },
  { value: "kpi", label: "KPI", icon: Hash },
  { value: "gauge", label: "Gauge", icon: Gauge },
  { value: "matrix", label: "Matrix", icon: Grid3x3 },
  { value: "map", label: "Map", icon: MapIcon },
  { value: "bubblemap", label: "Bubbles", icon: MapPin },
  { value: "table", label: "Table", icon: Table2 },
  { value: "ontology", label: "Ontology", icon: Network },
];

const ONTO_STAGE_LABEL: Record<OntologyBuildStage, string> = {
  scanning: "Scanning sources…",
  detecting: "Detecting relationships…",
  enriching: "AI is building the ontology…",
};

// ── Ontology source selection ─────────────────────────────────────────────
// Each source group (local datasets, one per warehouse, knowledge bases)
// holds "all" or an explicit set of member names/ids. "all" survives lists
// that haven't loaded yet (warehouse schemas, KB list) — it resolves to the
// full list at build time.

export type SelOrAll = "all" | Set<string>;

type OntoKb = { id: string; name: string; docCount: number; docs: string[] };

export const selHas = (sel: SelOrAll, name: string) => sel === "all" || sel.has(name);

/** Tri-state group checkbox value; `names` is null while the list loads. */
export function groupCheckState(
  sel: SelOrAll | undefined,
  names: string[] | null,
): boolean | "indeterminate" {
  if (!sel) return false;
  if (sel === "all") return true;
  if (sel.size === 0) return false;
  if (!names || names.length === 0) return true;
  const n = names.filter((x) => sel.has(x)).length;
  return n === 0 ? false : n === names.length ? true : "indeterminate";
}

export function toggleName(sel: SelOrAll | undefined, names: string[], name: string): SelOrAll {
  const set = sel === "all" ? new Set(names) : new Set(sel ?? []);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  return set;
}

type SourceTable = { name: string; cols: string[] };

/** A knowledge-base document the analyst can pull unstructured context from. */
type KbDocOption = { id: string; name: string; kbName: string };

/** Per-question cap keeps the excerpt budget meaningful per document. */
const MAX_AI_DOCS = 6;

function detectJoinKey(a: string[], b: string[]): string | null {
  const setB = new Set(b.map((c) => c.toLowerCase()));
  const common = a.filter((c) => setB.has(c.toLowerCase()));
  return (
    common.find((c) => /_id$/i.test(c)) ?? common.find((c) => /^id$/i.test(c)) ?? common[0] ?? null
  );
}

function seedSql(tables: SourceTable[]): string {
  if (tables.length === 0) return "";
  if (tables.length === 1) return `SELECT *\nFROM ${tables[0].name}\nLIMIT 50`;
  const [first, ...rest] = tables;
  const lines = ["SELECT *", `FROM ${first.name}`];
  for (const t of rest) {
    const key = detectJoinKey(first.cols, t.cols);
    lines.push(
      key
        ? `JOIN ${t.name} ON ${first.name}.${key} = ${t.name}.${key}`
        : `JOIN ${t.name} ON ${first.name}.<join_key> = ${t.name}.<join_key>`,
    );
  }
  lines.push("LIMIT 50");
  return lines.join("\n");
}

export function BiBuilderPane({
  ctx,
  tab,
  onTabChange,
  initial,
  onSubmit,
  onInsertAi,
  onClose,
}: {
  ctx: BiDataContext;
  tab: BuilderTab;
  onTabChange: (t: BuilderTab) => void;
  /** Present when editing an existing chart widget (Build tab). */
  initial: BiWidget | null;
  onSubmit: (widget: BiWidget) => void;
  onInsertAi: (widget: BiWidget) => void;
  onClose: () => void;
}) {
  // Shared source across both tabs.
  const [sourceKey, setSourceKey] = useState("local");

  // ── Build tab state ─────────────────────────────────────────────────
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [sql, setSql] = useState("");
  const lastSeeded = useRef("");
  const [title, setTitle] = useState("");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [xField, setXField] = useState("");
  const [yField, setYField] = useState("");
  const [nameField, setNameField] = useState("");
  const [valueField, setValueField] = useState("");
  const [kpiLabel, setKpiLabel] = useState("");
  const [lineField, setLineField] = useState("");
  const [sizeField, setSizeField] = useState("");
  const [rowField, setRowField] = useState("");
  const [rowSubField, setRowSubField] = useState("");
  const [colField, setColField] = useState("");
  const [locationField, setLocationField] = useState("");
  const [targetField, setTargetField] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [seriesField, setSeriesField] = useState("");
  const [stacked, setStacked] = useState(false);
  const [timeField, setTimeField] = useState(""); // bar-race frame column
  const [numFormat, setNumFormat] = useState<"auto" | "currency" | "percent">("auto");
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [decimalsSel, setDecimalsSel] = useState("auto");
  // Table widgets: per-column display formats keyed by column name.
  const [colFormats, setColFormats] = useState<Record<string, BiColumnFormat>>({});
  // Chart analytics (drill / time intelligence / reference line)
  const [drillList, setDrillList] = useState<string[]>([]);
  const [grainSel, setGrainSel] = useState("auto");
  const [compareSel, setCompareSel] = useState("none");
  const [runningB, setRunningB] = useState(false);
  const [trendB, setTrendB] = useState(false);
  const [forecastN, setForecastN] = useState("");
  const [refMode, setRefMode] = useState("none");
  const [matFmtMode, setMatFmtMode] = useState("none");
  const [matScaleColor, setMatScaleColor] = useState("blue");
  const [matRules, setMatRules] = useState<BiCondRule[]>([]);
  const [refValue, setRefValue] = useState("");
  const [refLabel, setRefLabel] = useState("");
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // Incremental refresh: "" = full refresh; otherwise the window in days.
  const [incDays, setIncDays] = useState("");
  const [incColumn, setIncColumn] = useState("");

  // ── Ontology state (chartType === "ontology") ───────────────────────
  // Per-group selections: local tables and knowledge bases default to all,
  // warehouses start excluded (no key) until the user picks them.
  const [ontoLocalSel, setOntoLocalSel] = useState<SelOrAll>("all");
  const [ontoKbSel, setOntoKbSel] = useState<SelOrAll>("all");
  const [ontoWhSel, setOntoWhSel] = useState<Record<string, SelOrAll>>({});
  const [ontoExpanded, setOntoExpanded] = useState<Set<string>>(new Set());
  const [ontoKbList, setOntoKbList] = useState<OntoKb[] | "loading" | "error" | null>(null);
  const kbListPromiseRef = useRef<Promise<OntoKb[]> | null>(null);
  const [ontoSpec, setOntoSpec] = useState<OntologySpec | null>(null);
  const [ontoBuilding, setOntoBuilding] = useState<OntologyBuildStage | null>(null);
  /** Rows fetched per table as AI signal ("0" = schema only). */
  const [ontoSampleRows, setOntoSampleRows] = useState("50");
  /** Optional user SQL whose result is sent to the AI as extra signal. */
  const [ontoSampleSql, setOntoSampleSql] = useState("");
  // Async build reads warehouse schemas through a ref so it sees fresh state.
  const whTablesRef = useRef(ctx.whTables);
  whTablesRef.current = ctx.whTables;

  /** Load the KB list once (deduped) — used by the picker and the build. */
  function ensureOntoKbList(): Promise<OntoKb[]> {
    if (!kbListPromiseRef.current) {
      setOntoKbList((cur) => (Array.isArray(cur) ? cur : "loading"));
      const p = (async () => {
        const [kbsRes, docsRes] = await Promise.all([
          supabase.from("knowledge_bases").select("id, name"),
          supabase.from("knowledge_documents").select("name, knowledge_base_id"),
        ]);
        if (kbsRes.error || docsRes.error) {
          throw new Error((kbsRes.error ?? docsRes.error)!.message);
        }
        const docsByKb = new Map<string, string[]>();
        for (const d of docsRes.data ?? []) {
          const arr = docsByKb.get(d.knowledge_base_id) ?? [];
          arr.push(d.name);
          docsByKb.set(d.knowledge_base_id, arr);
        }
        const list = (kbsRes.data ?? []).map((k) => {
          const docs = docsByKb.get(k.id) ?? [];
          return { id: k.id, name: k.name, docCount: docs.length, docs: docs.slice(0, 30) };
        });
        setOntoKbList(list);
        return list;
      })();
      p.catch(() => {
        setOntoKbList("error");
        kbListPromiseRef.current = null;
      });
      kbListPromiseRef.current = p;
    }
    return kbListPromiseRef.current;
  }

  // Preload the KB list as soon as the ontology panel is shown.
  useEffect(() => {
    if (tab === "build" && chartType === "ontology") void ensureOntoKbList().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, chartType]);

  function toggleOntoExpanded(key: string) {
    setOntoExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const localTableNames = ctx.datasets.map((d) => d.name);
  const kbListArr = Array.isArray(ontoKbList) ? ontoKbList : null;
  const kbIds = kbListArr ? kbListArr.map((k) => k.id) : null;
  const ontoHasSelection =
    ctx.datasets.some((d) => selHas(ontoLocalSel, d.name)) ||
    (ontoKbSel === "all" ? (kbListArr ? kbListArr.length > 0 : true) : ontoKbSel.size > 0) ||
    ctx.warehouses.some((w) => {
      const s = ontoWhSel[w.id];
      return s === "all" || (s instanceof Set && s.size > 0);
    });

  // ── AI tab state ────────────────────────────────────────────────────
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<BiTurn[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [insertedIdx, setInsertedIdx] = useState<Set<number>>(new Set());
  /** Tables the analyst may use; empty = all tables of the source. */
  const [aiTables, setAiTables] = useState<string[]>([]);
  /** Knowledge docs (ids) the analyst cross-references; empty = structured only. */
  const [aiDocs, setAiDocs] = useState<string[]>([]);
  const [kbDocOptions, setKbDocOptions] = useState<KbDocOption[] | "loading" | "error" | null>(
    null,
  );
  const docContentCache = useRef(new Map<string, string>());
  const turnsScrollRef = useRef<HTMLDivElement>(null);

  // Prefill / reset the Build form when the edited widget changes.
  useEffect(() => {
    if (initial) {
      const key = keyFromSource(initial.source);
      setSourceKey(key);
      if (key !== "local") ctx.ensureSchema(key);
      setSql(initial.sql ?? "");
      setTitle(initial.title);
      const c = initial.chart ?? { type: "table" as const };
      setChartType(c.type);
      setXField("xField" in c ? c.xField : "");
      setYField(c.type === "combo" ? c.barField : "yField" in c ? c.yField : "");
      setNameField(c.type === "wordcloud" ? c.textField : "nameField" in c ? c.nameField : "");
      setValueField("valueField" in c ? (c.valueField ?? "") : "");
      setKpiLabel("label" in c ? (c.label ?? "") : "");
      setLineField(c.type === "combo" ? c.lineField : "");
      setSizeField(c.type === "scatter" ? (c.sizeField ?? "") : "");
      setRowField(c.type === "matrix" ? c.rowField : "");
      setRowSubField(c.type === "matrix" ? (c.rowSubField ?? "") : "");
      setColField(c.type === "matrix" ? c.colField : "");
      setLocationField("locationField" in c ? c.locationField : "");
      setTargetField("targetField" in c ? (c.targetField ?? "") : "");
      setMaxInput(c.type === "gauge" && c.max !== undefined ? String(c.max) : "");
      setSeriesField("seriesField" in c ? (c.seriesField ?? "") : "");
      setIncDays(initial.incremental ? String(initial.incremental.days) : "");
      setIncColumn(initial.incremental?.column ?? "");
      setStacked(c.type === "bar" ? Boolean(c.stacked) : false);
      setTimeField(c.type === "barrace" ? c.timeField : "");
      setNumFormat(c.format ?? "auto");
      setCurrencyCode(c.currency ?? "USD");
      setDecimalsSel(c.decimals !== undefined ? String(c.decimals) : "auto");
      setColFormats(c.columnFormats ?? {});
      setOntoSpec(c.type === "ontology" ? c.spec : null);
      setDrillList(c.drillFields ?? []);
      setGrainSel(c.dateGrain ?? "auto");
      setCompareSel(c.compare ?? "none");
      setRunningB(Boolean(c.running));
      setTrendB(Boolean(c.trend));
      setForecastN(c.forecast ? String(c.forecast) : "");
      setRefMode(c.refLine?.mode ?? "none");
      const cf = c.type === "matrix" ? c.condFormat : undefined;
      setMatFmtMode(cf?.mode ?? "none");
      setMatScaleColor(cf?.mode === "scale" ? (cf.color ?? "blue") : "blue");
      setMatRules(cf?.mode === "rules" ? cf.rules : []);
      setRefValue(c.refLine?.value !== undefined ? String(c.refLine.value) : "");
      setRefLabel(c.refLine?.label ?? "");
      setPreview(
        initial.rows && initial.columns
          ? {
              columns: initial.columns,
              rows: initial.rows,
              row_count: initial.rows.length,
              total_matched: initial.rows.length,
              capped: false,
              duration_ms: 0,
            }
          : null,
      );
      onTabChange("build");
    } else {
      setSql("");
      lastSeeded.current = "";
      setTitle("");
      setChartType("bar");
      setXField("");
      setYField("");
      setNameField("");
      setValueField("");
      setKpiLabel("");
      setLineField("");
      setSizeField("");
      setRowField("");
      setColField("");
      setLocationField("");
      setTargetField("");
      setMaxInput("");
      setSeriesField("");
      setStacked(false);
      setTimeField("");
      setNumFormat("auto");
      setCurrencyCode("USD");
      setDecimalsSel("auto");
      setColFormats({});
      setOntoSpec(null);
      setDrillList([]);
      setGrainSel("auto");
      setCompareSel("none");
      setRunningB(false);
      setTrendB(false);
      setForecastN("");
      setRefMode("none");
      setRefValue("");
      setRefLabel("");
      setMatFmtMode("none");
      setMatScaleColor("blue");
      setMatRules([]);
      setPreview(null);
    }
    setSelectedTables([]);
    setRunError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  useEffect(() => {
    turnsScrollRef.current?.scrollTo({
      top: turnsScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  const sourceTables: SourceTable[] = useMemo(() => {
    if (sourceKey === "local") {
      return ctx.datasets.map((d) => ({ name: d.name, cols: d.columns.map((c) => c.name) }));
    }
    const t = ctx.whTables[sourceKey];
    if (!t || t === "loading" || t === "error") return [];
    return t.map((x) => ({
      name: `${x.schema}.${x.name}`,
      cols: x.columns.map((c) => c.name),
    }));
  }, [sourceKey, ctx.datasets, ctx.whTables]);

  const schemaLoading =
    sourceKey !== "local" &&
    (ctx.whTables[sourceKey] === "loading" || ctx.whTables[sourceKey] === undefined);

  function changeSource(v: string) {
    setSourceKey(v);
    setSelectedTables([]);
    setAiTables([]);
    setPreview(null);
    if (sql === lastSeeded.current) {
      setSql("");
      lastSeeded.current = "";
    }
    if (v !== "local") ctx.ensureSchema(v);
  }

  function toggleTable(name: string) {
    const next = selectedTables.includes(name)
      ? selectedTables.filter((t) => t !== name)
      : [...selectedTables, name];
    setSelectedTables(next);
    // Only auto-write the query while the user hasn't typed their own SQL.
    if (!sql.trim() || sql === lastSeeded.current) {
      const seeded = seedSql(
        next
          .map((n) => sourceTables.find((t) => t.name === n))
          .filter((t): t is SourceTable => Boolean(t)),
      );
      setSql(seeded);
      lastSeeded.current = seeded;
    }
  }

  /** Certified metric quick-insert: seed a runnable query and preview it. */
  function insertMetric(m: SavedMetric) {
    const table =
      ctx.datasets.find((d) => d.id === m.table_id)?.name ??
      selectedTables[0] ??
      ctx.datasets[0]?.name;
    if (!table) return;
    const q = `SELECT ${m.sql_expression} AS \`${m.name}\` FROM \`${table}\``;
    setSql(q);
    lastSeeded.current = q;
    if (!title.trim()) setTitle(m.name);
    void runPreview(q);
  }

  async function runPreview(overrideSql?: string) {
    const q = (overrideSql ?? sql).trim();
    if (!q) return;
    setRunning(true);
    setRunError(null);
    try {
      const res = await ctx.runSql(sourceFromKey(sourceKey, ctx.warehouses), q);
      setPreview(res);
      const firstString =
        res.columns.find((c) => typeof res.rows[0]?.[c] === "string") ?? res.columns[0] ?? "";
      const firstNumber =
        res.columns.find((c) => typeof res.rows[0]?.[c] === "number") ??
        res.columns[1] ??
        res.columns[0] ??
        "";
      if (!xField || !res.columns.includes(xField)) setXField(firstString);
      if (!yField || !res.columns.includes(yField)) setYField(firstNumber);
      if (!nameField || !res.columns.includes(nameField)) setNameField(firstString);
      if (!valueField || !res.columns.includes(valueField)) setValueField(firstNumber);
      const numericCols = res.columns.filter((c) => typeof res.rows[0]?.[c] === "number");
      const stringCols = res.columns.filter((c) => typeof res.rows[0]?.[c] === "string");
      if (!lineField || !res.columns.includes(lineField)) {
        setLineField(numericCols.find((c) => c !== firstNumber) ?? firstNumber);
      }
      if (!locationField || !res.columns.includes(locationField)) setLocationField(firstString);
      if (!rowField || !res.columns.includes(rowField)) setRowField(firstString);
      if (!colField || !res.columns.includes(colField)) {
        setColField(stringCols.find((c) => c !== firstString) ?? firstString);
      }
      if (res.row_count === 1 && res.columns.length === 1 && !initial) setChartType("kpi");
    } catch (e) {
      setPreview(null);
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  // Build the full data-estate map: wait for selected warehouse schemas,
  // load knowledge bases + prep-flow lineage, then run the ontology
  // pipeline (deterministic detection + AI enrichment).
  async function buildOntologyNow() {
    if (ontoBuilding) return;
    setOntoBuilding("scanning");
    try {
      const localDatasets = ctx.datasets.filter((d) => selHas(ontoLocalSel, d.name));

      const whIds = ctx.warehouses
        .map((w) => w.id)
        .filter((id) => {
          const s = ontoWhSel[id];
          return s === "all" || (s instanceof Set && s.size > 0);
        });
      for (const id of whIds) ctx.ensureSchema(id);
      const deadline = Date.now() + 25_000;
      const pending = () =>
        whIds.filter((id) => {
          const t = whTablesRef.current[id];
          return t === undefined || t === "loading";
        });
      while (pending().length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
      }
      const notLoaded = whIds.filter((id) => !Array.isArray(whTablesRef.current[id]));
      if (notLoaded.length > 0) {
        toast.warning("Some warehouse schemas didn't load in time — they were skipped.");
      }
      const whInputs = whIds.flatMap((id) => {
        const tables = whTablesRef.current[id];
        if (!Array.isArray(tables)) return [];
        const sel = ontoWhSel[id];
        const chosen = tables.filter((t) => selHas(sel, `${t.schema}.${t.name}`));
        if (chosen.length === 0) return [];
        const conn = ctx.warehouses.find((w) => w.id === id);
        return [{ id, name: conn?.name ?? "warehouse", tables: chosen }];
      });

      // Real data for the AI: the chosen number of rows per local table…
      const sampleLimit = Math.max(0, Math.min(200, Number(ontoSampleRows) || 0));
      const tableSamples = new Map<string, Record<string, unknown>[]>();
      if (sampleLimit > 0) {
        for (const d of localDatasets.slice(0, 12)) {
          try {
            const res = await ctx.runSql(
              { kind: "local" },
              `SELECT * FROM \`${d.name}\` LIMIT ${sampleLimit}`,
            );
            if (res.rows.length > 0) tableSamples.set(d.name, res.rows);
          } catch {
            /* samples are AI signal only — skip tables that fail */
          }
        }
      }

      // …plus the user's custom query, when provided.
      let customSample: { sql: string; rows: Record<string, unknown>[] } | undefined;
      if (ontoSampleSql.trim()) {
        try {
          const res = await ctx.runSql({ kind: "local" }, ontoSampleSql.trim());
          if (res.rows.length > 0) {
            customSample = { sql: ontoSampleSql.trim(), rows: res.rows.slice(0, 200) };
          } else {
            toast.warning("The custom sample query returned no rows — it was skipped.");
          }
        } catch (e) {
          toast.warning(`Custom sample query failed (${(e as Error).message}) — it was skipped.`);
        }
      }

      // …and content excerpts from the selected knowledge bases' documents.
      type OntoKbInput = OntoKb & {
        docExcerpts?: { name: string; excerpt: string }[];
        graph?: {
          entities: { name: string; type: string; description?: string; mentions: number }[];
          triples: { subject: string; predicate: string; object: string }[];
        };
      };
      let knowledgeBases: OntoKbInput[] = [];
      if (ontoKbSel === "all" || ontoKbSel.size > 0) {
        try {
          const list = await ensureOntoKbList();
          knowledgeBases = list.filter((k) => selHas(ontoKbSel, k.id));
          if (knowledgeBases.length > 0) {
            const kbIds = knowledgeBases.map((k) => k.id);
            const [{ data }, { data: gEnts }, { data: gRels }] = await Promise.all([
              supabase
                .from("knowledge_documents")
                .select("name, knowledge_base_id, content")
                .in("knowledge_base_id", kbIds)
                .not("content", "is", null)
                .limit(60),
              // The KB's knowledge graph (Knowledge → Graph), when built:
              // its entities become concept nodes, its subject–predicate–
              // object triples become typed edges in the ontology.
              supabase
                .from("kb_graph_entities")
                .select("id, name, type, description, mention_count, knowledge_base_id")
                .in("knowledge_base_id", kbIds)
                .order("mention_count", { ascending: false })
                .limit(200),
              supabase
                .from("kb_graph_relations")
                .select("source_entity_id, target_entity_id, predicate, knowledge_base_id")
                .in("knowledge_base_id", kbIds)
                .limit(600),
            ]);
            const byKb = new Map<string, { name: string; excerpt: string }[]>();
            for (const doc of data ?? []) {
              const excerpt = (doc.content ?? "").trim().slice(0, 600);
              if (!excerpt) continue;
              const arr = byKb.get(doc.knowledge_base_id) ?? [];
              if (arr.length < 6) arr.push({ name: doc.name, excerpt });
              byKb.set(doc.knowledge_base_id, arr);
            }
            const entName = new Map<string, string>();
            const graphByKb = new Map<string, NonNullable<OntoKbInput["graph"]>>();
            for (const ge of gEnts ?? []) {
              entName.set(ge.id, ge.name);
              const g = graphByKb.get(ge.knowledge_base_id) ?? { entities: [], triples: [] };
              g.entities.push({
                name: ge.name,
                type: ge.type,
                description: ge.description ?? undefined,
                mentions: ge.mention_count ?? 0,
              });
              graphByKb.set(ge.knowledge_base_id, g);
            }
            for (const gr of gRels ?? []) {
              const subject = entName.get(gr.source_entity_id);
              const object = entName.get(gr.target_entity_id);
              if (!subject || !object || !gr.predicate) continue;
              graphByKb
                .get(gr.knowledge_base_id)
                ?.triples.push({ subject, predicate: gr.predicate, object });
            }
            knowledgeBases = knowledgeBases.map((k) => ({
              ...k,
              docExcerpts: byKb.get(k.id) ?? [],
              graph: graphByKb.get(k.id),
            }));
          }
        } catch {
          toast.warning("Couldn't load the knowledge bases — they were skipped.");
        }
      }

      let prepFlows: { name: string; outputTable: string | null; sources: string[] }[] = [];
      if (localDatasets.length > 0) {
        try {
          prepFlows = (await listPrepFlows()).map((f) => ({
            name: f.name,
            outputTable: f.output_table_name,
            sources: prepTables(parsePrepConfig(f.config)),
          }));
        } catch {
          /* lineage is an enhancement — the ontology works without it */
        }
      }

      const spec = await buildOntology({
        inputs: {
          datasets: localDatasets,
          semantics: ctx.semantics,
          preparedTables: ctx.preparedTables ?? new Set(),
          warehouses: whInputs,
          knowledgeBases,
          prepFlows,
          tableSamples,
          customSample,
        },
        model: ctx.model ?? undefined,
        onProgress: setOntoBuilding,
      });
      setOntoSpec(spec);
      if (!title.trim()) setTitle("Data ontology");
      if (!spec.aiEnriched) {
        toast.warning("AI enrichment failed — showing the detected structure instead.");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOntoBuilding(null);
    }
  }

  const chartSpec: ChartSpec | null = useMemo(() => {
    const format = numFormat === "auto" ? undefined : numFormat;
    const spec = ((): ChartSpec | null => {
      switch (chartType) {
        case "table":
          return { type: "table" };
        case "ontology":
          return ontoSpec ? { type: "ontology", spec: ontoSpec } : null;
        case "kpi":
          return valueField
            ? {
                type: "kpi",
                valueField,
                label: kpiLabel || undefined,
                targetField: targetField || undefined,
              }
            : null;
        case "gauge": {
          const max = maxInput.trim() ? Number(maxInput) : undefined;
          return valueField
            ? {
                type: "gauge",
                valueField,
                label: kpiLabel || undefined,
                targetField: targetField || undefined,
                max: max !== undefined && Number.isFinite(max) ? max : undefined,
              }
            : null;
        }
        case "pie":
        case "funnel":
        case "treemap":
        case "nightingale":
          return nameField && valueField ? { type: chartType, nameField, valueField } : null;
        case "wordcloud":
          // textField reuses the dimension picker (nameField); the measure is optional.
          return nameField
            ? { type: "wordcloud", textField: nameField, valueField: valueField || undefined }
            : null;
        case "combo":
          return xField && yField && lineField
            ? { type: "combo", xField, barField: yField, lineField }
            : null;
        case "scatter":
          return xField && yField
            ? { type: "scatter", xField, yField, sizeField: sizeField || undefined }
            : null;
        case "heatmap":
          return xField && yField && valueField
            ? { type: "heatmap", xField, yField, valueField }
            : null;
        case "matrix": {
          if (!(rowField && colField && valueField)) return null;
          let condFormat: BiCondFormat | undefined;
          if (matFmtMode === "scale") condFormat = { mode: "scale", color: matScaleColor };
          else if (matFmtMode === "rules") {
            const rules = matRules.filter((r) => Number.isFinite(r.value));
            if (rules.length > 0) condFormat = { mode: "rules", rules };
          }
          return {
            type: "matrix",
            rowField,
            colField,
            valueField,
            rowSubField: rowSubField && rowSubField !== rowField ? rowSubField : undefined,
            condFormat,
          };
        }
        case "map":
        case "bubblemap":
          return locationField && valueField
            ? { type: chartType, locationField, valueField }
            : null;
        case "bar":
          return xField && yField
            ? {
                type: "bar",
                xField,
                yField,
                seriesField: seriesField || undefined,
                stacked: seriesField && stacked ? true : undefined,
              }
            : null;
        case "line":
        case "area":
          return xField && yField
            ? { type: chartType, xField, yField, seriesField: seriesField || undefined }
            : null;
        case "scolumn":
        case "shbar":
          return xField && yField && seriesField
            ? { type: chartType, xField, yField, seriesField }
            : null;
        case "radar":
          return xField && yField
            ? { type: "radar", xField, yField, seriesField: seriesField || undefined }
            : null;
        case "barrace":
          return xField && yField && timeField
            ? { type: "barrace", xField, yField, timeField }
            : null;
        case "sankey":
          return xField && yField && valueField
            ? { type: "sankey", xField, yField, valueField }
            : null;
        default:
          return xField && yField ? { type: chartType, xField, yField } : null;
      }
    })();
    if (!spec) return null;
    // Analytics options (each renderer applies what it supports).
    const analytics: Partial<ChartSpec> = {};
    if (
      (spec.type === "bar" ||
        spec.type === "hbar" ||
        spec.type === "pie" ||
        spec.type === "treemap") &&
      drillList.length > 1
    ) {
      analytics.drillFields = drillList;
    }
    if (spec.type === "line" || spec.type === "area") {
      if (grainSel !== "auto") analytics.dateGrain = grainSel as ChartSpec["dateGrain"];
      // Running total / compare / trend / forecast are single-series only — the
      // renderer skips them once the data is pivoted by a series split, so we
      // also drop them from the spec to keep it honest.
      if (!seriesField) {
        if (compareSel !== "none") analytics.compare = compareSel as ChartSpec["compare"];
        if (runningB) analytics.running = true;
        if (spec.type === "line") {
          if (trendB) analytics.trend = true;
          const f = Number(forecastN);
          if (forecastN.trim() && Number.isFinite(f) && f > 0) {
            analytics.forecast = Math.min(24, Math.round(f));
          }
        }
      }
    }
    if (
      refMode !== "none" &&
      (spec.type === "bar" || spec.type === "line" || spec.type === "area")
    ) {
      const rv = Number(refValue);
      if (refMode === "avg") analytics.refLine = { mode: "avg", label: refLabel || undefined };
      else if (refValue.trim() && Number.isFinite(rv)) {
        analytics.refLine = { mode: "value", value: rv, label: refLabel || undefined };
      }
    }
    // Display formatting (locale-aware; see fmtBiValue).
    if (format === "currency" && currencyCode && currencyCode !== "USD") {
      analytics.currency = currencyCode;
    }
    if (decimalsSel !== "auto" && Number.isFinite(Number(decimalsSel))) {
      analytics.decimals = Number(decimalsSel);
    }
    if (spec.type === "table" && Object.keys(colFormats).length > 0) {
      analytics.columnFormats = colFormats;
    }
    // Safe: spec is a valid member and analytics only adds wrapper fields.
    return { ...spec, format, ...analytics } as ChartSpec;
  }, [
    chartType,
    xField,
    yField,
    nameField,
    valueField,
    kpiLabel,
    lineField,
    sizeField,
    rowField,
    rowSubField,
    colField,
    locationField,
    targetField,
    maxInput,
    seriesField,
    stacked,
    timeField,
    numFormat,
    currencyCode,
    decimalsSel,
    colFormats,
    ontoSpec,
    drillList,
    grainSel,
    compareSel,
    runningB,
    trendB,
    forecastN,
    refMode,
    refValue,
    refLabel,
    matFmtMode,
    matScaleColor,
    matRules,
  ]);

  // Columns whose sampled values parse as dates — the only valid incremental
  // keys. Sampled from the preview so the offer matches this query's shape.
  const dateColumns = useMemo(() => {
    if (!preview || preview.rows.length === 0) return [] as string[];
    const sample = preview.rows.slice(0, 25);
    return preview.columns.filter((c) => {
      const vals = sample.map((r) => r[c]).filter((v) => v !== null && v !== undefined);
      if (vals.length === 0) return false;
      return vals.every((v) => {
        if (typeof v === "number") return false; // plain numbers are not dates
        const t = Date.parse(String(v));
        return Number.isFinite(t);
      });
    });
  }, [preview]);

  const canSubmit =
    chartType === "ontology"
      ? Boolean(title.trim() && chartSpec)
      : Boolean(title.trim() && sql.trim() && preview && chartSpec);

  function submit() {
    if (!canSubmit || !chartSpec) return;
    if (chartType === "ontology") {
      // The whole map lives in the chart spec — no SQL, no row snapshot.
      onSubmit({
        id: initial?.id ?? crypto.randomUUID(),
        kind: "chart",
        title: title.trim(),
        source: { kind: "local" },
        chart: chartSpec,
        columns: [],
        rows: [],
        refreshed_at: new Date().toISOString(),
      });
      toast.success(initial ? "Widget updated" : "Widget added to the dashboard");
      return;
    }
    if (!preview) return;
    onSubmit({
      id: initial?.id ?? crypto.randomUUID(),
      kind: "chart",
      title: title.trim(),
      source: sourceFromKey(sourceKey, ctx.warehouses),
      sql: sql.trim(),
      chart: chartSpec,
      columns: preview.columns,
      rows: snapshotRows(preview.rows),
      narrative: initial?.narrative,
      // New widgets aggregate in SQL by default so their totals are complete
      // regardless of table size. An EXISTING widget keeps whatever it had:
      // turning this on can change the number it shows (that number was a
      // partial sum), and that is the owner's call to make, not a side effect
      // of opening the editor.
      agg_pushdown: initial ? initial.agg_pushdown : isAggregatableChart(chartSpec),
      incremental:
        incColumn && Number(incDays) >= 1
          ? { column: incColumn, days: Number(incDays) }
          : undefined,
      refreshed_at: new Date().toISOString(),
    });
    toast.success(initial ? "Widget updated" : "Widget added to the dashboard");
  }

  // ── AI analyst ──────────────────────────────────────────────────────
  const activeWarehouse =
    sourceKey !== "local" ? (ctx.warehouses.find((w) => w.id === sourceKey) ?? null) : null;

  const aiDatasets = useMemo(() => {
    if (!activeWarehouse) return ctx.datasets;
    const tables = ctx.whTables[activeWarehouse.id];
    if (!tables || tables === "loading" || tables === "error") return [];
    return warehouseTablesAsDatasets(activeWarehouse.id, tables, ctx.userId);
  }, [activeWarehouse, ctx.datasets, ctx.whTables, ctx.userId]);

  // List content-bearing KB documents the caller can read (own + shared +
  // samples — RLS decides). Loaded lazily when the picker first opens.
  async function loadKbDocs() {
    if (kbDocOptions !== null && kbDocOptions !== "error") return;
    setKbDocOptions("loading");
    try {
      const [kbsRes, docsRes] = await Promise.all([
        supabase.from("knowledge_bases").select("id, name"),
        supabase
          .from("knowledge_documents")
          .select("id, name, knowledge_base_id")
          .not("content", "is", null)
          .neq("content", "")
          .order("name"),
      ]);
      if (kbsRes.error || docsRes.error) {
        throw new Error((kbsRes.error ?? docsRes.error)!.message);
      }
      const kbName = new Map((kbsRes.data ?? []).map((k) => [k.id, k.name]));
      setKbDocOptions(
        (docsRes.data ?? []).map((d) => ({
          id: d.id,
          name: d.name,
          kbName: kbName.get(d.knowledge_base_id) ?? "Knowledge Base",
        })),
      );
    } catch {
      setKbDocOptions("error");
    }
  }

  const docGroups = useMemo(() => {
    if (!Array.isArray(kbDocOptions)) return [];
    const groups = new Map<string, KbDocOption[]>();
    for (const d of kbDocOptions) {
      const arr = groups.get(d.kbName) ?? [];
      arr.push(d);
      groups.set(d.kbName, arr);
    }
    return Array.from(groups.entries());
  }, [kbDocOptions]);

  /** Fetch (and cache) the content of the selected docs; undefined = none usable. */
  async function loadSelectedDocs(): Promise<BiDoc[] | undefined> {
    if (aiDocs.length === 0 || !Array.isArray(kbDocOptions)) return undefined;
    const missing = aiDocs.filter((id) => !docContentCache.current.has(id));
    if (missing.length > 0) {
      const { data, error } = await supabase
        .from("knowledge_documents")
        .select("id, content")
        .in("id", missing);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) docContentCache.current.set(row.id, row.content ?? "");
    }
    const docs = aiDocs.flatMap((id): BiDoc[] => {
      const opt = kbDocOptions.find((o) => o.id === id);
      const content = (docContentCache.current.get(id) ?? "").trim();
      return opt && content ? [{ id, name: opt.name, kbName: opt.kbName, content }] : [];
    });
    return docs.length > 0 ? docs : undefined;
  }

  async function sendQuestion() {
    const q = question.trim();
    if (!q || aiBusy) return;
    if (aiDatasets.length === 0) {
      toast.error(
        activeWarehouse
          ? "The warehouse schema hasn't loaded yet."
          : "No local datasets — upload data on the Data & SQL page first.",
      );
      return;
    }
    // Scope the analyst to the picked tables (empty selection = all).
    const scoped =
      aiTables.length > 0 ? aiDatasets.filter((d) => aiTables.includes(d.name)) : aiDatasets;
    const datasetsToUse = scoped.length > 0 ? scoped : aiDatasets;
    setQuestion("");
    setAiBusy(true);
    setTurns((prev) => [...prev, { question: q, status: "planning" }]);
    // Docs are additive context — if they can't be loaded, warn and continue
    // with structured data alone rather than failing the whole question.
    let documents: BiDoc[] | undefined;
    if (aiDocs.length > 0) {
      try {
        documents = await loadSelectedDocs();
        if (!documents) {
          toast.warning(
            "The selected documents have no readable text — analysing structured data only.",
          );
        }
      } catch (e) {
        toast.warning(
          `Couldn't load the selected documents (${(e as Error).message}) — analysing structured data only.`,
        );
      }
    }
    try {
      await runBiTurn({
        question: q,
        datasets: datasetsToUse,
        semantics: activeWarehouse ? new Map() : ctx.semantics,
        metrics: activeWarehouse ? [] : ctx.metrics,
        documents,
        execute: activeWarehouse
          ? (generated) => ctx.runSql(sourceFromKey(activeWarehouse.id, ctx.warehouses), generated)
          : undefined,
        dialect: activeWarehouse ? WAREHOUSE_LABELS[activeWarehouse.provider] : undefined,
        model: ctx.model ?? undefined,
        onUpdate: (turn) => {
          setTurns((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = turn;
            return copy;
          });
        },
      });
    } finally {
      setAiBusy(false);
    }
  }

  function insertTurn(turn: BiTurn, idx: number) {
    const widget = widgetFromBiTurn(turn, sourceFromKey(sourceKey, ctx.warehouses));
    if (!widget) return toast.error("This answer has no result to insert");
    onInsertAi(widget);
    setInsertedIdx((prev) => new Set(prev).add(idx));
    toast.success("Widget inserted into the dashboard");
  }

  const fieldSelect = (label: string, value: string, setter: (v: string) => void) => (
    <div className="space-y-1">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <Select value={value || undefined} onValueChange={setter}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue placeholder="Pick a column" />
        </SelectTrigger>
        <SelectContent>
          {(preview?.columns ?? []).map((c) => (
            <SelectItem key={c} value={c} className="text-xs">
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const optionalFieldSelect = (label: string, value: string, setter: (v: string) => void) => (
    <div className="space-y-1">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <Select value={value || "__none__"} onValueChange={(v) => setter(v === "__none__" ? "" : v)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__" className="text-xs">
            None
          </SelectItem>
          {(preview?.columns ?? []).map((c) => (
            <SelectItem key={c} value={c} className="text-xs">
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const formatSelect = (
    <div
      className="space-y-1"
      title="How numeric values are displayed on axes, tooltips, KPI and gauge figures"
    >
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Value format
      </Label>
      <Select value={numFormat} onValueChange={(v) => setNumFormat(v as typeof numFormat)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto" className="text-xs">
            Auto — 1234 → 1.2k
          </SelectItem>
          <SelectItem value="currency" className="text-xs">
            Currency — 1234 → $1.2k
          </SelectItem>
          <SelectItem value="percent" className="text-xs">
            Percent — 12.3 → 12.3%
          </SelectItem>
        </SelectContent>
      </Select>
      {(numFormat === "currency" || numFormat === "percent") && (
        <div className="flex gap-1.5">
          {numFormat === "currency" && (
            <Select value={currencyCode} onValueChange={setCurrencyCode}>
              <SelectTrigger className="h-7 flex-1 text-[11px]" title="Currency (ISO 4217)">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCY_CODES.map((c) => (
                  <SelectItem key={c} value={c} className="text-xs">
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={decimalsSel} onValueChange={setDecimalsSel}>
            <SelectTrigger className="h-7 flex-1 text-[11px]" title="Fixed decimal places">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto" className="text-xs">
                Auto decimals
              </SelectItem>
              {["0", "1", "2", "3"].map((d) => (
                <SelectItem key={d} value={d} className="text-xs">
                  {d} decimals
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground">
        Formats follow each viewer's locale (separators & symbols).
      </p>
    </div>
  );

  // Table widgets: per-column format editor over the preview's columns.
  const columnFormatEditor =
    chartType === "table" && (preview?.columns ?? []).length > 0 ? (
      <div className="space-y-1">
        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Column formats
        </Label>
        <div className="space-y-1">
          {(preview?.columns ?? []).map((c) => {
            const cf = colFormats[c] ?? {};
            const val = cf.format ?? "auto";
            return (
              <div key={c} className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px]" title={c}>
                  {c}
                </span>
                <Select
                  value={val}
                  onValueChange={(v) =>
                    setColFormats((prev) => {
                      const next = { ...prev };
                      if (v === "auto") delete next[c];
                      else next[c] = { ...next[c], format: v as BiColumnFormat["format"] };
                      return next;
                    })
                  }
                >
                  <SelectTrigger className="h-7 w-24 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" className="text-xs">
                      Auto
                    </SelectItem>
                    <SelectItem value="number" className="text-xs">
                      Number
                    </SelectItem>
                    <SelectItem value="currency" className="text-xs">
                      Currency
                    </SelectItem>
                    <SelectItem value="percent" className="text-xs">
                      Percent
                    </SelectItem>
                  </SelectContent>
                </Select>
                {cf.format === "currency" && (
                  <Select
                    value={cf.currency ?? "USD"}
                    onValueChange={(v) =>
                      setColFormats((prev) => ({ ...prev, [c]: { ...prev[c], currency: v } }))
                    }
                  >
                    <SelectTrigger className="h-7 w-20 text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCY_CODES.map((cc) => (
                        <SelectItem key={cc} value={cc} className="text-xs">
                          {cc}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            );
          })}
        </div>
      </div>
    ) : null;

  const sourceSelect = (
    <div className="space-y-1.5">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Data source
      </Label>
      <Select value={sourceKey} onValueChange={changeSource}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="local" className="text-xs">
            Local datasets (Data &amp; SQL)
          </SelectItem>
          {ctx.warehouses.map((w) => (
            <SelectItem key={w.id} value={w.id} className="text-xs">
              {w.name} — {WAREHOUSE_LABELS[w.provider]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="flex w-[420px] shrink-0 flex-col border-l border-border bg-background">
      {/* Header + tab switch */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex flex-1 rounded-md bg-muted p-0.5">
          <button
            type="button"
            className={cn(
              "flex-1 rounded px-2 py-1 text-xs font-medium transition",
              tab === "build"
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onTabChange("build")}
          >
            Build a chart
          </button>
          <button
            type="button"
            className={cn(
              "flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-xs font-medium transition",
              tab === "ai"
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onTabChange("ai")}
          >
            <Sparkles className="h-3 w-3 text-primary" /> AI analyst
          </button>
        </div>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose} title="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {tab === "build" ? (
        <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {initial && (
              <Badge variant="secondary" className="text-[10px]">
                Editing “{initial.title}”
              </Badge>
            )}

            {/* Visualization — icon picker */}
            <div className="space-y-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Visualisation
              </Label>
              <TooltipProvider>
                <div className="grid grid-cols-3 gap-1.5">
                  {VIZ_TYPES.map((v) => {
                    const req = VIZ_REQUIREMENTS[v.value];
                    const btn = (
                      <button
                        key={v.value}
                        type="button"
                        onClick={() => setChartType(v.value)}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-[10px] font-medium transition",
                          chartType === v.value
                            ? "border-primary bg-primary/10 text-primary shadow-sm"
                            : "border-border/60 text-muted-foreground hover:border-primary/40 hover:bg-muted/50 hover:text-foreground",
                        )}
                      >
                        <v.icon className="h-5 w-5" />
                        {v.label}
                      </button>
                    );
                    if (!req) return btn;
                    return (
                      <Tooltip key={v.value} delayDuration={200}>
                        <TooltipTrigger asChild>{btn}</TooltipTrigger>
                        <TooltipContent
                          side="top"
                          className="max-w-[240px] border border-border bg-popover text-popover-foreground shadow-md"
                        >
                          <p className="text-xs font-semibold text-foreground">{v.label}</p>
                          <p className="mt-0.5 text-xs text-foreground/90">{req.requires}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{req.how}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </TooltipProvider>
            </div>

            {chartType === "ontology" ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[11px] leading-snug text-muted-foreground">
                  A high-level map of your whole data estate and how it relates. Expand a source to
                  pick individual tables or knowledge bases; the AI classifies entities into
                  business domains, labels each relationship and writes a summary.
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Sources to include
                  </Label>
                  <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-md border border-border/60 p-1.5">
                    {/* Local & prepared datasets */}
                    <div>
                      <div className="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60">
                        <button
                          type="button"
                          className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
                          onClick={() => toggleOntoExpanded("local")}
                          title="Choose tables"
                        >
                          <ChevronRight
                            className={cn(
                              "h-3 w-3 transition-transform",
                              ontoExpanded.has("local") && "rotate-90",
                            )}
                          />
                        </button>
                        <Label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[11px] font-normal">
                          <Checkbox
                            checked={groupCheckState(ontoLocalSel, localTableNames)}
                            onCheckedChange={() =>
                              setOntoLocalSel(
                                groupCheckState(ontoLocalSel, localTableNames) === true
                                  ? new Set()
                                  : "all",
                              )
                            }
                          />
                          <span className="truncate">Local &amp; prepared datasets</span>
                          <span className="ml-auto shrink-0 text-[9px] tabular-nums text-muted-foreground">
                            {ctx.datasets.filter((d) => selHas(ontoLocalSel, d.name)).length}/
                            {ctx.datasets.length} tables
                          </span>
                        </Label>
                      </div>
                      {ontoExpanded.has("local") && (
                        <div className="ml-4 space-y-0.5 border-l border-border/40 pl-2">
                          {ctx.datasets.length === 0 && (
                            <p className="px-1 py-1 text-[10px] text-muted-foreground">
                              No local datasets — upload data on the Data &amp; SQL page.
                            </p>
                          )}
                          {ctx.datasets.map((d) => (
                            <Label
                              key={d.name}
                              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 font-mono text-[10px] font-normal hover:bg-muted/60"
                            >
                              <Checkbox
                                checked={selHas(ontoLocalSel, d.name)}
                                onCheckedChange={() =>
                                  setOntoLocalSel((s) => toggleName(s, localTableNames, d.name))
                                }
                              />
                              <span className="truncate">{d.name}</span>
                              {ctx.preparedTables?.has(d.name) && (
                                <Badge variant="secondary" className="shrink-0 px-1 text-[9px]">
                                  prep
                                </Badge>
                              )}
                            </Label>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Warehouses — schemas load on expand/select */}
                    {ctx.warehouses.map((w) => {
                      const t = ctx.whTables[w.id];
                      const names = Array.isArray(t) ? t.map((x) => `${x.schema}.${x.name}`) : null;
                      const sel = ontoWhSel[w.id];
                      const st = groupCheckState(sel, names);
                      return (
                        <div key={w.id}>
                          <div className="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60">
                            <button
                              type="button"
                              className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
                              onClick={() => {
                                ctx.ensureSchema(w.id);
                                toggleOntoExpanded(w.id);
                              }}
                              title="Choose tables"
                            >
                              <ChevronRight
                                className={cn(
                                  "h-3 w-3 transition-transform",
                                  ontoExpanded.has(w.id) && "rotate-90",
                                )}
                              />
                            </button>
                            <Label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[11px] font-normal">
                              <Checkbox
                                checked={st}
                                onCheckedChange={() => {
                                  if (st === true) {
                                    setOntoWhSel((prev) => {
                                      const next = { ...prev };
                                      delete next[w.id];
                                      return next;
                                    });
                                  } else {
                                    ctx.ensureSchema(w.id);
                                    setOntoWhSel((prev) => ({ ...prev, [w.id]: "all" }));
                                  }
                                }}
                              />
                              <span className="truncate">
                                {w.name} — {WAREHOUSE_LABELS[w.provider]}
                              </span>
                              {names && (
                                <span className="ml-auto shrink-0 text-[9px] tabular-nums text-muted-foreground">
                                  {names.filter((n) => (sel ? selHas(sel, n) : false)).length}/
                                  {names.length} tables
                                </span>
                              )}
                              {sel && (t === undefined || t === "loading") && (
                                <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                              )}
                            </Label>
                          </div>
                          {ontoExpanded.has(w.id) && (
                            <div className="ml-4 space-y-0.5 border-l border-border/40 pl-2">
                              {t === "error" && (
                                <p className="px-1 py-1 text-[10px] text-destructive">
                                  Couldn't load this warehouse's schema.
                                </p>
                              )}
                              {(t === undefined || t === "loading") && (
                                <p className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
                                  <Loader2 className="h-3 w-3 animate-spin" /> Loading schema…
                                </p>
                              )}
                              {names?.map((n) => (
                                <Label
                                  key={n}
                                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 font-mono text-[10px] font-normal hover:bg-muted/60"
                                >
                                  <Checkbox
                                    checked={sel ? selHas(sel, n) : false}
                                    onCheckedChange={() =>
                                      setOntoWhSel((prev) => ({
                                        ...prev,
                                        [w.id]: toggleName(prev[w.id], names, n),
                                      }))
                                    }
                                  />
                                  <span className="truncate">{n}</span>
                                </Label>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Knowledge bases */}
                    <div>
                      <div className="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60">
                        <button
                          type="button"
                          className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
                          onClick={() => {
                            void ensureOntoKbList().catch(() => {});
                            toggleOntoExpanded("kb");
                          }}
                          title="Choose knowledge bases"
                        >
                          <ChevronRight
                            className={cn(
                              "h-3 w-3 transition-transform",
                              ontoExpanded.has("kb") && "rotate-90",
                            )}
                          />
                        </button>
                        <Label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[11px] font-normal">
                          <Checkbox
                            checked={groupCheckState(ontoKbSel, kbIds)}
                            onCheckedChange={() =>
                              setOntoKbSel(
                                groupCheckState(ontoKbSel, kbIds) === true ? new Set() : "all",
                              )
                            }
                          />
                          <span className="truncate">Knowledge bases</span>
                          {kbListArr && (
                            <span className="ml-auto shrink-0 text-[9px] tabular-nums text-muted-foreground">
                              {kbListArr.filter((k) => selHas(ontoKbSel, k.id)).length}/
                              {kbListArr.length}
                            </span>
                          )}
                        </Label>
                      </div>
                      {ontoExpanded.has("kb") && (
                        <div className="ml-4 space-y-0.5 border-l border-border/40 pl-2">
                          {ontoKbList === "loading" && (
                            <p className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" /> Loading knowledge bases…
                            </p>
                          )}
                          {ontoKbList === "error" && (
                            <p className="px-1 py-1 text-[10px] text-destructive">
                              Couldn't load your knowledge bases — collapse and expand to retry.
                            </p>
                          )}
                          {kbListArr && kbListArr.length === 0 && (
                            <p className="px-1 py-1 text-[10px] text-muted-foreground">
                              No knowledge bases yet — create one on the Knowledge page.
                            </p>
                          )}
                          {kbListArr?.map((k) => (
                            <Label
                              key={k.id}
                              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[10px] font-normal hover:bg-muted/60"
                            >
                              <Checkbox
                                checked={selHas(ontoKbSel, k.id)}
                                onCheckedChange={() =>
                                  setOntoKbSel((s) => toggleName(s, kbIds ?? [], k.id))
                                }
                              />
                              <span className="truncate">{k.name}</span>
                              <span className="ml-auto shrink-0 text-[9px] tabular-nums text-muted-foreground">
                                {k.docCount} docs
                              </span>
                            </Label>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Data sample for the AI
                  </Label>
                  <div className="flex items-center gap-2">
                    <Select value={ontoSampleRows} onValueChange={setOntoSampleRows}>
                      <SelectTrigger className="h-8 w-40 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0" className="text-xs">
                          Schema only — no rows
                        </SelectItem>
                        {["5", "10", "25", "50", "100", "200"].map((n) => (
                          <SelectItem key={n} value={n} className="text-xs">
                            {n} rows per table
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-[10px] leading-tight text-muted-foreground">
                      Real values sent to the AI to find relationships
                    </span>
                  </div>
                  <Textarea
                    value={ontoSampleSql}
                    onChange={(e) => setOntoSampleSql(e.target.value)}
                    rows={2}
                    className="font-mono text-xs"
                    placeholder="Optional custom SQL — its result is given to the AI as extra signal (runs on local & prepared datasets)"
                  />
                </div>

                {ctx.onModelChange && (
                  <div className="space-y-1.5">
                    <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      AI model
                    </Label>
                    <BiModelSelect
                      value={ctx.model ?? null}
                      onChange={ctx.onModelChange}
                      className="w-full"
                    />
                  </div>
                )}

                <Button
                  className="w-full gap-1.5"
                  onClick={() => void buildOntologyNow()}
                  disabled={Boolean(ontoBuilding) || !ontoHasSelection}
                >
                  {ontoBuilding ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {ontoBuilding
                    ? ONTO_STAGE_LABEL[ontoBuilding]
                    : ontoSpec
                      ? "Rebuild ontology"
                      : "Build ontology with AI"}
                </Button>

                {ontoSpec && (
                  <>
                    <div className="rounded-lg border border-border/60 bg-card p-2">
                      <OntologyGraph spec={ontoSpec} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Widget title
                      </Label>
                      <Input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Data ontology"
                        className="h-8 text-xs"
                      />
                    </div>
                  </>
                )}
              </div>
            ) : (
              <>
                {sourceSelect}

                {/* Tables — above the SQL, multi-select for joins */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Tables — select one or more to join
                    </Label>
                    {schemaLoading && (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> loading…
                      </span>
                    )}
                  </div>
                  <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-border/60 p-1.5">
                    {sourceTables.length === 0 && !schemaLoading && (
                      <p className="px-1 py-2 text-[11px] text-muted-foreground">
                        No tables available for this source.
                      </p>
                    )}
                    {sourceTables.map((t) => {
                      const checked = selectedTables.includes(t.name);
                      return (
                        <div key={t.name} className="rounded px-1 py-0.5 hover:bg-muted/60">
                          <Label className="flex cursor-pointer items-center gap-2 py-0.5 font-mono text-[11px] font-normal">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => toggleTable(t.name)}
                            />
                            <span className="truncate">{t.name}</span>
                            {ctx.preparedTables?.has(t.name) && (
                              <Badge variant="secondary" className="shrink-0 px-1 text-[9px]">
                                prep
                              </Badge>
                            )}
                          </Label>
                          {checked && (
                            <p
                              className="ml-6 truncate text-[9px] text-muted-foreground"
                              title={t.cols.join(", ")}
                            >
                              {t.cols.slice(0, 8).join(" · ")}
                              {t.cols.length > 8 ? ` · +${t.cols.length - 8} more` : ""}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {selectedTables.length > 1 && (
                    <p className="text-[10px] text-muted-foreground">
                      A JOIN skeleton was written below — adjust the join keys if needed.
                    </p>
                  )}
                </div>

                {/* SQL */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    SQL (SELECT only)
                  </Label>
                  {sourceKey === "local" && ctx.metrics.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 pb-0.5">
                      <span
                        className="flex items-center gap-1 text-[10px] text-muted-foreground"
                        title="Certified metrics saved from Data & SQL — click to insert as a query"
                      >
                        <BadgeCheck className="h-3 w-3 text-primary" /> Metrics:
                      </span>
                      {ctx.metrics.slice(0, 8).map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          title={`${m.sql_expression}${m.description ? ` — ${m.description}` : ""}`}
                          onClick={() => insertMetric(m)}
                          className="rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/10"
                        >
                          {m.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <Textarea
                    value={sql}
                    onChange={(e) => setSql(e.target.value)}
                    rows={5}
                    className="font-mono text-xs"
                    placeholder="Select tables above, or write your own query"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => void runPreview()}
                      disabled={running || !sql.trim()}
                    >
                      {running ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Play className="h-3 w-3" />
                      )}
                      Run
                    </Button>
                    {preview && (
                      <span className="text-[10px] text-muted-foreground">
                        {preview.row_count} rows · {preview.columns.length} cols
                        {preview.capped ? " (truncated)" : ""}
                      </span>
                    )}
                  </div>
                  {runError && (
                    <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                      {runError}
                    </p>
                  )}
                </div>

                {preview && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      {(chartType === "bar" ||
                        chartType === "hbar" ||
                        chartType === "line" ||
                        chartType === "area") && (
                        <>
                          {fieldSelect(
                            chartType === "hbar" ? "Category" : "X axis",
                            xField,
                            setXField,
                          )}
                          {fieldSelect("Value (numeric)", yField, setYField)}
                          {chartType !== "hbar" &&
                            optionalFieldSelect("Split by series", seriesField, setSeriesField)}
                          {chartType === "bar" && seriesField && (
                            <div className="flex items-end pb-1.5">
                              <Label className="flex cursor-pointer items-center gap-2 text-xs font-normal normal-case tracking-normal text-foreground">
                                <Checkbox
                                  checked={stacked}
                                  onCheckedChange={(v) => setStacked(Boolean(v))}
                                />
                                Stacked bars
                              </Label>
                            </div>
                          )}
                        </>
                      )}
                      {(chartType === "scolumn" || chartType === "shbar") && (
                        <>
                          {fieldSelect("Category", xField, setXField)}
                          {fieldSelect("Value (numeric)", yField, setYField)}
                          {fieldSelect("Split by (stack)", seriesField, setSeriesField)}
                        </>
                      )}
                      {chartType === "barrace" && (
                        <>
                          {fieldSelect("Racing category", xField, setXField)}
                          {fieldSelect("Value (numeric)", yField, setYField)}
                          {fieldSelect("Time / frame", timeField, setTimeField)}
                        </>
                      )}
                      {chartType === "radar" && (
                        <>
                          {fieldSelect("Metric (spoke)", xField, setXField)}
                          {fieldSelect("Value (numeric)", yField, setYField)}
                          {optionalFieldSelect("Split by series", seriesField, setSeriesField)}
                        </>
                      )}
                      {chartType === "sankey" && (
                        <>
                          {fieldSelect("Source (from)", xField, setXField)}
                          {fieldSelect("Target (to)", yField, setYField)}
                          {fieldSelect("Value (numeric)", valueField, setValueField)}
                        </>
                      )}
                      {chartType === "waterfall" && (
                        <>
                          {fieldSelect("Stage / step", xField, setXField)}
                          {fieldSelect("Change (+/- numeric)", yField, setYField)}
                        </>
                      )}
                      {chartType === "boxplot" && (
                        <>
                          {fieldSelect("Category", xField, setXField)}
                          {fieldSelect("Value (numeric)", yField, setYField)}
                        </>
                      )}
                      {(chartType === "pie" ||
                        chartType === "funnel" ||
                        chartType === "treemap" ||
                        chartType === "nightingale") && (
                        <>
                          {fieldSelect(
                            chartType === "funnel" ? "Stage" : "Category",
                            nameField,
                            setNameField,
                          )}
                          {fieldSelect("Value (numeric)", valueField, setValueField)}
                        </>
                      )}
                      {chartType === "wordcloud" && (
                        <>
                          {fieldSelect("Text / words", nameField, setNameField)}
                          {optionalFieldSelect("Weight by (numeric)", valueField, setValueField)}
                        </>
                      )}
                      {chartType === "combo" && (
                        <>
                          {fieldSelect("X axis", xField, setXField)}
                          {fieldSelect("Bars (numeric)", yField, setYField)}
                          {fieldSelect("Line (numeric)", lineField, setLineField)}
                        </>
                      )}
                      {chartType === "scatter" && (
                        <>
                          {fieldSelect("X (numeric)", xField, setXField)}
                          {fieldSelect("Y (numeric)", yField, setYField)}
                          {optionalFieldSelect("Bubble size", sizeField, setSizeField)}
                        </>
                      )}
                      {chartType === "heatmap" && (
                        <>
                          {fieldSelect("Columns (X)", xField, setXField)}
                          {fieldSelect("Rows (Y)", yField, setYField)}
                          {fieldSelect("Value (numeric)", valueField, setValueField)}
                        </>
                      )}
                      {chartType === "matrix" && (
                        <>
                          {fieldSelect("Rows", rowField, setRowField)}
                          {fieldSelect("Columns", colField, setColField)}
                          {fieldSelect("Value (numeric)", valueField, setValueField)}
                          {optionalFieldSelect(
                            "Row detail (expandable)",
                            rowSubField,
                            setRowSubField,
                          )}
                          <div className="col-span-2 space-y-1.5">
                            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Conditional formatting
                            </Label>
                            <Select value={matFmtMode} onValueChange={setMatFmtMode}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none" className="text-xs">
                                  None
                                </SelectItem>
                                <SelectItem value="scale" className="text-xs">
                                  Colour scale (min → max)
                                </SelectItem>
                                <SelectItem value="rules" className="text-xs">
                                  Rules (first match wins)
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            {matFmtMode === "scale" && (
                              <div className="flex items-center gap-1.5 pt-0.5">
                                {Object.entries(COND_COLORS).map(([id, c]) => (
                                  <button
                                    key={id}
                                    type="button"
                                    title={c.label}
                                    onClick={() => setMatScaleColor(id)}
                                    className={`h-6 w-8 rounded-md border ${
                                      matScaleColor === id
                                        ? "border-foreground"
                                        : "border-border/60"
                                    }`}
                                    style={{
                                      background: `linear-gradient(to right, color-mix(in oklch, ${c.hex} 10%, transparent), ${c.hex})`,
                                    }}
                                  />
                                ))}
                              </div>
                            )}
                            {matFmtMode === "rules" && (
                              <div className="space-y-1.5 pt-0.5">
                                {matRules.map((r, i) => (
                                  <div key={i} className="flex flex-wrap items-center gap-1">
                                    <Select
                                      value={r.op}
                                      onValueChange={(v) =>
                                        setMatRules((rs) =>
                                          rs.map((x, j) =>
                                            j === i ? { ...x, op: v as BiCondRule["op"] } : x,
                                          ),
                                        )
                                      }
                                    >
                                      <SelectTrigger className="h-7 w-24 text-[11px]">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {(
                                          [
                                            ["gt", "> above"],
                                            ["gte", "≥ at least"],
                                            ["lt", "< below"],
                                            ["lte", "≤ at most"],
                                            ["eq", "= equals"],
                                            ["neq", "≠ not"],
                                            ["between", "between"],
                                          ] as const
                                        ).map(([v, l]) => (
                                          <SelectItem key={v} value={v} className="text-xs">
                                            {l}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <Input
                                      value={Number.isFinite(r.value) ? String(r.value) : ""}
                                      onChange={(e) =>
                                        setMatRules((rs) =>
                                          rs.map((x, j) =>
                                            j === i ? { ...x, value: Number(e.target.value) } : x,
                                          ),
                                        )
                                      }
                                      inputMode="decimal"
                                      placeholder="value"
                                      className="h-7 w-20 text-[11px]"
                                    />
                                    {r.op === "between" && (
                                      <Input
                                        value={
                                          r.value2 !== undefined && Number.isFinite(r.value2)
                                            ? String(r.value2)
                                            : ""
                                        }
                                        onChange={(e) =>
                                          setMatRules((rs) =>
                                            rs.map((x, j) =>
                                              j === i
                                                ? { ...x, value2: Number(e.target.value) }
                                                : x,
                                            ),
                                          )
                                        }
                                        inputMode="decimal"
                                        placeholder="and"
                                        className="h-7 w-20 text-[11px]"
                                      />
                                    )}
                                    <div className="flex gap-0.5">
                                      {Object.entries(COND_COLORS).map(([id, c]) => (
                                        <button
                                          key={id}
                                          type="button"
                                          title={c.label}
                                          onClick={() =>
                                            setMatRules((rs) =>
                                              rs.map((x, j) => (j === i ? { ...x, color: id } : x)),
                                            )
                                          }
                                          className={`h-5 w-5 rounded border ${
                                            r.color === id
                                              ? "border-foreground"
                                              : "border-border/60"
                                          }`}
                                          style={{ background: c.hex }}
                                        />
                                      ))}
                                    </div>
                                    <button
                                      type="button"
                                      className="ml-auto text-muted-foreground hover:text-destructive"
                                      onClick={() =>
                                        setMatRules((rs) => rs.filter((_, j) => j !== i))
                                      }
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </div>
                                ))}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 gap-1 text-[11px]"
                                  onClick={() =>
                                    setMatRules((rs) => [
                                      ...rs,
                                      { op: "gt", value: 0, color: "emerald" },
                                    ])
                                  }
                                >
                                  <Plus className="h-3 w-3" /> Add rule
                                </Button>
                                <p className="text-[9px] text-muted-foreground">
                                  Rules are checked top-down; the first match colours the cell.
                                  Totals stay uncoloured.
                                </p>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                      {(chartType === "map" || chartType === "bubblemap") && (
                        <>
                          {fieldSelect("Location (country)", locationField, setLocationField)}
                          {fieldSelect("Value (numeric)", valueField, setValueField)}
                        </>
                      )}

                      {/* Drill hierarchy (bar/hbar/pie/treemap) */}
                      {(chartType === "bar" ||
                        chartType === "hbar" ||
                        chartType === "pie" ||
                        chartType === "treemap") && (
                        <div className="col-span-2 space-y-1">
                          <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Drill hierarchy (top → detail)
                          </Label>
                          <div className="flex flex-wrap items-center gap-1">
                            {drillList.map((f, i) => (
                              <Badge
                                key={f}
                                variant="secondary"
                                className="gap-1 px-1.5 text-[10px]"
                              >
                                {i + 1}. {f}
                                <button
                                  type="button"
                                  onClick={() => setDrillList(drillList.filter((x) => x !== f))}
                                >
                                  <X className="h-2.5 w-2.5" />
                                </button>
                              </Badge>
                            ))}
                            <Select
                              key={drillList.length}
                              onValueChange={(v) =>
                                !drillList.includes(v) && setDrillList([...drillList, v])
                              }
                            >
                              <SelectTrigger className="h-7 w-28 text-[10px]">
                                <SelectValue placeholder="+ add level" />
                              </SelectTrigger>
                              <SelectContent>
                                {(preview?.columns ?? [])
                                  .filter((c) => !drillList.includes(c))
                                  .map((c) => (
                                    <SelectItem key={c} value={c} className="text-xs">
                                      {c}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <p className="text-[9px] text-muted-foreground">
                            Two or more levels enable click-to-drill (the query must include every
                            level's column).
                          </p>
                        </div>
                      )}

                      {/* Time intelligence (line/area) */}
                      {(chartType === "line" || chartType === "area") && (
                        <>
                          <div className="space-y-1">
                            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Date grain
                            </Label>
                            <Select value={grainSel} onValueChange={setGrainSel}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {["auto", "day", "week", "month", "quarter", "year"].map((g) => (
                                  <SelectItem key={g} value={g} className="text-xs">
                                    {g}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {/* Running total, comparison, trend and forecast are
                              single-series calculations — hidden while a series
                              split is active so we never offer a toggle that the
                              renderer can't apply. Date grain works either way. */}
                          {seriesField ? (
                            <p className="col-span-2 text-[10px] text-muted-foreground">
                              Running total, compare, trend and forecast apply to single-series
                              charts. Clear “Split by series” to use them.
                            </p>
                          ) : (
                            <>
                              <div className="space-y-1">
                                <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                  Compare
                                </Label>
                                <Select value={compareSel} onValueChange={setCompareSel}>
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="none" className="text-xs">
                                      None
                                    </SelectItem>
                                    <SelectItem value="prior_period" className="text-xs">
                                      Prior period
                                    </SelectItem>
                                    <SelectItem value="prior_year" className="text-xs">
                                      Prior year
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="col-span-2 flex flex-wrap items-center gap-4">
                                <Label className="flex cursor-pointer items-center gap-1.5 text-xs font-normal">
                                  <Checkbox
                                    checked={runningB}
                                    onCheckedChange={(v) => setRunningB(Boolean(v))}
                                  />
                                  Running total
                                </Label>
                                {chartType === "line" && (
                                  <Label className="flex cursor-pointer items-center gap-1.5 text-xs font-normal">
                                    <Checkbox
                                      checked={trendB}
                                      onCheckedChange={(v) => setTrendB(Boolean(v))}
                                    />
                                    Trend line
                                  </Label>
                                )}
                                {chartType === "line" && (
                                  <span className="flex items-center gap-1.5 text-xs">
                                    Forecast
                                    <Input
                                      value={forecastN}
                                      onChange={(e) => setForecastN(e.target.value)}
                                      className="h-7 w-14 text-xs"
                                      placeholder="0"
                                      inputMode="numeric"
                                    />
                                    periods
                                  </span>
                                )}
                              </div>
                            </>
                          )}
                        </>
                      )}

                      {/* Reference line (bar/line/area) */}
                      {(chartType === "bar" || chartType === "line" || chartType === "area") && (
                        <>
                          <div className="space-y-1">
                            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Reference line
                            </Label>
                            <Select value={refMode} onValueChange={setRefMode}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none" className="text-xs">
                                  None
                                </SelectItem>
                                <SelectItem value="avg" className="text-xs">
                                  Average
                                </SelectItem>
                                <SelectItem value="value" className="text-xs">
                                  Target value
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {refMode === "value" && (
                            <div className="space-y-1">
                              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Target
                              </Label>
                              <Input
                                value={refValue}
                                onChange={(e) => setRefValue(e.target.value)}
                                className="h-8 text-xs"
                                inputMode="decimal"
                                placeholder="e.g. 10000"
                              />
                            </div>
                          )}
                          {refMode !== "none" && (
                            <div className="space-y-1">
                              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Line label
                              </Label>
                              <Input
                                value={refLabel}
                                onChange={(e) => setRefLabel(e.target.value)}
                                className="h-8 text-xs"
                                placeholder="target"
                              />
                            </div>
                          )}
                        </>
                      )}
                      {chartType !== "table" &&
                        chartType !== "heatmap" &&
                        chartType !== "boxplot" &&
                        chartType !== "map" &&
                        chartType !== "bubblemap" &&
                        chartType !== "kpi" &&
                        chartType !== "gauge" &&
                        formatSelect}
                      {columnFormatEditor}
                      {(chartType === "kpi" || chartType === "gauge") && (
                        <>
                          {fieldSelect("Value column", valueField, setValueField)}
                          {optionalFieldSelect("Target column", targetField, setTargetField)}
                          {chartType === "gauge" && (
                            <div className="space-y-1">
                              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Max (optional)
                              </Label>
                              <Input
                                value={maxInput}
                                onChange={(e) => setMaxInput(e.target.value)}
                                className="h-8 text-xs"
                                placeholder="auto"
                                inputMode="decimal"
                              />
                            </div>
                          )}
                          <div className="space-y-1">
                            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Label
                            </Label>
                            <Input
                              value={kpiLabel}
                              onChange={(e) => setKpiLabel(e.target.value)}
                              className="h-8 text-xs"
                              placeholder="Total revenue"
                            />
                          </div>
                          {formatSelect}
                        </>
                      )}
                    </div>
                    {(chartType === "map" || chartType === "bubblemap") && (
                      <p className="text-[10px] text-muted-foreground">
                        Locations are matched to countries by name or common shorthand (USA, UK…).
                        Unmatched rows are counted on the map.
                      </p>
                    )}

                    {/* Preview */}
                    <div className="rounded-lg border border-border/60 bg-card p-2">
                      {chartSpec && chartSpec.type !== "table" ? (
                        <BiChartRender chart={chartSpec} rows={preview.rows} />
                      ) : (
                        <div className="max-h-48 overflow-auto rounded border border-border/50">
                          <table className="w-full text-left">
                            <thead>
                              <tr>
                                {preview.columns.map((c) => (
                                  <th
                                    key={c}
                                    className="sticky top-0 bg-muted px-2 py-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground"
                                  >
                                    {c}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {preview.rows.slice(0, 20).map((row, i) => (
                                <tr key={i} className="border-t border-border/40">
                                  {preview.columns.map((c) => (
                                    <td key={c} className="px-2 py-1 font-mono text-[10px]">
                                      {row[c] === null || row[c] === undefined
                                        ? "null"
                                        : typeof row[c] === "number"
                                          ? fmtBiValue(row[c], colFormats[c])
                                          : String(row[c])}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Widget title
                      </Label>
                      <Input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Revenue by month"
                        className="h-8 text-xs"
                      />
                    </div>

                    {dateColumns.length > 0 && (
                      <div className="space-y-1.5">
                        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Scheduled refresh
                        </Label>
                        <div className="grid grid-cols-2 gap-2">
                          <Select
                            value={incDays || "full"}
                            onValueChange={(v) => {
                              setIncDays(v === "full" ? "" : v);
                              if (v !== "full" && !incColumn) setIncColumn(dateColumns[0]);
                            }}
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="full">Full re-query</SelectItem>
                              <SelectItem value="7">Last 7 days only</SelectItem>
                              <SelectItem value="30">Last 30 days only</SelectItem>
                              <SelectItem value="90">Last 90 days only</SelectItem>
                              <SelectItem value="365">Last 365 days only</SelectItem>
                            </SelectContent>
                          </Select>
                          <Select
                            value={incColumn || dateColumns[0]}
                            onValueChange={setIncColumn}
                            disabled={!incDays}
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue placeholder="Date column" />
                            </SelectTrigger>
                            <SelectContent>
                              {dateColumns.map((c) => (
                                <SelectItem key={c} value={c}>
                                  {c}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <p className="text-[10px] leading-relaxed text-muted-foreground">
                          Incremental: each scheduled refresh re-queries only the window and keeps
                          older rows from the last snapshot. Assumes history outside the window no
                          longer changes — pick Full re-query if old rows get edited.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
          <div className="border-t border-border p-3">
            <Button className="w-full gap-1.5" onClick={submit} disabled={!canSubmit}>
              <Plus className="h-4 w-4" />
              {initial ? "Save widget" : "Add to dashboard"}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-2 p-3 pb-2">
            {sourceSelect}
            {ctx.onModelChange && (
              <div className="space-y-1.5">
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  AI model
                </Label>
                <BiModelSelect
                  value={ctx.model ?? null}
                  onChange={ctx.onModelChange}
                  className="w-full"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Tables to analyse
              </Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-full justify-between gap-1.5 text-xs font-normal"
                    title="Limit which tables the analyst may use"
                  >
                    <span className="truncate">
                      {aiTables.length === 0
                        ? "All tables"
                        : aiTables.length === 1
                          ? aiTables[0]
                          : `${aiTables.length} tables selected`}
                    </span>
                    <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-2">
                  <div className="max-h-56 space-y-0.5 overflow-y-auto">
                    {sourceTables.length === 0 && (
                      <p className="px-1 py-2 text-[11px] text-muted-foreground">
                        {schemaLoading ? "Loading tables…" : "No tables for this source."}
                      </p>
                    )}
                    {sourceTables.map((t) => {
                      const checked = aiTables.includes(t.name);
                      return (
                        <Label
                          key={t.name}
                          className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 font-mono text-[11px] font-normal hover:bg-muted/60"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(on) =>
                              setAiTables((prev) =>
                                on ? [...prev, t.name] : prev.filter((x) => x !== t.name),
                              )
                            }
                          />
                          <span className="truncate">{t.name}</span>
                        </Label>
                      );
                    })}
                  </div>
                  <div className="mt-1.5 flex items-center justify-between border-t border-border/50 pt-1.5">
                    <p className="text-[10px] text-muted-foreground">Empty = analyse all tables</p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => setAiTables([])}
                    >
                      Clear
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Knowledge documents
              </Label>
              <Popover onOpenChange={(open) => open && void loadKbDocs()}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-full justify-between gap-1.5 text-xs font-normal"
                    title="Blend unstructured context from your knowledge bases into the analysis"
                  >
                    <span className="truncate">
                      {aiDocs.length === 0
                        ? "None — structured data only"
                        : aiDocs.length === 1
                          ? ((Array.isArray(kbDocOptions)
                              ? kbDocOptions.find((o) => o.id === aiDocs[0])?.name
                              : undefined) ?? "1 document selected")
                          : `${aiDocs.length} documents selected`}
                    </span>
                    <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-2">
                  <div className="max-h-56 space-y-0.5 overflow-y-auto">
                    {kbDocOptions === "loading" && (
                      <p className="flex items-center gap-1.5 px-1 py-2 text-[11px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Loading documents…
                      </p>
                    )}
                    {kbDocOptions === "error" && (
                      <p className="px-1 py-2 text-[11px] text-destructive">
                        Couldn't load your knowledge documents — close and reopen to retry.
                      </p>
                    )}
                    {Array.isArray(kbDocOptions) && kbDocOptions.length === 0 && (
                      <p className="px-1 py-2 text-[11px] text-muted-foreground">
                        No documents with text content — add some on the Knowledge page first.
                      </p>
                    )}
                    {docGroups.map(([kb, docs]) => (
                      <div key={kb}>
                        <p className="px-1.5 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                          {kb}
                        </p>
                        {docs.map((d) => {
                          const checked = aiDocs.includes(d.id);
                          return (
                            <Label
                              key={d.id}
                              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11px] font-normal hover:bg-muted/60"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(on) =>
                                  setAiDocs((prev) => {
                                    if (!on) return prev.filter((x) => x !== d.id);
                                    if (prev.length >= MAX_AI_DOCS) {
                                      toast.info(
                                        `Up to ${MAX_AI_DOCS} documents per question — deselect one first.`,
                                      );
                                      return prev;
                                    }
                                    return [...prev, d.id];
                                  })
                                }
                              />
                              <span className="truncate">{d.name}</span>
                            </Label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 flex items-center justify-between border-t border-border/50 pt-1.5">
                    <p className="text-[10px] text-muted-foreground">
                      The analyst cross-references docs with your data
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => setAiDocs([])}
                    >
                      Clear
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            {schemaLoading && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> loading schema…
              </span>
            )}
          </div>
          <div
            ref={turnsScrollRef}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto border-t border-border/50 bg-muted/20 p-3"
          >
            {turns.length === 0 && (
              <p className="py-10 text-center text-xs text-muted-foreground">
                Ask a business question — the analyst writes and runs the SQL, picks a chart, and
                explains the result. Select knowledge documents to blend unstructured context into
                the insight. Insert any answer as a widget.
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className="space-y-1.5">
                <BiChatMessage turn={t} />
                {t.status === "done" && t.result && (
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      variant={insertedIdx.has(i) ? "secondary" : "default"}
                      onClick={() => insertTurn(t, i)}
                    >
                      <Plus className="h-3 w-3" />
                      {insertedIdx.has(i) ? "Insert again" : "Insert into dashboard"}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-1.5 border-t border-border p-3">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendQuestion();
                }
              }}
              placeholder="Ask a business question…"
              className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-xs focus:border-primary focus:outline-none"
              disabled={aiBusy}
            />
            <Button
              size="icon"
              className="h-9 w-9"
              onClick={() => void sendQuestion()}
              disabled={aiBusy || !question.trim() || schemaLoading}
            >
              {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
