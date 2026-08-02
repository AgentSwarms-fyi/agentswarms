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
  Map as MapIcon,
  MapPin,
  Network,
  PieChart,
  Plus,
  ScatterChart,
  Send,
  Sparkles,
  Table2,
  Cloud,
  X,
} from "lucide-react";

import { BiVizPicker, type ChartType } from "@/components/bi/BiVizPicker";
import { BiAiTab, type KbDocOption } from "@/components/bi/BiAiTab";
import { BiOntologyTab } from "@/components/bi/BiOntologyTab";
import { BiTablePicker } from "@/components/bi/BiTablePicker";
import { BiSqlEditor } from "@/components/bi/BiSqlEditor";
import { BiCondFormatEditor } from "@/components/bi/BiCondFormatEditor";
import {
  BiDrillHierarchy,
  BiRefLineOptions,
  BiTimeSeriesOptions,
} from "@/components/bi/BiChartOptions";
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
import { snapshotRows, widgetFromBiTurn, type BiWidget } from "@/lib/biDashboards";
import { isAggregatableChart } from "@/lib/biAggregate";
import { buildOntology, type OntologyBuildStage, type OntologySpec } from "@/lib/biOntology";
import { listPrepFlows, parsePrepConfig, prepTables } from "@/lib/dataPrep";
import type { QueryResult } from "@/lib/sqlEngine";
import { SqlEngineStatus } from "@/components/data/SqlEngineStatus";

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

// ONTO_STAGE_LABEL moved to BiOntologyTab, the only place that renders it.

// Source selection, join detection and seed SQL now live in lib/biBuilder —
// pure, React-free, and tested. Re-exported so the (single) consumer of this
// file, and any future split children, keep one import site.
import { groupCheckState, seedSql, selHas, toggleName } from "@/lib/biBuilder";
import type { SelOrAll, SourceTable } from "@/lib/biBuilder";

export { groupCheckState, selHas, toggleName, type SelOrAll, type SourceTable };

type OntoKb = { id: string; name: string; docCount: number; docs: string[] };

// KbDocOption and MAX_AI_DOCS moved to BiAiTab, which is the only place that
// renders or enforces them. Re-declaring them here would be two definitions
// agreeing by coincidence — the cap in particular is a number the tab's own
// message quotes back to the user.

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
    const q = `SELECT ${m.sql_expression} AS "${m.name}" FROM "${table}"`;
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
              `SELECT * FROM "${d.name}" LIMIT ${sampleLimit}`,
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

      {/* Explains the one-off WebAssembly download; renders nothing once the
          engine is ready. Above the tab content so it is visible whichever
          tab is open — both build and Ask AI run local queries. */}
      <SqlEngineStatus className="mx-3 mb-2" />

      {tab === "build" ? (
        <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {initial && (
              <Badge variant="secondary" className="text-[10px]">
                Editing “{initial.title}”
              </Badge>
            )}

            <BiVizPicker value={chartType} onChange={setChartType} />

            {chartType === "ontology" ? (
              <BiOntologyTab
                ctx={ctx}
                title={title}
                setTitle={setTitle}
                localTableNames={localTableNames}
                ontoLocalSel={ontoLocalSel}
                setOntoLocalSel={setOntoLocalSel}
                ontoWhSel={ontoWhSel}
                setOntoWhSel={setOntoWhSel}
                ontoKbSel={ontoKbSel}
                setOntoKbSel={setOntoKbSel}
                ontoKbList={ontoKbList}
                ensureOntoKbList={ensureOntoKbList}
                kbListArr={kbListArr}
                kbIds={kbIds}
                ontoExpanded={ontoExpanded}
                toggleOntoExpanded={toggleOntoExpanded}
                ontoHasSelection={ontoHasSelection}
                ontoBuilding={ontoBuilding}
                buildOntologyNow={buildOntologyNow}
                ontoSpec={ontoSpec}
                ontoSampleSql={ontoSampleSql}
                setOntoSampleSql={setOntoSampleSql}
                ontoSampleRows={ontoSampleRows}
                setOntoSampleRows={setOntoSampleRows}
              />
            ) : (
              <>
                {sourceSelect}

                {/* Tables — above the SQL, multi-select for joins */}
                <BiTablePicker
                  sourceTables={sourceTables}
                  selectedTables={selectedTables}
                  schemaLoading={schemaLoading}
                  preparedTables={ctx.preparedTables}
                  toggleTable={toggleTable}
                />

                {/* SQL */}
                <BiSqlEditor
                  sql={sql}
                  setSql={setSql}
                  sourceKey={sourceKey}
                  metrics={ctx.metrics}
                  insertMetric={insertMetric}
                  runPreview={() => void runPreview()}
                  running={running}
                  preview={preview}
                  runError={runError}
                />

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
                          <BiCondFormatEditor
                            matFmtMode={matFmtMode}
                            setMatFmtMode={setMatFmtMode}
                            matScaleColor={matScaleColor}
                            setMatScaleColor={setMatScaleColor}
                            matRules={matRules}
                            setMatRules={setMatRules}
                          />
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
                        <BiDrillHierarchy
                          drillList={drillList}
                          setDrillList={setDrillList}
                          columns={preview?.columns ?? []}
                        />
                      )}

                      {/* Time intelligence (line/area) */}
                      {(chartType === "line" || chartType === "area") && (
                        <BiTimeSeriesOptions
                          chartType={chartType}
                          seriesField={seriesField}
                          grainSel={grainSel}
                          setGrainSel={setGrainSel}
                          compareSel={compareSel}
                          setCompareSel={setCompareSel}
                          runningB={runningB}
                          setRunningB={setRunningB}
                          trendB={trendB}
                          setTrendB={setTrendB}
                          forecastN={forecastN}
                          setForecastN={setForecastN}
                        />
                      )}

                      {/* Reference line (bar/line/area) */}
                      {(chartType === "bar" || chartType === "line" || chartType === "area") && (
                        <BiRefLineOptions
                          refMode={refMode}
                          setRefMode={setRefMode}
                          refValue={refValue}
                          setRefValue={setRefValue}
                          refLabel={refLabel}
                          setRefLabel={setRefLabel}
                        />
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
        <BiAiTab
          ctx={ctx}
          title={title}
          question={question}
          setQuestion={setQuestion}
          turns={turns}
          turnsScrollRef={turnsScrollRef}
          aiBusy={aiBusy}
          aiTables={aiTables}
          setAiTables={setAiTables}
          aiDocs={aiDocs}
          setAiDocs={setAiDocs}
          docGroups={docGroups}
          kbDocOptions={kbDocOptions}
          loadKbDocs={loadKbDocs}
          insertTurn={insertTurn}
          insertedIdx={insertedIdx}
          sendQuestion={sendQuestion}
          sourceSelect={sourceSelect}
          sourceTables={sourceTables}
          schemaLoading={schemaLoading}
        />
      )}
    </div>
  );
}
