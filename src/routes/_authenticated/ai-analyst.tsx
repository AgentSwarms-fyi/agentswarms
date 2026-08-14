// AI Analyst — dedicated Spotter-style conversational analysis.
//
// Create ANALYSTS: each is a pinned (reasoning model, data scope) pair —
// nothing else to configure. Ask one a question and it plans, queries,
// CHECKS ITS OWN WORK, refines, and writes up the answer, with the whole
// trace (approach, per-step SQL, result samples, check verdicts) rendered
// and persisted. Transparency is the contract: every number in an answer
// traces to a step whose SQL a reader can re-run. Analyses export to PDF.
//
// The reasoning loop lives in lib/aiAnalyst (tested); this page is the
// shell: analyst CRUD (RLS owner-only), scope resolution (local DuckDB
// datasets or one warehouse connection), thread persistence, rendering.
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  Database,
  FlaskConical,
  FileDown,
  HelpCircle,
  LayoutDashboard,
  Loader2,
  History,
  MessageSquarePlus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  ShieldCheck,
  Wrench,
} from "lucide-react";

import { BiChartRender, fmtBiValue } from "@/components/bi/BiChartRender";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { clickable } from "@/lib/clickable";
import {
  analystNameOnEdit,
  ANALYST_ROW_CAP,
  isReasoningModelId,
  modelsUsedIn,
  rerunStep,
  resynthesizeTurn,
  runAnalystTurn,
  trimTurnForStorage,
  withStaleAnswer,
  type AnalystSource,
  type AnalystStep,
  type AnalystTurn,
  type GovernedModelFields,
} from "@/lib/aiAnalyst";
import {
  buildScenario,
  describeScenario,
  scenarioDelta,
  scenarioLevers,
} from "@/lib/analystScenario";
import {
  ensureGovernedCatalog,
  generateSuggestedQuestions,
  governedCatalogFor,
  loadSavedMetrics,
  loadSemantics,
  type SavedMetric,
  type SemanticEntry,
} from "@/lib/biAgent";
import { semanticRunQuery } from "@/utils/semantic.functions";
import {
  appendWidgetToDashboard,
  listDashboards,
  widgetFromAnalystStep,
  type BiDashboardRow,
  type BiWidgetSource,
} from "@/lib/biDashboards";
import { exportAnalysisPdf } from "@/lib/biPdf";
import { hydrateFromSupabase, type DatasetMeta, type QueryResult } from "@/lib/sqlEngine";
import {
  fetchWarehouseSchema,
  runWarehouseQuery,
  warehouseTablesAsDatasets,
} from "@/lib/warehouseClient";
import { listWarehouseConnections } from "@/utils/warehouse.functions";
import { WAREHOUSE_LABELS, type WarehouseTable } from "@/utils/warehouse/types";
import type { WarehouseConnectionSummary } from "@/utils/warehouse/types";

export const Route = createFileRoute("/_authenticated/ai-analyst")({
  component: AiAnalystPage,
});

type AnalystRow = {
  id: string;
  name: string;
  model: string;
  source: AnalystSource;
  created_at: string;
};

type ThreadRow = {
  id: string;
  analyst_id: string;
  title: string;
  turns: AnalystTurn[];
  updated_at?: string;
};

/** How many past analyses an analyst lists. Enough to find one, not a log. */
const ANALYST_THREAD_HISTORY = 50;

/** Auto-name from the data pick — the dialog stays two fields on purpose. */
function analystNameFor(source: AnalystSource, warehouses: WarehouseConnectionSummary[]): string {
  if (source.kind === "warehouse") {
    const w = warehouses.find((x) => x.id === source.connection_id);
    return `${w?.name ?? "Warehouse"} analyst`;
  }
  return source.tables.length === 1 ? `${source.tables[0]} analyst` : "Data analyst";
}

function sourceLabel(
  source: AnalystSource,
  warehouses: WarehouseConnectionSummary[],
): { icon: "wh" | "local"; text: string } {
  if (source.kind === "warehouse") {
    const w = warehouses.find((x) => x.id === source.connection_id);
    return {
      icon: "wh",
      text: w ? `${w.name} — ${WAREHOUSE_LABELS[w.provider]}` : "Warehouse (disconnected)",
    };
  }
  return {
    icon: "local",
    text: source.tables.length === 0 ? "All local datasets" : source.tables.join(", "),
  };
}

const STATUS_LABEL: Record<AnalystTurn["status"], string> = {
  planning: "Planning the analysis…",
  working: "Running the steps…",
  checking: "Checking its own work…",
  synthesizing: "Writing up the findings…",
  done: "Done",
  clarifying: "Waiting on you",
  error: "Failed",
};

function AiAnalystPage() {
  const { user, session } = useAuth();
  const token = session?.access_token;
  const listWarehousesFn = useServerFn(listWarehouseConnections);
  // Compilation happens SERVER-side: that is where the full model, its row
  // filters and its column masks are. The browser only ever sees field names.
  const runSemanticFn = useServerFn(semanticRunQuery);

  // ── Data the analysts can be scoped to ──────────────────────────────
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  /**
   * Governed models over the datasets in scope — their declared parameters
   * are what a what-if scenario is allowed to vary.
   *
   * STATE, not a memo over `datasets`. governedCatalogFor reads a module-level
   * cache that `ensureGovernedCatalog()` fills asynchronously, so a memo keyed
   * on datasets alone computed once against an EMPTY cache and never
   * recomputed. Measured live: a model declaring commission_rate showed
   * "declares no parameters", which is the one thing the empty state must
   * never say wrongly — it reads as a fact about the model.
   */
  const [catalog, setCatalog] = useState<GovernedModelFields[]>([]);
  const [semantics, setSemantics] = useState<Map<string, SemanticEntry>>(new Map());
  const [metrics, setMetrics] = useState<SavedMetric[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseConnectionSummary[]>([]);
  const whSchemaCache = useRef<Map<string, WarehouseTable[]>>(new Map());

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const tables = await hydrateFromSupabase();
        setDatasets(tables);
        const [sem, mets] = await Promise.all([
          loadSemantics(tables.map((d) => d.id)),
          loadSavedMetrics(),
          // Fill the governed cache BEFORE reading it, or the catalog is
          // whatever happened to be cached — usually nothing on a fresh load.
          ensureGovernedCatalog(),
        ]);
        setSemantics(sem);
        setMetrics(mets);
        setCatalog(governedCatalogFor(tables));
      } catch (e) {
        toast.error(`Could not load local datasets: ${(e as Error).message}`);
      }
    })();
  }, [user?.id]);

  useEffect(() => {
    if (!token) return;
    listWarehousesFn({ data: { access_token: token } }).then((res) => {
      if (res.ok) setWarehouses(res.connections.filter((c) => c.is_active));
    });
  }, [token, listWarehousesFn]);

  // ── Analysts (RLS owner-only) ───────────────────────────────────────
  const [analysts, setAnalysts] = useState<AnalystRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    supabase
      .from("ai_analysts")
      .select("id, name, model, source, created_at")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          toast.error(error.message);
          setAnalysts([]);
          return;
        }
        const rows = (data ?? []).map((r) => ({ ...r, source: r.source as AnalystSource }));
        setAnalysts(rows as AnalystRow[]);
        setSelectedId((cur) => cur ?? rows[0]?.id ?? null);
      });
  }, [user?.id]);

  const selected = analysts?.find((a) => a.id === selectedId) ?? null;

  // ── The selected analyst's thread ───────────────────────────────────
  const [thread, setThread] = useState<ThreadRow | null>(null);
  /** This analyst's past analyses, newest first. */
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [liveTurn, setLiveTurn] = useState<AnalystTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);

  // EVERY analysis, not just the newest. Loading one meant each earlier
  // analysis was written to the database and then unreachable — the work was
  // kept and hidden, which is worse than not keeping it.
  useEffect(() => {
    setThread(null);
    setLiveTurn(null);
    setThreads([]);
    if (!selectedId) return;
    setThreadLoading(true);
    supabase
      .from("ai_analyst_threads")
      .select("id, analyst_id, title, turns, updated_at")
      .eq("analyst_id", selectedId)
      .order("updated_at", { ascending: false })
      .limit(ANALYST_THREAD_HISTORY)
      .then(({ data, error }) => {
        setThreadLoading(false);
        if (error) return toast.error(error.message);
        const rows = (data ?? []).map(
          (r) => ({ ...r, turns: (r.turns ?? []) as AnalystTurn[] }) as ThreadRow,
        );
        setThreads(rows);
        if (rows[0]) setThread(rows[0]);
      });
  }, [selectedId]);

  // Keep the newest content in view while a turn streams in.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [liveTurn, thread]);

  // ── The analyst's scope, resolved once and reused ────────────────────
  //
  // Asking a question and re-running one edited step need the SAME data
  // scope and the SAME executor. Resolving it in two places is how the two
  // paths drift into querying different things.
  type Scope = {
    datasets: DatasetMeta[];
    semantics: Map<string, SemanticEntry>;
    metrics: SavedMetric[];
    execute?: (sql: string) => Promise<QueryResult>;
    dialect?: string;
    source: BiWidgetSource;
  };

  const resolveScope = useCallback(async (): Promise<Scope | null> => {
    if (!selected || !user?.id) return null;
    if (selected.source.kind === "warehouse") {
      if (!token) {
        toast.error("Not signed in");
        return null;
      }
      const connId = selected.source.connection_id;
      const conn = warehouses.find((w) => w.id === connId);
      if (!conn) {
        toast.error("This analyst's warehouse connection is gone — recreate it.");
        return null;
      }
      try {
        let tables = whSchemaCache.current.get(connId);
        if (!tables) {
          tables = await fetchWarehouseSchema(token, connId);
          whSchemaCache.current.set(connId, tables);
        }
        return {
          datasets: warehouseTablesAsDatasets(connId, tables, user.id),
          semantics: new Map(),
          metrics: [],
          execute: (sql: string) => runWarehouseQuery(token, connId, sql),
          dialect: WAREHOUSE_LABELS[conn.provider],
          source: {
            kind: "warehouse",
            connection_id: connId,
            connection_name: conn.name,
            provider: conn.provider,
          },
        };
      } catch (e) {
        toast.error(`Could not load the warehouse schema: ${(e as Error).message}`);
        return null;
      }
    }
    const wanted = selected.source.tables;
    // Datasets hydrate asynchronously, so `datasets` is EMPTY for the first
    // moments after the page opens. Reading it then and reporting what we
    // found was how an analyst scoped to a dataset that plainly exists got
    // told, on every load, that its data had been deleted — a false alarm
    // about the one thing that would make the analyst useless. Hydration is
    // coordinated (an in-flight call is shared), so awaiting it here costs
    // nothing when it has already run.
    const available = datasets.length > 0 ? datasets : await hydrateFromSupabase();
    const scoped =
      wanted.length === 0 ? available : available.filter((d) => wanted.includes(d.name));
    if (scoped.length === 0) {
      toast.error(
        wanted.length === 0
          ? "No local datasets yet — upload data on the Data Catalog page first."
          : `The dataset "${wanted[0]}" no longer exists.`,
      );
      return null;
    }
    const ids = new Set(scoped.map((d) => d.id));
    return {
      datasets: scoped,
      semantics: new Map([...semantics].filter(([id]) => ids.has(id))),
      metrics,
      source: { kind: "local" },
    };
  }, [selected, user?.id, token, warehouses, datasets, semantics, metrics]);

  /** Persist a thread's turns, creating the thread on the first answer. */
  const persistTurns = useCallback(
    async (nextTurns: AnalystTurn[], titleFrom: string) => {
      if (!selected || !user?.id) return;
      if (thread) {
        const { error } = await supabase
          .from("ai_analyst_threads")
          .update({ turns: nextTurns as never, updated_at: new Date().toISOString() })
          .eq("id", thread.id);
        if (error) toast.error(`The analysis ran but could not be saved: ${error.message}`);
        const updated = { ...thread, turns: nextTurns };
        setThread(updated);
        setThreads((cur) => cur.map((t) => (t.id === updated.id ? updated : t)));
        return;
      }
      const { data, error } = await supabase
        .from("ai_analyst_threads")
        .insert({
          analyst_id: selected.id,
          user_id: user.id,
          title: titleFrom.slice(0, 80),
          turns: nextTurns as never,
        })
        .select("id, analyst_id, title, turns, updated_at")
        .single();
      if (error) {
        toast.error(`The analysis ran but could not be saved: ${error.message}`);
        setThread({ id: "unsaved", analyst_id: selected.id, title: titleFrom, turns: nextTurns });
      } else {
        const created = { ...data, turns: (data.turns ?? []) as AnalystTurn[] } as ThreadRow;
        setThread(created);
        setThreads((cur) => [created, ...cur]);
      }
    },
    [selected, user?.id, thread],
  );

  // ── Ask ─────────────────────────────────────────────────────────────
  const askQuestion = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q || busy || !selected) return;
      const scope = await resolveScope();
      if (!scope) return;

      setQuestion("");
      setBusy(true);
      try {
        const turn = await runAnalystTurn({
          question: q,
          datasets: scope.datasets,
          semantics: scope.semantics,
          metrics: scope.metrics,
          priorTurns: thread?.turns ?? [],
          model: selected.model,
          execute: scope.execute,
          dialect: scope.dialect,
          // The catalog resolved at load, AFTER ensureGovernedCatalog(). Read
          // straight from the cache here and a cold first question gets an
          // empty catalog — no step could be governed, and nothing would say
          // why.
          catalog,
          runSemantic: token
            ? async (query) => {
                const res = await runSemanticFn({ data: { accessToken: token, query } });
                return {
                  sql: res.sql,
                  columns: res.columns,
                  rows: res.rows as Record<string, unknown>[],
                  rollup: res.rollup,
                  access_note: res.access_note,
                };
              }
            : undefined,
          onUpdate: setLiveTurn,
        });
        // Persist the finished turn (including failures — the trace is the
        // record), then fold it into the rendered thread.
        await persistTurns([...(thread?.turns ?? []), trimTurnForStorage(turn)], q);
        setLiveTurn(null);
      } finally {
        setBusy(false);
      }
    },
    [busy, selected, thread, resolveScope, persistTurns],
  );

  const ask = useCallback(() => askQuestion(question), [askQuestion, question]);

  // ── Editing a step, and rewriting what was written about it ──────────
  const rerunStepAt = useCallback(
    async (turnIndex: number, stepIndex: number, sql: string) => {
      const turns = thread?.turns ?? [];
      const turn = turns[turnIndex];
      if (!turn || !selected) return;
      const scope = await resolveScope();
      if (!scope) return;
      try {
        const patched = await rerunStep({
          step: turn.steps[stepIndex],
          sql,
          execute: scope.execute,
        });
        const steps = turn.steps.map((s, i) => (i === stepIndex ? patched : s));
        const next = turns.map((t, i) =>
          i === turnIndex ? trimTurnForStorage(withStaleAnswer(t, steps)) : t,
        );
        await persistTurns(next, turn.question);
        toast.success("Step re-run — the findings now need a rewrite.");
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [thread, selected, resolveScope, persistTurns],
  );

  /**
   * Re-run a governed step under changed assumptions.
   *
   * The scenario is stored ON the step beside the measured result and the
   * findings are left alone — deliberately. A what-if that rewrote the answer
   * would turn "what the data says" into "what the data would say if", with
   * nothing in the text to tell them apart.
   */
  const runScenarioAt = useCallback(
    async (
      turnIndex: number,
      stepIndex: number,
      paramOverrides: Record<string, string>,
      filterOverrides: Record<string, string>,
    ) => {
      const turns = thread?.turns ?? [];
      const turn = turns[turnIndex];
      const step = turn?.steps?.[stepIndex];
      if (!turn || !step?.semantic || !step.governed || !token) return;
      const scope = await resolveScope();
      if (!scope) return;
      const model = catalog.find((m) => m.name === step.governed?.model);
      const plan = buildScenario({
        baseline: step.semantic,
        parameters: model?.parameters ?? [],
        paramOverrides,
        filterOverrides,
      });
      if (!plan) {
        toast.error("Nothing changed — a scenario has to vary an assumption or a filter value.");
        return;
      }
      try {
        const res = await runSemanticFn({ data: { accessToken: token, query: plan.query } });
        const patched: AnalystStep = {
          ...step,
          scenario: {
            changes: plan.changes,
            label: describeScenario(plan.changes),
            sql: res.sql,
            columns: res.columns,
            rows: (res.rows as Record<string, unknown>[]).slice(0, ANALYST_ROW_CAP),
            delta: scenarioDelta(
              step.semantic.metrics,
              step.rows ?? [],
              res.rows as Record<string, unknown>[],
            ),
          },
        };
        const steps = turn.steps.map((s, i) => (i === stepIndex ? patched : s));
        // NOT withStaleAnswer: the measured result is untouched, so the
        // findings still describe exactly what they described before.
        const next = turns.map((t, i) =>
          i === turnIndex ? trimTurnForStorage({ ...t, steps }) : t,
        );
        await persistTurns(next, turn.question);
      } catch (e) {
        toast.error(`The scenario could not be compiled: ${(e as Error).message}`);
      }
    },
    [thread, resolveScope, persistTurns, runSemanticFn, token],
  );

  const rewriteTurn = useCallback(
    async (turnIndex: number) => {
      const turns = thread?.turns ?? [];
      const turn = turns[turnIndex];
      if (!turn || !selected || busy) return;
      setBusy(true);
      try {
        const rewritten = await resynthesizeTurn({
          turn,
          priorTurns: turns.slice(0, turnIndex),
          model: selected.model,
          onUpdate: (t) => setLiveTurn(null) ?? void t,
        });
        const next = turns.map((t, i) => (i === turnIndex ? trimTurnForStorage(rewritten) : t));
        await persistTurns(next, turn.question);
        if (rewritten.error) toast.error(rewritten.error);
        else toast.success("Findings rewritten from the current results.");
      } finally {
        setBusy(false);
      }
    },
    [thread, selected, busy, persistTurns],
  );

  // ── Pin a step's result to a dashboard ───────────────────────────────
  const [pinStep, setPinStep] = useState<{ turn: number; step: number } | null>(null);
  const [dashboards, setDashboards] = useState<BiDashboardRow[] | null>(null);
  const [pinning, setPinning] = useState(false);

  const openPin = useCallback((turnIndex: number, stepIndex: number) => {
    setPinStep({ turn: turnIndex, step: stepIndex });
    setDashboards(null);
    listDashboards()
      .then(setDashboards)
      .catch((e) => {
        toast.error((e as Error).message);
        setDashboards([]);
      });
  }, []);

  const pinToDashboard = useCallback(
    async (dashboardId: string) => {
      if (!pinStep || !selected) return;
      const turn = (thread?.turns ?? [])[pinStep.turn];
      const step = turn?.steps[pinStep.step];
      if (!turn || !step) return;
      const scope = await resolveScope();
      if (!scope) return;
      const widget = widgetFromAnalystStep(step, scope.source, turn.question);
      if (!widget) return toast.error("This step has no result to pin.");
      setPinning(true);
      try {
        await appendWidgetToDashboard(dashboardId, widget);
        toast.success("Added to the dashboard — it re-runs this SQL on refresh.");
        setPinStep(null);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setPinning(false);
      }
    },
    [pinStep, selected, thread, resolveScope],
  );

  // ── Starter questions for an analyst with nothing asked yet ──────────
  const [starters, setStarters] = useState<string[] | "loading" | null>(null);
  const startersFor = useRef<string | null>(null);

  useEffect(() => {
    if (!selected || thread || liveTurn || busy) return;
    if (startersFor.current === selected.id) return;
    startersFor.current = selected.id;
    setStarters("loading");
    (async () => {
      const scope = await resolveScope();
      if (!scope) return setStarters(null);
      try {
        setStarters(
          await generateSuggestedQuestions({
            datasets: scope.datasets,
            semantics: scope.semantics,
            metrics: scope.metrics,
            model: selected.model,
          }),
        );
      } catch {
        // Starters are a convenience; their absence is not an error worth
        // shouting about — the composer works either way.
        setStarters(null);
      }
    })();
  }, [selected, thread, liveTurn, busy, resolveScope]);

  // ── Analyst CRUD ────────────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  /** Non-null while the dialog is EDITING that analyst rather than creating. */
  const [editingAnalyst, setEditingAnalyst] = useState<AnalystRow | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftData, setDraftData] = useState("");

  /** The picker token ("wh:<id>" / "local:<name>" / "local:all") for a source. */
  function dataTokenFor(source: AnalystSource): string {
    if (source.kind === "warehouse") return `wh:${source.connection_id}`;
    return source.tables.length === 0 ? "local:all" : `local:${source.tables[0]}`;
  }

  function openEdit(a: AnalystRow) {
    setEditingAnalyst(a);
    setDraftModel(a.model);
    setDraftData(dataTokenFor(a.source));
    setCreateOpen(true);
  }

  function openCreate() {
    setEditingAnalyst(null);
    setDraftModel(null);
    setDraftData("");
    setCreateOpen(true);
  }

  async function saveAnalyst() {
    if (!user?.id || !draftModel || !draftData) return;
    const source: AnalystSource = draftData.startsWith("wh:")
      ? { kind: "warehouse", connection_id: draftData.slice(3) }
      : { kind: "local", tables: draftData === "local:all" ? [] : [draftData.slice(6)] };

    if (editingAnalyst) {
      const name = analystNameOnEdit({
        currentName: editingAnalyst.name,
        autoNameForOldSource: analystNameFor(editingAnalyst.source, warehouses),
        autoNameForNewSource: analystNameFor(source, warehouses),
      });
      const patch = { model: draftModel, source: source as never, name };
      const { error } = await supabase
        .from("ai_analysts")
        .update(patch)
        .eq("id", editingAnalyst.id);
      if (error) return toast.error(error.message);
      setAnalysts((cur) =>
        (cur ?? []).map((x) => (x.id === editingAnalyst.id ? { ...x, ...patch, source } : x)),
      );
      setCreateOpen(false);
      setEditingAnalyst(null);
      toast.success(`${name} updated — it applies to your next question.`);
      return;
    }

    const name = analystNameFor(source, warehouses);
    const { data, error } = await supabase
      .from("ai_analysts")
      .insert({ user_id: user.id, name, model: draftModel, source: source as never })
      .select("id, name, model, source, created_at")
      .single();
    if (error) return toast.error(error.message);
    const row = { ...data, source: data.source as AnalystSource } as AnalystRow;
    setAnalysts((cur) => [row, ...(cur ?? [])]);
    setSelectedId(row.id);
    setCreateOpen(false);
    setDraftModel(null);
    setDraftData("");
    toast.success(`${name} is ready — ask it something.`);
  }

  async function renameAnalyst(id: string, name: string) {
    const clean = name.trim();
    if (!clean) return;
    setAnalysts((cur) => (cur ?? []).map((a) => (a.id === id ? { ...a, name: clean } : a)));
    const { error } = await supabase.from("ai_analysts").update({ name: clean }).eq("id", id);
    if (error) toast.error(error.message);
  }

  async function deleteAnalyst(id: string) {
    const a = analysts?.find((x) => x.id === id);
    if (!window.confirm(`Delete ${a?.name ?? "this analyst"} and its analyses?`)) return;
    const { error } = await supabase.from("ai_analysts").delete().eq("id", id);
    if (error) return toast.error(error.message);
    setAnalysts((cur) => (cur ?? []).filter((x) => x.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function newAnalysis() {
    // The next question starts a fresh thread; older threads stay stored.
    setThread(null);
    setLiveTurn(null);
  }

  const turnsToRender = useMemo(() => {
    const list = [...(thread?.turns ?? [])];
    if (liveTurn) list.push(liveTurn);
    return list;
  }, [thread, liveTurn]);

  async function savePdf() {
    if (!selected) return;
    try {
      // The report is laid out from the TURN DATA (vector text — crisp and
      // selectable); only each turn's chart is rasterised from the DOM.
      await exportAnalysisPdf({
        title: thread?.title ?? selected.name,
        analystName: selected.name,
        // The models that actually ANSWERED, not whatever the analyst is set
        // to now — those differ the moment someone edits the analyst, and a
        // report naming the wrong model is a citation nobody can check.
        model: modelsUsedIn(turnsToRender, selected.model),
        sourceText: sourceLabel(selected.source, warehouses).text,
        turns: turnsToRender,
        // Every step's chart, not just the lead one — the report shows what
        // the thread shows.
        chartElFor: (turnIndex, stepIndex) =>
          threadRef.current?.querySelector<HTMLElement>(
            `[data-analysis-chart="${turnIndex}-${stepIndex}"]`,
          ) ?? null,
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const draftIsReasoning = useMemo(() => {
    if (!draftModel) return null;
    const id = draftModel.split("::").pop() ?? draftModel;
    return isReasoningModelId(id);
  }, [draftModel]);

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0">
      {/* Analyst rail */}
      <div className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <BrainCircuit className="h-4 w-4 text-primary" /> AI Analyst
          </span>
          <Button size="sm" className="h-7 gap-1 px-2 text-xs" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" /> New
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
          {analysts === null ? (
            <p className="p-3 text-xs text-muted-foreground">Loading…</p>
          ) : analysts.length === 0 ? (
            <p className="p-3 text-xs leading-relaxed text-muted-foreground">
              No analysts yet. An analyst is a reasoning model pinned to your data — create one and
              ask it questions in plain language.
            </p>
          ) : (
            analysts.map((a) => {
              const src = sourceLabel(a.source, warehouses);
              return (
                <Card
                  key={a.id}
                  className={`cursor-pointer p-2.5 transition hover:border-primary/40 ${
                    a.id === selectedId ? "border-primary/60 bg-primary/5" : ""
                  }`}
                  {...clickable(() => setSelectedId(a.id), `Analyst ${a.name}`)}
                >
                  <div className="flex items-start justify-between gap-1">
                    <p className="truncate text-xs font-medium">{a.name}</p>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        title="Change this analyst's model or data"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit(a);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Delete analyst"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteAnalyst(a.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                    {(a.model.split("::").pop() ?? a.model).slice(0, 40)}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                    <Database className="h-3 w-3 shrink-0" /> {src.text}
                  </p>
                </Card>
              );
            })
          )}
        </div>
      </div>

      {/* Analysis pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <BrainCircuit className="h-10 w-10 text-muted-foreground/50" />
            <div>
              <p className="text-sm font-medium">Your analytical partner, on your data</p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                An analyst reasons through every question step by step — plans the analysis, writes
                and runs the SQL, checks its own work, and writes up the findings with every number
                traceable to a query. Create one to start.
              </p>
            </div>
            <Button size="sm" className="gap-1.5" onClick={openCreate}>
              <Plus className="h-4 w-4" /> New analyst
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border px-4 py-2">
              <Input
                key={selected.id}
                defaultValue={selected.name}
                onBlur={(e) => void renameAnalyst(selected.id, e.target.value)}
                className="h-7 w-56 border-transparent bg-transparent px-1 text-sm font-semibold focus-visible:border-input"
              />
              <Badge variant="secondary" className="max-w-48 truncate font-mono text-[10px]">
                {selected.model.split("::").pop()}
              </Badge>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {sourceLabel(selected.source, warehouses).text}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                {threads.length > 1 && (
                  <Select
                    value={thread?.id ?? ""}
                    onValueChange={(id) => {
                      const pick = threads.find((t) => t.id === id);
                      if (pick) {
                        setThread(pick);
                        setLiveTurn(null);
                      }
                    }}
                  >
                    <SelectTrigger className="h-7 max-w-52 gap-1 text-xs" title="Past analyses">
                      <History className="h-3.5 w-3.5 shrink-0" />
                      <SelectValue placeholder="Past analyses" />
                    </SelectTrigger>
                    <SelectContent>
                      {threads.map((t) => (
                        <SelectItem key={t.id} value={t.id} className="text-xs">
                          {t.title || "Untitled analysis"}
                          {t.updated_at ? ` · ${new Date(t.updated_at).toLocaleDateString()}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={newAnalysis}
                  disabled={busy || (!thread && !liveTurn)}
                  title="Start a fresh analysis thread"
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" /> New analysis
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => void savePdf()}
                  disabled={busy || turnsToRender.length === 0}
                  title="Save this analysis as a PDF"
                >
                  <FileDown className="h-3.5 w-3.5" /> Save as PDF
                </Button>
              </div>
            </div>

            <div ref={threadRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              {threadLoading ? (
                <p className="text-xs text-muted-foreground">Loading the last analysis…</p>
              ) : turnsToRender.length === 0 ? (
                <div className="mx-auto max-w-lg pt-10 text-center">
                  <p className="text-sm font-medium">Ask {selected.name} anything about its data</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    It will show its full working: the approach, each query it runs, the self-check
                    on every result, and the write-up.
                  </p>
                  {/* Starter questions written from THIS analyst's schema —
                      a blank composer is the hardest part of a blank page. */}
                  {starters === "loading" ? (
                    <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Reading the schema for ideas…
                    </p>
                  ) : Array.isArray(starters) && starters.length > 0 ? (
                    <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                      {starters.map((q) => (
                        <button
                          key={q}
                          type="button"
                          disabled={busy}
                          onClick={() => void askQuestion(q)}
                          className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] transition hover:border-primary/50 hover:bg-primary/5 disabled:opacity-50"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                turnsToRender.map((t, ti) => (
                  <TurnView
                    key={ti}
                    turn={t}
                    index={ti}
                    busy={busy}
                    onRerunStep={rerunStepAt}
                    onRewrite={rewriteTurn}
                    onPin={openPin}
                    onAsk={(q) => void askQuestion(q)}
                    onScenario={runScenarioAt}
                    catalog={catalog}
                  />
                ))
              )}
            </div>

            <div className="border-t border-border p-3">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void ask();
                }}
              >
                <Input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={
                    busy ? STATUS_LABEL[liveTurn?.status ?? "planning"] : "Ask the analyst…"
                  }
                  disabled={busy}
                  className="h-9 text-sm"
                />
                <Button type="submit" disabled={busy || !question.trim()} className="h-9 gap-1.5">
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  Ask
                </Button>
              </form>
            </div>
          </>
        )}
      </div>

      {/* Pin a step onto a dashboard — the widget re-runs that step's SQL. */}
      <Dialog open={pinStep !== null} onOpenChange={(o) => !o && setPinStep(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add this step to a dashboard</DialogTitle>
          </DialogHeader>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The widget keeps this step's SQL and chart, so a scheduled refresh re-runs it against{" "}
            {selected ? sourceLabel(selected.source, warehouses).text : "the same source"}.
          </p>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {dashboards === null ? (
              <p className="p-3 text-xs text-muted-foreground">Loading dashboards…</p>
            ) : dashboards.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                No dashboards yet — create one in the BI Workspace first.
              </p>
            ) : (
              dashboards.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  disabled={pinning}
                  onClick={() => void pinToDashboard(d.id)}
                  className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-xs transition hover:border-primary/50 hover:bg-primary/5 disabled:opacity-50"
                >
                  <LayoutDashboard className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{d.name}</span>
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* New analyst — exactly two choices: the model and the data. */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingAnalyst ? "Edit analyst" : "New analyst"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Reasoning model</Label>
              <BiModelSelect value={draftModel} onChange={setDraftModel} />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Analysts think in steps — pick a <strong>reasoning model</strong> from your
                connected providers (o3, GPT-5, Claude Opus, DeepSeek-R1, Gemini 2.5 Pro…).
              </p>
              {draftIsReasoning === false && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] leading-relaxed">
                  This doesn't look like a reasoning model. It will still work, but multi-step
                  analysis is usually sharper with one.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Data</Label>
              <Select value={draftData || undefined} onValueChange={setDraftData}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Choose the data it analyses" />
                </SelectTrigger>
                <SelectContent>
                  {datasets.length > 0 && (
                    <SelectItem value="local:all" className="text-xs">
                      All local datasets &amp; uploads ({datasets.length})
                    </SelectItem>
                  )}
                  {datasets.map((d) => (
                    <SelectItem key={d.id} value={`local:${d.name}`} className="text-xs">
                      {d.name}
                    </SelectItem>
                  ))}
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={`wh:${w.id}`} className="text-xs">
                      {w.name} — {WAREHOUSE_LABELS[w.provider]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {datasets.length === 0 && warehouses.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Nothing to analyse yet — upload a file on the Data Catalog page or connect a
                  warehouse in Integrations.
                </p>
              )}
            </div>
          </div>
          {editingAnalyst && (thread?.turns?.length ?? 0) > 0 && (
            <p className="rounded-md border border-border/60 bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
              Applies to your next question. Analyses already on this thread keep the model and data
              that produced them — they are not re-run, and their reports still name the model that
              answered them.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void saveAnalyst()} disabled={!draftModel || !draftData}>
              {editingAnalyst ? "Save changes" : "Create analyst"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Turn rendering (each block is a PDF export unit) ────────────────────

function CheckBadge({ verdict, note }: { verdict: string; note: string }) {
  const style =
    verdict === "pass"
      ? {
          cls: "border-emerald-500/40 bg-emerald-500/10",
          Icon: CheckCircle2,
          label: "Check passed",
        }
      : verdict === "refined"
        ? { cls: "border-sky-500/40 bg-sky-500/10", Icon: Wrench, label: "Self-corrected" }
        : { cls: "border-amber-500/40 bg-amber-500/10", Icon: AlertTriangle, label: "Flagged" };
  return (
    <p
      className={`flex items-start gap-1.5 rounded-md border p-2 text-[11px] leading-relaxed ${style.cls}`}
    >
      <style.Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <strong>{style.label}.</strong> {note}
      </span>
    </p>
  );
}

function TurnView({
  turn,
  index,
  busy,
  onRerunStep,
  onRewrite,
  onPin,
  onAsk,
  onScenario,
  catalog,
}: {
  turn: AnalystTurn;
  index: number;
  busy: boolean;
  /** Re-run one step with edited SQL. */
  onRerunStep: (turnIndex: number, stepIndex: number, sql: string) => Promise<void>;
  /** Rewrite stale findings from the current step results. */
  onRewrite: (turnIndex: number) => Promise<void>;
  /** Pin a step's result to a BI dashboard. */
  onPin: (turnIndex: number, stepIndex: number) => void;
  /** Ask a follow-up. */
  onAsk: (question: string) => void;
  /** Re-run a governed step under changed assumptions. */
  onScenario: (
    turnIndex: number,
    stepIndex: number,
    paramOverrides: Record<string, string>,
    filterOverrides: Record<string, string>,
  ) => Promise<void>;
  /** Governed models in scope — for their declared parameters. */
  catalog: GovernedModelFields[];
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [clarifyDraft, setClarifyDraft] = useState("");
  const [draftSql, setDraftSql] = useState("");
  const [running, setRunning] = useState(false);
  /** Which step's what-if panel is open, and the values typed into it. */
  const [scenarioAt, setScenarioAt] = useState<number | null>(null);
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({});
  const [filterDraft, setFilterDraft] = useState<Record<string, string>>({});
  const [scenarioRunning, setScenarioRunning] = useState(false);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3">
      <div className="rounded-lg bg-primary/10 px-3 py-2">
        <p className="text-sm font-medium">{turn.question}</p>
      </div>

      {turn.approach && (
        <div className="rounded-lg border border-border/60 bg-card px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Approach
          </p>
          <p className="mt-1 text-xs leading-relaxed">{turn.approach}</p>
        </div>
      )}

      {turn.steps.map((s, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-border/60 bg-card px-3 py-2">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-xs font-medium">
              <span className="text-muted-foreground">Step {i + 1} · </span>
              {s.goal}
              {["writing_sql", "running", "checking"].includes(s.status) && (
                <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin text-muted-foreground" />
              )}
              {s.edited && (
                <Badge variant="secondary" className="ml-1.5 text-[9px]">
                  edited
                </Badge>
              )}
              {s.governed && (
                <Badge
                  variant="outline"
                  className="ml-1.5 border-primary/40 bg-primary/5 text-[9px] text-primary"
                  title={
                    `Compiled from the governed model "${s.governed.model}" — the SQL below ` +
                    `comes from its definitions, not from the analyst` +
                    (s.governed.rollup ? `, answered by rollup ${s.governed.rollup}` : "") +
                    (s.governed.accessNote ? `. ${s.governed.accessNote}` : "")
                  }
                >
                  <ShieldCheck className="mr-0.5 inline h-2.5 w-2.5" />
                  {s.governed.model}
                </Badge>
              )}
            </p>
            {s.status === "done" && s.rows && s.columns && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  title="Add this result to a dashboard"
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => onPin(index, i)}
                >
                  <LayoutDashboard className="h-3.5 w-3.5" />
                </button>
                {s.governed && (
                  <button
                    type="button"
                    title="Re-run this step under a different assumption"
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => {
                      const open = scenarioAt === i ? null : i;
                      setScenarioAt(open);
                      setParamDraft({});
                      setFilterDraft({});
                    }}
                  >
                    <FlaskConical className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  title="Edit this step's SQL and re-run it"
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    setEditing(editing === i ? null : i);
                    setDraftSql(s.sql ?? "");
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          {editing === i ? (
            <div className="space-y-1.5">
              <Textarea
                value={draftSql}
                onChange={(e) => setDraftSql(e.target.value)}
                spellCheck={false}
                className="min-h-32 font-mono text-[10px] leading-relaxed"
              />
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={running || busy || !draftSql.trim()}
                  onClick={async () => {
                    setRunning(true);
                    try {
                      await onRerunStep(index, i, draftSql);
                      setEditing(null);
                    } finally {
                      setRunning(false);
                    }
                  }}
                >
                  {running ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                  Run this step
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
                <span className="text-[10px] text-muted-foreground">
                  SELECT only · the findings will need rewriting
                </span>
              </div>
            </div>
          ) : (
            s.sql && (
              <pre className="overflow-x-auto rounded bg-muted/60 p-2 font-mono text-[10px] leading-relaxed">
                {s.sql}
              </pre>
            )
          )}

          {/* What-if: the SAME governed query recompiled with one thing
              changed, so the difference is that change and nothing else. */}
          {scenarioAt === i &&
            s.governed &&
            (() => {
              const levers = scenarioLevers(
                s.semantic,
                catalog.find((m) => m.name === s.governed?.model)?.parameters ?? [],
              );
              const nothingToVary = levers.parameters.length === 0 && levers.filters.length === 0;
              return (
                <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-2">
                  {nothingToVary ? (
                    // A control that cannot change anything teaches people the
                    // feature is broken rather than inapplicable.
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      <strong>{s.governed.model}</strong> declares no parameters and this step has
                      no filters, so there is nothing a scenario could vary. Declare a parameter on
                      the model in the Semantic Layer to test an assumption.
                    </p>
                  ) : (
                    <>
                      {levers.parameters.map((p) => (
                        <label key={p.name} className="flex items-center gap-2 text-[11px]">
                          <span className="w-40 shrink-0 truncate text-muted-foreground">
                            {p.label || p.name}
                          </span>
                          <Input
                            className="h-7 text-xs"
                            placeholder={String(p.default)}
                            value={paramDraft[p.name] ?? ""}
                            onChange={(e) =>
                              setParamDraft((d) => ({ ...d, [p.name]: e.target.value }))
                            }
                          />
                        </label>
                      ))}
                      {levers.filters.map((f) => (
                        <label key={f.field} className="flex items-center gap-2 text-[11px]">
                          <span className="w-40 shrink-0 truncate text-muted-foreground">
                            {f.field} {f.op}
                          </span>
                          <Input
                            className="h-7 text-xs"
                            placeholder={String(f.value ?? "")}
                            value={filterDraft[f.field] ?? ""}
                            onChange={(e) =>
                              setFilterDraft((d) => ({ ...d, [f.field]: e.target.value }))
                            }
                          />
                        </label>
                      ))}
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs"
                          disabled={scenarioRunning || busy}
                          onClick={async () => {
                            setScenarioRunning(true);
                            try {
                              await onScenario(index, i, paramDraft, filterDraft);
                            } finally {
                              setScenarioRunning(false);
                            }
                          }}
                        >
                          {scenarioRunning ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <FlaskConical className="h-3 w-3" />
                          )}
                          Run scenario
                        </Button>
                        <span className="text-[10px] text-muted-foreground">
                          Compiled from the same model — the findings above stay as measured
                        </span>
                      </div>
                    </>
                  )}
                </div>
              );
            })()}

          {s.scenario && (
            <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
              <p className="text-[11px] font-semibold">
                {s.scenario.label}{" "}
                <span className="font-normal text-muted-foreground">
                  — not measured data; what the numbers would be under this assumption
                </span>
              </p>
              {s.scenario.delta.length > 0 && (
                <ul className="space-y-0.5 text-[11px]">
                  {s.scenario.delta.map((d) => (
                    <li key={d.metric}>
                      <strong>{d.metric}</strong>: {fmtBiValue(d.baseline)} →{" "}
                      {fmtBiValue(d.scenario)} ({d.change >= 0 ? "+" : ""}
                      {fmtBiValue(d.change)}
                      {d.pctChange === null ? "" : `, ${(d.pctChange * 100).toFixed(1)}%`})
                    </li>
                  ))}
                </ul>
              )}
              <pre className="overflow-x-auto rounded bg-muted/60 p-2 font-mono text-[10px] leading-relaxed">
                {s.scenario.sql}
              </pre>
            </div>
          )}

          {/* A rollup answering instead of the fact table, and a row filter
              narrowing what this viewer can see, both change what the number
              MEANS. The badge names the model; these say what it did. */}
          {(s.governed?.rollup || s.governed?.accessNote) && (
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {s.governed.rollup && (
                <>
                  Answered by the declared rollup <code>{s.governed.rollup}</code> rather than the
                  fact table.{" "}
                </>
              )}
              {s.governed.accessNote}
            </p>
          )}

          {s.error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px]">
              {s.error}
            </p>
          ) : (
            s.rows &&
            s.columns && (
              <>
                <p className="text-[10px] text-muted-foreground">
                  {s.rowCount} row{s.rowCount === 1 ? "" : "s"}
                  {(s.rowCount ?? 0) > s.rows.length ? ` (showing ${s.rows.length})` : ""}
                </p>
                {/* Every step that HAS a visual shows it — the analysis ran
                    several queries and each one has something to say. */}
                {s.chart && s.chart.type !== "table" && (
                  <div
                    data-analysis-chart={`${index}-${i}`}
                    className="rounded-lg border border-border/60 bg-card p-2"
                  >
                    <BiChartRender chart={s.chart} rows={s.rows} />
                  </div>
                )}
                <div className="max-h-44 overflow-auto rounded border border-border/50">
                  <table className="w-full text-left">
                    <thead>
                      <tr>
                        {s.columns.map((c) => (
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
                      {s.rows.slice(0, 8).map((row, ri) => (
                        <tr key={ri} className="border-t border-border/40">
                          {s.columns!.map((c) => (
                            <td key={c} className="px-2 py-1 font-mono text-[10px]">
                              {row[c] === null || row[c] === undefined ? "null" : String(row[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )
          )}
          {s.check && <CheckBadge verdict={s.check.verdict} note={s.check.note} />}
        </div>
      ))}

      {turn.status === "clarifying" && turn.clarify && (
        <div className="space-y-2 rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-2.5">
          <p className="flex items-start gap-1.5 text-xs font-medium">
            <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600" />
            {turn.clarify}
          </p>
          {turn.assumption && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Otherwise it will assume: {turn.assumption}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={clarifyDraft}
              onChange={(e) => setClarifyDraft(e.target.value)}
              placeholder="Answer it…"
              disabled={busy}
              className="h-7 flex-1 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter" && clarifyDraft.trim() && !busy) {
                  onAsk(`${turn.question}\n\nTo clarify: ${clarifyDraft.trim()}`);
                }
              }}
            />
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={busy || !clarifyDraft.trim()}
              onClick={() => onAsk(`${turn.question}\n\nTo clarify: ${clarifyDraft.trim()}`)}
            >
              Answer
            </Button>
            {turn.assumption && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={busy}
                onClick={() =>
                  onAsk(`${turn.question}\n\nProceed with this assumption: ${turn.assumption}`)
                }
              >
                Go with the assumption
              </Button>
            )}
          </div>
        </div>
      )}

      {turn.status !== "done" && turn.status !== "error" && turn.status !== "clarifying" && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {STATUS_LABEL[turn.status]}
        </p>
      )}

      {turn.error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2">
          <p className="text-xs">{turn.error}</p>
        </div>
      )}

      {turn.answer && (
        <div
          className={`rounded-lg border bg-card px-3 py-2.5 ${
            turn.answerStale ? "border-amber-500/50" : "border-primary/25"
          }`}
        >
          <div className="flex items-center gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Findings
            </p>
            {turn.answerStale && (
              <>
                <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-[9px]">
                  written before a step was re-run
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-6 gap-1 px-2 text-[10px]"
                  disabled={busy}
                  onClick={() => void onRewrite(index)}
                >
                  <RefreshCw className="h-3 w-3" /> Rewrite findings
                </Button>
              </>
            )}
          </div>
          <div className="mt-1.5 text-sm">
            <MarkdownMessage content={turn.answer} />
          </div>
        </div>
      )}

      {turn.status === "done" && (turn.followUps?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Ask next
          </span>
          {turn.followUps!.map((q) => (
            <button
              key={q}
              type="button"
              disabled={busy}
              onClick={() => onAsk(q)}
              className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] transition hover:border-primary/50 hover:bg-primary/5 disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
