import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TraceFlowCanvas } from "@/components/observability/TraceFlowCanvas";
import { format } from "date-fns";
import { ArrowLeft, GitBranch, ListOrdered } from "lucide-react";

export const Route = createFileRoute("/_authenticated/analytics_/observability/$runId")({
  component: TraceDetail,
});

type Run = {
  id: string;
  swarm_name: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  input_prompt: string | null;
  final_output: string | null;
  total_latency_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  step_count: number;
  error_count: number;
  error_message: string | null;
  swarm_snapshot: {
    nodes?: Array<{ id: string; data?: { label?: string } }>;
    edges?: Array<{ source: string; target: string }>;
  } | null;
};

type Step = {
  id: string;
  node_id: string;
  node_label: string | null;
  node_kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  latency_ms: number;
  input: unknown;
  output: string | null;
  thinking: string | null;
  tool_calls: unknown[];
  memory_used: unknown[];
  rag_chunks: unknown[];
  data_extractions: unknown[];
  llm_provider: string | null;
  llm_model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error_message: string | null;
};

type Edge = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  payload_preview: string | null;
  bytes: number;
  created_at: string;
};

function TraceDetail() {
  const { runId } = Route.useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedStep, setSelectedStep] = useState<Step | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const [r, s, e] = await Promise.all([
        supabase.from("swarm_runs").select("*").eq("id", runId).maybeSingle(),
        supabase.from("swarm_run_steps").select("*").eq("run_id", runId).order("started_at"),
        supabase.from("swarm_run_edges").select("*").eq("run_id", runId).order("created_at"),
      ]);
      setRun((r.data as Run) ?? null);
      setSteps((s.data ?? []) as Step[]);
      setEdges((e.data ?? []) as Edge[]);
      setLoading(false);
    })();
  }, [runId]);

  if (loading)
    return (
      <div className="p-6">
        <Skeleton className="h-64" />
      </div>
    );
  if (!run) return <div className="p-6 text-sm text-muted-foreground">Run not found.</div>;

  const startedAt = new Date(run.started_at).getTime();
  const totalDuration = Math.max(
    1,
    run.total_latency_ms || (run.finished_at ? new Date(run.finished_at).getTime() - startedAt : 1),
  );

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Link
          to="/analytics/observability"
          className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All runs
        </Link>
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          Observability
        </p>
        <h1 className="font-display text-2xl font-semibold tracking-tight flex items-center gap-2">
          {run.swarm_name ?? "Untitled swarm"}
          <Badge
            variant="outline"
            className={
              run.status === "success"
                ? "border-emerald-500/40 text-emerald-500"
                : run.status === "error"
                  ? "border-red-500/40 text-red-500"
                  : "border-amber-500/40 text-amber-500"
            }
          >
            {run.status}
          </Badge>
        </h1>
        <p className="text-xs text-muted-foreground mt-1 font-mono">
          {format(new Date(run.started_at), "PPpp")} · run {run.id.slice(0, 8)}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <Metric label="Steps" value={String(run.step_count)} />
        <Metric label="Errors" value={String(run.error_count)} />
        <Metric label="Duration" value={`${run.total_latency_ms}ms`} />
        <Metric label="Tokens in" value={run.total_tokens_in.toLocaleString()} />
        <Metric label="Tokens out" value={run.total_tokens_out.toLocaleString()} />
        <Metric label="Cost" value={`$${Number(run.total_cost_usd).toFixed(4)}`} />
      </div>

      {run.input_prompt && (
        <Card className="p-3">
          <p className="text-[10px] uppercase text-muted-foreground mb-1">Input</p>
          <p className="text-xs whitespace-pre-wrap">{run.input_prompt}</p>
        </Card>
      )}
      {run.error_message && (
        <Card className="p-3 border-red-500/30 bg-red-500/5">
          <p className="text-[10px] uppercase text-red-400 mb-1">Error</p>
          <p className="text-xs font-mono whitespace-pre-wrap text-red-400">{run.error_message}</p>
        </Card>
      )}

      <Tabs defaultValue="canvas" className="w-full">
        <TabsList>
          <TabsTrigger value="canvas">
            <GitBranch className="h-3.5 w-3.5 mr-1" /> Canvas
          </TabsTrigger>
          <TabsTrigger value="timeline">
            <ListOrdered className="h-3.5 w-3.5 mr-1" /> Timeline
          </TabsTrigger>
          <TabsTrigger value="dataflow">Data flow ({edges.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="canvas" className="mt-3">
          <TraceFlowCanvas
            snapshot={run.swarm_snapshot}
            steps={steps}
            edges={edges}
            onSelectStep={(s) => setSelectedStep(s as Step)}
          />
          <p className="text-[10px] text-muted-foreground mt-2">
            Solid edges fired during this run · animated edges flowed successfully · dashed edges
            were configured but not taken (e.g. condition routed away).
          </p>
        </TabsContent>

        <TabsContent value="timeline" className="mt-3">
          <Card>
            <div className="px-4 py-2 border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
              Execution timeline · click any step to dig in
            </div>
            <div className="divide-y divide-border">
              {steps.map((s) => {
                const offset =
                  ((new Date(s.started_at).getTime() - startedAt) / totalDuration) * 100;
                const width = Math.max(1, (s.latency_ms / totalDuration) * 100);
                return (
                  <button
                    key={s.id}
                    onClick={() => setSelectedStep(s)}
                    className="w-full text-left px-4 py-2.5 hover:bg-muted/40 grid grid-cols-12 gap-2 items-center"
                  >
                    <div className="col-span-3 min-w-0">
                      <p className="text-sm font-medium truncate">{s.node_label ?? s.node_id}</p>
                      <p className="text-[10px] text-muted-foreground font-mono truncate">
                        {s.node_kind} · {s.llm_model ?? "—"}
                      </p>
                    </div>
                    <div className="col-span-6 relative h-5 bg-muted/30 rounded">
                      <div
                        className={
                          "absolute top-0 bottom-0 rounded " +
                          (s.status === "success"
                            ? "bg-emerald-500/60"
                            : s.status === "error"
                              ? "bg-red-500/60"
                              : s.status === "skipped"
                                ? "bg-muted-foreground/30"
                                : "bg-amber-500/60")
                        }
                        style={{
                          left: `${Math.min(99, offset)}%`,
                          width: `${Math.min(100 - offset, width)}%`,
                        }}
                      />
                    </div>
                    <div className="col-span-3 text-right text-[11px] font-mono text-muted-foreground">
                      {s.latency_ms}ms · {s.tokens_in}/{s.tokens_out} tok · $
                      {Number(s.cost_usd).toFixed(4)}
                    </div>
                  </button>
                );
              })}
              {steps.length === 0 && (
                <p className="text-sm text-muted-foreground p-6 text-center">No steps recorded.</p>
              )}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="dataflow" className="mt-3">
          {edges.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6 text-center">No edges fired.</p>
          ) : (
            <Card className="p-3">
              <div className="space-y-1 text-xs font-mono">
                {edges.map((e) => (
                  <div key={e.id} className="flex items-center gap-2">
                    <span className="text-muted-foreground">{e.source_node_id}</span>
                    <span className="text-primary">→</span>
                    <span className="text-muted-foreground">{e.target_node_id}</span>
                    <span className="text-[10px] text-muted-foreground/70 ml-auto">{e.bytes}b</span>
                    {e.payload_preview && (
                      <span className="truncate max-w-[40%] text-muted-foreground/70">
                        {e.payload_preview.slice(0, 80)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {run.final_output && (
        <Card className="p-3 border-emerald-500/30">
          <p className="text-[10px] uppercase text-emerald-400 mb-1">Final output</p>
          <p className="text-xs whitespace-pre-wrap">{run.final_output}</p>
        </Card>
      )}

      <Sheet open={!!selectedStep} onOpenChange={(o) => !o && setSelectedStep(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          {selectedStep && (
            <>
              <SheetHeader>
                <SheetTitle>{selectedStep.node_label ?? selectedStep.node_id}</SheetTitle>
              </SheetHeader>
              <div className="mt-4 grid grid-cols-4 gap-2">
                <Metric label="Status" value={selectedStep.status} />
                <Metric label="Latency" value={`${selectedStep.latency_ms}ms`} />
                <Metric
                  label="Tokens"
                  value={`${selectedStep.tokens_in}/${selectedStep.tokens_out}`}
                />
                <Metric label="Cost" value={`$${Number(selectedStep.cost_usd).toFixed(4)}`} />
              </div>
              <Tabs defaultValue="input" className="mt-4">
                <TabsList className="flex-wrap h-auto">
                  <TabsTrigger value="input">Input</TabsTrigger>
                  <TabsTrigger value="output">Output</TabsTrigger>
                  <TabsTrigger value="thinking">Thinking</TabsTrigger>
                  <TabsTrigger value="tools">Tools</TabsTrigger>
                  <TabsTrigger value="memory">Memory</TabsTrigger>
                  <TabsTrigger value="rag">RAG</TabsTrigger>
                  <TabsTrigger value="error">Error</TabsTrigger>
                </TabsList>
                <TabsContent value="input">
                  <Pre>{JSON.stringify(selectedStep.input, null, 2)}</Pre>
                </TabsContent>
                <TabsContent value="output">
                  <Pre>{selectedStep.output ?? "—"}</Pre>
                </TabsContent>
                <TabsContent value="thinking">
                  <Pre>{selectedStep.thinking ?? "(none captured)"}</Pre>
                </TabsContent>
                <TabsContent value="tools">
                  <Pre>{JSON.stringify(selectedStep.tool_calls, null, 2)}</Pre>
                </TabsContent>
                <TabsContent value="memory">
                  <Pre>{JSON.stringify(selectedStep.memory_used, null, 2)}</Pre>
                </TabsContent>
                <TabsContent value="rag">
                  <Pre>{JSON.stringify(selectedStep.rag_chunks, null, 2)}</Pre>
                </TabsContent>
                <TabsContent value="error">
                  <Pre>{selectedStep.error_message ?? "(no error)"}</Pre>
                </TabsContent>
              </Tabs>
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
      <p className="text-sm font-mono font-semibold mt-0.5 truncate">{value}</p>
    </div>
  );
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-muted/30 border border-border rounded-md p-3 text-[11px] font-mono whitespace-pre-wrap break-all max-h-96 overflow-auto">
      {children}
    </pre>
  );
}
