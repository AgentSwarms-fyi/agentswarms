import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { traceCountHeadline, windowComplete } from "@/lib/traceWindow";
import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { formatMs } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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
  Search,
  ScrollText,
  ChevronLeft,
  ChevronRight,
  Wrench,
  BookOpen,
  Download,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  getExecutionTraceDetail,
  getExecutionTraces,
  type ExecutionTraceRow,
} from "@/utils/traceLog.functions";
import {
  getDecision,
  getPassportForDecision,
  replayDecision,
  type DecisionChain,
} from "@/utils/provenance.functions";
import { isDataRead } from "@/utils/provenance/actions";
import type { ReplayResult } from "@/utils/provenance/replay.server";

export const Route = createFileRoute("/_authenticated/traces")({
  component: TracesPage,
});

type Trace = ExecutionTraceRow;

const PAGE_SIZE = 25;

function TracesPage() {
  const { user, session } = useAuth();
  const fetchTraces = useServerFn(getExecutionTraces);
  const fetchTraceDetail = useServerFn(getExecutionTraceDetail);
  const fetchDecision = useServerFn(getDecision);
  const fetchPassport = useServerFn(getPassportForDecision);
  const runReplay = useServerFn(replayDecision);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [modelFilter, setModelFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [rangeFilter, setRangeFilter] = useState<string>("90d");
  const [notebooksOnly, setNotebooksOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Trace | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // "Where did this come from?" — everything the decision touched, keyed by
  // the id stamped on this trace. Loaded per selection, never blocks the sheet.
  const [chain, setChain] = useState<DecisionChain | null>(null);
  // Counted with the SAME predicate the passport uses, so the screen and the
  // exported document can never disagree about how many reads there were.
  const readCount = chain?.events.filter((e) => isDataRead(e.action)).length ?? 0;
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [replaying, setReplaying] = useState(false);
  useEffect(() => {
    const id = selected?.decision_id;
    setChain(null);
    setReplay(null);
    if (!id) return;
    let live = true;
    fetchDecision({ data: { decisionId: id } })
      .then((c) => {
        if (live) setChain(c);
      })
      .catch(() => {
        if (live) setChain(null);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.decision_id]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The exact row count for the active range. The fetch is capped (PostgREST
  // max-rows), so without this the header presents the loaded window as the
  // population — "1,000 traces" to an account holding 2,773.
  const [exactTotal, setExactTotal] = useState(0);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const days =
      rangeFilter === "1d" ? 1 : rangeFilter === "7d" ? 7 : rangeFilter === "30d" ? 30 : 90;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    if (!session?.access_token) {
      setTraces([]);
      setLoadError("Your session is still loading. Please retry in a moment.");
      setLoading(false);
      return;
    }
    try {
      const result = await fetchTraces({ data: { accessToken: session.access_token, days } });
      if (result.ok) {
        setTraces(result.traces as Trace[]);
        setExactTotal(result.total);
      } else {
        throw new Error(result.error);
      }
    } catch (serverError) {
      const { data, error } = await supabase
        .from("execution_traces")
        .select(
          "id, agent_name, llm_provider, llm_model, latency_ms, tokens_in, tokens_out, cost_usd, status, prompt, error_message, created_at, parent_trace_id, pricing_missing:request_payload->>pricing_missing",
        )
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) {
        console.error("Failed to load traces", serverError, error);
        setLoadError(error.message);
        setTraces([]);
      } else {
        setTraces((data ?? []) as Trace[]);
        // Fallback path: same honesty, from the client. A failed count is not
        // worth failing the page over — rows on screen beat a perfect label —
        // but then the label claims only what it holds.
        const { count } = await supabase
          .from("execution_traces")
          .select("id", { count: "exact", head: true })
          .gte("created_at", since);
        setExactTotal(count ?? (data ?? []).length);
      }
    }
    setLoading(false);
  };

  const openTrace = async (trace: Trace) => {
    setSelected(trace);
    setDetailError(null);
    if (!session?.access_token) return;
    setDetailLoading(true);
    try {
      const result = await fetchTraceDetail({
        data: { accessToken: session.access_token, id: trace.id },
      });
      if (result.ok && result.trace) {
        setSelected(result.trace as Trace);
      } else if (!result.ok) {
        setDetailError(result.error);
      }
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Couldn’t load trace details");
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    load();
  }, [user, session?.access_token, rangeFilter]);

  const models = useMemo(
    () => Array.from(new Set(traces.map((t) => t.llm_model))).sort(),
    [traces],
  );
  const agents = useMemo(
    () => Array.from(new Set(traces.map((t) => t.agent_name))).sort(),
    [traces],
  );

  const isNotebookTrace = (name: string) =>
    name.startsWith("Notebook[") || name === "Notebook: AI Chat" || name === "Notebook: Embeddings";

  const notebookCount = useMemo(
    () => traces.filter((t) => isNotebookTrace(t.agent_name)).length,
    [traces],
  );

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    const matches = (t: Trace) => {
      if (notebooksOnly && !isNotebookTrace(t.agent_name)) return false;
      if (modelFilter !== "all" && t.llm_model !== modelFilter) return false;
      if (agentFilter !== "all" && t.agent_name !== agentFilter) return false;
      if (s && !`${t.agent_name} ${t.llm_model} ${t.prompt ?? ""}`.toLowerCase().includes(s))
        return false;
      return true;
    };
    // Child traces (tool rounds inside a chat turn) render indented under
    // their parent rather than interleaved with unrelated turns. A child
    // whose parent isn't in the loaded window falls back to a normal row.
    const loadedIds = new Set(traces.map((t) => t.id));
    const childrenOf = new Map<string, Trace[]>();
    for (const t of traces) {
      const pid = (t as Trace & { parent_trace_id?: string | null }).parent_trace_id;
      if (pid && loadedIds.has(pid)) {
        const list = childrenOf.get(pid) ?? [];
        list.push(t);
        childrenOf.set(pid, list);
      }
    }
    const out: (Trace & {
      isChild?: boolean;
      rollup?: {
        tokens_in: number;
        tokens_out: number;
        cost_usd: number;
        rounds: number;
        unpriced: boolean;
      };
    })[] = [];
    const isUnpriced = (row: Trace) => row.pricing_missing === "true";
    for (const t of traces) {
      const pid = (t as Trace & { parent_trace_id?: string | null }).parent_trace_id;
      if (pid && loadedIds.has(pid)) continue; // rendered under its parent
      if (!matches(t)) continue;
      const kids = (childrenOf.get(t.id) ?? []).slice().reverse(); // oldest round first
      if (kids.length > 0) {
        // Parent rows show the WHOLE TURN: their own usage plus every tool
        // round's. Billing-wise the split is deliberate (replayed finals keep
        // the parent's columns at zero so children carry the cost exactly
        // once); without this display roll-up an agent turn looked like it
        // cost nothing.
        out.push({
          ...t,
          rollup: {
            tokens_in: t.tokens_in + kids.reduce((s, k) => s + (k.tokens_in || 0), 0),
            tokens_out: t.tokens_out + kids.reduce((s, k) => s + (k.tokens_out || 0), 0),
            cost_usd:
              Number(t.cost_usd || 0) + kids.reduce((s, k) => s + Number(k.cost_usd || 0), 0),
            rounds: kids.length,
            // A turn containing any unpriced round has a PARTIAL total — say
            // so rather than presenting the sum as complete.
            unpriced: isUnpriced(t) || kids.some(isUnpriced),
          },
        });
      } else {
        out.push(t);
      }
      for (const k of kids) out.push({ ...k, isChild: true });
    }
    return out;
  }, [traces, search, modelFilter, agentFilter, notebooksOnly]);

  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const hasClientFilters =
    search.trim() !== "" || modelFilter !== "all" || agentFilter !== "all" || notebooksOnly;
  const rangeLabel =
    rangeFilter === "1d"
      ? "the last day"
      : rangeFilter === "7d"
        ? "the last 7 days"
        : rangeFilter === "30d"
          ? "the last 30 days"
          : "the last 90 days";

  useEffect(() => {
    setPage(0);
  }, [search, modelFilter, agentFilter, rangeFilter, notebooksOnly]);

  if (loading && traces.length === 0) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-12" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (!loading && traces.length === 0) {
    return (
      <div className="p-6">
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          Observability
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight mb-1">Traces & Logs</h1>
        <p className="text-muted-foreground mb-6">Granular logs from every agent execution.</p>
        <EmptyState
          icon={ScrollText}
          title={loadError ? "Couldn’t load traces" : "No traces yet"}
          description={
            loadError
              ? loadError
              : "Traces are captured automatically when you run agents in the Playground. Swarm traces stay in Swarm Observability."
          }
          action={
            <Button variant="outline" onClick={load} disabled={loading}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Observability
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Traces & Logs</h1>
          <p className="text-muted-foreground mt-1">
            {hasClientFilters
              ? `${filtered.length.toLocaleString()} of the ${traces.length.toLocaleString()} loaded traces match · click any row for details`
              : `${traceCountHeadline({ fetched: traces.length, total: exactTotal }, rangeLabel)} · click any row for details`}
          </p>
          {!windowComplete({ fetched: traces.length, total: exactTotal }) && (
            <p className="mt-0.5 text-xs text-warning">
              Only the most recent {traces.length.toLocaleString()} are loaded — filters and counts
              below cover these, not all {exactTotal.toLocaleString()}. Narrow the date range for a
              complete window.
            </p>
          )}
        </div>
      </div>

      {/* Filters */}
      <Card className="p-3">
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search prompt, agent, model..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
            />
          </div>
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="h-9 w-40">
              <SelectValue placeholder="Agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={modelFilter} onValueChange={setModelFilter}>
            <SelectTrigger className="h-9 w-48">
              <SelectValue placeholder="Model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All models</SelectItem>
              {models.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={rangeFilter} onValueChange={setRangeFilter}>
            <SelectTrigger className="h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1d">Last 24h</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="90d">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant={notebooksOnly ? "default" : "outline"}
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => setNotebooksOnly((v) => !v)}
            title="Show only traces from Notebooks"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Notebooks
            {notebookCount > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                {notebookCount}
              </Badge>
            )}
          </Button>
        </div>
      </Card>

      {/* Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40 [&_th]:h-9 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
              <TableHead className="w-[140px]">Timestamp</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-center w-[90px]">Status</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((t) => (
              <TableRow
                key={t.id}
                onClick={() => void openTrace(t)}
                className="cursor-pointer border-b border-border/40 transition-colors odd:bg-muted/20 hover:bg-primary/5"
              >
                <TableCell className="text-xs text-muted-foreground font-mono tabular-nums">
                  {format(new Date(t.created_at), "MMM dd HH:mm:ss")}
                </TableCell>
                <TableCell
                  className={
                    (t as Trace & { isChild?: boolean }).isChild
                      ? "pl-8 text-xs text-muted-foreground"
                      : "text-sm font-medium"
                  }
                >
                  {(t as Trace & { isChild?: boolean }).isChild
                    ? `↳ ${t.agent_name}`
                    : t.agent_name}
                </TableCell>
                <TableCell className="text-xs font-mono text-muted-foreground">
                  {t.llm_model}
                </TableCell>
                <TableCell className="text-right text-xs font-mono tabular-nums">
                  {formatMs(t.latency_ms)}
                </TableCell>
                <TableCell
                  className="text-right text-xs font-mono tabular-nums"
                  title={
                    (t as { rollup?: { rounds: number } }).rollup
                      ? `Whole turn incl. ${(t as { rollup: { rounds: number } }).rollup.rounds} tool round(s)`
                      : undefined
                  }
                >
                  <span className="text-muted-foreground">
                    {(t as { rollup?: { tokens_in: number } }).rollup?.tokens_in ?? t.tokens_in}
                  </span>
                  <span className="text-muted-foreground/50 mx-0.5">/</span>
                  <span>
                    {(t as { rollup?: { tokens_out: number } }).rollup?.tokens_out ?? t.tokens_out}
                  </span>
                </TableCell>
                <TableCell className="text-center">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      t.status === "success"
                        ? "bg-success/10 text-success"
                        : t.status === "cancelled"
                          ? "bg-muted text-muted-foreground"
                          : "bg-destructive/10 text-destructive"
                    }`}
                  >
                    {t.status === "success" ? "ok" : t.status === "cancelled" ? "stopped" : "error"}
                  </span>
                </TableCell>
                <TableCell className="text-right text-xs font-mono tabular-nums">
                  {(() => {
                    const rollup = (t as { rollup?: { cost_usd: number; unpriced: boolean } })
                      .rollup;
                    const unpriced = rollup ? rollup.unpriced : t.pricing_missing === "true";
                    const amount = Number(rollup?.cost_usd ?? t.cost_usd);
                    // $0.0000 for a call nothing knew how to price reads as
                    // "free", and budgets summed exactly that. Label the gap.
                    if (unpriced && amount === 0) {
                      return (
                        <span
                          className="text-amber-600 dark:text-amber-400"
                          title="No price is known for this model — the amount is missing, not zero. The maintenance pass re-prices it once a rate is known."
                        >
                          unpriced
                        </span>
                      );
                    }
                    return (
                      <span
                        title={
                          unpriced
                            ? "Partial: this turn includes calls whose model has no known price."
                            : undefined
                        }
                      >
                        ${amount.toFixed(4)}
                        {unpriced ? "+?" : ""}
                      </span>
                    );
                  })()}
                </TableCell>
              </TableRow>
            ))}
            {paged.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-sm text-muted-foreground">
                  No traces match these filters
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground">
              Page {page + 1} of {totalPages} · {filtered.length} results
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Detail Sheet */}
      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-2xl p-0 flex flex-col h-full">
          {selected && (
            <>
              <SheetHeader className="border-b border-border p-4 shrink-0">
                <SheetTitle className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${selected.status === "success" ? "bg-emerald-500" : selected.status === "cancelled" ? "bg-muted-foreground" : "bg-red-500"}`}
                  />
                  Trace Details
                  <Badge variant="outline" className="ml-2 text-[10px] font-mono">
                    {selected.id.slice(0, 8)}
                  </Badge>
                </SheetTitle>
                <SheetDescription className="text-xs">
                  {selected.agent_name} · {selected.llm_model} ·{" "}
                  {format(new Date(selected.created_at), "PPpp")}
                </SheetDescription>
              </SheetHeader>

              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="p-4 space-y-4 min-w-0">
                  {/* Metrics row */}
                  <div className="grid grid-cols-4 gap-2">
                    <Metric label="Latency" value={formatMs(selected.latency_ms)} />
                    <Metric label="Tokens In" value={selected.tokens_in.toLocaleString()} />
                    <Metric label="Tokens Out" value={selected.tokens_out.toLocaleString()} />
                    <Metric
                      label="Cost"
                      value={
                        selected.pricing_missing === "true" && Number(selected.cost_usd) === 0
                          ? "unpriced"
                          : `$${Number(selected.cost_usd).toFixed(4)}`
                      }
                    />
                  </div>

                  {selected.error_message && (
                    <Section title="Error">
                      <pre className="bg-destructive/10 border border-destructive/30 rounded-md p-3 text-xs text-destructive font-mono whitespace-pre-wrap break-all">
                        {selected.error_message}
                      </pre>
                    </Section>
                  )}

                  {selected.prompt && (
                    <Section title="Prompt">
                      <div className="bg-muted/40 rounded-md p-3 text-xs whitespace-pre-wrap break-words">
                        {selected.prompt}
                      </div>
                    </Section>
                  )}

                  {chain && (
                    <Section title="Provenance">
                      <div className="space-y-2 text-xs">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="font-mono text-muted-foreground">
                            decision {chain.decision.id.slice(0, 8)}
                          </span>
                          <span className="rounded bg-muted px-1.5 py-0.5">
                            {chain.decision.kind.replace("_", " ")}
                          </span>
                          {chain.reproducible ? (
                            <span
                              className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-400"
                              title="The lakehouse snapshot this answer saw is recorded; its queries can be re-run against it."
                            >
                              reproducible · snapshot {chain.decision.lakehouse_snapshot_id}
                            </span>
                          ) : (
                            <span
                              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400"
                              title="No lakehouse snapshot was recorded, so this answer is recorded but cannot be re-run as of that moment."
                            >
                              recorded, not reproducible
                            </span>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground">
                            {chain.traces.length} model turn
                            {chain.traces.length === 1 ? "" : "s"} · {readCount} data read
                            {readCount === 1 ? "" : "s"}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            onClick={async () => {
                              try {
                                const p = await fetchPassport({
                                  data: { decisionId: chain.decision.id },
                                });
                                if (!p) return toast.error("Passport unavailable");
                                // The SIGNED bytes are what gets saved, with the
                                // signature beside them — a recipient must be able
                                // to verify without this instance re-deriving
                                // anything, so the canonical form is the artifact.
                                const file = JSON.stringify(
                                  {
                                    passport: JSON.parse(p.canonical),
                                    signature: p.signature,
                                    algorithm: p.algorithm,
                                    canonical: p.canonical,
                                  },
                                  null,
                                  2,
                                );
                                const url = URL.createObjectURL(
                                  new Blob([file], { type: "application/json" }),
                                );
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = `answer-passport-${chain.decision.id.slice(0, 8)}.json`;
                                a.click();
                                URL.revokeObjectURL(url);
                                toast.success(
                                  p.signature
                                    ? "Passport downloaded (signed)"
                                    : "Passport downloaded (unsigned)",
                                );
                              } catch (e) {
                                toast.error((e as Error).message);
                              }
                            }}
                          >
                            <Download className="mr-1 h-3 w-3" /> Passport
                          </Button>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            disabled={replaying || readCount === 0}
                            onClick={async () => {
                              setReplaying(true);
                              try {
                                const r = await runReplay({
                                  data: { decisionId: chain.decision.id },
                                });
                                setReplay(r);
                                if (!r) toast.error("Replay unavailable");
                                else if (r.summary.unfaithful > 0)
                                  toast.error(
                                    `${r.summary.unfaithful} read(s) do not match the record`,
                                  );
                                else if (r.summary.movedSince > 0)
                                  toast.warning(
                                    `${r.summary.movedSince} read(s) return different data today`,
                                  );
                                else if (r.summary.replayed > 0)
                                  toast.success("Replayed — the data still matches");
                                else toast.info("Nothing on this decision could be replayed");
                              } catch (e) {
                                toast.error((e as Error).message);
                              } finally {
                                setReplaying(false);
                              }
                            }}
                          >
                            <RotateCcw className="mr-1 h-3 w-3" />
                            {replaying ? "Replaying…" : "Replay reads"}
                          </Button>
                          <span className="text-[10px] text-muted-foreground">
                            re-runs the recorded queries — against the original snapshot, and
                            against today
                          </span>
                        </div>
                        {replay && (
                          <div className="space-y-1 rounded-md border border-dashed p-2">
                            {replay.reads.map((r) => (
                              <div key={r.eventId} className="text-[11px]">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-mono font-semibold">{r.action}</span>
                                  {r.asOf?.matchesRecord === true && (
                                    <span className="text-green-600 dark:text-green-500">
                                      matches the record
                                    </span>
                                  )}
                                  {r.asOf?.matchesRecord === false && (
                                    <span className="font-semibold text-destructive">
                                      does NOT match the record
                                    </span>
                                  )}
                                  {r.asOf?.matchesRecord === null && !r.asOf.error && (
                                    <span className="text-muted-foreground">
                                      re-ran; nothing to compare against
                                    </span>
                                  )}
                                  {!r.asOf && (
                                    <span className="text-muted-foreground">not replayable</span>
                                  )}
                                </div>
                                {r.current?.matchesRecord === false && (
                                  <div className="text-amber-600 dark:text-amber-500">
                                    returns different data today than when the answer was given
                                  </div>
                                )}
                                {r.current?.matchesRecord === true && (
                                  <div className="text-muted-foreground">
                                    unchanged since the answer was given
                                  </div>
                                )}
                                {r.current?.matchesRecord === null &&
                                  !r.current.error &&
                                  r.recordedDigest !== null && (
                                    <div className="text-muted-foreground">
                                      the fingerprint recorded for this read is in an older format,
                                      so today&rsquo;s result cannot be compared to it
                                    </div>
                                  )}
                                {(r.reason || r.current?.error) && (
                                  <div className="text-muted-foreground">
                                    {r.reason ?? r.current?.error}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {chain.events.length > 0 && (
                          <div className="space-y-1">
                            {chain.events.map((e) => {
                              const d = (e.detail ?? {}) as Record<string, unknown>;
                              const tables = Array.isArray(d.tables) ? (d.tables as string[]) : [];
                              return (
                                <div key={e.id} className="rounded-md bg-muted/40 p-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-mono font-semibold">
                                      {e.action}
                                      {!isDataRead(e.action) && (
                                        <span className="ml-1 font-sans text-[10px] font-normal text-muted-foreground">
                                          (not a data read)
                                        </span>
                                      )}
                                    </span>
                                    <span className="text-muted-foreground">
                                      {e.resource_name ?? e.resource_type ?? ""}
                                    </span>
                                  </div>
                                  {(tables.length > 0 || typeof d.via === "string") && (
                                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                                      {tables.length > 0 && <>tables: {tables.join(", ")}</>}
                                      {tables.length > 0 && typeof d.via === "string" && " · "}
                                      {typeof d.via === "string" && <>via {d.via}</>}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {readCount === 0 && (
                          <div className="text-muted-foreground">
                            No data reads were recorded for this decision.
                          </div>
                        )}
                      </div>
                    </Section>
                  )}

                  {detailLoading && (
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-24 w-full" />
                    </div>
                  )}

                  {detailError && (
                    <Section title="Details">
                      <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3 text-xs text-destructive font-mono whitespace-pre-wrap break-all">
                        {detailError}
                      </div>
                    </Section>
                  )}

                  {Array.isArray(selected.tool_calls) && selected.tool_calls.length > 0 && (
                    <Section title={`Tool Calls (${selected.tool_calls.length})`}>
                      <div className="space-y-1.5">
                        {selected.tool_calls.map((tc: any, i: number) => (
                          <div
                            key={i}
                            className="flex items-start gap-2 bg-muted/40 rounded-md p-2"
                          >
                            <Wrench className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-mono font-semibold break-all">{tc.name}</p>
                              <pre className="text-[10px] text-muted-foreground font-mono mt-0.5 whitespace-pre-wrap break-all">
                                {JSON.stringify(tc.arguments, null, 2)}
                              </pre>
                            </div>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}

                  {selected.request_payload !== undefined && (
                    <Section title="Request Payload">
                      <pre className="bg-background border border-border rounded-md p-3 text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all max-w-full">
                        {JSON.stringify(selected.request_payload, null, 2)}
                      </pre>
                    </Section>
                  )}

                  {selected.response_payload !== undefined && (
                    <Section title="Response Payload">
                      <pre className="bg-background border border-border rounded-md p-3 text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all max-w-full">
                        {JSON.stringify(selected.response_payload, null, 2)}
                      </pre>
                    </Section>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/40 rounded-md p-2">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-sm font-mono font-semibold mt-0.5">{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
        {title}
      </h4>
      {children}
    </div>
  );
}
