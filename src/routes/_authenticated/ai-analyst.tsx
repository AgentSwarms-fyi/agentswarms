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
  FileDown,
  Loader2,
  MessageSquarePlus,
  Plus,
  Send,
  Trash2,
  Wrench,
} from "lucide-react";

import { BiChartRender } from "@/components/bi/BiChartRender";
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
  isReasoningModelId,
  runAnalystTurn,
  trimTurnForStorage,
  type AnalystSource,
  type AnalystTurn,
} from "@/lib/aiAnalyst";
import {
  loadSavedMetrics,
  loadSemantics,
  type SavedMetric,
  type SemanticEntry,
} from "@/lib/biAgent";
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
};

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
  error: "Failed",
};

function AiAnalystPage() {
  const { user, session } = useAuth();
  const token = session?.access_token;
  const listWarehousesFn = useServerFn(listWarehouseConnections);

  // ── Data the analysts can be scoped to ──────────────────────────────
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
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
        ]);
        setSemantics(sem);
        setMetrics(mets);
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
  const [threadLoading, setThreadLoading] = useState(false);
  const [liveTurn, setLiveTurn] = useState<AnalystTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setThread(null);
    setLiveTurn(null);
    if (!selectedId) return;
    setThreadLoading(true);
    supabase
      .from("ai_analyst_threads")
      .select("id, analyst_id, title, turns")
      .eq("analyst_id", selectedId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .then(({ data, error }) => {
        setThreadLoading(false);
        if (error) return toast.error(error.message);
        const row = data?.[0];
        if (row) setThread({ ...row, turns: (row.turns ?? []) as AnalystTurn[] } as ThreadRow);
      });
  }, [selectedId]);

  // Keep the newest content in view while a turn streams in.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [liveTurn, thread]);

  // ── Ask ─────────────────────────────────────────────────────────────
  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || busy || !selected || !user?.id) return;

    // Resolve the analyst's pinned scope into datasets + an executor.
    let scopeDatasets: DatasetMeta[];
    let scopeSemantics: Map<string, SemanticEntry>;
    let scopeMetrics: SavedMetric[];
    let execute: ((sql: string) => Promise<QueryResult>) | undefined;
    let dialect: string | undefined;

    if (selected.source.kind === "warehouse") {
      if (!token) return toast.error("Not signed in");
      const connId = selected.source.connection_id;
      const conn = warehouses.find((w) => w.id === connId);
      if (!conn) return toast.error("This analyst's warehouse connection is gone — recreate it.");
      try {
        let tables = whSchemaCache.current.get(connId);
        if (!tables) {
          tables = await fetchWarehouseSchema(token, connId);
          whSchemaCache.current.set(connId, tables);
        }
        scopeDatasets = warehouseTablesAsDatasets(connId, tables, user.id);
      } catch (e) {
        return toast.error(`Could not load the warehouse schema: ${(e as Error).message}`);
      }
      scopeSemantics = new Map();
      scopeMetrics = [];
      execute = (sql: string) => runWarehouseQuery(token, connId, sql);
      dialect = WAREHOUSE_LABELS[conn.provider];
    } else {
      const wanted = selected.source.tables;
      scopeDatasets =
        wanted.length === 0 ? datasets : datasets.filter((d) => wanted.includes(d.name));
      if (scopeDatasets.length === 0) {
        return toast.error(
          wanted.length === 0
            ? "No local datasets yet — upload data on the Data Catalog page first."
            : `The dataset "${wanted[0]}" no longer exists.`,
        );
      }
      const ids = new Set(scopeDatasets.map((d) => d.id));
      scopeSemantics = new Map([...semantics].filter(([id]) => ids.has(id)));
      scopeMetrics = metrics;
    }

    setQuestion("");
    setBusy(true);
    try {
      const turn = await runAnalystTurn({
        question: q,
        datasets: scopeDatasets,
        semantics: scopeSemantics,
        metrics: scopeMetrics,
        priorTurns: thread?.turns ?? [],
        model: selected.model,
        execute,
        dialect,
        onUpdate: setLiveTurn,
      });
      // Persist the finished turn (including failures — the trace is the
      // record), then fold it into the rendered thread.
      const stored = trimTurnForStorage(turn);
      const nextTurns = [...(thread?.turns ?? []), stored];
      if (thread) {
        const { error } = await supabase
          .from("ai_analyst_threads")
          .update({ turns: nextTurns as never, updated_at: new Date().toISOString() })
          .eq("id", thread.id);
        if (error) toast.error(`The analysis ran but could not be saved: ${error.message}`);
        setThread({ ...thread, turns: nextTurns });
      } else {
        const { data, error } = await supabase
          .from("ai_analyst_threads")
          .insert({
            analyst_id: selected.id,
            user_id: user.id,
            title: q.slice(0, 80),
            turns: nextTurns as never,
          })
          .select("id, analyst_id, title, turns")
          .single();
        if (error) {
          toast.error(`The analysis ran but could not be saved: ${error.message}`);
          setThread({ id: "unsaved", analyst_id: selected.id, title: q, turns: nextTurns });
        } else {
          setThread({ ...data, turns: (data.turns ?? []) as AnalystTurn[] } as ThreadRow);
        }
      }
      setLiveTurn(null);
    } finally {
      setBusy(false);
    }
  }, [question, busy, selected, user?.id, token, warehouses, datasets, semantics, metrics, thread]);

  // ── Analyst CRUD ────────────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftData, setDraftData] = useState("");

  async function createAnalyst() {
    if (!user?.id || !draftModel || !draftData) return;
    const source: AnalystSource = draftData.startsWith("wh:")
      ? { kind: "warehouse", connection_id: draftData.slice(3) }
      : { kind: "local", tables: draftData === "local:all" ? [] : [draftData.slice(6)] };
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
        model: selected.model.split("::").pop() ?? selected.model,
        sourceText: sourceLabel(selected.source, warehouses).text,
        turns: turnsToRender,
        chartElFor: (i) =>
          threadRef.current?.querySelector<HTMLElement>(`[data-analysis-chart="${i}"]`) ?? null,
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
          <Button size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setCreateOpen(true)}>
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
            <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
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
                    on every result, and the write-up. Try “what drives revenue?” or “compare this
                    quarter to last”.
                  </p>
                </div>
              ) : (
                turnsToRender.map((t, ti) => <TurnView key={ti} turn={t} index={ti} />)
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

      {/* New analyst — exactly two choices: the model and the data. */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New analyst</DialogTitle>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createAnalyst()} disabled={!draftModel || !draftData}>
              Create analyst
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

function TurnView({ turn, index }: { turn: AnalystTurn; index: number }) {
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
          <p className="text-xs font-medium">
            <span className="text-muted-foreground">Step {i + 1} · </span>
            {s.goal}
            {["writing_sql", "running", "checking"].includes(s.status) && (
              <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin text-muted-foreground" />
            )}
          </p>
          {s.sql && (
            <pre className="overflow-x-auto rounded bg-muted/60 p-2 font-mono text-[10px] leading-relaxed">
              {s.sql}
            </pre>
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

      {turn.status !== "done" && turn.status !== "error" && (
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
        <div className="rounded-lg border border-primary/25 bg-card px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Findings
          </p>
          <div className="mt-1.5 text-sm">
            <MarkdownMessage content={turn.answer} />
          </div>
        </div>
      )}

      {turn.chart && turn.chartStep !== undefined && turn.steps[turn.chartStep]?.rows && (
        <div data-analysis-chart={index} className="rounded-lg border border-border/60 bg-card p-2">
          <BiChartRender chart={turn.chart} rows={turn.steps[turn.chartStep].rows!} />
        </div>
      )}
    </div>
  );
}
